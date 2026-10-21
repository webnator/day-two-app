export type LanguageHint = 'es' | 'en' | 'auto';

export interface Segment {
  start: number; // seconds
  end: number;
  text: string;
  confidence?: number; // 0..1
}

export interface Span {
  start: number;
  end: number;
}

export interface TranscriptionResult {
  text: string;
  language: string;
  segments: Segment[];
  uncertain?: Span[];
  provider: string;
  model: string;
  durationSec: number;
}

export interface TranscribeInput {
  audioPath: string;
  languageHint: LanguageHint;
  durationSec: number;
  signal?: AbortSignal;
  /** Owner and job, for adapters that stage audio remotely (e.g. a GCS object name). */
  ref?: { userId: string; jobId: string };
}

/**
 * Speech-to-text adapter. Implementations must keep the original language (never translate)
 * and must never return invented output: if they cannot run, they throw.
 */
export interface Transcriber {
  readonly name: string;
  readonly model: string;
  transcribe(input: TranscribeInput): Promise<TranscriptionResult>;
}
