import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { protos } from '@google-cloud/speech';
import { NotConfiguredError } from '../lib/errors.js';
import { splitAtPauses, toFlac16kMono } from './audio.js';
import type { Segment, TranscribeInput, Transcriber, TranscriptionResult } from './transcriber.js';

type Duration = protos.google.protobuf.IDuration | null | undefined;

/** Subset of the Speech V2 client we use (injectable for tests). */
export interface SpeechV2Like {
  recognize(req: protos.google.cloud.speech.v2.IRecognizeRequest, opts?: { timeout?: number }): Promise<[protos.google.cloud.speech.v2.IRecognizeResponse, ...unknown[]]>;
  batchRecognize(
    req: protos.google.cloud.speech.v2.IBatchRecognizeRequest,
    opts?: { timeout?: number },
  ): Promise<[{ promise(): Promise<[protos.google.cloud.speech.v2.IBatchRecognizeResponse, ...unknown[]]>; cancel?(): Promise<unknown> }, ...unknown[]]>;
}

/** Private staging bucket for audio longer than the inline limit. */
export interface StagingStore {
  upload(localPath: string, objectName: string): Promise<void>;
  delete(objectName: string): Promise<void>;
}

export interface Chirp3Options {
  projectId?: string;
  location: string; // 'eu' -> eu-speech.googleapis.com
  bucket?: string;
  /** languageCodes for languageHint=auto, e.g. ['auto'] or ['es-ES','en-US']. */
  autoLanguageCodes: string[];
  ffmpegBin: string;
  tmpDir: string;
  /**
   * Split at pauses and send each sentence-sized chunk inline (in parallel). Each request gets its
   * own language, so a switch between sentences is not dropped, and nothing is staged in GCS.
   */
  segmented?: boolean;
  speech?: SpeechV2Like;
  store?: StagingStore;
}

/** Recognize (sync) is for audio under one minute; keep a margin. Inline content limit is 10 MB. */
export const INLINE_MAX_SEC = 55;
const INLINE_MAX_BYTES = 9.5 * 1024 * 1024;

const HINT_CODES: Record<string, string[]> = { es: ['es-ES'], en: ['en-US'] };

/**
 * Google Cloud Speech-to-Text V2, model chirp_3, regional endpoint (EU by default).
 * Chirp 3 returns no reliable word-level confidence, so this adapter
 * returns segments per recognition result and does NOT report uncertain spans.
 */
export class GoogleChirp3Transcriber implements Transcriber {
  readonly name = 'google-chirp3';
  readonly model = 'chirp_3';
  private speech?: SpeechV2Like;
  private store?: StagingStore;

  constructor(private opts: Chirp3Options) {
    this.speech = opts.speech;
    this.store = opts.store;
  }

  get recognizer() {
    return `projects/${this.opts.projectId}/locations/${this.opts.location}/recognizers/_`;
  }

  async transcribe(input: TranscribeInput): Promise<TranscriptionResult> {
    if (!this.opts.projectId) throw new NotConfiguredError('missing credential GOOGLE_CLOUD_PROJECT');
    await fs.mkdir(this.opts.tmpDir, { recursive: true });
    const base = path.join(this.opts.tmpDir, randomUUID());
    const flac = `${base}.flac`;
    try {
      await toFlac16kMono(this.opts.ffmpegBin, input.audioPath, flac, input.signal);
      const size = (await fs.stat(flac)).size;
      const config: protos.google.cloud.speech.v2.IRecognitionConfig = {
        autoDecodingConfig: {},
        model: 'chirp_3',
        languageCodes: HINT_CODES[input.languageHint] ?? this.opts.autoLanguageCodes,
        features: { enableAutomaticPunctuation: true },
        denoiserConfig: { denoiseAudio: true, snrThreshold: 0 },
      };
      const segmented = this.opts.segmented && input.durationSec > 5 ? await this.recognizeSegmented(flac, base, config, input) : null;
      const results =
        segmented ??
        (input.durationSec < INLINE_MAX_SEC && size <= INLINE_MAX_BYTES
          ? await this.recognizeInline(flac, config)
          : await this.recognizeBatch(flac, config, input));
      return { ...mapResults(results, input), provider: this.name, model: this.model, durationSec: input.durationSec };
    } catch (err) {
      throw mapGoogleError(err);
    } finally {
      const prefix = path.basename(base);
      for (const f of await fs.readdir(this.opts.tmpDir).catch(() => [] as string[])) {
        if (f.startsWith(prefix)) await fs.rm(path.join(this.opts.tmpDir, f), { force: true });
      }
    }
  }

  /** Returns null when the audio can't be split into inline-sized chunks (caller falls back). */
  private async recognizeSegmented(flac: string, base: string, config: protos.google.cloud.speech.v2.IRecognitionConfig, input: TranscribeInput) {
    const split = await splitAtPauses(this.opts.ffmpegBin, flac, base, input.durationSec, { signal: input.signal, ext: 'flac', maxChunk: 50 });
    if (!split || split.chunks.some((c) => c.end - c.start >= INLINE_MAX_SEC)) return null;
    const out: protos.google.cloud.speech.v2.ISpeechRecognitionResult[][] = new Array(split.files.length);
    let next = 0;
    const worker = async () => {
      while (next < split.files.length) {
        const i = next++;
        const chunk = split.chunks[i]!;
        const results = await this.recognizeInline(split.files[i]!, config);
        // Shift chunk-relative offsets to the whole recording.
        out[i] = results.map((r) => {
          const end = seconds(r.resultEndOffset);
          const abs = Math.min(chunk.end, chunk.start + (end ?? chunk.end - chunk.start));
          return { ...r, resultEndOffset: { seconds: Math.floor(abs), nanos: Math.round((abs % 1) * 1e9) } };
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, split.files.length) }, worker));
    return out.flat();
  }

