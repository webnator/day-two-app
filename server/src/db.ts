import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- One active code per (purpose, email_hash, user scope). email_hash = sha256(pepper|email).
CREATE TABLE IF NOT EXISTS otp_codes (
  purpose TEXT NOT NULL,            -- 'login' | 'email_change'
  email_hash TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '', -- owner for email_change, '' for login
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (purpose, email_hash, user_id)
);

-- Send log for cooldown and hourly limits. Only hashes, never raw email or IP.
CREATE TABLE IF NOT EXISTS otp_sends (
  email_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS otp_sends_email ON otp_sends(email_hash, at);
CREATE INDEX IF NOT EXISTS otp_sends_ip ON otp_sends(ip_hash, at);

CREATE TABLE IF NOT EXISTS transcription_jobs (
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL,             -- queued | processing | done | failed
  language_hint TEXT NOT NULL DEFAULT 'auto',
  audio_path TEXT,
  duration_sec REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (user_id, job_id)
);
CREATE INDEX IF NOT EXISTS transcription_jobs_status ON transcription_jobs(status);

CREATE TABLE IF NOT EXISTS classifications (
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, job_id)
);
`;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
