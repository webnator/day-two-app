import { Journal } from './journal';
import { normalize } from '../domain/rules';
import type { Entry } from '../domain/model';

export type SyncedEntry = Pick<Entry, 'id' | 'day' | 'createdAt' | 'timeZone' | 'localTime' | 'kind' | 'origin' | 'title' | 'titleAuto' | 'body' | 'contextStatus' | 'transcriptStatus'> & {
  tags: { kind: 'topic' | 'emotion'; name: string; origin: 'manual' | 'suggested' }[];
  city: string | null; temperatureC: number | null; weatherCondition: Entry['weatherCondition'] | null;
};
export interface RemoteChange { id: string; revision: number; sequence: number; updatedAt: string; entry: SyncedEntry | null }
export interface JournalSyncApi {
  changes(after: number): Promise<{ items: RemoteChange[]; cursor: number; hasMore: boolean }>;
  put(id: string, baseRevision: number, entry: SyncedEntry | null): Promise<RemoteChange>;
}
interface Base { revision: number; content: string | null }
export interface SyncConflict { id: string; local: SyncedEntry | null; remote: RemoteChange; fields: string[] }

export function projection(e: Entry | null): SyncedEntry | null {
  if (!e) return null;
  return { id: e.id, day: e.day, createdAt: e.createdAt, timeZone: e.timeZone, localTime: e.localTime, kind: e.kind, origin: e.origin,
    title: e.title, titleAuto: e.titleAuto, body: e.body, tags: e.tags.map(({ kind, name, origin }) => ({ kind, name, origin })),
    city: e.city ?? null, temperatureC: e.temperatureC ?? null, weatherCondition: e.weatherCondition ?? null,
    contextStatus: e.contextStatus, transcriptStatus: e.transcriptStatus };
}
// Stable across JSON object key order, including responses parsed by a different runtime.
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
const equal = (a: unknown, b: unknown) => stable(a) === stable(b);
export function mergeEntry(base: SyncedEntry | null, local: SyncedEntry | null, remote: SyncedEntry | null): { entry: SyncedEntry | null; conflicts: string[] } {
  if (equal(local, remote) || equal(local, base)) return { entry: remote, conflicts: [] };
  if (equal(remote, base)) return { entry: local, conflicts: [] };
  if (!base || !local || !remote) return { entry: local, conflicts: ['entry'] };
  const result = { ...local }, conflicts: string[] = [];
  for (const key of Object.keys(remote) as (keyof SyncedEntry)[]) {
    if (equal(local[key], base[key])) (result as Record<string, unknown>)[key] = remote[key];
    else if (!equal(remote[key], base[key]) && !equal(remote[key], local[key])) conflicts.push(key);
  }
  return { entry: result, conflicts };
}
const readBase = async (j: Journal, id: string): Promise<Base | null> => j.db.first<Base>('SELECT revision,content FROM sync_bases WHERE entry_id=?', [id]);
const saveBase = async (j: Journal, r: RemoteChange) => j.db.run(`INSERT INTO sync_bases VALUES (?,?,?) ON CONFLICT(entry_id) DO UPDATE SET revision=excluded.revision,content=excluded.content`, [r.id, r.revision, r.entry ? JSON.stringify(r.entry) : null]);

