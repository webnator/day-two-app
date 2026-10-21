import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { NotConfiguredError } from '../lib/errors.js';
import type { ClassifyInput, Classifier, LabelSets } from './classifier.js';
import { buildUserMessage, LABELS_SCHEMA, SYSTEM_PROMPT } from './prompt.js';

/** Minimal surface of the @google/genai client used here (injectable for tests). */
export interface GenAILike {
  models: {
    generateContent(params: Parameters<GoogleGenAI['models']['generateContent']>[0]): Promise<{ text?: string }>;
  };
}

/** Gemini API with JSON-schema structured output. Same prompt and post-validation as the others. */
export class GeminiClassifier implements Classifier {
  readonly name = 'gemini';
  private client?: GenAILike;

  constructor(
    private apiKey: string | undefined,
    readonly model: string,
    private thinkingLevel = 'LOW',
    client?: GenAILike,
  ) {
    this.client = client;
  }

  async classify(input: ClassifyInput, signal?: AbortSignal): Promise<LabelSets> {
    if (!this.client) {
      if (!this.apiKey) throw new NotConfiguredError('missing credential GEMINI_API_KEY');
      this.client = new GoogleGenAI({ apiKey: this.apiKey });
    }
    const res = await this.client.models.generateContent({
      model: this.model,
      contents: buildUserMessage(input),
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: 'application/json',
        responseJsonSchema: LABELS_SCHEMA,
        thinkingConfig: { thinkingLevel: this.thinkingLevel as ThinkingLevel },
        maxOutputTokens: 1024,
        abortSignal: signal ?? AbortSignal.timeout(60_000),
      },
    });
    if (!res.text) throw new Error('classifier_empty');
    return JSON.parse(res.text) as LabelSets;
  }
}
