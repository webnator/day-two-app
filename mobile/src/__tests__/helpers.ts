import { DatabaseSync } from "node:sqlite";
import { migrate, serialized, type Db } from "../data/db";
import { Journal, type FileStore } from "../data/journal";

export function memoryDb(): Db {
  const raw = new DatabaseSync(":memory:");
  return serialized({
    exec: async (sql) => void raw.exec(sql),
    run: async (sql, params = []) => {
      const r = raw.prepare(sql).run(...(params as any[]));
      return { changes: Number(r.changes) };
    },
    all: async (sql, params = []) => raw.prepare(sql).all(...(params as any[])) as any,
    first: async (sql, params = []) => (raw.prepare(sql).get(...(params as any[])) as any) ?? null,
  });
}

export class MemoryFiles implements FileStore {
  stored = new Map<string, string>();
  failNextPut = false;
  async put(src: string, rel: string) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("disk full");
    }
    this.stored.set(rel, src);
    return src.length;
  }
  async remove(rel: string) {
    this.stored.delete(rel);
  }
  uri(rel: string) {
    return "mem://" + rel;
  }
  exists(rel: string) {
    return this.stored.has(rel);
  }
}

export class TestClock {
  constructor(public t = new Date("2026-10-05T19:06:00Z"), public zone = "Europe/Madrid") {}
  now() {
    return new Date(this.t);
  }
  timeZone() {
    return this.zone;
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export async function makeJournal() {
  const db = memoryDb();
  await migrate(db);
  const files = new MemoryFiles();
  const clock = new TestClock();
  let n = 0;
  const j = new Journal(db, files, clock, () => `id${++n}`);
  return { j, db, files, clock };
}
