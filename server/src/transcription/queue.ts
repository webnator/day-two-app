import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { DB } from '../db.js';
import type { Clock } from '../lib/clock.js';
import { NotConfiguredError } from '../lib/errors.js';
import type { LanguageHint, Transcriber, TranscriptionResult } from './transcriber.js';
import { assertTranscriptQuality, TranscriptionQualityError } from './quality.js';

export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';
export const RESULT_TTL_MS = 24 * 3_600_000;
const MAX_ATTEMPTS = 2;

interface JobRow {
  user_id: string;
  job_id: string;
  status: JobStatus;
  language_hint: LanguageHint;
  audio_path: string | null;
  duration_sec: number;
  attempts: number;
  result_json: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface JobView {
  jobId: string;
  status: JobStatus;
  result?: TranscriptionResult;
  error?: string;
}

export class TranscriptionQueue {
  private pending: { userId: string; jobId: string }[] = [];
  private running = new Map<string, AbortController>();
  private idleWaiters: (() => void)[] = [];
  private stopped = false;

  constructor(
    private db: DB,
    private transcriber: Transcriber,
    private clock: Clock,
    private log: FastifyBaseLogger,
    private audioDir: string,
    private concurrency: number,
  ) {}

  userAudioDir(userId: string) {
    return path.join(this.audioDir, userId);
  }

  get(userId: string, jobId: string): JobView | null {
    const row = this.row(userId, jobId);
    return row ? view(row) : null;
  }

  /**
   * Idempotent create. Returns the existing job if (userId, jobId) already exists, in which case
   * the caller must discard the uploaded file.
   */
  create(userId: string, jobId: string, audioPath: string, languageHint: LanguageHint, durationSec: number): { job: JobView; created: boolean } {
    const now = this.clock.now();
    const res = this.db
      .prepare(
        `INSERT INTO transcription_jobs (user_id, job_id, status, language_hint, audio_path, duration_sec, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?) ON CONFLICT (user_id, job_id) DO NOTHING`,
      )
      .run(userId, jobId, languageHint, audioPath, durationSec, now, now);
    const created = res.changes === 1;
    if (created) this.enqueue(userId, jobId);
    return { job: this.get(userId, jobId)!, created };
  }

  /** Logical cancellation: stops work, deletes audio and result. */
  async cancel(userId: string, jobId: string): Promise<boolean> {
    const row = this.row(userId, jobId);
    if (!row) return false;
    this.running.get(key(userId, jobId))?.abort();
    this.pending = this.pending.filter((p) => !(p.userId === userId && p.jobId === jobId));
    this.db.prepare('DELETE FROM transcription_jobs WHERE user_id = ? AND job_id = ?').run(userId, jobId);
    if (row.audio_path) await fs.rm(row.audio_path, { force: true });
    return true;
  }

  /** Cancels every job of a user and removes their audio directory. */
  async deleteUser(userId: string): Promise<void> {
    for (const [k, ctrl] of this.running) if (k.startsWith(`${userId}/`)) ctrl.abort();
    this.pending = this.pending.filter((p) => p.userId !== userId);
    this.db.prepare('DELETE FROM transcription_jobs WHERE user_id = ?').run(userId);
    await fs.rm(this.userAudioDir(userId), { recursive: true, force: true });
  }

  /** Re-queues jobs that were queued or interrupted mid-processing before a restart. */
  resume(): number {
    this.db.prepare(`UPDATE transcription_jobs SET status = 'queued' WHERE status = 'processing'`).run();
    const rows = this.db
      .prepare(`SELECT user_id, job_id FROM transcription_jobs WHERE status = 'queued' ORDER BY created_at`)
      .all() as { user_id: string; job_id: string }[];
    for (const r of rows) this.enqueue(r.user_id, r.job_id);
    return rows.length;
  }

  /** Deletes finished results older than 24 h and orphaned work/audio older than 24 h. */
  async purge(): Promise<number> {
    const cutoff = this.clock.now() - RESULT_TTL_MS;
    const stale = this.db
      .prepare(
        `SELECT user_id, job_id, audio_path FROM transcription_jobs
         WHERE (finished_at IS NOT NULL AND finished_at < ?) OR (finished_at IS NULL AND created_at < ?)`,
      )
      .all(cutoff, cutoff) as { user_id: string; job_id: string; audio_path: string | null }[];
    for (const r of stale) {
      this.running.get(key(r.user_id, r.job_id))?.abort();
      this.db.prepare('DELETE FROM transcription_jobs WHERE user_id = ? AND job_id = ?').run(r.user_id, r.job_id);
      if (r.audio_path) await fs.rm(r.audio_path, { force: true });
    }
    await this.sweepOrphanFiles(cutoff);
    return stale.length;
  }

  stop() {
    this.stopped = true;
    for (const c of this.running.values()) c.abort();
  }

