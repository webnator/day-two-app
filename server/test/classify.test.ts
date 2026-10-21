import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { labelKey, postValidate } from '../src/classify/classifier.js';
import { OllamaClassifier } from '../src/classify/ollama.js';
import { auth, login, makeApp, makeFetchMock, type TestCtx } from './helpers.js';

const none = { topics: [], emotions: [] };

describe('postValidate', () => {
  it('never returns rejected labels (case/accent-insensitive)', () => {
    const out = postValidate(
      { topics: ['trabajo', 'Familia', 'SALUD'], emotions: ['preocupacion', 'Alegría'] },
      { vocabulary: none, rejected: { topics: ['Trabajo', 'salud'], emotions: ['Preocupación'] } },
    );
    expect(out).toEqual({ topics: ['Familia'], emotions: ['Alegría'] });
  });

  it('dedupes, reuses vocabulary spelling and caps at 3 + 3', () => {
    const out = postValidate(
      { topics: ['trabajo', 'Trabajo ', 'TRABAJO', 'familia', 'Amistad', 'Deporte', 'Viajes'], emotions: ['a', 'b', 'c', 'd'] },
      { vocabulary: { topics: ['Trabajo', 'Familia'], emotions: [] }, rejected: none },
    );
    expect(out.topics).toEqual(['Trabajo', 'Familia', 'Amistad']);
    expect(out.emotions).toEqual(['A', 'B', 'C']);
  });

  it('drops junk: empty, non-strings, overlong, hashtags', () => {
    const out = postValidate(
      { topics: ['', '   ', 42, '#Trabajo', 'x'.repeat(60)], emotions: 'Alegría' as unknown },
      { vocabulary: none, rejected: none },
    );
    expect(out).toEqual({ topics: ['Trabajo'], emotions: [] });
  });

  it('a label cannot be both topic and emotion', () => {
    expect(postValidate({ topics: ['Estrés'], emotions: ['estres', 'Calma'] }, { vocabulary: none, rejected: none })).toEqual({
      topics: ['Estrés'],
      emotions: ['Calma'],
    });
  });

  it('labelKey normalizes accents, case and spaces', () => {
    expect(labelKey('  Salud   Mental ')).toBe(labelKey('salud mental'));
    expect(labelKey('Preocupación')).toBe('preocupacion');
  });
});

describe('POST /v1/classify', () => {
  let ctx: TestCtx;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => ctx.app.close());

  it('filters rejected labels returned by the model and reports provider/model', async () => {
    const { token } = await login(ctx, 'c@example.com');
    ctx.classifier.next = { topics: ['Trabajo', 'Familia'], emotions: ['Alegría', 'Preocupación'] };
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/v1/classify',
      headers: auth(token),
      payload: {
        jobId: randomUUID(),
        text: 'Hoy estuve con mi familia y en el curro; contenta pero preocupada.',
        vocabulary: { topics: ['Trabajo'], emotions: [] },
        rejected: { topics: ['familia'], emotions: [] },
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ topics: ['Trabajo'], emotions: ['Alegría', 'Preocupación'], provider: 'fake', model: 'fake-1' });
  });

  it('is idempotent by jobId for identical input; recomputes if input changes', async () => {
    const { token } = await login(ctx, 'c@example.com');
    const jobId = randomUUID();
    const payload = { jobId, text: 'Día tranquilo.', vocabulary: none, rejected: none };
    const send = (p: object) => ctx.app.inject({ method: 'POST', url: '/v1/classify', headers: auth(token), payload: p });
    const a = await send(payload);
    const b = await send(payload);
    expect(b.json()).toEqual(a.json());
    expect(ctx.classifier.calls).toHaveLength(1);
    // The user rejects a label after the first run: the cached answer must not resurface it.
    const c = await send({ ...payload, rejected: { topics: ['Trabajo'], emotions: [] } });
    expect(c.json().topics).not.toContain('Trabajo');
    expect(ctx.classifier.calls).toHaveLength(2);
  });

  it('validates input and requires a session', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/classify', payload: { jobId: randomUUID(), text: 'x' } })).statusCode).toBe(401);
    const { token } = await login(ctx, 'c@example.com');
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/classify', headers: auth(token), payload: { jobId: 'nope', text: '' } });
    expect(r.statusCode).toBe(400);
  });

  it('503 when the classifier fails', async () => {
    const { token } = await login(ctx, 'c@example.com');
    ctx.classifier.classify = async () => {
      throw new Error('down');
    };
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/classify', headers: auth(token), payload: { jobId: randomUUID(), text: 'hola' } });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: 'classifier_unavailable' });
  });
});

describe('OllamaClassifier request', () => {
  it('sends a JSON-schema format, no thinking, temperature 0', async () => {
    let sent: Record<string, unknown> = {};
    const fetchMock = makeFetchMock((_url, init) => {
      sent = JSON.parse(String(init?.body));
      return { message: { content: '{"topics":["Trabajo"],"emotions":[]}' } };
    });
    const c = new OllamaClassifier('http://ollama:11434', 'm', fetchMock as unknown as typeof fetch);
    const out = await c.classify({ text: 'curro', vocabulary: none, rejected: none });
    expect(out).toEqual({ topics: ['Trabajo'], emotions: [] });
    expect(fetchMock.urls[0]).toBe('http://ollama:11434/api/chat');
    expect(sent).toMatchObject({ model: 'm', stream: false, think: false, options: { temperature: 0 } });
    expect((sent.format as { required: string[] }).required).toEqual(['topics', 'emotions']);
  });
});
