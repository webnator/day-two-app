import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { DestinationStream } from 'pino';
import { z } from 'zod';
import { OtpService } from './auth/otp.js';
import { SessionService } from './auth/sessions.js';
import { postValidate, type Classifier } from './classify/classifier.js';
import type { Config } from './config.js';
import { fetchWeatherAt, ReverseGeocoder, type ContextDeps } from './context/context.js';
import type { DB } from './db.js';
import { codeEmail, type Mailer } from './mail/mailer.js';
import type { Clock } from './lib/clock.js';
import { emailHash, logEmailRef, normalizeEmail, sha256Hex } from './lib/crypto.js';
import { HttpError } from './lib/errors.js';
import { loggerOptions } from './logging.js';
import { probeAudio } from './transcription/audio.js';
import { TranscriptionQueue } from './transcription/queue.js';
import type { Transcriber } from './transcription/transcriber.js';
import { JournalStore } from './journal/store.js';
import { OAuthService } from './mcp/oauth.js';
import { registerJournalRoutes } from './mcp/server.js';

export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const CLASSIFY_TTL_MS = 24 * 3_600_000;

export interface AppDeps {
  config: Config;
  db: DB;
  clock: Clock;
  mailer: Mailer;
  transcriber: Transcriber;
  classifier: Classifier;
  fetchImpl?: typeof fetch;
  logStream?: DestinationStream;
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    sessionToken: string;
  }
  interface FastifyInstance {
    queue: TranscriptionQueue;
    purgeAll(): Promise<void>;
  }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const emailSchema = z
  .string()
  .max(254)
  .transform(normalizeEmail)
  .refine((e) => EMAIL_RE.test(e));
const labels = z.array(z.string().max(80)).max(500).default([]);
const labelSets = z.object({ topics: labels, emotions: labels }).default({ topics: [], emotions: [] });

