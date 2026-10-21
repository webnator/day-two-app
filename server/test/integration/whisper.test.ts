import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { makeTranscriber } from '../../src/providers.js';
import { probeAudio } from '../../src/transcription/audio.js';

// Runs the real whisper.cpp adapter on a macOS `say` clip (requires WHISPER_MODEL).
it('transcribes Spanish in Spanish (no translation) with segments', async () => {
  const cfg = loadConfig({ ...process.env, TRANSCRIBER: 'whisper', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'daytwo-wh-')) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daytwo-say-'));
  const aiff = path.join(dir, 'es.aiff');
  const m4a = path.join(dir, 'es.m4a');
  execFileSync('say', ['-v', 'Mónica', '-o', aiff, 'Hoy no he ido a trabajar porque me dolía la cabeza.']);
  execFileSync(cfg.ffmpegBin, ['-loglevel', 'error', '-y', '-i', aiff, '-c:a', 'aac', m4a]);
  const probe = await probeAudio(cfg.ffprobeBin, m4a);
  expect(probe?.formatName).toBe('mov');
  const res = await makeTranscriber(cfg).transcribe({ audioPath: m4a, languageHint: 'auto', durationSec: probe!.durationSec });
  expect(res.language).toBe('es');
  expect(res.text.toLowerCase()).toContain('cabeza');
  expect(res.text.toLowerCase()).not.toContain('head');
  expect(res.segments.length).toBeGreaterThan(0);
  expect(res.provider).toBe('whisper.cpp');
});
