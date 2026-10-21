import type { ClassifyInput, Classifier, LabelSets } from './classifier.js';
import { buildUserMessage, LABELS_SCHEMA, SYSTEM_PROMPT } from './prompt.js';

export class OllamaClassifier implements Classifier {
  readonly name = 'ollama';
  constructor(
    private url: string,
    readonly model: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async classify(input: ClassifyInput, signal?: AbortSignal): Promise<LabelSets> {
    const res = await this.fetchImpl(`${this.url.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: signal ?? AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: false,
        format: LABELS_SCHEMA, // JSON-schema constrained decoding
        options: { temperature: 0, num_ctx: 8192 },
        keep_alive: '30m',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage(input) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`ollama_http_${res.status}`);
    const body = (await res.json()) as { message?: { content?: string } };
    return JSON.parse(body.message?.content ?? '{}') as LabelSets;
  }
}
