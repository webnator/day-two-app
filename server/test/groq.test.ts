import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { NotConfiguredError } from '../src/lib/errors.js';
import { makeTranscriber } from '../src/providers.js';
import { GroqTranscriber, parseGroqResult, type GroqOptions } from '../src/transcription/groq.js';
import { assertTranscriptQuality } from '../src/transcription/quality.js';
import { silentWav } from './helpers.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function setup(fetch: typeof globalThis.fetch, apiKey: string | undefined = 'test-key') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daytwo-groq-'));
  dirs.push(dir);
  const input = path.join(dir, 'original.wav');
  fs.writeFileSync(input, silentWav(2));
  const opts: GroqOptions = { apiKey, model: 'whisper-large-v3', ffmpegBin: 'ffmpeg', ffprobeBin: 'ffprobe', tmpDir: path.join(dir, 'tmp'), fetch };
  return { t: new GroqTranscriber(opts), input, opts };
}
const response = { text: 'No, no quiero ir. I need a break.', language: 'spanish', segments: [
  { start: 0, end: 1, text: 'No, no quiero ir.', avg_logprob: -0.2, no_speech_prob: 0.01, compression_ratio: 1.1 },
  { start: 1, end: 2, text: 'I need a break.', avg_logprob: -1.3, no_speech_prob: 0.01, compression_ratio: 1 },
] };

describe('Groq transcription', () => {
  it('sends the complete FLAC to transcriptions, preserves negations/code switching, leaves original intact', async () => {
    const calls: RequestInit[] = [];
    const { t, input, opts } = setup(async (url, init) => {
      expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
      calls.push(init!);
      return Response.json(response);
    });
    const original = fs.readFileSync(input);
    // Deliberately inaccurate uploaded duration: decoded FLAC supplies the actual sample count.
    const result = await t.transcribe({ audioPath: input, durationSec: 1.8, languageHint: 'auto' });
    expect(calls).toHaveLength(1);
    const form = calls[0]!.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('language')).toBeNull();
    expect(form.get('prompt')).toBeNull();
    expect(form.get('temperature')).toBe('0');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(Buffer.from(await (form.get('file') as File).arrayBuffer()).subarray(0, 4).toString()).toBe('fLaC');
    expect(result).toMatchObject({ text: response.text, language: 'es', durationSec: 2, uncertain: [{ start: 1, end: 2 }] });
    expect(fs.readFileSync(input)).toEqual(original);
    expect(fs.readdirSync(opts.tmpDir)).toEqual([]);
  });

  it('uses an explicit language hint when given', async () => {
    const { t, input } = setup(async (_url, init) => {
      expect((init!.body as FormData).get('language')).toBe('en');
      return Response.json(response);
    });
    await t.transcribe({ audioPath: input, durationSec: 2, languageHint: 'en' });
  });

  it.each([401, 429, 500])('sanitizes provider error %s and cleans temporary audio', async (status) => {
    const { t, input, opts } = setup(async () => new Response('private audio text and credentials', { status }));
    const error = await t.transcribe({ audioPath: input, durationSec: 2, languageHint: 'es' }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('private');
    if (status === 401) expect(error).toBeInstanceOf(NotConfiguredError);
    expect(fs.readdirSync(opts.tmpDir)).toEqual([]);
    expect(fs.existsSync(input)).toBe(true);
  });

  it('propagates cancellation and never sends audio when credentials are missing', async () => {
    const { opts, input } = setup(async () => { throw new Error('must not call network'); });
    const t = new GroqTranscriber({ ...opts, apiKey: undefined });
    await expect(t.transcribe({ audioPath: input, durationSec: 2, languageHint: 'es' })).rejects.toBeInstanceOf(NotConfiguredError);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(new GroqTranscriber(opts).transcribe({ audioPath: input, durationSec: 2, languageHint: 'es', signal: ctrl.signal })).rejects.toThrow();
    expect(fs.readdirSync(opts.tmpDir)).toEqual([]);
  });

  it('rejects malformed/private responses without leaking their content', () => {
    expect(() => parseGroqResult({ text: 'private', segments: [{ start: 'bad' }] }, 2)).toThrow('groq_invalid_response');
    expect(() => parseGroqResult({ ...response, segments: [{ start: 10, end: 1, text: 'private' }] }, 2)).toThrow('groq_invalid_timestamps');
  });

  it('can be selected without credentials at boot; defaults to the full model', () => {
    const t = makeTranscriber(loadConfig({ TRANSCRIBER: 'groq' }));
    expect(t.name).toBe('groq');
    expect(t.model).toBe('whisper-large-v3');
  });
});

describe('transcription quality guard', () => {
  it('blocks long decoder loops, including mixed case and punctuation', () => {
    expect(() => assertTranscriptQuality({ text: 'Hoy empecé. ' + 'La verdad, eh. la VERDAD eh! '.repeat(250), segments: [] })).toThrow('transcription_repetition');
    expect(() => assertTranscriptQuality({ text: 'No '.repeat(30), segments: [] })).toThrow('transcription_repetition');
  });
  it('keeps ordinary emphasis, hesitations and repeated themes unchanged', () => {
    const text = 'No, no, no. Me hace mucha, mucha ilusión. La verdad, hoy caminé. La verdad, mañana descansaré. I need a break.';
    const result = { text, segments: [] };
    expect(() => assertTranscriptQuality(result)).not.toThrow();
    expect(result.text).toBe(text);
  });
  it('does not call empty output a successful transcription', () => {
    expect(() => assertTranscriptQuality({ text: '  ', segments: [] })).toThrow('transcription_empty');
  });
});
