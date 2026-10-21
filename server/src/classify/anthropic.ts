import Anthropic from '@anthropic-ai/sdk';
import type { ClassifyInput, Classifier, LabelSets } from './classifier.js';
import { buildUserMessage, LABELS_SCHEMA, SYSTEM_PROMPT } from './prompt.js';

/** Used only when ANTHROPIC_API_KEY is set. */
export class AnthropicClassifier implements Classifier {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 });
  }

  async classify(input: ClassifyInput, signal?: AbortSignal): Promise<LabelSets> {
    const response = await this.client.beta.messages.create(
      {
        model: this.model,
        max_tokens: 1024,
        // Server-side refusal fallback: on a policy decline the API retries on a fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: LABELS_SCHEMA as unknown as Record<string, unknown> },
        },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(input) }],
      },
      { signal },
    );
    if (response.stop_reason === 'refusal') throw new Error('classifier_refused');
    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') throw new Error('classifier_empty');
    return JSON.parse(text.text) as LabelSets;
  }
}