/** Updates only synchronized fields; every local audio, transcript alternative and attachment stays intact. */
async function applyProjection(j: Journal, id: string, entry: SyncedEntry | null, cleanup: (string | null | undefined)[]) {
  const existing = await j.entry(id);
  if (equal(projection(existing), entry)) return false;
  if (!entry) {
    if (existing) { cleanup.push(existing.audioFileId, ...existing.resources.map(r => r.fileId)); await j.deleteEntry(id, false); }
    return !!existing;
  }
  const bodyChanged = existing && existing.body !== entry.body;
  await j.db.run(`INSERT INTO entries(id,day,created_at,time_zone,local_time,kind,origin,title,title_auto,body,body_manual,transcript_status,city,temperature_c,weather_condition,context_status,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day,created_at=excluded.created_at,time_zone=excluded.time_zone,local_time=excluded.local_time,
    kind=excluded.kind,origin=excluded.origin,title=excluded.title,title_auto=excluded.title_auto,body=excluded.body,transcript_status=excluded.transcript_status,
    city=excluded.city,temperature_c=excluded.temperature_c,weather_condition=excluded.weather_condition,context_status=excluded.context_status,updated_at=excluded.updated_at`,
    [id, entry.day, entry.createdAt, entry.timeZone, entry.localTime, entry.kind, entry.origin, entry.title, +entry.titleAuto, entry.body,
      entry.transcriptStatus, entry.city, entry.temperatureC, entry.weatherCondition ?? null, entry.contextStatus, j.clock.now().toISOString()]);
  if (bodyChanged) await j.db.run('UPDATE entries SET body_revision=body_revision+1,body_manual=1,transcript_uncertain=NULL WHERE id=?', [id]);
  if (entry.contextStatus !== 'pending') await j.db.run('UPDATE entries SET geo_lat=NULL,geo_lon=NULL WHERE id=?', [id]);
  if (!equal(projection(existing)?.tags, entry.tags) || bodyChanged) {
    // Jobs already in flight cannot later overwrite the edited tags/body.
    await j.db.run("UPDATE jobs SET status='cancelled' WHERE entry_id=? AND kind='classify' AND status NOT IN ('done','cancelled')", [id]);
  }
  for (const old of existing?.tags ?? []) if (old.origin === 'suggested' && !entry.tags.some(t => t.kind === old.kind && normalize(t.name) === normalize(old.name)))
    await j.db.run('INSERT OR IGNORE INTO tag_rejections VALUES (?,?,?)', [id, old.kind, normalize(old.name)]);
  await j.db.run('DELETE FROM entry_tags WHERE entry_id=?', [id]);
  for (let index = 0; index < entry.tags.length; index++) {
    const t = entry.tags[index], key = normalize(t.name);
    await j.db.run('INSERT OR IGNORE INTO tags(id,kind,name,norm) VALUES (?,?,?,?)', [j.newId(), t.kind, t.name, key]);
    const tag = await j.db.first<{ id: string }>('SELECT id FROM tags WHERE kind=? AND norm=?', [t.kind, key]);
    await j.db.run('INSERT OR IGNORE INTO entry_tags(entry_id,tag_id,origin,position) VALUES (?,?,?,?)', [id, tag!.id, t.origin, index]);
  }
  await j.db.run("DELETE FROM tombstones WHERE kind='entry' AND id=?", [id]);
  return true;
}

export async function receiveChange(j: Journal, remote: RemoteChange, sent?: SyncedEntry | null): Promise<boolean> {
  const cleanup: (string | null | undefined)[] = [];
  const changed = await j.db.tx(async db => {
    const tx = new Journal(db, j.files, j.clock, j.newId), base = await readBase(tx, remote.id);
    if (base && base.revision >= remote.revision) return false;
    const local = projection(await tx.entry(remote.id));
    const merged = mergeEntry(sent === undefined ? (base?.content ? JSON.parse(base.content) : null) : sent, local, remote.entry);
    if (merged.conflicts.length) {
      await db.run('INSERT INTO sync_conflicts VALUES (?,?,?) ON CONFLICT(entry_id) DO UPDATE SET remote_json=excluded.remote_json,fields_json=excluded.fields_json', [remote.id, JSON.stringify(remote), JSON.stringify(merged.conflicts)]);
      return true;
    }
    const changed = await applyProjection(tx, remote.id, merged.entry, cleanup);
    await saveBase(tx, remote);
    await db.run('DELETE FROM sync_conflicts WHERE entry_id=?', [remote.id]);
    return changed;
  });
  // Delete physical files only after the transaction commits, never during a rollback.
  await j.collect(cleanup);
  return changed;
}

