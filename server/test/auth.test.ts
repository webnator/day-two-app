import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OTP } from '../src/auth/otp.js';
import { SESSION_TTL_MS } from '../src/auth/sessions.js';
import { auth, login, makeApp, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeEach(async () => {
  ctx = await makeApp();
});
afterEach(async () => {
  await ctx.app.close();
});

const request = (email: string, ip = '10.0.0.1', locale?: string) =>
  ctx.app.inject({ method: 'POST', url: '/v1/auth/request-code', payload: { email, ...(locale ? { locale } : {}) }, remoteAddress: ip });
const verify = (email: string, code: string | undefined) =>
  ctx.app.inject({ method: 'POST', url: '/v1/auth/verify-code', payload: { email, code } });

describe('request-code', () => {
  it('returns the contract body and emails a 6-digit code', async () => {
    const r = await request('Ana@Example.com');
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ ok: true, resendAfter: 42, expiresIn: 600, codeLength: 6 });
    const mail = ctx.mailer.sent[0]!;
    expect(mail.to).toBe('ana@example.com');
    expect(mail.subject).toBe('Tu código de Day Two');
    expect(mail.subject).not.toMatch(/\d{6}/);
    expect(mail.text).toMatch(/\b\d{6}\b/);
    expect(mail.html).not.toMatch(/<img|https?:\/\//);
  });

  it('sends English email when locale=en', async () => {
    await request('en@example.com', '10.0.0.1', 'en');
    expect(ctx.mailer.sent[0]!.subject).toBe('Your Day Two code');
  });

  it('rejects syntactically invalid email', async () => {
    const r = await request('not-an-email');
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'invalid_email' });
  });

  it('does not reveal whether an account exists', async () => {
    await login(ctx, 'exists@example.com');
    ctx.clock.advance(OTP.resendCooldownMs + 1);
    const a = await request('exists@example.com');
    const b = await request('nobody@example.com');
    expect(a.statusCode).toBe(b.statusCode);
    expect(a.body).toBe(b.body);
  });

  it('stores codes only as hashes (no plaintext email or code)', async () => {
    await request('hash@example.com');
    const code = ctx.mailer.lastCodeFor('hash@example.com')!;
    const dump = JSON.stringify([ctx.db.prepare('SELECT * FROM otp_codes').all(), ctx.db.prepare('SELECT * FROM otp_sends').all()]);
    expect(dump).not.toContain('hash@example.com');
    expect(dump).not.toContain(code);
  });

  it('enforces the 42 s resend cooldown', async () => {
    await request('cool@example.com');
    ctx.clock.advance(10_000);
    const r = await request('cool@example.com');
    expect(r.statusCode).toBe(429);
    expect(r.json()).toEqual({ error: 'rate_limited', retryAfter: 32 });
    ctx.clock.advance(32_000);
    expect((await request('cool@example.com')).statusCode).toBe(202);
  });

  it('limits 5 sends per email per hour', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await request('five@example.com', `10.0.1.${i}`)).statusCode).toBe(202);
      ctx.clock.advance(OTP.resendCooldownMs);
    }
    const r = await request('five@example.com', '10.0.2.1');
    expect(r.statusCode).toBe(429);
    expect(r.json().retryAfter).toBeGreaterThan(0);
    ctx.clock.advance(3_600_000);
    expect((await request('five@example.com')).statusCode).toBe(202);
  });

  it('limits 20 sends per IP per hour', async () => {
    for (let i = 0; i < 20; i++) expect((await request(`ip${i}@example.com`, '10.9.9.9')).statusCode).toBe(202);
    expect((await request('ip20@example.com', '10.9.9.9')).statusCode).toBe(429);
    expect((await request('ip20@example.com', '10.9.9.10')).statusCode).toBe(202);
  });
});