  private async recognizeInline(flac: string, config: protos.google.cloud.speech.v2.IRecognitionConfig) {
    const content = await fs.readFile(flac);
    const [res] = await (await this.client()).recognize({ recognizer: this.recognizer, config, content }, { timeout: 120_000 });
    return res.results ?? [];
  }

  private async recognizeBatch(flac: string, config: protos.google.cloud.speech.v2.IRecognitionConfig, input: TranscribeInput) {
    if (!this.opts.bucket) throw new NotConfiguredError('missing credential GCS_TRANSCRIBE_BUCKET');
    const store = await this.staging();
    const owner = input.ref?.userId ?? 'anonymous';
    const job = input.ref?.jobId ?? randomUUID();
    const objectName = `transcribe/${owner}/${job}.flac`;
    const uri = `gs://${this.opts.bucket}/${objectName}`;
    await store.upload(flac, objectName);
    try {
      const [op] = await (await this.client()).batchRecognize(
        { recognizer: this.recognizer, config, files: [{ uri }], recognitionOutputConfig: { inlineResponseConfig: {} } },
        { timeout: 120_000 },
      );
      const [res] = await abortable(op.promise(), input.signal, () => void op.cancel?.().catch(() => undefined));
      const file = res.results?.[uri];
      if (!file) throw new Error('chirp3_batch_missing_result');
      if (file.error && file.error.code) throw Object.assign(new Error('chirp3_batch_file_error'), { code: file.error.code });
      return file.transcript?.results ?? file.inlineResult?.transcript?.results ?? [];
    } finally {
      // Delete the staged audio right away, on success, failure or cancellation.
      await store.delete(objectName).catch(() => undefined);
    }
  }

  private async client(): Promise<SpeechV2Like> {
    if (!this.speech) {
      const { v2 } = await import('@google-cloud/speech');
      this.speech = new v2.SpeechClient({ apiEndpoint: `${this.opts.location}-speech.googleapis.com` }) as unknown as SpeechV2Like;
    }
    return this.speech;
  }

  private async staging(): Promise<StagingStore> {
    if (!this.store) {
      const { Storage } = await import('@google-cloud/storage');
      const bucket = new Storage({ projectId: this.opts.projectId }).bucket(this.opts.bucket!);
      this.store = {
        upload: async (local, name) => {
          await bucket.upload(local, { destination: name, resumable: false, metadata: { contentType: 'audio/flac' } });
        },
        delete: async (name) => {
          await bucket.file(name).delete({ ignoreNotFound: true });
        },
      };
    }
    return this.store;
  }
}

function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      onAbort();
      return reject(new Error('aborted'));
    }
    signal.addEventListener('abort', () => {
      onAbort();
      reject(new Error('aborted'));
    }, { once: true });
    p.then(resolve, reject);
  });
}

function seconds(d: Duration): number | undefined {
  if (!d) return undefined;
  return Number(d.seconds ?? 0) + (d.nanos ?? 0) / 1e9;
}

/** Pure mapping, exported for tests. */
export function mapResults(results: protos.google.cloud.speech.v2.ISpeechRecognitionResult[], input: Pick<TranscribeInput, 'durationSec' | 'languageHint'>) {
  const segments: Segment[] = [];
  const charsByLang = new Map<string, number>();
  let prevEnd = 0;
  for (const r of results) {
    const text = (r.alternatives?.[0]?.transcript ?? '').trim();
    const end = seconds(r.resultEndOffset) ?? input.durationSec;
    if (text) {
      segments.push({ start: round(prevEnd), end: round(Math.max(end, prevEnd)), text });
      const lang = (r.languageCode ?? '').slice(0, 2).toLowerCase();
      if (lang) charsByLang.set(lang, (charsByLang.get(lang) ?? 0) + text.length);
    }
    prevEnd = Math.max(prevEnd, end);
  }
  const dominant = [...charsByLang.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    text: segments.map((s) => s.text).join(' '),
    language: dominant ?? (input.languageHint === 'auto' ? 'und' : input.languageHint),
    segments,
  };
}

/** Auth/permission problems are configuration errors (no retry); everything else is a provider failure. */
export function mapGoogleError(err: unknown): Error {
  if (err instanceof NotConfiguredError) return err;
  const e = err as { code?: number; message?: string };
  if (e.code === 7 || e.code === 16 || /default credentials/i.test(e.message ?? '')) {
    return new NotConfiguredError('google credentials or permissions');
  }
  const out = new Error('chirp3_failed');
  out.name = `GoogleError${typeof e.code === 'number' ? `_${e.code}` : ''}`;
  return out;
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}
