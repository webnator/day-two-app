import { NotConfiguredError } from '../lib/errors.js';
import type { TranscribeInput, Transcriber, TranscriptionResult } from './transcriber.js';

/**
 * Skeleton for Deepgram Nova-3. Selectable with TRANSCRIBER=deepgram.
 * Not implemented: it always throws not_configured and never fabricates output.
 * To finish: POST https://api.deepgram.com/v1/listen?model=nova-3&detect_language=true&punctuate=true
 * with the audio body; map words[].confidence to uncertain spans.
 */
export class DeepgramTranscriber implements Transcriber {
  readonly name = 'deepgram';
  readonly model = 'nova-3';
  constructor(private apiKey?: string) {}
  async transcribe(_input: TranscribeInput): Promise<TranscriptionResult> {
    if (!this.apiKey) throw new NotConfiguredError(this.name);
    throw new NotConfiguredError(`${this.name} (adapter not implemented yet)`);
  }
}
