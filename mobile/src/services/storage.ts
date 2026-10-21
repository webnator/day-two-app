import { Directory, File, Paths } from "expo-file-system";
import * as LegacyFS from "expo-file-system/legacy";
import * as SQLite from "expo-sqlite";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { migrate, serialized, type Db } from "../data/db";
import { Journal, type Clock, type FileStore } from "../data/journal";
import { currentTimeZone } from "../domain/dates";
import type { User } from "./api";

/** Media of one account under Documents/accounts/<userId>/ (never in cache: the OS must not evict originals). */
export class NativeFileStore implements FileStore {
  constructor(private root: Directory) {}
  async put(srcUri: string, relPath: string, move = false): Promise<number> {
    const dest = new File(this.root, relPath);
    const dir = dest.parentDirectory;
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    if (!new File(srcUri).exists) throw new Error("source_missing");
    // Streamed native copy/move (works for large originals and on both platforms).
    if (move) await LegacyFS.moveAsync({ from: srcUri, to: dest.uri });
    else await LegacyFS.copyAsync({ from: srcUri, to: dest.uri });
    const written = new File(this.root, relPath);
    if (!written.exists) throw new Error("write_failed");
    return written.size ?? 0;
  }
  async remove(relPath: string) {
    const f = new File(this.root, relPath);
    if (f.exists) f.delete();
  }
  uri(relPath: string) {
    return new File(this.root, relPath).uri;
  }
  exists(relPath: string) {
    return new File(this.root, relPath).exists;
  }
}

export function accountDir(userId: string): Directory {
  return new Directory(Paths.document, "accounts", userId);
}

export const systemClock: Clock = { now: () => new Date(), timeZone: currentTimeZone };

function wrap(raw: SQLite.SQLiteDatabase): Db {
  return serialized({
    exec: (sql) => raw.execAsync(sql),
    run: async (sql, params = []) => {
      const r = await raw.runAsync(sql, params as SQLite.SQLiteBindParams);
      return { changes: r.changes };
    },
    all: (sql, params = []) => raw.getAllAsync(sql, params as SQLite.SQLiteBindParams) as any,
    first: (sql, params = []) => raw.getFirstAsync(sql, params as SQLite.SQLiteBindParams) as any,
  });
}

const open = new Map<string, { raw: SQLite.SQLiteDatabase; journal: Journal }>();

export async function openJournal(userId: string, clock: Clock = systemClock): Promise<Journal> {
  const cached = open.get(userId);
  if (cached) return cached.journal;
  const dir = accountDir(userId);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const raw = await SQLite.openDatabaseAsync("journal.db", {}, dir.uri.replace(/^file:\/\//, ""));
  const db = wrap(raw);
  await migrate(db);
  const journal = new Journal(db, new NativeFileStore(dir), clock, () => Crypto.randomUUID());
  open.set(userId, { raw, journal });
  return journal;
}

export async function closeJournal(userId: string) {
  const o = open.get(userId);
  if (!o) return;
  open.delete(userId);
  await o.raw.closeAsync();
}

/** Removes every local trace of an account: database, originals, photos, resources. */
export async function wipeAccount(userId: string) {
  await closeJournal(userId);
  const dir = accountDir(userId);
  if (dir.exists) dir.delete();
}

// ---------------------------------------------------------------- session (Keychain / Keystore)

export interface Session {
  token: string;
  user: User;
}
const SESSION_KEY = "daytwo.session";
const PREFS_KEY = "daytwo.prefs";

export async function loadSession(): Promise<Session | null> {
  try {
    const v = await SecureStore.getItemAsync(SESSION_KEY);
    return v ? (JSON.parse(v) as Session) : null;
  } catch {
    return null;
  }
}
export async function saveSession(s: Session | null) {
  if (s) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(s), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  else await SecureStore.deleteItemAsync(SESSION_KEY);
}

export interface DevicePrefs {
  lang?: "es" | "en";
  lastEmail?: string;
}
export async function loadPrefs(): Promise<DevicePrefs> {
  try {
    return JSON.parse((await SecureStore.getItemAsync(PREFS_KEY)) || "{}");
  } catch {
    return {};
  }
}
export async function savePrefs(p: DevicePrefs) {
  await SecureStore.setItemAsync(PREFS_KEY, JSON.stringify(p));
}
