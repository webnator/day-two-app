import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { NotConfiguredError } from '../lib/errors.js';
import { probeAudio, toFlac16kMono } from './audio.js';
import type { Span, Transcriber, TranscribeInput, TranscriptionResult } from './transcriber.js';

// The free tier accepts 25 MB. Use the same safe limit in both plans.
export const GROQ_MAX_BYTES = 25_000_000;
const responseSchema = z.object({
  text: z.string(),
  language: z.string(),
  segments: z.array(z.object({
    start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
    text: z.string(),
    avg_logprob: z.number().finite().optional(),
    no_speech_prob: z.number().finite().optional(),
    compression_ratio: z.number().finite().optional(),
  })),
});

export interface GroqOptions {
  apiKey?: string;
  model: 'whisper-large-v3' | 'whisper-large-v3-turbo';
  ffmpegBin: string;
  ffprobeBin: string;
  tmpDir: string;
  fetch?: typeof globalThis.fetch;
}

/** Whole-recording transcription: no hard cuts mid-sentence, no LLM rewriting. */
export class GroqTranscriber implements Transcriber {
  readonly name = 'groq';
  readonly model: string;
  constructor(private opts: GroqOptions) { this.model = opts.model; }

  async transcribe(input: TranscribeInput): Promise<TranscriptionResult> {
    if (!this.opts.apiKey) throw new NotConfiguredError('missing credential GROQ_API_KEY');
    await fs.mkdir(this.opts.tmpDir, { recursive: true });
    const file = path.join(this.opts.tmpDir, `${randomUUID()}.flac`);
    // Includes decoding, upload and provider time; a caller cancellation is never retried here.
    const signal = AbortSignal.any([AbortSignal.timeout(180_000), ...(input.signal ? [input.signal] : [])]);
    try {
      await toFlac16kMono(this.opts.ffmpegBin, input.audioPath, file, signal);
      if ((await fs.stat(file)).size > GROQ_MAX_BYTES) throw new Error('groq_audio_too_large');
      // ADTS/AAC duration from the upload probe can be an estimate. FLAC has an exact sample count.
      const probe = await probeAudio(this.opts.ffprobeBin, file);
      if (!probe || probe.durationSec <= 0) throw new Error('groq_invalid_audio');
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(await fs.readFile(file))], { type: 'audio/flac' }), 'recording.flac');
      form.set('model', this.model);
      form.set('response_format', 'verbose_json');
      form.set('timestamp_granularities[]', 'segment');
      form.set('temperature', '0');
      if (input.languageHint !== 'auto') form.set('language', input.languageHint);
      const res = await (this.opts.fetch ?? globalThis.fetch)('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${this.opts.apiKey}` }, body: form, signal,
        redirect: 'error',
      });
      if (!res.ok) {
        // Provider response bodies can contain private data. Never include them in an exception.
        await res.body?.cancel();
        if (res.status === 401 || res.status === 403) throw new NotConfiguredError('Groq authentication');
        const err = new Error(`groq_http_${res.status}`);
        err.name = `GroqError_${res.status}`;
        throw err;
      }
      return { ...parseGroqResult(await res.json(), probe.durationSec), provider: this.name, model: this.model };
    } finally {
      await fs.rm(file, { force: true });
    }
  }
}

export function parseGroqResult(raw: unknown, durationSec: number): Omit<TranscriptionResult, 'provider' | 'model'> {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new Error('groq_invalid_response');
  const data = parsed.data;
  const uncertain: Span[] = [];
  const segments = data.segments.filter((s) => s.text.trim()).map((s) => {
    if (s.end < s.start || s.start > durationSec + 1) throw new Error('groq_invalid_timestamps');
    const start = Math.min(s.start, durationSec);
    const end = Math.min(s.end, durationSec);
    // Whisper decoder diagnostics are heuristics, not calibrated probabilities of correctness.
    if ((s.avg_logprob != null && s.avg_logprob < -1) ||
        (s.no_speech_prob != null && s.no_speech_prob > 0.6) ||
        (s.compression_ratio != null && s.compression_ratio > 2.4)) {
      const previous = uncertain.at(-1);
      if (previous && start <= previous.end + 0.1) previous.end = Math.max(previous.end, end);
      else uncertain.push({ start, end });
    }
    return { start, end, text: s.text.trim() };
  });
  const language = ({ spanish: 'es', english: 'en' } as Record<string, string>)[data.language.toLowerCase()] ?? data.language.toLowerCase();
  return { text: data.text.trim(), language, segments, uncertain, durationSec };
}
