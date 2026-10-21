import { z } from 'zod';
import type { DB } from '../db.js';
import type { Clock } from '../lib/clock.js';
import { HttpError } from '../lib/errors.js';
import { isDeepStrictEqual } from 'node:util';

export const norm = (s: string) => s.normalize('NFKC').trim().toLocaleLowerCase('es');

export const entryId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
});
export const timeZone = z.string().max(80).refine(s => {
  try { new Intl.DateTimeFormat('en', { timeZone: s }); return true; } catch { return false; }
});
export const tagSchema = z.object({
  kind: z.enum(['topic', 'emotion']), name: z.string().trim().min(1).max(80), origin: z.enum(['manual', 'suggested']),
});
// An explicit allowlist: no file paths, recordings, GPS coordinates or credentials cross sync.
export const entrySchema = z.object({
  id: entryId, day, createdAt: z.string().datetime({ offset: true }), timeZone,
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  kind: z.enum(['text', 'audio']), origin: z.enum(['written', 'recorded', 'imported']),
  title: z.string().max(500), titleAuto: z.boolean(), body: z.string().max(200_000),
  tags: z.array(tagSchema).max(100).transform(tags => {
    const unique = new Map<string, z.infer<typeof tagSchema>>();
    for (const t of tags) {
      const key = t.kind + ':' + norm(t.name);
      if (!unique.has(key) || t.origin === 'manual') unique.set(key, t);
    }
    return [...unique.values()];
  }),
  city: z.string().max(200).nullable(), temperatureC: z.number().min(-100).max(100).nullable(),
  weatherCondition: z.enum(['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'rain', 'snow', 'storm']).nullable(),
  contextStatus: z.enum(['none', 'pending', 'resolved', 'unavailable', 'removed']),
  transcriptStatus: z.enum(['none', 'pending', 'offline', 'processing', 'ready', 'error']),
}).strict();
export type JournalEntry = z.infer<typeof entrySchema>;
export interface Change { id: string; revision: number; sequence: number; updatedAt: string; entry: JournalEntry | null }
interface Row { id: string; revision: number; sequence: number; updated_at: string; content: string | null }
export const periodSchema = z.object({ start: day, end: day }).refine(x => x.start <= x.end && (Date.parse(x.end) - Date.parse(x.start)) <= 3660 * 86400000, 'Range must be ordered and at most ten years');

export function migrateJournal(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal_clock (id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL);
    INSERT OR IGNORE INTO journal_clock VALUES (1,0);
    CREATE TABLE IF NOT EXISTS journal_entries (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL, revision INTEGER NOT NULL, sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL, day TEXT, content TEXT,
      PRIMARY KEY(user_id,id)
    );
    CREATE INDEX IF NOT EXISTS journal_user_sequence ON journal_entries(user_id,sequence);
    CREATE INDEX IF NOT EXISTS journal_user_day ON journal_entries(user_id,day);
    CREATE TABLE IF NOT EXISTS journal_creations (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, input_hash TEXT NOT NULL, entry_id TEXT NOT NULL,
      PRIMARY KEY(user_id,request_id)
    );
  `);
}

export class JournalStore {
  constructor(readonly db: DB, private clock: Clock) { migrateJournal(db); }
  private decode(row: Row): Change {
    return { id: row.id, revision: row.revision, sequence: row.sequence, updatedAt: row.updated_at, entry: row.content ? JSON.parse(row.content) as JournalEntry : null };
  }
  get(user: string, id: string): Change | null {
    const row = this.db.prepare('SELECT * FROM journal_entries WHERE user_id=? AND id=?').get(user, id) as Row | undefined;
    return row ? this.decode(row) : null;
  }
  put(user: string, id: string, baseRevision: number, entry: JournalEntry | null): Change {
    if (entry) entry = entrySchema.parse(entry);
    if (entry && entry.id !== id) throw new HttpError(400, 'id_mismatch');
    return this.db.transaction(() => {
      const cur = this.get(user, id);
      // Retried writes with an identical payload do not bump revisions or resurrect tombstones.
      if (cur && isDeepStrictEqual(cur.entry, entry)) return cur;
      if ((cur?.revision ?? 0) !== baseRevision) throw new HttpError(409, 'revision_conflict', { current: cur });
      if (cur && !cur.entry && entry) throw new HttpError(409, 'entry_deleted', { current: cur });
      const seq = this.db.prepare('UPDATE journal_clock SET sequence=sequence+1 WHERE id=1 RETURNING sequence').get() as { sequence: number };
      const now = new Date(this.clock.now()).toISOString();
      this.db.prepare(`INSERT INTO journal_entries(user_id,id,revision,sequence,updated_at,day,content) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(user_id,id) DO UPDATE SET revision=excluded.revision,sequence=excluded.sequence,updated_at=excluded.updated_at,day=excluded.day,content=excluded.content`)
        .run(user, id, (cur?.revision ?? 0) + 1, seq.sequence, now, entry?.day ?? null, entry ? JSON.stringify(entry) : null);
      return this.get(user, id)!;
    })();
  }
  changes(user: string, after: number, limit = 100) {
    const rows = this.db.prepare('SELECT * FROM journal_entries WHERE user_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(user, after, limit + 1) as Row[];
    const hasMore = rows.length > limit, items = rows.slice(0, limit).map(r => this.decode(r));
    return { items, cursor: items.at(-1)?.sequence ?? after, hasMore };
  }
  inPeriod(user: string, start: string, end: string): Change[] {
    return (this.db.prepare('SELECT * FROM journal_entries WHERE user_id=? AND day>=? AND day<=? AND content IS NOT NULL ORDER BY day,id').all(user, start, end) as Row[]).map(r => this.decode(r));
  }
  coverage(user: string) {
    const row = this.db.prepare('SELECT COUNT(content) entries, MIN(day) firstDay, MAX(day) lastDay, MAX(updated_at) lastChangeAt FROM journal_entries WHERE user_id=?').get(user);
    return { ...(row as object), media: 'Audio and photos remain on the phone. Only synced entries are included.' };
  }
}
