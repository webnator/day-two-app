// Minimal async SQLite surface shared by expo-sqlite (app) and node:sqlite (tests).
export type Param = string | number | null;
export interface Db {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: Param[]): Promise<{ changes: number }>;
  all<T>(sql: string, params?: Param[]): Promise<T[]>;
  first<T>(sql: string, params?: Param[]): Promise<T | null>;
  /**
   * Runs `fn` inside an exclusive transaction with a handle bound to it; rolls back if it throws.
   * Other callers wait: nothing outside `fn` can interleave with the transaction.
   */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export const SCHEMA_VERSION = 3;

const V1 = `
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, rel_path TEXT NOT NULL, mime TEXT, size INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  local_time TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text','audio')),
  origin TEXT NOT NULL CHECK (origin IN ('written','recorded','imported')),
  title TEXT NOT NULL,
  title_auto INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL DEFAULT '',
  body_revision INTEGER NOT NULL DEFAULT 1,
  body_manual INTEGER NOT NULL DEFAULT 0,
  transcript_auto TEXT,
  transcript_alternative TEXT,
  transcript_language TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'none',
  audio_file_id TEXT REFERENCES files(id),
  audio_duration_ms INTEGER,
  waveform TEXT,
  context_at TEXT,
  geo_lat REAL,
  geo_lon REAL,
  city TEXT,
  temperature_c REAL,
  weather_condition TEXT,
  context_status TEXT NOT NULL DEFAULT 'none',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_day ON entries(day);
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('topic','emotion')), name TEXT NOT NULL, norm TEXT NOT NULL,
  UNIQUE(kind, norm)
);
CREATE TABLE IF NOT EXISTS entry_tags (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (origin IN ('suggested','manual')),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entry_id, tag_id)
);
CREATE TABLE IF NOT EXISTS tag_rejections (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, norm TEXT NOT NULL,
  PRIMARY KEY (entry_id, kind, norm)
);
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('link','image','video')),
  title TEXT NOT NULL,
  url TEXT,
  file_id TEXT REFERENCES files(id),
  status TEXT NOT NULL DEFAULT 'ready',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS day_photos (
  day TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id),
  local_time TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  width INTEGER, height INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY, day TEXT NOT NULL, prompt TEXT, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  resources_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  temp_uri TEXT NOT NULL,
  file_id TEXT REFERENCES files(id),
  mime TEXT NOT NULL DEFAULT 'audio/wav',
  waveform TEXT,
  day TEXT NOT NULL, started_at TEXT NOT NULL, time_zone TEXT NOT NULL, local_time TEXT NOT NULL,
  geo_lat REAL, geo_lon REAL, city TEXT, temperature_c REAL, weather_condition TEXT,
  context_status TEXT NOT NULL DEFAULT 'none',
  state TEXT NOT NULL DEFAULT 'recording'
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('transcribe','classify','context','remote-cancel')),
  entry_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT NOT NULL,
  remote_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (kind, entry_id, revision)
);
CREATE TABLE IF NOT EXISTS tombstones (kind TEXT NOT NULL, id TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY (kind, id));
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export async function migrate(db: Db): Promise<void> {
  await db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  const row = await db.first<{ user_version: number }>("PRAGMA user_version");
  const version = row?.user_version ?? 0;
  if (version < 1) {
    await db.exec(V1);
    await db.exec("PRAGMA user_version = 1");
  }
  if (version < 2) {
    await db.tx(async (tx) => {
      await tx.exec("ALTER TABLE entries ADD COLUMN transcript_uncertain TEXT;");
      await tx.exec("ALTER TABLE entries ADD COLUMN transcript_alternative_uncertain TEXT;");
      await tx.exec("PRAGMA user_version = 2");
    });
  }
  if (version < 3) {
    await db.tx(async tx => {
      await tx.exec(`CREATE TABLE IF NOT EXISTS sync_bases (entry_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, content TEXT);
        CREATE TABLE IF NOT EXISTS sync_conflicts (entry_id TEXT PRIMARY KEY, remote_json TEXT NOT NULL, fields_json TEXT NOT NULL);
        PRAGMA user_version = 3;`);
    });
  }
}

/** Serializes every statement on one connection; `tx` holds the lock for its whole scope. */
export function serialized(raw: Omit<Db, "tx">): Db {
  let tail: Promise<unknown> = Promise.resolve();
  const lock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
  const inner: Db = {
    exec: (s) => raw.exec(s),
    run: (s, p) => raw.run(s, p),
    all: (s, p) => raw.all(s, p),
    first: (s, p) => raw.first(s, p),
    tx: (fn) => fn(inner), // nested transactions join the outer one
  };
  return {
    exec: (s) => lock(() => raw.exec(s)),
    run: (s, p) => lock(() => raw.run(s, p)),
    all: (s, p) => lock(() => raw.all(s, p)),
    first: (s, p) => lock(() => raw.first(s, p)),
    tx: (fn) =>
      lock(async () => {
        await raw.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn(inner);
          await raw.exec("COMMIT");
          return result;
        } catch (e) {
          await raw.exec("ROLLBACK");
          throw e;
        }
      }),
  };
}
