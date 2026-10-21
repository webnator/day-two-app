import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { ClassifyInput, Classifier, LabelSets } from '../src/classify/classifier.js';
import { loadConfig } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { FakeClock } from '../src/lib/clock.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import type { TranscribeInput, Transcriber, TranscriptionResult } from '../src/transcription/transcriber.js';

export class FakeTranscriber implements Transcriber {
  readonly name = 'fake';
  readonly model = 'fake-1';
  calls: TranscribeInput[] = [];
  /** When set, transcribe() waits for this promise (to observe in-flight states). */
  gate?: Promise<void>;
  fail = false;
  text = 'Hoy he ido al curro y estoy contento.';
  async transcribe(input: TranscribeInput): Promise<TranscriptionResult> {
    this.calls.push(input);
    if (this.gate) await this.gate;
    if (this.fail) throw new Error('boom');
    return {
      text: this.text,
      language: 'es',
      segments: [{ start: 0, end: 1, text: this.text, confidence: 0.9 }],
      uncertain: [],
      provider: this.name,
      model: this.model,
      durationSec: input.durationSec,
    };
  }
}

export class FakeClassifier implements Classifier {
  readonly name = 'fake';
  readonly model = 'fake-1';
  calls: ClassifyInput[] = [];
  next: LabelSets = { topics: ['Trabajo'], emotions: ['Alegría'] };
  async classify(input: ClassifyInput): Promise<LabelSets> {
    this.calls.push(input);
    return this.next;
  }
}

export class LogCapture extends Writable {
  lines: string[] = [];
  override _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.lines.push(chunk.toString());
    cb();
  }
  get text() {
    return this.lines.join('');
  }
}

export interface TestCtx {
  app: FastifyInstance;
  db: DB;
  clock: FakeClock;
  mailer: MemoryMailer;
  transcriber: FakeTranscriber;
  classifier: FakeClassifier;
  logs: LogCapture;
  dataDir: string;
  fetchMock: FetchMock;
}

export type FetchMock = ((url: string, init?: RequestInit) => Promise<Response>) & { urls: string[] };

export function makeFetchMock(handler: (url: string, init?: RequestInit) => unknown): FetchMock {
  const urls: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    const body = handler(String(url), init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as FetchMock;
  fn.urls = urls;
  return fn;
}

export async function makeApp(opts: { db?: DB; dataDir?: string; clock?: FakeClock; transcriber?: FakeTranscriber; fetchMock?: FetchMock } = {}): Promise<TestCtx> {
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'daytwo-test-'));
  const config = loadConfig({ DATA_DIR: dataDir, OTP_PEPPER: 'test-pepper-0123456789abcdef0123456789', LOG_LEVEL: 'debug' });
  const db = opts.db ?? openDb(':memory:');
  const clock = opts.clock ?? new FakeClock();
  const mailer = new MemoryMailer();
  const transcriber = opts.transcriber ?? new FakeTranscriber();
  const classifier = new FakeClassifier();
  const logs = new LogCapture();
  const fetchMock = opts.fetchMock ?? makeFetchMock(() => new Response('{}', { status: 500 }));
  const app = await buildApp({ config, db, clock, mailer, transcriber, classifier, logStream: logs, fetchImpl: fetchMock as unknown as typeof fetch });
  return { app, db, clock, mailer, transcriber, classifier, logs, dataDir, fetchMock };
}

export async function login(ctx: TestCtx, email: string, ip = '10.0.0.1'): Promise<{ token: string; userId: string }> {
  const r1 = await ctx.app.inject({ method: 'POST', url: '/v1/auth/request-code', payload: { email }, remoteAddress: ip });
  if (r1.statusCode !== 202) throw new Error(`request-code ${r1.statusCode} ${r1.body}`);
  const code = ctx.mailer.lastCodeFor(email.toLowerCase());
  const r2 = await ctx.app.inject({ method: 'POST', url: '/v1/auth/verify-code', payload: { email, code } });
  if (r2.statusCode !== 200) throw new Error(`verify ${r2.statusCode} ${r2.body}`);
  const body = r2.json() as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id };
}

export function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** 1 s of 16 kHz mono silence as a valid WAV file. */
export function silentWav(seconds = 1): Buffer {
  const rate = 16_000;
  const data = Buffer.alloc(rate * 2 * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export function multipart(fields: Record<string, string>, file?: { name: string; filename: string; data: Buffer; type?: string }) {
  const boundary = `----daytwo${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      file.data,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export async function uploadAudio(ctx: TestCtx, token: string, jobId: string, data = silentWav()) {
  const mp = multipart({ jobId, languageHint: 'auto' }, { name: 'audio', filename: 'a.wav', data, type: 'audio/wav' });
  return ctx.app.inject({ method: 'POST', url: '/v1/transcriptions', payload: mp.payload, headers: { ...mp.headers, ...auth(token) } });
}

export function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(d.parentPath, d.name));
}
