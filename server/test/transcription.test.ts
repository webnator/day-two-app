import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_AUDIO_BYTES } from '../src/app.js';
import { openDb } from '../src/db.js';
import { FakeClock } from '../src/lib/clock.js';
import { RESULT_TTL_MS } from '../src/transcription/queue.js';
import { parseWhisperJson } from '../src/transcription/whisperCpp.js';
import { auth, FakeTranscriber, listFiles, login, makeApp, multipart, uploadAudio, type TestCtx } from './helpers.js';

const apps: TestCtx[] = [];
async function setup(opts: Parameters<typeof makeApp>[0] = {}) {
  const ctx = await makeApp(opts);
  apps.push(ctx);
  return ctx;
}
afterEach(async () => {
  for (const c of apps.splice(0)) {
    c.app.queue.stop();
    await c.app.close();
  }
});

const get = (ctx: TestCtx, token: string, jobId: string) =>
  ctx.app.inject({ method: 'GET', url: `/v1/transcriptions/${jobId}`, headers: auth(token) });

describe('transcription jobs', () => {
  it('processes a job, returns the result and deletes the audio', async () => {
    const ctx = await setup();
    const { token } = await login(ctx, 'a@example.com');
    const jobId = randomUUID();
    const r = await uploadAudio(ctx, token, jobId);
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ jobId, status: 'queued' });
    await ctx.app.queue.idle();
    const job = (await get(ctx, token, jobId)).json();
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ text: ctx.transcriber.text, language: 'es', provider: 'fake', model: 'fake-1' });
    expect(job.result.durationSec).toBeCloseTo(1, 1);
    expect(listFiles(path.join(ctx.dataDir, 'audio'))).toEqual([]);
  });

  it('is idempotent by jobId for the same user', async () => {
    const ctx = await setup();
    let release!: () => void;
    ctx.transcriber.gate = new Promise((r) => (release = r));
    const { token } = await login(ctx, 'a@example.com');
    const jobId = randomUUID();
    expect((await uploadAudio(ctx, token, jobId)).statusCode).toBe(202);
    const again = await uploadAudio(ctx, token, jobId);
    expect(again.statusCode).toBe(202);
    expect(again.json().jobId).toBe(jobId);
    release();
    await ctx.app.queue.idle();
    const third = await uploadAudio(ctx, token, jobId);
    expect(third.json()).toEqual({ jobId, status: 'done' });
    expect(ctx.transcriber.calls).toHaveLength(1);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM transcription_jobs').get()).toEqual({ n: 1 });
    expect(listFiles(path.join(ctx.dataDir, 'audio'))).toEqual([]); // duplicates discarded
  });

  it("isolates accounts: user B gets 404 for user A's job", async () => {
    const ctx = await setup();
    const a = await login(ctx, 'a@example.com');
    const b = await login(ctx, 'b@example.com');
    const jobId = randomUUID();
    await uploadAudio(ctx, a.token, jobId);
    await ctx.app.queue.idle();
    expect((await get(ctx, a.token, jobId)).statusCode).toBe(200);
    const rb = await get(ctx, b.token, jobId);
    expect(rb.statusCode).toBe(404);
    expect(rb.json()).toEqual({ error: 'not_found' });
    expect((await ctx.app.inject({ method: 'DELETE', url: `/v1/transcriptions/${jobId}`, headers: auth(b.token) })).statusCode).toBe(404);
    // Reusing A's jobId as B creates B's own job and never exposes A's result.
    ctx.transcriber.text = 'texto de B';
    await uploadAudio(ctx, b.token, jobId);
    await ctx.app.queue.idle();
    expect((await get(ctx, b.token, jobId)).json().result.text).toBe('texto de B');
    expect((await get(ctx, a.token, jobId)).json().result.text).not.toBe('texto de B');
  });

  it('requires authentication', async () => {
    const ctx = await setup();
    const mp = multipart({ jobId: randomUUID() }, { name: 'audio', filename: 'a.wav', data: Buffer.from('x') });
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/transcriptions', payload: mp.payload, headers: mp.headers });
    expect(r.statusCode).toBe(401);
  });

  it('rejects non-audio with 415 and leaves no file behind', async () => {
    const ctx = await setup();
    const { token } = await login(ctx, 'a@example.com');
    const r = await uploadAudio(ctx, token, randomUUID(), Buffer.from('definitely not audio'.repeat(100)));
    expect(r.statusCode).toBe(415);
    expect(r.json()).toEqual({ error: 'unsupported_media' });
    expect(listFiles(path.join(ctx.dataDir, 'audio'))).toEqual([]);
  });

  it('rejects files over 50 MB with 413', async () => {
    const ctx = await setup();
    const { token } = await login(ctx, 'a@example.com');
    const r = await uploadAudio(ctx, token, randomUUID(), Buffer.alloc(MAX_AUDIO_BYTES + 1024));
    expect(r.statusCode).toBe(413);
    expect(r.json()).toEqual({ error: 'too_large', maxBytes: MAX_AUDIO_BYTES });
    expect(listFiles(path.join(ctx.dataDir, 'audio'))).toEqual([]);
  });

  it('rejects a missing or invalid jobId', async () => {
    const ctx = await setup();
    const { token } = await login(ctx, 'a@example.com');
    expect((await uploadAudio(ctx, token, 'not-a-uuid')).statusCode).toBe(400);
  });

  it('failed jobs are retried once, then marked failed and audio is deleted', async () => {
    const ctx = await setup();
    ctx.transcriber.fail = true;
    const { token } = await login(ctx, 'a@example.com');
    const jobId = randomUUID();
    await uploadAudio(ctx, token, jobId);
    await ctx.app.queue.idle();
    expect((await get(ctx, token, jobId)).json()).toEqual({ jobId, status: 'failed', error: 'transcription_failed' });
    expect(ctx.transcriber.calls).toHaveLength(2);
    expect(listFiles(path.join(ctx.dataDir, 'audio'))).toEqual([]);
  });

  it('never publishes a repetitive hallucination as a successful transcript', async () => {
    const ctx = await setup();
    ctx.transcriber.text = 'La verdad, eh. '.repeat(500);
    const { token } = await login(ctx, 'a@example.com');
    const jobId = randomUUID();
    await uploadAudio(ctx, token, jobId);
    await ctx.app.queue.idle();
    expect((await get(ctx, token, jobId)).json()).toEqual({ jobId, status: 'failed', error: 'transcription_unreliable' });
    expect(ctx.transcriber.calls).toHaveLength(1); // repeating the same decode cannot establish fidelity
    expect(listFiles(path.join(ctx.dataDir, 'audio'))).toEqual([]);
  });

  it('DELETE cancels: removes audio and result', async () => {
    const ctx = await setup();
    let release!: () => void;
    ctx.transcriber.gate = new Promise((r) => (release = r));
    const { token } = await login(ctx, 'a@example.com');
    const jobId = randomUUID();
    await uploadAudio(ctx, token, jobId);
    await new Promise((r) => setTimeout(r, 20));
    expect(listFiles(path.join(ctx.dataDir, 'audio'))).toHaveLength(1);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/v1/transcriptions/${jobId}`, headers: auth(token) })).statusCode).toBe(204);
    release();
    await ctx.app.queue.idle();
    expect((await get(ctx, token, jobId)).statusCode).toBe(404);
    expect(listFiles(path.join(ctx.dataDir, 'audio'))).toEqual([]);
  });

  it('survives restart: queued/processing jobs are re-queued on boot', async () => {
    const dbFile = path.join((await import('node:os')).tmpdir(), `daytwo-restart-${randomUUID()}.db`);
    const clock = new FakeClock();
    const stuck = new FakeTranscriber();
    stuck.gate = new Promise(() => {}); // never finishes: simulates a crash mid-processing
    const first = await setup({ db: openDb(dbFile), clock, transcriber: stuck });
    const { token } = await login(first, 'a@example.com');
    const jobId = randomUUID();
    await uploadAudio(first, token, jobId);
    await new Promise((r) => setTimeout(r, 20));
    expect((await get(first, token, jobId)).json().status).toBe('processing');
    first.app.queue.stop();

    const second = await setup({ db: openDb(dbFile), clock, dataDir: first.dataDir });
    expect(second.app.queue.resume()).toBe(1);
    await second.app.queue.idle();
    const job = (await get(second, token, jobId)).json();
    expect(job.status).toBe('done');
    expect(second.transcriber.calls).toHaveLength(1);
    expect(listFiles(path.join(first.dataDir, 'audio'))).toEqual([]);
  });

  it('purges results after 24 h', async () => {
    const ctx = await setup();
    const { token } = await login(ctx, 'a@example.com');
    const jobId = randomUUID();
    await uploadAudio(ctx, token, jobId);
    await ctx.app.queue.idle();
    ctx.clock.advance(RESULT_TTL_MS - 1000);
    await ctx.app.purgeAll();
    expect((await get(ctx, token, jobId)).statusCode).toBe(200);
    ctx.clock.advance(2000);
    await ctx.app.purgeAll();
    // Session is still valid (sliding); only the job is gone.
    expect((await get(ctx, token, jobId)).statusCode).toBe(404);
  });
});

describe('whisper.cpp JSON parsing', () => {
  it('builds segments, confidence and merged uncertain spans', () => {
    const tok = (text: string, p: number, from: number, to: number) => ({ text, p, offsets: { from, to } });
    const parsed = parseWhisperJson({
      result: { language: 'es' },
      transcription: [
        {
          offsets: { from: 0, to: 2000 },
          text: ' No creo que vaya.',
          tokens: [tok('[_BEG_]', 0.99, 0, 0), tok(' No', 0.98, 0, 300), tok(' creo', 0.3, 300, 600), tok(' que', 0.2, 650, 800), tok(' vaya', 0.9, 800, 1500), tok('.', 0.99, 1500, 1600)],
        },
        { offsets: { from: 2000, to: 3000 }, text: '   ', tokens: [] },
      ],
    });
    expect(parsed.language).toBe('es');
    expect(parsed.text).toBe('No creo que vaya.');
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]!.confidence).toBeCloseTo((0.98 + 0.3 + 0.2 + 0.9 + 0.99) / 5, 3);
    expect(parsed.uncertain).toEqual([{ start: 0.3, end: 0.8 }]);
  });
});
