import { describe, expect, it } from 'vitest';
import { errorRates, meaningFlags, normalizeForWer } from '../eval/transcription/wer.js';

describe('eval WER/CER', () => {
  it('normalizes punctuation, case and thousands separators', () => {
    expect(normalizeForWer('¡Hola, Mundo! Pagué 1.250 €.')).toBe('hola mundo pagué 1250');
    expect(normalizeForWer("I don't know, 1,450 dollars.")).toBe("i don't know 1450 dollars");
  });

  it('counts substitutions, deletions and insertions', () => {
    const r = errorRates('no creo que vaya mañana', 'creo que vaya a mañana');
    expect(r.deletions).toBe(1);
    expect(r.insertions).toBe(1);
    expect(r.substitutions).toBe(0);
    expect(r.wer).toBeCloseTo(2 / 5);
    expect(r.diffs).toEqual(['− "no"', '+ "a"']);
  });

  it('perfect match has zero error', () => {
    expect(errorRates('Hola, ¿qué tal?', 'hola qué tal').wer).toBe(0);
  });

  it('flags dropped negations, number changes and missing names', () => {
    const f = meaningFlags('No creo que Iñaki pague 87 euros', 'Creo que Inaki pague 78 euros', ['Iñaki']);
    expect(f.some((x) => x.includes('"no"'))).toBe(true);
    expect(f.some((x) => x.startsWith('numbers differ'))).toBe(true);
    expect(f).toContain('name missing/altered: Iñaki');
  });
});