export async function syncJournal(j: Journal, api: JournalSyncApi, stopped = () => false): Promise<{ changed: boolean; conflicts: number }> {
  let changed = false;
  // Take each snapshot transactionally, but never hold the database while doing network I/O.
  const ids = await j.db.all<{ id: string }>("SELECT id FROM entries UNION SELECT id FROM tombstones WHERE kind='entry'");
  for (const { id } of ids) {
    if (stopped()) return { changed, conflicts: 0 };
    const snapshot = await j.db.tx(async db => {
      if (await db.first('SELECT 1 FROM sync_conflicts WHERE entry_id=?', [id])) return null;
      const tx = new Journal(db, j.files, j.clock, j.newId), entry = projection(await tx.entry(id)), base = await readBase(tx, id);
      if (equal(entry, base?.content ? JSON.parse(base.content) : null) && base) return null;
      return { entry, revision: base?.revision ?? 0 };
    });
    if (!snapshot) continue;
    try {
      const result = await api.put(id, snapshot.revision, snapshot.entry);
      if (stopped()) return { changed, conflicts: 0 };
      changed = (await receiveChange(j, result, snapshot.entry)) || changed;
    } catch (error) {
      const e = error as { status?: number; body?: { current?: RemoteChange } };
      if (e.status !== 409 || !e.body?.current) throw error;
      if (stopped()) return { changed, conflicts: 0 };
      changed = (await receiveChange(j, e.body.current)) || changed;
    }
  }
  let cursor = await j.get('sync.cursor', 0), more = true;
  while (more && !stopped()) {
    const page = await api.changes(cursor);
    if (stopped()) break;
    for (const r of page.items) changed = (await receiveChange(j, r)) || changed;
    await j.set('sync.cursor', page.cursor);
    if (page.hasMore && page.cursor <= cursor) throw new Error('invalid_sync_cursor');
    cursor = page.cursor; more = page.hasMore;
  }
  const count = await j.db.first<{ n: number }>('SELECT COUNT(*) n FROM sync_conflicts');
  return { changed, conflicts: count?.n ?? 0 };
}

export async function conflicts(j: Journal): Promise<SyncConflict[]> {
  const rows = await j.db.all<{ entry_id: string; remote_json: string; fields_json: string }>('SELECT * FROM sync_conflicts');
  return Promise.all(rows.map(async r => ({ id: r.entry_id, local: projection(await j.entry(r.entry_id)), remote: JSON.parse(r.remote_json), fields: JSON.parse(r.fields_json) })));
}
/** This is called only after the person explicitly chooses a version in Settings. */
export async function resolveConflict(j: Journal, id: string, choose: 'local' | 'remote') {
  const cleanup: (string | null | undefined)[] = [];
  await j.db.tx(async db => {
    const tx = new Journal(db, j.files, j.clock, j.newId);
    const row = await db.first<{ remote_json: string }>('SELECT remote_json FROM sync_conflicts WHERE entry_id=?', [id]);
    if (!row) return;
    const remote = JSON.parse(row.remote_json) as RemoteChange;
    if (choose === 'remote') await applyProjection(tx, id, remote.entry, cleanup);
    else if (!remote.entry && await tx.entry(id)) {
      // A tombstone cannot be revived. Keep the selected local version under a new ID,
      // including its local media and attachments, then acknowledge the deleted old ID.
      const newId = j.newId();
      const columns = (await db.all<{ name: string }>('PRAGMA table_info(entries)')).map(c => c.name).filter(c => c !== 'id');
      const names = columns.map(c => '"' + c.replaceAll('"', '""') + '"').join(',');
      await db.run(`INSERT INTO entries(id,${names}) SELECT ?,${names} FROM entries WHERE id=?`, [newId, id]);
      await db.run('INSERT INTO entry_tags SELECT ?,tag_id,origin,position FROM entry_tags WHERE entry_id=?', [newId, id]);
      await db.run('UPDATE resources SET entry_id=? WHERE entry_id=?', [newId, id]);
      await db.run('UPDATE jobs SET entry_id=? WHERE entry_id=?', [newId, id]);
      await db.run('UPDATE tag_rejections SET entry_id=? WHERE entry_id=?', [newId, id]);
      await applyProjection(tx, id, null, cleanup);
    }
    await saveBase(tx, remote);
    await db.run('DELETE FROM sync_conflicts WHERE entry_id=?', [id]);
  });
  await j.collect(cleanup);
}
