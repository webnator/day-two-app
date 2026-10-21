import type { TranscriptionResult } from './transcriber.js';

/** A guard against obvious decoder failures, not a measure of transcription accuracy. */
export class TranscriptionQualityError extends Error {
  constructor(public reason: 'empty' | 'repetition') {
    super(`transcription_${reason}`);
    this.name = 'TranscriptionQualityError';
  }
}

export function assertTranscriptQuality(result: Pick<TranscriptionResult, 'text' | 'segments'>): void {
  if (!result.text.trim()) throw new TranscriptionQualityError('empty');
  // Test the entire text too: loops can span several provider segments. Keep ordinary hesitations
  // and repeated words; reject only extended, contiguous loops (at least 24 words / six cycles).
  const words = result.text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (let period = 1; period <= 12; period++) {
    let matching = 0;
    for (let i = period; i < words.length; i++) {
      matching = words[i] === words[i - period] ? matching + 1 : 0;
      if (matching + period >= 24 && matching >= period * 5) {
        throw new TranscriptionQualityError('repetition');
      }
    }
  }
}
