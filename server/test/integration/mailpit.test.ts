import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db.js';
import { systemClock } from '../../src/lib/clock.js';
import { SmtpMailer } from '../../src/mail/mailer.js';
import { waitForMailpitCode } from '../../scripts/lib/mailpit.js';
import { FakeClassifier, FakeTranscriber } from '../helpers.js';

// Real SMTP delivery to a local Mailpit (docker compose up -d). Reads SMTP_* / MAILPIT_URL from env.
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const config = loadConfig({ ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'daytwo-int-')), LOG_LEVEL: 'silent' });
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  const info = await fetch(`${MAILPIT}/api/v1/info`).catch(() => null);
  if (!info?.ok) throw new Error(`Mailpit not reachable at ${MAILPIT}: run docker compose up -d`);
  app = await buildApp({
    config, db: openDb(':memory:'), clock: systemClock, mailer: new SmtpMailer(config.smtp),
    transcriber: new FakeTranscriber(), classifier: new FakeClassifier(),
  });
});
afterAll(async () => app?.close());

it.each(['es', 'en'] as const)('delivers a real %s code email via SMTP and the code logs in', async (locale) => {
  const email = `int-${locale}-${randomUUID().slice(0, 8)}@daytwo.test`;
  const since = Date.now();
  const r = await app.inject({ method: 'POST', url: '/v1/auth/request-code', payload: { email, locale } });
  expect(r.statusCode).toBe(202);
  const mail = await waitForMailpitCode(MAILPIT, email, { sinceMs: since });
  expect(mail.subject).toBe(locale === 'es' ? 'Tu código de Day Two' : 'Your Day Two code');
  expect(mail.html).not.toMatch(/<img|https?:\/\//i); // no tracking pixels or links
  const v = await app.inject({ method: 'POST', url: '/v1/auth/verify-code', payload: { email, code: mail.code } });
  expect(v.statusCode).toBe(200);
  expect(v.json().user.email).toBe(email);
});
