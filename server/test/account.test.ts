import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { OTP } from '../src/auth/otp.js';
import { auth, listFiles, login, makeApp, uploadAudio, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeEach(async () => {
  ctx = await makeApp();
});
afterEach(async () => {
  ctx.app.queue.stop();
  await ctx.app.close();
});

it('DELETE /v1/account revokes every token and removes jobs, files and codes', async () => {
  let release!: () => void;
  ctx.transcriber.gate = new Promise((r) => (release = r));
  const a1 = await login(ctx, 'del@example.com');
  ctx.clock.advance(OTP.resendCooldownMs);
  const a2 = await login(ctx, 'del@example.com');
  const other = await login(ctx, 'keep@example.com');

  const inFlight = randomUUID();
  const queued = randomUUID();
  await uploadAudio(ctx, a1.token, inFlight);
  await uploadAudio(ctx, a1.token, queued);
  await ctx.app.inject({ method: 'POST', url: '/v1/classify', headers: auth(a1.token), payload: { jobId: randomUUID(), text: 'hola' } });
  ctx.clock.advance(OTP.resendCooldownMs);
  await ctx.app.inject({ method: 'POST', url: '/v1/account/email/request', headers: auth(a1.token), payload: { newEmail: 'pending@example.com' } });
  await new Promise((r) => setTimeout(r, 20));
  expect(listFiles(path.join(ctx.dataDir, 'audio', a1.userId))).toHaveLength(2);

  const del = await ctx.app.inject({ method: 'DELETE', url: '/v1/account', headers: auth(a1.token) });
  expect(del.statusCode).toBe(204);
  release();
  await ctx.app.queue.idle();

  for (const t of [a1.token, a2.token]) {
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(t) })).statusCode).toBe(401);
  }
  const count = (sql: string, ...p: unknown[]) => (ctx.db.prepare(sql).get(...p) as { n: number }).n;
  expect(count('SELECT COUNT(*) n FROM users WHERE id = ?', a1.userId)).toBe(0);
  expect(count('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', a1.userId)).toBe(0);
  expect(count('SELECT COUNT(*) n FROM transcription_jobs WHERE user_id = ?', a1.userId)).toBe(0);
  expect(count('SELECT COUNT(*) n FROM classifications WHERE user_id = ?', a1.userId)).toBe(0);
  expect(count('SELECT COUNT(*) n FROM otp_codes WHERE user_id = ?', a1.userId)).toBe(0);
  expect(listFiles(path.join(ctx.dataDir, 'audio', a1.userId))).toEqual([]);
  // The interrupted job never produced a result for the deleted account.
  expect(count('SELECT COUNT(*) n FROM transcription_jobs')).toBe(0);

  // Other accounts are untouched.
  expect((await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(other.token) })).statusCode).toBe(200);

  // Signing up again with the same email creates a fresh, empty account.
  ctx.clock.advance(OTP.resendCooldownMs);
  const again = await login(ctx, 'del@example.com');
  expect(again.userId).not.toBe(a1.userId);
});
