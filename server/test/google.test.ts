import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GeminiClassifier, type GenAILike } from '../src/classify/gemini.js';
import { loadConfig } from '../src/config.js';
import { NotConfiguredError } from '../src/lib/errors.js';
import { makeClassifier, makeTranscriber } from '../src/providers.js';
import { GoogleChirp3Transcriber, mapGoogleError, mapResults, type SpeechV2Like, type StagingStore } from '../src/transcription/chirp3.js';
import { silentWav } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'daytwo-g-'));
function wavFile(seconds = 1) {
  const f = path.join(tmp(), 'a.wav');
  fs.writeFileSync(f, silentWav(seconds));
  return f;
}
const dur = (s: number) => ({ seconds: s, nanos: 0 });

function fakes(opts: { batchFails?: boolean } = {}) {
  const calls = { recognize: [] as unknown[], batch: [] as unknown[], uploaded: [] as string[], deleted: [] as string[] };
  const result = { results: [{ alternatives: [{ transcript: ' No creo que vaya. ' }], resultEndOffset: dur(2), languageCode: 'es-ES' }] };
  const speech: SpeechV2Like = {
    async recognize(req) {
      calls.recognize.push(req);
      return [result];
    },
    async batchRecognize(req) {
      calls.batch.push(req);
      const uri = req.files![0]!.uri!;
      return [
        {
          promise: async () => {
            if (opts.batchFails) throw Object.assign(new Error('boom'), { code: 13 });
            return [{ results: { [uri]: { transcript: result } } }];
          },
        },
      ];
    },
  };
  const store: StagingStore = {
    upload: async (_local, name) => void calls.uploaded.push(name),
    delete: async (name) => void calls.deleted.push(name),
  };
  return { speech, store, calls };
}

const base = { location: 'eu', autoLanguageCodes: ['auto'], ffmpegBin: process.env.FFMPEG_BIN ?? 'ffmpeg' };

describe('GoogleChirp3Transcriber', () => {
  it('short audio goes inline to the EU recognizer with chirp_3 and auto language', async () => {
    const f = fakes();
    const t = new GoogleChirp3Transcriber({ ...base, projectId: 'p', bucket: 'b', tmpDir: tmp(), speech: f.speech, store: f.store });
    const res = await t.transcribe({ audioPath: wavFile(), languageHint: 'auto', durationSec: 1 });
    expect(f.calls.recognize).toHaveLength(1);
    const req = f.calls.recognize[0] as { recognizer: string; config: { model: string; languageCodes: string[] }; content: Buffer };
    expect(req.recognizer).toBe('projects/p/locations/eu/recognizers/_');
    expect(req.config.model).toBe('chirp_3');
    expect(req.config).toMatchObject({ denoiserConfig: { denoiseAudio: true, snrThreshold: 0 } });
    expect(req.config.languageCodes).toEqual(['auto']);
    expect(req.content.subarray(0, 4).toString()).toBe('fLaC'); // transcoded to FLAC 16 kHz mono
    expect(f.calls.uploaded).toEqual([]);
    expect(res).toMatchObject({ text: 'No creo que vaya.', language: 'es', provider: 'google-chirp3', model: 'chirp_3' });
    expect(res.uncertain).toBeUndefined(); // chirp_3 has no reliable word confidence
  });

  it('language hint maps to a single language code', async () => {
    const f = fakes();
    const t = new GoogleChirp3Transcriber({ ...base, projectId: 'p', tmpDir: tmp(), speech: f.speech, store: f.store });
    await t.transcribe({ audioPath: wavFile(), languageHint: 'en', durationSec: 1 });
    expect((f.calls.recognize[0] as { config: { languageCodes: string[] } }).config.languageCodes).toEqual(['en-US']);
  });

  it('long audio is staged in the bucket under transcribe/<userId>/<jobId>, batched, then deleted', async () => {
    const f = fakes();
    const t = new GoogleChirp3Transcriber({ ...base, projectId: 'p', bucket: 'bkt', tmpDir: tmp(), speech: f.speech, store: f.store });
    const res = await t.transcribe({ audioPath: wavFile(), languageHint: 'auto', durationSec: 90, ref: { userId: 'u1', jobId: 'j1' } });
    expect(f.calls.uploaded).toEqual(['transcribe/u1/j1.flac']);
    expect((f.calls.batch[0] as { files: { uri: string }[] }).files[0]!.uri).toBe('gs://bkt/transcribe/u1/j1.flac');
    expect(f.calls.deleted).toEqual(['transcribe/u1/j1.flac']);
    expect(res.text).toBe('No creo que vaya.');
  });

  it('deletes the staged object when the batch fails', async () => {
    const f = fakes({ batchFails: true });
    const t = new GoogleChirp3Transcriber({ ...base, projectId: 'p', bucket: 'bkt', tmpDir: tmp(), speech: f.speech, store: f.store });
    await expect(t.transcribe({ audioPath: wavFile(), languageHint: 'auto', durationSec: 90, ref: { userId: 'u', jobId: 'j' } })).rejects.toThrow();
    expect(f.calls.deleted).toEqual(['transcribe/u/j.flac']);
  });

  it('segmented mode splits at pauses, sends each chunk inline and shifts offsets (no bucket)', async () => {
    const dir = tmp();
    const f = path.join(dir, 'two.wav');
    // 3 s tone, 1 s silence, 3 s tone
    execFileSync(base.ffmpegBin, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=1', '-f', 'lavfi', '-i', 'sine=f=440:d=3',
      '-filter_complex', '[0:a]aresample=16000,aformat=channel_layouts=mono[a];[2:a]aresample=16000,aformat=channel_layouts=mono[c];[a][1:a][c]concat=n=3:v=0:a=1', f]);
    const fk = fakes();
    const t = new GoogleChirp3Transcriber({ ...base, projectId: 'p', bucket: 'b', segmented: true, tmpDir: dir, speech: fk.speech, store: fk.store });
    const res = await t.transcribe({ audioPath: f, languageHint: 'auto', durationSec: 7 });
    expect(fk.calls.recognize).toHaveLength(2);
    expect(fk.calls.uploaded).toEqual([]);
    expect(res.segments).toHaveLength(2);
    expect(res.segments[1]!.start).toBeCloseTo(2, 1); // previous segment end
    expect(res.segments[1]!.end).toBeGreaterThan(5); // 3.5 s chunk start + 2 s
    expect(fs.readdirSync(dir).filter((x) => x.endsWith('.flac'))).toEqual([]); // temp chunks cleaned
  });

  it('missing project or bucket -> not_configured (never fake output)', async () => {
    const f = fakes();
    await expect(
      new GoogleChirp3Transcriber({ ...base, tmpDir: tmp(), speech: f.speech }).transcribe({ audioPath: wavFile(), languageHint: 'auto', durationSec: 1 }),
    ).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/);
    await expect(
      new GoogleChirp3Transcriber({ ...base, projectId: 'p', tmpDir: tmp(), speech: f.speech }).transcribe({ audioPath: wavFile(), languageHint: 'auto', durationSec: 120 }),
    ).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it('maps auth errors to not_configured and hides provider messages', () => {
    expect(mapGoogleError({ code: 7, message: 'denied for x@y' })).toBeInstanceOf(NotConfiguredError);
    expect(mapGoogleError(new Error('Could not load the default credentials'))).toBeInstanceOf(NotConfiguredError);
    const e = mapGoogleError({ code: 3, message: 'secret transcript text' });
    expect(e.message).not.toContain('secret');
    expect(e.name).toBe('GoogleError_3');
  });

  it('maps results to segments using result end offsets and dominant language', () => {
    const out = mapResults(
      [
        { alternatives: [{ transcript: 'This morning I finished the report.' }], resultEndOffset: dur(3), languageCode: 'en-us' },
        { alternatives: [{ transcript: '' }], resultEndOffset: dur(3.5) },
        { alternatives: [{ transcript: 'Después he comido con mi madre y hemos hablado mucho.' }], resultEndOffset: { seconds: 7, nanos: 500_000_000 }, languageCode: 'es-es' },
      ],
      { durationSec: 8, languageHint: 'auto' },
    );
    expect(out.segments).toEqual([
      { start: 0, end: 3, text: 'This morning I finished the report.' },
      { start: 3.5, end: 7.5, text: 'Después he comido con mi madre y hemos hablado mucho.' },
    ]);
    expect(out.language).toBe('es');
  });
});

