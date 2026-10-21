import { describe, expect, it } from "vitest";
import { migrate, SCHEMA_VERSION } from "../data/db";
import { makeJournal } from "./helpers";

describe("transcription metadata migration", () => {
  it("upgrades an existing v1 journal without altering text, files, jobs or preferences", async () => {
    const { j, db } = await makeJournal();
    await j.commitDraft({ id: "entry", day: "2026-10-05", prompt: null, title: "Original", body: "Mi texto intacto", resources: [] }, { title: "Original", auto: false });
    await db.run("INSERT INTO kv (key, value) VALUES (?, ?)", ["setting", '"es"']);
    await db.exec("ALTER TABLE entries DROP COLUMN transcript_uncertain; ALTER TABLE entries DROP COLUMN transcript_alternative_uncertain; PRAGMA user_version = 1;");
    const before = await db.all<Record<string, unknown>>("SELECT * FROM entries");
    const jobs = await db.all("SELECT * FROM jobs");
    await migrate(db);
    await migrate(db); // repeated startup is safe
    const after = await db.all<Record<string, unknown>>("SELECT * FROM entries");
    const { transcript_uncertain, transcript_alternative_uncertain, ...preserved } = after[0];
    expect(preserved).toEqual(before[0]);
    expect(transcript_uncertain).toBeNull();
    expect(transcript_alternative_uncertain).toBeNull();
    expect(await db.all("SELECT * FROM jobs")).toEqual(jobs);
    expect(await db.first("SELECT value FROM kv WHERE key = 'setting'")).toEqual({ value: '"es"' });
    expect(await db.first("PRAGMA user_version")).toEqual({ user_version: SCHEMA_VERSION });
  });
});