function parse<T extends z.ZodType>(schema: T, data: unknown, code = 'invalid_request'): z.output<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, code);
  return r.data;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, clock, mailer, transcriber, classifier } = deps;
  const app = Fastify({
    logger: loggerOptions(config.logLevel, deps.logStream),
    bodyLimit: 256 * 1024,
    // Per-IP code limits need the real client IP: enable only behind a trusted reverse proxy.
    trustProxy: config.trustProxy,
    genReqId: () => randomUUID().slice(0, 8),
  });
  const otp = new OtpService(db, clock, config.otpPepper);
  const sessions = new SessionService(db, clock);
  const journal = new JournalStore(db, clock);
  const oauth = new OAuthService(db, clock, config.publicBaseUrl, otp, mailer);
  const audioDir = path.join(config.dataDir, 'audio');
  const queue = new TranscriptionQueue(db, transcriber, clock, app.log, audioDir, config.transcribeConcurrency);
  const ctxDeps: ContextDeps = {
    fetchImpl: deps.fetchImpl ?? fetch,
    now: () => clock.now(),
    userAgent: config.nominatimUserAgent,
  };
  const geocoder = new ReverseGeocoder(ctxDeps);
  app.decorate('queue', queue);
  app.decorate('purgeAll', async () => {
    otp.purge();
    sessions.purge();
    oauth.purge();
    await queue.purge();
    db.prepare('DELETE FROM classifications WHERE created_at < ?').run(clock.now() - CLASSIFY_TTL_MS);
  });

  await app.register(multipart, {
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 5, fieldSize: 1024, parts: 6 },
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, ...err.extra });
    }
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({ error: 'too_large', maxBytes: MAX_AUDIO_BYTES });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: err.statusCode === 413 ? 'too_large' : 'invalid_request' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal' });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found' }));

  async function requireAuth(req: FastifyRequest) {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(h);
    const userId = m ? sessions.authenticate(m[1]!) : null;
    if (!m || !userId) throw new HttpError(401, 'unauthorized');
    req.userId = userId;
    req.sessionToken = m[1]!;
  }

  function getUser(id: string) {
    return db.prepare('SELECT id, email FROM users WHERE id = ?').get(id) as { id: string; email: string } | undefined;
  }

  async function sendCode(req: FastifyRequest, to: string, code: string, locale: 'es' | 'en', purpose: 'login' | 'email_change') {
    try {
      await mailer.send(codeEmail(to, code, locale, purpose));
      req.log.info({ emailRef: logEmailRef(config.otpPepper, to), purpose }, 'code sent');
    } catch (err) {
      req.log.error({ err, emailRef: logEmailRef(config.otpPepper, to) }, 'mail send failed');
      throw new HttpError(503, 'mail_unavailable');
    }
  }

  const codeResponse = { ok: true, resendAfter: 42, expiresIn: 600, codeLength: 6 };
  oauth.register(app);
  registerJournalRoutes(app, journal, oauth, requireAuth, classifier, clock);

  // ---------- Account ----------

  app.post('/v1/auth/request-code', async (req, reply) => {
    const body = parse(z.object({ email: z.unknown(), locale: z.enum(['es', 'en']).optional() }), req.body);
    const email = parse(emailSchema, body.email, 'invalid_email');
    const code = otp.issue('login', email, req.ip);
    // Same response and same work whether or not the account exists.
    await sendCode(req, email, code, body.locale ?? 'es', 'login');
    return reply.status(202).send(codeResponse);
  });

  app.post('/v1/auth/verify-code', async (req) => {
    const body = parse(z.object({ email: z.unknown(), code: z.string().max(32) }), req.body);
    const email = parse(emailSchema, body.email, 'invalid_email');
    otp.verify('login', email, body.code.trim());
    let user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email) as { id: string; email: string } | undefined;
    if (!user) {
      user = { id: randomUUID(), email };
      db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(user.id, email, clock.now());
    }
    const token = sessions.create(user.id);
    return { token, user };
  });

  app.get('/v1/me', { preHandler: requireAuth }, async (req) => {
    const user = getUser(req.userId);
    if (!user) throw new HttpError(401, 'unauthorized');
    return user;
  });

  app.post('/v1/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    sessions.revoke(req.sessionToken);
    return reply.status(204).send();
  });

  app.post('/v1/account/email/request', { preHandler: requireAuth }, async (req, reply) => {
    const body = parse(z.object({ newEmail: z.unknown(), locale: z.enum(['es', 'en']).optional() }), req.body);
    const newEmail = parse(emailSchema, body.newEmail, 'invalid_email');
    // Whether the address is taken is only revealed at verify time, to its verified owner.
    const code = otp.issue('email_change', newEmail, req.ip, req.userId);
    await sendCode(req, newEmail, code, body.locale ?? 'es', 'email_change');
    return reply.status(202).send(codeResponse);
  });

  app.post('/v1/account/email/verify', { preHandler: requireAuth }, async (req) => {
    const body = parse(z.object({ newEmail: z.unknown(), code: z.string().max(32) }), req.body);
    const newEmail = parse(emailSchema, body.newEmail, 'invalid_email');
    otp.verify('email_change', newEmail, body.code.trim(), req.userId);
    const owner = db.prepare('SELECT id FROM users WHERE email = ?').get(newEmail) as { id: string } | undefined;
    if (owner && owner.id !== req.userId) throw new HttpError(409, 'email_taken');
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(newEmail, req.userId);
    return { user: getUser(req.userId) };
  });

  app.delete('/v1/account', { preHandler: requireAuth }, async (req, reply) => {
    const user = getUser(req.userId);
    await queue.deleteUser(req.userId);
    db.transaction(() => {
      db.prepare('DELETE FROM classifications WHERE user_id = ?').run(req.userId);
      db.prepare('DELETE FROM otp_codes WHERE user_id = ?').run(req.userId);
      if (user) {
        db.prepare('DELETE FROM mcp_flows WHERE email = ?').run(user.email);
        db.prepare(`DELETE FROM otp_codes WHERE purpose IN ('login','mcp') AND email_hash = ?`).run(
          emailHash(config.otpPepper, user.email),
        );
      }
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.userId);
      db.prepare('DELETE FROM users WHERE id = ?').run(req.userId);
    })();
    req.log.info('account deleted');
    return reply.status(204).send();
  });

  // ---------- Transcription ----------

  app.post('/v1/transcriptions', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.isMultipart()) throw new HttpError(415, 'unsupported_media');
    const userDir = queue.userAudioDir(req.userId);
    await fsp.mkdir(userDir, { recursive: true });
    const tmpPath = path.join(userDir, `${randomUUID()}.upload`);
    const fields: Record<string, string> = {};
    let gotFile = false;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'audio' || gotFile) {
            part.file.resume();
            continue;
          }
          gotFile = true;
          await pipeline(part.file, fs.createWriteStream(tmpPath, { mode: 0o600 }));
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }
      const { jobId, languageHint } = parse(
        z.object({ jobId: z.string().uuid(), languageHint: z.enum(['es', 'en', 'auto']).default('auto') }),
        fields,
      );
      if (!gotFile) throw new HttpError(400, 'invalid_request');
      const existing = queue.get(req.userId, jobId);
      if (existing) {
        await fsp.rm(tmpPath, { force: true });
        return reply.status(202).send({ jobId, status: existing.status });
      }
      const probe = await probeAudio(config.ffprobeBin, tmpPath);
      if (!probe) throw new HttpError(415, 'unsupported_media');
      const finalPath = path.join(userDir, `${jobId}.audio`);
      await fsp.rename(tmpPath, finalPath);
      const { job, created } = queue.create(req.userId, jobId, finalPath, languageHint, probe.durationSec);
      if (!created) await fsp.rm(finalPath, { force: true });
      req.log.info({ job: jobId.slice(0, 8), format: probe.formatName, audioSec: Math.round(probe.durationSec) }, 'transcription queued');
      return reply.status(202).send({ jobId, status: job.status });
    } catch (err) {
      await fsp.rm(tmpPath, { force: true });
      throw err;
    }
  });

  app.get('/v1/transcriptions/:jobId', { preHandler: requireAuth }, async (req) => {
    const { jobId } = req.params as { jobId: string };
    const job = queue.get(req.userId, jobId);
    if (!job) throw new HttpError(404, 'not_found');
    return job;
  });

  app.delete('/v1/transcriptions/:jobId', { preHandler: requireAuth }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!(await queue.cancel(req.userId, jobId))) throw new HttpError(404, 'not_found');
    return reply.status(204).send();
  });

  // ---------- Classification ----------

  app.post('/v1/classify', { preHandler: requireAuth }, async (req) => {
    const body = parse(
      z.object({
        jobId: z.string().uuid(),
        text: z.string().min(1).max(20_000),
        language: z.string().max(10).nullish(),
        vocabulary: labelSets,
        rejected: labelSets,
      }),
      req.body,
    );
    const inputHash = sha256Hex(JSON.stringify([body.text, body.language ?? '', body.vocabulary, body.rejected]));
    const cached = db
      .prepare('SELECT input_hash, result_json FROM classifications WHERE user_id = ? AND job_id = ? AND created_at >= ?')
      .get(req.userId, body.jobId, clock.now() - CLASSIFY_TTL_MS) as { input_hash: string; result_json: string } | undefined;
    if (cached && cached.input_hash === inputHash) return JSON.parse(cached.result_json);

    let raw;
    try {
      raw = await classifier.classify({ ...body, language: body.language ?? undefined });
    } catch (err) {
      req.log.warn({ err, provider: classifier.name }, 'classifier failed');
      throw new HttpError(503, 'classifier_unavailable');
    }
    const result = { ...postValidate(raw, body), provider: classifier.name, model: classifier.model };
    db.prepare(
      `INSERT INTO classifications (user_id, job_id, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, job_id) DO UPDATE SET input_hash = excluded.input_hash, result_json = excluded.result_json, created_at = excluded.created_at`,
    ).run(req.userId, body.jobId, inputHash, JSON.stringify(result), clock.now());
    return result;
  });

  // ---------- Context ----------

  app.get('/v1/context', { preHandler: requireAuth }, async (req) => {
    const q = parse(
      z.object({
        lat: z.coerce.number().min(-90).max(90),
        lon: z.coerce.number().min(-180).max(180),
        at: z.string().datetime({ offset: true }),
      }),
      req.query,
    );
    const atMs = Date.parse(q.at);
    if (atMs > clock.now() + 3_600_000 || atMs < Date.UTC(1940, 0, 1)) throw new HttpError(400, 'invalid_request');
    // Enforce the ~1 km precision even if a client sends more.
    const lat = Math.round(q.lat * 100) / 100;
    const lon = Math.round(q.lon * 100) / 100;
    const lang = parseLang(req.headers['accept-language']);
    const [weather, city] = await Promise.all([
      fetchWeatherAt(ctxDeps, lat, lon, atMs).catch(() => ({})),
      geocoder.city(lat, lon, lang).catch(() => undefined),
    ]);
    return { ...(city ? { city } : {}), ...weather, source: 'open-meteo' };
  });

  app.get('/v1/health', async () => ({
    ok: true,
    transcriber: transcriber.name,
    classifier: classifier.name,
    mailer: mailer.name,
  }));

  return app;
}

function parseLang(h: string | undefined): string {
  const first = (h ?? 'es').split(',')[0]!.trim().slice(0, 5);
  return /^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/.test(first) ? first : 'es';
}