  /** Resolves when nothing is pending or running (tests and smoke). */
  idle(): Promise<void> {
    if (!this.pending.length && !this.running.size) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private enqueue(userId: string, jobId: string) {
    if (this.running.has(key(userId, jobId))) return;
    if (this.pending.some((p) => p.userId === userId && p.jobId === jobId)) return;
    this.pending.push({ userId, jobId });
    queueMicrotask(() => this.pump());
  }

  private pump() {
    while (!this.stopped && this.running.size < this.concurrency && this.pending.length) {
      const next = this.pending.shift()!;
      const ctrl = new AbortController();
      this.running.set(key(next.userId, next.jobId), ctrl);
      void this.process(next.userId, next.jobId, ctrl.signal)
        .catch((err) => {
          this.log.error({ err, job: next.jobId.slice(0, 8) }, 'queue error');
          return false;
        })
        .then((retry) => {
          this.running.delete(key(next.userId, next.jobId));
          if (retry && !this.stopped) this.pending.push(next);
          this.pump();
          if (!this.pending.length && !this.running.size) this.idleWaiters.splice(0).forEach((r) => r());
        });
    }
  }

  /** Returns true when the job should be retried. Never throws. */
  private async process(userId: string, jobId: string, signal: AbortSignal): Promise<boolean> {
    const row = this.row(userId, jobId);
    if (!row || row.status !== 'queued') return false;
    const now = this.clock.now();
    this.db
      .prepare(`UPDATE transcription_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE user_id = ? AND job_id = ?`)
      .run(now, userId, jobId);
    const started = Date.now();
    const durationSec = row.duration_sec;
    try {
      if (!row.audio_path) throw new Error('audio_missing');
      const result = await this.transcriber.transcribe({
        audioPath: row.audio_path,
        languageHint: row.language_hint,
        durationSec,
        signal,
        ref: { userId, jobId },
      });
      if (signal.aborted) return false;
      assertTranscriptQuality(result);
      this.finish(userId, jobId, 'done', JSON.stringify(result), null);
      this.log.info(
        { job: jobId.slice(0, 8), provider: result.provider, audioSec: round1(durationSec), ms: Date.now() - started },
        'transcription done',
      );
      return false;
    } catch (err) {
      if (signal.aborted) return false;
      const code = err instanceof NotConfiguredError ? 'not_configured'
        : err instanceof TranscriptionQualityError ? 'transcription_unreliable' : 'transcription_failed';
      // Log only the error class/code: stderr of tools could echo file paths, never content.
      this.log.warn({ job: jobId.slice(0, 8), errCode: code, attempt: row.attempts + 1, errName: (err as Error).name }, 'transcription error');
      if (code !== 'not_configured' && code !== 'transcription_unreliable' && row.attempts + 1 < MAX_ATTEMPTS && row.audio_path) {
        this.db
          .prepare(`UPDATE transcription_jobs SET status = 'queued', updated_at = ? WHERE user_id = ? AND job_id = ?`)
          .run(this.clock.now(), userId, jobId);
        return true;
      }
      this.finish(userId, jobId, 'failed', null, code);
      return false;
    } finally {
      // Audio is deleted as soon as the job reaches a terminal state (or was cancelled).
      const after = this.row(userId, jobId);
      if (row.audio_path && (!after || after.status === 'done' || after.status === 'failed')) {
        await fs.rm(row.audio_path, { force: true });
      }
    }
  }

  private finish(userId: string, jobId: string, status: 'done' | 'failed', resultJson: string | null, error: string | null) {
    const now = this.clock.now();
    this.db
      .prepare(
        `UPDATE transcription_jobs SET status = ?, result_json = ?, error = ?, audio_path = NULL, updated_at = ?, finished_at = ?
         WHERE user_id = ? AND job_id = ?`,
      )
      .run(status, resultJson, error, now, now, userId, jobId);
  }

  private row(userId: string, jobId: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM transcription_jobs WHERE user_id = ? AND job_id = ?').get(userId, jobId) as JobRow | undefined;
  }

  private async sweepOrphanFiles(cutoff: number) {
    const referenced = new Set(
      (this.db.prepare('SELECT audio_path FROM transcription_jobs WHERE audio_path IS NOT NULL').all() as { audio_path: string }[]).map(
        (r) => r.audio_path,
      ),
    );
    let users: string[] = [];
    try {
      users = await fs.readdir(this.audioDir);
    } catch {
      return;
    }
    for (const u of users) {
      const dir = path.join(this.audioDir, u);
      for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
        const p = path.join(dir, f);
        const st = await fs.stat(p).catch(() => null);
        if (st && !referenced.has(p) && st.mtimeMs < cutoff) await fs.rm(p, { force: true });
      }
    }
  }
}

function key(userId: string, jobId: string) {
  return `${userId}/${jobId}`;
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function view(row: JobRow): JobView {
  const v: JobView = { jobId: row.job_id, status: row.status };
  if (row.status === 'done' && row.result_json) v.result = JSON.parse(row.result_json) as TranscriptionResult;
  if (row.status === 'failed' && row.error) v.error = row.error;
  return v;
}
