import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { splitAtPauses, toWav16kMono } from './audio.js';
import { groupRuns, parseDetections, type Run } from './languageRuns.js';
import type { LanguageHint, Segment, Span, TranscribeInput, Transcriber, TranscriptionResult } from './transcriber.js';

const execFileP = promisify(execFile);

/** Tokens below this probability are reported as uncertain spans. */
export const UNCERTAIN_P = 0.5;
/** Uncertain tokens closer than this (seconds) are merged into one span. */
const MERGE_GAP_SEC = 0.3;

export interface WhisperCppOptions {
  bin: string;
  model: string;
  ffmpegBin: string;
  tmpDir: string;
  threads: number;
  /** Split at pauses and decode each language run separately in auto mode (default true). */
  codeSwitching?: boolean;
}

interface WhisperToken {
  text: string;
  p: number;
  offsets: { from: number; to: number };
}
interface WhisperJson {
  result?: { language?: string };
  transcription?: { offsets: { from: number; to: number }; text: string; tokens?: WhisperToken[] }[];
}

type Parsed = Pick<TranscriptionResult, 'text' | 'language' | 'segments' | 'uncertain'>;

export class WhisperCppTranscriber implements Transcriber {
  readonly name = 'whisper.cpp';
  readonly model: string;

  constructor(private opts: WhisperCppOptions) {
    this.model = path.basename(opts.model).replace(/^ggml-/, '').replace(/\.bin$/, '');
  }

  async transcribe(input: TranscribeInput): Promise<TranscriptionResult> {
    await fs.mkdir(this.opts.tmpDir, { recursive: true });
    const base = path.join(this.opts.tmpDir, randomUUID());
    const wav = `${base}.wav`;
    const meta = { provider: this.name, model: this.model, durationSec: input.durationSec };
    try {
      await toWav16kMono(this.opts.ffmpegBin, input.audioPath, wav, input.signal);
      const runs =
        input.languageHint === 'auto' && this.opts.codeSwitching !== false && input.durationSec > 5
          ? await this.detectRuns(wav, base, input)
          : null;
      if (!runs || runs.length <= 1) {
        const lang = (runs?.[0]?.language ?? input.languageHint) as LanguageHint;
        const [parsed] = await this.decode([wav], lang, input);
        return { ...parsed!, ...meta };
      }
      return { ...(await this.decodeRuns(wav, base, runs, input)), ...meta };
    } finally {
      const dir = path.dirname(base);
      const prefix = path.basename(base);
      for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
        if (f.startsWith(prefix)) await fs.rm(path.join(dir, f), { force: true });
      }
    }
  }

  /** Decodes files with one whisper-cli invocation (model loaded once). Never passes --translate. */
  private async decode(files: string[], language: string, input: TranscribeInput): Promise<Parsed[]> {
    const args = ['-m', this.opts.model, '-l', language, '-t', String(this.opts.threads), '-ojf', '-np', ...files];
    // Generous timeout: model load (~10 s cold) plus ~real time on CPU fallback.
    const timeout = 120_000 + Math.ceil(input.durationSec * 3_000);
    await execFileP(this.opts.bin, args, { timeout, signal: input.signal, maxBuffer: 16 * 1024 * 1024 });
    return Promise.all(files.map(async (f) => parseWhisperJson(JSON.parse(await fs.readFile(`${f}.json`, 'utf8')) as WhisperJson)));
  }

  private async detectRuns(wav: string, base: string, input: TranscribeInput): Promise<Run[] | null> {
    const split = await splitAtPauses(this.opts.ffmpegBin, wav, base, input.durationSec, { signal: input.signal, ext: 'wav' });
    if (!split) return null;
    const det = await execFileP(this.opts.bin, ['-m', this.opts.model, '-l', 'auto', '-dl', '-t', String(this.opts.threads), ...split.files], {
      timeout: 120_000,
      signal: input.signal,
      maxBuffer: 16 * 1024 * 1024,
    });
    const found = parseDetections(det.stderr);
    if (found.length !== split.chunks.length) return null;
    return groupRuns(split.chunks.map((c, i) => ({ ...c, ...found[i]! })));
  }

  private async decodeRuns(wav: string, base: string, runs: Run[], input: TranscribeInput): Promise<Parsed> {
    const files = await Promise.all(
      runs.map(async (r, i) => {
        const f = `${base}.r${i}.wav`;
        await execFileP(
          this.opts.ffmpegBin,
          ['-nostdin', '-loglevel', 'error', '-y', '-i', wav, '-ss', r.start.toFixed(3), '-to', r.end.toFixed(3), '-c', 'copy', f],
          { timeout: 60_000, signal: input.signal },
        );
        return f;
      }),
    );
    const parsedByRun: Parsed[] = new Array(runs.length);
    for (const lang of new Set(runs.map((r) => r.language))) {
      const idx = runs.map((r, i) => (r.language === lang ? i : -1)).filter((i) => i >= 0);
      const parsed = await this.decode(idx.map((i) => files[i]!), lang, input);
      idx.forEach((runIdx, k) => (parsedByRun[runIdx] = parsed[k]!));
    }
    const segments: Segment[] = [];
    const uncertain: Span[] = [];
    const dur = new Map<string, number>();
    runs.forEach((r, i) => {
      const p = parsedByRun[i]!;
      dur.set(r.language, (dur.get(r.language) ?? 0) + (r.end - r.start));
      segments.push(...p.segments.map((s) => ({ ...s, start: round(s.start + r.start, 3), end: round(s.end + r.start, 3) })));
      uncertain.push(...(p.uncertain ?? []).map((u) => ({ start: round(u.start + r.start, 3), end: round(u.end + r.start, 3) })));
    });
    return {
      text: segments.map((s) => s.text).join(' '),
      language: [...dur.entries()].sort((a, b) => b[1] - a[1])[0]![0],
      segments,
      uncertain,
    };
  }
}

/** Pure parser, exported for unit tests. */
export function parseWhisperJson(json: WhisperJson): Parsed {
  const segments: Segment[] = [];
  const uncertain: Span[] = [];
  for (const seg of json.transcription ?? []) {
    const text = seg.text.trim();
    if (!text) continue;
    const words = (seg.tokens ?? []).filter((t) => !/^\[_.*\]$/.test(t.text) && t.text.trim() !== '');
    const confidence = words.length ? words.reduce((a, t) => a + t.p, 0) / words.length : undefined;
    segments.push({
      start: seg.offsets.from / 1000,
      end: seg.offsets.to / 1000,
      text,
      ...(confidence !== undefined ? { confidence: round(confidence, 3) } : {}),
    });
    for (const t of words) {
      if (t.p >= UNCERTAIN_P) continue;
      const span = { start: t.offsets.from / 1000, end: t.offsets.to / 1000 };
      const prev = uncertain.at(-1);
      if (prev && span.start - prev.end <= MERGE_GAP_SEC) prev.end = Math.max(prev.end, span.end);
      else uncertain.push(span);
    }
  }
  return {
    text: segments.map((s) => s.text).join(' '),
    language: json.result?.language ?? 'und',
    segments,
    uncertain,
  };
}

function round(n: number, d: number) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
