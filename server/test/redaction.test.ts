import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { auth, login, makeApp, makeFetchMock, uploadAudio, type TestCtx } from './helpers.js';

let ctx: TestCtx;
afterEach(async () => {
  ctx.app.queue.stop();
  await ctx.app.close();
});

it('logs never contain emails, codes, tokens, transcripts, entry text or coordinates', async () => {
  const fetchMock = makeFetchMock((url) =>
    url.includes('nominatim') ? { address: { city: 'Madrid' } } : { hourly: { time: [], temperature_2m: [], weather_code: [] } },
  );
  ctx = await makeApp({ fetchMock });
  const email = 'Secret.Person@Example.com';
  ctx.transcriber.text = 'TRANSCRIPT-SENTINEL mi secreto';
  const { token } = await login(ctx, email);
  const code = ctx.mailer.lastCodeFor(email.toLowerCase())!;

  // Failed verify attempts with a body that shows up in parser errors.
  await ctx.app.inject({ method: 'POST', url: '/v1/auth/verify-code', payload: { email, code: '999999' } });
  await ctx.app.inject({ method: 'POST', url: '/v1/auth/verify-code', headers: { 'content-type': 'application/json' }, payload: `{"email":"${email}","code":"12` });
  await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) });
  const jobId = randomUUID();
  await uploadAudio(ctx, token, jobId);
  await ctx.app.queue.idle();
  await ctx.app.inject({ method: 'GET', url: `/v1/transcriptions/${jobId}`, headers: auth(token) });
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/classify',
    headers: auth(token),
    payload: { jobId: randomUUID(), text: 'ENTRY-SENTINEL hoy lloré', vocabulary: { topics: ['VOCAB-SENTINEL'], emotions: [] } },
  });
  ctx.classifier.classify = async () => {
    throw new Error('model echoed ENTRY-SENTINEL-2');
  };
  await ctx.app.inject({ method: 'POST', url: '/v1/classify', headers: auth(token), payload: { jobId: randomUUID(), text: 'ENTRY-SENTINEL-2' } });
  await ctx.app.inject({ method: 'GET', url: '/v1/context?lat=40.4168&lon=-3.7038&at=2026-10-04T10:00:00Z', headers: auth(token) });
  await ctx.app.inject({ method: 'POST', url: '/v1/account/email/request', headers: auth(token), payload: { newEmail: 'other.secret@example.com' } });
  await ctx.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: auth(token) });

  const logs = ctx.logs.text;
  expect(logs.length).toBeGreaterThan(1000); // logging is actually on (debug level)
  expect(logs).toContain('"emailRef"'); // hashed reference is what we log
  for (const secret of [
    email, email.toLowerCase(), 'secret.person', 'other.secret', code, token, token.slice(0, 16),
    'TRANSCRIPT-SENTINEL', 'ENTRY-SENTINEL', 'VOCAB-SENTINEL', '40.4168', '-3.7038', '40.42', '-3.7',
  ]) {
    expect(logs, `log leaked: ${secret}`).not.toContain(secret);
  }
  // Request lines keep the path but not the query string.
  expect(logs).toContain('"path":"/v1/context"');
});