describe('verify-code', () => {
  it('valid code creates the account, returns token + user, and is single-use', async () => {
    await request('new@example.com');
    const code = ctx.mailer.lastCodeFor('new@example.com')!;
    const r = await verify('NEW@example.com', code);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.user.email).toBe('new@example.com');
    expect(body.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.token.length).toBeGreaterThanOrEqual(43);
    const me = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(body.token) });
    expect(me.json()).toEqual(body.user);
    expect((await verify('new@example.com', code)).statusCode).toBe(400);
  });

  it('same path for sign-up and sign-in keeps the user id stable', async () => {
    const a = await login(ctx, 'stable@example.com');
    ctx.clock.advance(OTP.resendCooldownMs);
    const b = await login(ctx, 'stable@example.com');
    expect(b.userId).toBe(a.userId);
    expect(b.token).not.toBe(a.token);
  });

  it('incomplete code is invalid and does not consume an attempt', async () => {
    await request('inc@example.com');
    for (let i = 0; i < 10; i++) {
      const r = await verify('inc@example.com', '123');
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: 'invalid_code' });
    }
    expect((await verify('inc@example.com', ctx.mailer.lastCodeFor('inc@example.com'))).statusCode).toBe(200);
  });

  it('wrong code -> invalid_code; after 5 attempts -> too_many_attempts even with the right code', async () => {
    await request('wrong@example.com');
    const code = ctx.mailer.lastCodeFor('wrong@example.com')!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < OTP.maxAttempts; i++) {
      const r = await verify('wrong@example.com', wrong);
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: 'invalid_code' });
    }
    const r = await verify('wrong@example.com', code);
    expect(r.statusCode).toBe(429);
    expect(r.json()).toEqual({ error: 'too_many_attempts' });
    // A new code resets the attempt budget.
    ctx.clock.advance(OTP.resendCooldownMs);
    await request('wrong@example.com');
    expect((await verify('wrong@example.com', ctx.mailer.lastCodeFor('wrong@example.com'))).statusCode).toBe(200);
  });

  it('expired code -> 410 (injected clock)', async () => {
    await request('exp@example.com');
    const code = ctx.mailer.lastCodeFor('exp@example.com')!;
    ctx.clock.advance(OTP.ttlMs);
    const r = await verify('exp@example.com', code);
    expect(r.statusCode).toBe(410);
    expect(r.json()).toEqual({ error: 'expired_code' });
  });

  it('code still valid just before expiry', async () => {
    await request('edge@example.com');
    ctx.clock.advance(OTP.ttlMs - 1);
    expect((await verify('edge@example.com', ctx.mailer.lastCodeFor('edge@example.com'))).statusCode).toBe(200);
  });

  it('a new code invalidates the previous one', async () => {
    await request('two@example.com');
    const first = ctx.mailer.lastCodeFor('two@example.com')!;
    ctx.clock.advance(OTP.resendCooldownMs);
    await request('two@example.com');
    const second = ctx.mailer.lastCodeFor('two@example.com')!;
    if (first !== second) expect((await verify('two@example.com', first)).statusCode).toBe(400);
    expect((await verify('two@example.com', second)).statusCode).toBe(200);
  });

  it('no code requested -> invalid_code (no disclosure)', async () => {
    expect((await verify('ghost@example.com', '123456')).json()).toEqual({ error: 'invalid_code' });
  });
});

describe('sessions', () => {
  it('rejects missing or unknown tokens', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth('x'.repeat(43)) })).statusCode).toBe(401);
  });

  it('stores only the sha256 of tokens', async () => {
    const { token } = await login(ctx, 'tok@example.com');
    const dump = JSON.stringify(ctx.db.prepare('SELECT * FROM sessions').all());
    expect(dump).not.toContain(token);
  });

  it('logout revokes the current token only', async () => {
    const a = await login(ctx, 'out@example.com');
    ctx.clock.advance(OTP.resendCooldownMs);
    const b = await login(ctx, 'out@example.com');
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: auth(a.token) })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(a.token) })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(b.token) })).statusCode).toBe(200);
  });

  it('90-day sliding expiry', async () => {
    const { token } = await login(ctx, 'slide@example.com');
    const me = () => ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) });
    ctx.clock.advance(SESSION_TTL_MS - 60_000);
    expect((await me()).statusCode).toBe(200); // slides
    ctx.clock.advance(SESSION_TTL_MS - 60_000);
    expect((await me()).statusCode).toBe(200);
    ctx.clock.advance(SESSION_TTL_MS);
    expect((await me()).statusCode).toBe(401);
  });
});

describe('email change', () => {
  it('verifies the new address before switching', async () => {
    const { token, userId } = await login(ctx, 'old@example.com');
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/account/email/request', headers: auth(token), payload: { newEmail: 'New@Example.com' } });
    expect(r.statusCode).toBe(202);
    const code = ctx.mailer.lastCodeFor('new@example.com')!;
    expect(ctx.mailer.sent.at(-1)!.subject).toBe('Confirma tu nuevo email en Day Two');
    const bad = await ctx.app.inject({ method: 'POST', url: '/v1/account/email/verify', headers: auth(token), payload: { newEmail: 'new@example.com', code: code === '000000' ? '111111' : '000000' } });
    expect(bad.statusCode).toBe(400);
    const ok = await ctx.app.inject({ method: 'POST', url: '/v1/account/email/verify', headers: auth(token), payload: { newEmail: 'new@example.com', code } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ user: { id: userId, email: 'new@example.com' } });
    // Login code for the new address now reaches the same account.
    ctx.clock.advance(OTP.resendCooldownMs);
    expect((await login(ctx, 'new@example.com')).userId).toBe(userId);
  });

  it('another user cannot use a code issued to someone else', async () => {
    const a = await login(ctx, 'a@example.com');
    const b = await login(ctx, 'b@example.com');
    await ctx.app.inject({ method: 'POST', url: '/v1/account/email/request', headers: auth(a.token), payload: { newEmail: 'c@example.com' } });
    const code = ctx.mailer.lastCodeFor('c@example.com')!;
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/account/email/verify', headers: auth(b.token), payload: { newEmail: 'c@example.com', code } });
    expect(r.statusCode).toBe(400);
  });

  it('409 email_taken when the new address belongs to another account', async () => {
    const a = await login(ctx, 'taken-a@example.com');
    await login(ctx, 'taken-b@example.com');
    ctx.clock.advance(OTP.resendCooldownMs); // cooldown is per address, across purposes
    await ctx.app.inject({ method: 'POST', url: '/v1/account/email/request', headers: auth(a.token), payload: { newEmail: 'taken-b@example.com' } });
    const code = ctx.mailer.lastCodeFor('taken-b@example.com')!;
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/account/email/verify', headers: auth(a.token), payload: { newEmail: 'taken-b@example.com', code } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'email_taken' });
  });
});