describe('GeminiClassifier', () => {
  it('sends the system prompt and a JSON schema; parses the JSON text', async () => {
    let params: Record<string, unknown> = {};
    const client: GenAILike = {
      models: {
        generateContent: async (p) => {
          params = p as unknown as Record<string, unknown>;
          return { text: '{"topics":["Familia","Trabajo"],"emotions":["Alegría"]}' };
        },
      },
    };
    const c = new GeminiClassifier(undefined, 'gemini-3.8-flash', 'LOW', client);
    expect(await c.classify({ text: 'x', vocabulary: { topics: [], emotions: [] }, rejected: { topics: [], emotions: [] } })).toEqual({
      topics: ['Familia', 'Trabajo'],
      emotions: ['Alegría'],
    });
    const config = params.config as Record<string, unknown>;
    expect(params.model).toBe('gemini-3.8-flash');
    expect(config.responseMimeType).toBe('application/json');
    expect((config.responseJsonSchema as { required: string[] }).required).toEqual(['topics', 'emotions']);
    expect(String(config.systemInstruction)).toContain('TOPICS');
  });

  it('without GEMINI_API_KEY -> not_configured', async () => {
    await expect(new GeminiClassifier(undefined, 'm').classify({ text: 'x', vocabulary: { topics: [], emotions: [] }, rejected: { topics: [], emotions: [] } })).rejects.toThrow(
      /GEMINI_API_KEY/,
    );
  });
});

describe('provider selection', () => {
  it('defaults are chirp3 + gemini and boot without credentials', () => {
    const cfg = loadConfig({ DATA_DIR: tmp() });
    expect(makeTranscriber(cfg).name).toBe('google-chirp3');
    expect(makeClassifier(cfg).name).toBe('gemini');
    expect(cfg.speechLocation).toBe('eu');
    expect(cfg.geminiModel).toBe('gemini-3.8-flash');
  });

  it('whisper/ollama/anthropic remain selectable', () => {
    const cfg = loadConfig({ DATA_DIR: tmp(), TRANSCRIBER: 'whisper', WHISPER_MODEL: '/m/ggml-large-v3-turbo.bin', CLASSIFIER: 'ollama' });
    expect(makeTranscriber(cfg).name).toBe('whisper.cpp');
    expect(makeClassifier(cfg).name).toBe('ollama');
    expect(makeClassifier(loadConfig({ DATA_DIR: tmp(), CLASSIFIER: 'anthropic' })).name).toBe('anthropic');
  });
});
