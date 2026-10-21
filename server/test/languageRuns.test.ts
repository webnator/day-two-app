import { describe, expect, it } from 'vitest';
import { groupRuns, parseDetections, parseSilences, planChunks } from '../src/transcription/languageRuns.js';

describe('code-switching helpers', () => {
  it('parses ffmpeg silencedetect and whisper -dl output', () => {
    const ff = '[silencedetect] silence_start: 2.84\n[silencedetect] silence_end: 3.32 | silence_duration: 0.48\n[silencedetect] silence_start: 6.6';
    expect(parseSilences(ff)).toEqual([{ start: 2.84, end: 3.32 }]);
    const wh = 'auto-detected language: en (p = 0.999675)\n...\nauto-detected language: es (p = 0.98)';
    expect(parseDetections(wh)).toEqual([{ language: 'en', p: 0.999675 }, { language: 'es', p: 0.98 }]);
  });

  it('cuts at pause midpoints, merges short pieces and hard-splits long stretches', () => {
    expect(planChunks([{ start: 2.8, end: 3.3 }, { start: 4, end: 4.4 }], 9)).toEqual([
      { start: 0, end: 3.05 },
      { start: 3.05, end: 9 },
    ]);
    expect(planChunks([], 9)).toEqual([{ start: 0, end: 9 }]);
    expect(planChunks([], 60)).toEqual([{ start: 0, end: 28 }, { start: 28, end: 56 }, { start: 56, end: 60 }]);
    // Too-short tail joins the previous chunk.
    expect(planChunks([{ start: 7.9, end: 8.1 }], 9)).toEqual([{ start: 0, end: 9 }]);
  });

  it('groups same-language chunks and only switches language on confident, long chunks', () => {
    const d = (start: number, end: number, language: string, p = 0.99) => ({ start, end, language, p });
    expect(groupRuns([d(0, 3, 'en'), d(3, 7, 'es'), d(7, 12, 'es')])).toEqual([
      { start: 0, end: 3, language: 'en' },
      { start: 3, end: 12, language: 'es' },
    ]);
    // Low-confidence minority chunk stays in the dominant language (avoids forced-language translation).
    expect(groupRuns([d(0, 5, 'es'), d(5, 8, 'en', 0.6), d(8, 12, 'es')])).toEqual([{ start: 0, end: 12, language: 'es' }]);
    expect(groupRuns([d(0, 5, 'es'), d(5, 6, 'en'), d(6, 12, 'es')])).toEqual([{ start: 0, end: 12, language: 'es' }]);
  });
});
