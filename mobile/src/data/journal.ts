import type { Db, Param } from "./db";
import type { DayKey } from "../domain/dates";
import type {
  ContextStatus, DayPhoto, Draft, DraftResource, Entry, EntryOrigin, EntryTag, Resource, TagKind, TagOrigin,
  TranscriptSpan, TranscriptStatus, WeatherCondition,
} from "../domain/model";
import { decideTranscript, mergeSuggestions, normalize, type Suggestions } from "../domain/rules";

/** Physical media storage owned by one account. Paths are relative to the account folder. */
export interface FileStore {
  put(srcUri: string, relPath: string, move?: boolean): Promise<number>;
  remove(relPath: string): Promise<void>;
  uri(relPath: string): string;
  exists(relPath: string): boolean;
}

export interface Clock {
  now(): Date;
  timeZone(): string;
}
export type IdGen = () => string;

type Row = Record<string, any>;

export interface ContextSnapshot {
  lat?: number | null;
  lon?: number | null;
  city?: string | null;
  temperatureC?: number | null;
  condition?: WeatherCondition | null;
  status: ContextStatus;
}

export interface JobRow {
  id: string;
  kind: "transcribe" | "classify" | "context" | "remote-cancel";
  entry_id: string;
  revision: number;
  status: "queued" | "running" | "remote" | "done" | "failed" | "cancelled";
  attempts: number;
  next_run_at: string;
  remote_id: string | null;
  last_error: string | null;
}

export class Journal {
  constructor(
    readonly db: Db,
    readonly files: FileStore,
    readonly clock: Clock,
    readonly newId: IdGen,
  ) {}

  /** Runs `fn` in one exclusive transaction with a repository bound to it. */
  private inTx<T>(fn: (j: Journal) => Promise<T>): Promise<T> {
    return this.db.tx((db) => fn(new Journal(db, this.files, this.clock, this.newId)));
  }

  private iso() {
    return this.clock.now().toISOString();
  }

  // ---------- files & references ----------

  /** Copies (or moves) a picked/recorded file into account storage and registers it. Not yet referenced. */
  async importFile(srcUri: string, folder: string, ext: string, mime: string, move = false): Promise<{ id: string; relPath: string }> {
    const id = this.newId();
    const relPath = `${folder}/${id}${ext}`;
    const size = await this.files.put(srcUri, relPath, move);
    await this.db.run("INSERT INTO files (id, rel_path, mime, size, created_at) VALUES (?,?,?,?,?)", [id, relPath, mime, size, this.iso()]);
    return { id, relPath };
  }

  async fileUri(fileId: string | null | undefined): Promise<string | null> {
    if (!fileId) return null;
    const f = await this.db.first<{ rel_path: string }>("SELECT rel_path FROM files WHERE id = ?", [fileId]);
    return f ? this.files.uri(f.rel_path) : null;
  }

  async referenceCount(fileId: string): Promise<number> {
    const r = await this.db.first<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM entries WHERE audio_file_id = ?)
            + (SELECT COUNT(*) FROM resources WHERE file_id = ?)
            + (SELECT COUNT(*) FROM day_photos WHERE file_id = ?)
            + (SELECT COUNT(*) FROM recordings WHERE file_id = ?)
            + (SELECT COUNT(*) FROM drafts WHERE instr(resources_json, ?) > 0) AS n`,
      [fileId, fileId, fileId, fileId, fileId],
    );
    return r?.n ?? 0;
  }

  /** Physically deletes the given files once nothing references them any more. */
  async collect(fileIds: (string | null | undefined)[]): Promise<string[]> {
    const removed: string[] = [];
    for (const id of new Set(fileIds.filter(Boolean) as string[])) {
      if ((await this.referenceCount(id)) > 0) continue;
      const f = await this.db.first<{ rel_path: string }>("SELECT rel_path FROM files WHERE id = ?", [id]);
      if (!f) continue;
      await this.files.remove(f.rel_path);
      await this.db.run("DELETE FROM files WHERE id = ?", [id]);
      removed.push(id);
    }
    return removed;
  }

  /** Orphans left by abandoned edit sessions (picked but never saved), older than `olderThanMs`. */
  async sweepOrphans(olderThanMs = 24 * 3600 * 1000): Promise<string[]> {
    const limit = new Date(this.clock.now().getTime() - olderThanMs).toISOString();
    const rows = await this.db.all<{ id: string }>("SELECT id FROM files WHERE created_at < ?", [limit]);
    return this.collect(rows.map((r) => r.id));
  }

  // ---------- reading ----------

  private async hydrate(rows: Row[]): Promise<Entry[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => "?").join(",");
    const tags = await this.db.all<Row>(
      `SELECT et.entry_id, t.id, t.kind, t.name, et.origin FROM entry_tags et JOIN tags t ON t.id = et.tag_id
       WHERE et.entry_id IN (${marks}) ORDER BY et.position, t.name`,
      ids,
    );
    const res = await this.db.all<Row>(
      `SELECT r.*, f.rel_path FROM resources r LEFT JOIN files f ON f.id = r.file_id WHERE r.entry_id IN (${marks}) ORDER BY r.position, r.created_at`,
      ids,
    );
    const audio = await this.db.all<Row>(
      `SELECT f.id, f.rel_path FROM files f WHERE f.id IN (SELECT audio_file_id FROM entries WHERE id IN (${marks}))`,
      ids,
    );
    return rows.map((r) => ({
      id: r.id,
      day: r.day,
      createdAt: r.created_at,
      timeZone: r.time_zone,
      localTime: r.local_time,
      kind: r.kind,
      origin: r.origin,
      title: r.title,
      titleAuto: !!r.title_auto,
      body: r.body,
      bodyRevision: r.body_revision,
      bodyManual: !!r.body_manual,
      transcriptAuto: r.transcript_auto,
      transcriptAlternative: r.transcript_alternative,
      transcriptUncertain: r.transcript_uncertain ? JSON.parse(r.transcript_uncertain) : [],
      transcriptAlternativeUncertain: r.transcript_alternative_uncertain ? JSON.parse(r.transcript_alternative_uncertain) : [],
      transcriptLanguage: r.transcript_language,
      transcriptStatus: r.transcript_status,
      audioFileId: r.audio_file_id,
      audioUri: (() => {
        const f = audio.find((a) => a.id === r.audio_file_id);
        return f ? this.files.uri(f.rel_path) : null;
      })(),
      audioDurationMs: r.audio_duration_ms,
      waveform: r.waveform ? JSON.parse(r.waveform) : null,
      city: r.city,
      temperatureC: r.temperature_c,
      weatherCondition: r.weather_condition,
      contextStatus: r.context_status,
      updatedAt: r.updated_at,
      tags: tags.filter((t) => t.entry_id === r.id).map((t) => ({ id: t.id, kind: t.kind, name: t.name, origin: t.origin })),
      resources: res
        .filter((x) => x.entry_id === r.id)
        .map((x) => ({
          id: x.id, entryId: x.entry_id, kind: x.kind, title: x.title, url: x.url, fileId: x.file_id,
          fileUri: x.rel_path ? this.files.uri(x.rel_path) : null, status: x.status, position: x.position,
        })),
    }));
  }

  async entry(id: string): Promise<Entry | null> {
    const r = await this.db.first<Row>("SELECT * FROM entries WHERE id = ?", [id]);
    return r ? (await this.hydrate([r]))[0] : null;
  }

  async entriesForDay(day: DayKey): Promise<Entry[]> {
    return this.hydrate(await this.db.all<Row>("SELECT * FROM entries WHERE day = ? ORDER BY local_time, created_at", [day]));
  }

  async allEntries(): Promise<Entry[]> {
    return this.hydrate(await this.db.all<Row>("SELECT * FROM entries ORDER BY day DESC, local_time DESC"));
  }

  async photo(day: DayKey): Promise<DayPhoto | null> {
    const r = await this.db.first<Row>(
      "SELECT p.*, f.rel_path FROM day_photos p JOIN files f ON f.id = p.file_id WHERE p.day = ?",
      [day],
    );
    return r ? { day: r.day, fileId: r.file_id, uri: this.files.uri(r.rel_path), localTime: r.local_time, width: r.width, height: r.height } : null;
  }

  async photos(): Promise<DayPhoto[]> {
    const rows = await this.db.all<Row>("SELECT p.*, f.rel_path FROM day_photos p JOIN files f ON f.id = p.file_id ORDER BY p.day DESC");
    return rows.map((r) => ({ day: r.day, fileId: r.file_id, uri: this.files.uri(r.rel_path), localTime: r.local_time, width: r.width, height: r.height }));
  }

  async monthMarkers(prefix: string): Promise<{ entries: Set<DayKey>; photos: Set<DayKey> }> {
    const e = await this.db.all<{ day: string }>("SELECT DISTINCT day FROM entries WHERE day LIKE ?", [prefix + "%"]);
    const p = await this.db.all<{ day: string }>("SELECT day FROM day_photos WHERE day LIKE ?", [prefix + "%"]);
    return { entries: new Set(e.map((r) => r.day)), photos: new Set(p.map((r) => r.day)) };
  }

  async daysWithContent(): Promise<DayKey[]> {
    const rows = await this.db.all<{ day: string }>("SELECT day FROM entries UNION SELECT day FROM day_photos ORDER BY day DESC");
    return rows.map((r) => r.day);
  }

  async tagCatalog(kind?: TagKind): Promise<{ id: string; kind: TagKind; name: string }[]> {
    return kind
      ? this.db.all("SELECT id, kind, name FROM tags WHERE kind = ? ORDER BY name", [kind])
      : this.db.all("SELECT id, kind, name FROM tags ORDER BY kind, name");
  }

  async rejections(entryId: string): Promise<{ kind: TagKind; norm: string }[]> {
    return this.db.all("SELECT kind, norm FROM tag_rejections WHERE entry_id = ?", [entryId]);
  }

  // ---------- drafts ----------

  async draft(): Promise<Draft | null> {
    const r = await this.db.first<Row>("SELECT * FROM drafts ORDER BY updated_at DESC LIMIT 1");
    return r ? { id: r.id, day: r.day, prompt: r.prompt, title: r.title, body: r.body, resources: JSON.parse(r.resources_json), updatedAt: r.updated_at } : null;
  }

  async saveDraft(d: Omit<Draft, "updatedAt">): Promise<void> {
    await this.db.run(
      `INSERT INTO drafts (id, day, prompt, title, body, resources_json, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET day=excluded.day, prompt=excluded.prompt, title=excluded.title, body=excluded.body,
       resources_json=excluded.resources_json, updated_at=excluded.updated_at`,
      [d.id, d.day, d.prompt ?? null, d.title, d.body, JSON.stringify(d.resources), this.iso()],
    );
  }

  /** Explicit discard: removes the draft and the media only it referenced. */
  async discardDraft(id: string): Promise<void> {
    const d = await this.db.first<Row>("SELECT resources_json FROM drafts WHERE id = ?", [id]);
    await this.db.run("DELETE FROM drafts WHERE id = ?", [id]);
    if (d) await this.collect((JSON.parse(d.resources_json) as DraftResource[]).map((r) => r.fileId));
  }

  // ---------- entries ----------

  private async upsertTag(kind: TagKind, name: string): Promise<string> {
    const norm = normalize(name);
    const found = await this.db.first<{ id: string }>("SELECT id FROM tags WHERE kind = ? AND norm = ?", [kind, norm]);
    if (found) return found.id;
    const id = this.newId();
    await this.db.run("INSERT INTO tags (id, kind, name, norm) VALUES (?,?,?,?)", [id, kind, name.trim(), norm]);
    return id;
  }

  private async writeResources(entryId: string, resources: DraftResource[]) {
    let position = 0;
    for (const r of resources) {
      await this.db.run(
        `INSERT INTO resources (id, entry_id, kind, title, url, file_id, status, position, created_at) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, url=excluded.url, status=excluded.status, position=excluded.position`,
        [r.id, entryId, r.kind, r.title, r.url ?? null, r.fileId ?? null, r.status, position++, this.iso()],
      );
    }
  }

  /**
   * Turns the draft into an entry exactly once: the entry id is the draft id, so a double tap
   * or a retried save never creates a second entry.
   */
  async commitDraft(draft: Omit<Draft, "updatedAt">, title: { title: string; auto: boolean }): Promise<{ id: string; created: boolean }> {
    const now = this.clock.now();
    const created = await this.inTx(async (j) => {
      const exists = await j.db.first("SELECT 1 FROM entries WHERE id = ?", [draft.id]);
      if (exists) {
        await j.db.run("DELETE FROM drafts WHERE id = ?", [draft.id]);
        return false;
      }
      const localTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      await j.db.run(
        `INSERT INTO entries (id, day, created_at, time_zone, local_time, kind, origin, title, title_auto, body, body_revision, body_manual,
          transcript_status, context_status, updated_at) VALUES (?,?,?,?,?,'text','written',?,?,?,1,1,'none','none',?)`,
        [draft.id, draft.day, now.toISOString(), this.clock.timeZone(), localTime, title.title, title.auto ? 1 : 0, draft.body, now.toISOString()],
      );
      await j.writeResources(draft.id, draft.resources);
      await j.db.run("DELETE FROM drafts WHERE id = ?", [draft.id]);
      if (draft.body.trim() || title.title.trim()) await j.enqueue("classify", draft.id, 1);
      return true;
    });
    return { id: draft.id, created };
  }

  /**
   * Registers an in-progress recording before the first audio frame is written, pointing at the
   * recorder's temporary file, so an interrupted recording can be recovered on next launch.
   */
  async beginRecording(r: { id: string; tempUri: string; mime: string; day: DayKey; startedAt: Date; timeZone: string; localTime: string }) {
    await this.db.run(
      "INSERT INTO recordings (id, temp_uri, mime, day, started_at, time_zone, local_time, state) VALUES (?,?,?,?,?,?,?, 'recording')",
      [r.id, r.tempUri, r.mime, r.day, r.startedAt.toISOString(), r.timeZone, r.localTime],
    );
  }

  /** Moves the finished recorder file into account storage and links it to the recording. */
  async attachRecordingFile(id: string, ext: string, waveform?: number[] | null): Promise<string> {
    const r = await this.db.first<Row>("SELECT temp_uri, mime, file_id FROM recordings WHERE id = ?", [id]);
    if (!r) throw new Error("recording_not_found");
    if (r.file_id) return r.file_id;
    const f = await this.importFile(r.temp_uri, "audio", ext, r.mime, true);
    await this.db.run("UPDATE recordings SET file_id = ?, waveform = ? WHERE id = ?", [f.id, waveform ? JSON.stringify(waveform) : null, id]);
    return f.id;
  }

  async setRecordingContext(id: string, c: ContextSnapshot) {
    await this.db.run(
      "UPDATE recordings SET geo_lat=?, geo_lon=?, city=?, temperature_c=?, weather_condition=?, context_status=? WHERE id = ?",
      [c.lat ?? null, c.lon ?? null, c.city ?? null, c.temperatureC ?? null, c.condition ?? null, c.status, id],
    );
  }

  async openRecordings(): Promise<Row[]> {
    return this.db.all<Row>("SELECT r.*, f.rel_path FROM recordings r LEFT JOIN files f ON f.id = r.file_id");
  }

  /** Converts a finished (or recovered) recording into an audio entry; idempotent by recording id. */
  async finishRecording(recordingId: string, durationMs: number, title: string): Promise<string> {
    return this.inTx(async (j) => {
      const r = await j.db.first<Row>("SELECT * FROM recordings WHERE id = ?", [recordingId]);
      if (!r) {
        const existing = await j.db.first<{ id: string }>("SELECT id FROM entries WHERE id = ?", [recordingId]);
        if (existing) return existing.id;
        throw new Error("recording_not_found");
      }
      if (!r.file_id) throw new Error("recording_file_missing");
      const now = this.iso();
      const hasGeo = r.geo_lat != null && r.geo_lon != null;
      const contextStatus: ContextStatus =
        r.context_status === "resolved" ? "resolved" : hasGeo ? "pending" : r.context_status === "unavailable" ? "unavailable" : "none";
      await j.db.run(
        `INSERT INTO entries (id, day, created_at, time_zone, local_time, kind, origin, title, title_auto, body, body_revision, body_manual,
          transcript_status, audio_file_id, audio_duration_ms, waveform, context_at, geo_lat, geo_lon, city, temperature_c, weather_condition, context_status, updated_at)
         VALUES (?,?,?,?,?,'audio','recorded',?,1,'',1,0,'pending',?,?,?,?,?,?,?,?,?,?,?)`,
        [recordingId, r.day, r.started_at, r.time_zone, r.local_time, title, r.file_id, durationMs, r.waveform, r.started_at,
          contextStatus === "resolved" ? null : r.geo_lat, contextStatus === "resolved" ? null : r.geo_lon,
          r.city, r.temperature_c, r.weather_condition, contextStatus, now],
      );
      await j.db.run("DELETE FROM recordings WHERE id = ?", [recordingId]);
      await j.enqueue("transcribe", recordingId, 1);
      if (contextStatus === "pending") await j.enqueue("context", recordingId, 0);
      return recordingId;
    });
  }

  /** Explicit discard: deletes the temporary file and anything already moved into storage. */
  async discardRecording(recordingId: string, deleteTemp: (uri: string) => void): Promise<void> {
    const r = await this.db.first<{ file_id: string | null; temp_uri: string }>("SELECT file_id, temp_uri FROM recordings WHERE id = ?", [recordingId]);
    await this.db.run("DELETE FROM recordings WHERE id = ?", [recordingId]);
    if (!r) return;
    try {
      deleteTemp(r.temp_uri);
    } catch {}
    await this.collect([r.file_id]);
  }

  /** Imported audio: original kept; no capture context (import location/time is not the recording's). */
  async createImportedAudio(input: { id: string; fileId: string; day: DayKey; durationMs: number | null; title: string }): Promise<string> {
    const now = this.clock.now();
    const localTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    await this.inTx(async (j) => {
      if (await j.db.first("SELECT 1 FROM entries WHERE id = ?", [input.id])) return;
      await j.db.run(
        `INSERT INTO entries (id, day, created_at, time_zone, local_time, kind, origin, title, title_auto, body, body_revision, body_manual,
          transcript_status, audio_file_id, audio_duration_ms, context_status, updated_at)
         VALUES (?,?,?,?,?,'audio','imported',?,1,'',1,0,'pending',?,?,'none',?)`,
        [input.id, input.day, now.toISOString(), this.clock.timeZone(), localTime, input.title, input.fileId, input.durationMs, now.toISOString()],
      );
      await j.enqueue("transcribe", input.id, 1);
    });
    return input.id;
  }

  /**
   * Saves an edit. Changing the text bumps the revision so stale automatic results cannot
   * overwrite it; tags edited by hand become manual; removed suggestions are remembered as rejected.
   */
  async updateEntry(
    id: string,
    patch: {
      title: string;
      titleAuto: boolean;
      body: string;
      topics: string[];
      emotions: string[];
      resources: DraftResource[];
      removeContext: boolean;
    },
  ): Promise<void> {
    const removedFiles: (string | null)[] = [];
    await this.inTx(async (j) => {
      const cur = await j.entry(id);
      if (!cur) throw new Error("entry_deleted");
      const bodyChanged = patch.body !== cur.body;
      const revision = bodyChanged ? cur.bodyRevision + 1 : cur.bodyRevision;
      const manual = cur.bodyManual || bodyChanged;
      const ctx = patch.removeContext
        ? ", city = NULL, temperature_c = NULL, weather_condition = NULL, geo_lat = NULL, geo_lon = NULL, context_status = 'removed'"
        : "";
      await j.db.run(
        `UPDATE entries SET title = ?, title_auto = ?, body = ?, body_revision = ?, body_manual = ?, updated_at = ?${ctx} WHERE id = ?`,
        [patch.title, patch.titleAuto ? 1 : 0, patch.body, revision, manual ? 1 : 0, this.iso(), id],
      );
      if (patch.removeContext) await j.db.run("UPDATE jobs SET status = 'cancelled' WHERE entry_id = ? AND kind = 'context' AND status IN ('queued','failed')", [id]);
      // Transcript text typed while the transcription is pending makes the entry readable.
      if (bodyChanged && cur.kind === "audio" && cur.transcriptStatus !== "ready" && patch.body.trim())
        await j.db.run("UPDATE entries SET transcript_status = 'ready' WHERE id = ?", [id]);
      await j.setTags(id, cur.tags, patch.topics, patch.emotions);
      // Resources
      const keep = new Set(patch.resources.map((r) => r.id));
      for (const r of cur.resources) if (!keep.has(r.id)) {
        await j.db.run("DELETE FROM resources WHERE id = ?", [r.id]);
        removedFiles.push(r.fileId ?? null);
      }
      await j.writeResources(id, patch.resources);
      if (bodyChanged && patch.body.trim()) await j.enqueue("classify", id, revision);
    });
    await this.collect(removedFiles);
  }

  private async setTags(entryId: string, current: EntryTag[], topics: string[], emotions: string[]) {
    const wanted: { kind: TagKind; name: string }[] = [
      ...topics.map((name) => ({ kind: "topic" as const, name })),
      ...emotions.map((name) => ({ kind: "emotion" as const, name })),
    ];
    const same = (t: { kind: TagKind; name: string }, w: { kind: TagKind; name: string }) => t.kind === w.kind && normalize(t.name) === normalize(w.name);
    for (const t of current) {
      if (wanted.some((w) => same(t, w))) continue;
      await this.db.run("DELETE FROM entry_tags WHERE entry_id = ? AND tag_id = ?", [entryId, t.id]);
      if (t.origin === "suggested")
        await this.db.run("INSERT OR IGNORE INTO tag_rejections (entry_id, kind, norm) VALUES (?,?,?)", [entryId, t.kind, normalize(t.name)]);
    }
    let position = 0;
    for (const w of wanted) {
      const existing = current.find((t) => same(t, w));
      if (existing) {
        await this.db.run("UPDATE entry_tags SET position = ? WHERE entry_id = ? AND tag_id = ?", [position++, entryId, existing.id]);
        continue;
      }
      const tagId = await this.upsertTag(w.kind, w.name);
      await this.db.run("INSERT OR REPLACE INTO entry_tags (entry_id, tag_id, origin, position) VALUES (?,?, 'manual', ?)", [entryId, tagId, position++]);
      await this.db.run("DELETE FROM tag_rejections WHERE entry_id = ? AND kind = ? AND norm = ?", [entryId, w.kind, normalize(w.name)]);
    }
  }

  /** Renames a tag in the catalog; identity is kept for every entry. Merges if the name exists. */
  async renameTag(tagId: string, name: string): Promise<void> {
    const t = await this.db.first<{ kind: TagKind }>("SELECT kind FROM tags WHERE id = ?", [tagId]);
    if (!t || !name.trim()) return;
    await this.inTx(async (j) => {
      const other = await j.db.first<{ id: string }>("SELECT id FROM tags WHERE kind = ? AND norm = ? AND id <> ?", [t.kind, normalize(name), tagId]);
      if (other) {
        await j.db.run("UPDATE OR IGNORE entry_tags SET tag_id = ? WHERE tag_id = ?", [other.id, tagId]);
        await j.db.run("DELETE FROM tags WHERE id = ?", [tagId]);
      } else {
        await j.db.run("UPDATE tags SET name = ?, norm = ? WHERE id = ?", [name.trim(), normalize(name), tagId]);
      }
    });
  }

  /** Delete an entry: text, original audio, transcripts, context, own resources, relations. Day photo stays. */
  async deleteEntry(id: string, collectFiles = true): Promise<boolean> {
    let files: (string | null)[] = [];
    const deleted = await this.inTx(async (j) => {
      const e = await j.db.first<Row>("SELECT audio_file_id FROM entries WHERE id = ?", [id]);
      if (!e) return false;
      const res = await j.db.all<{ file_id: string | null }>("SELECT file_id FROM resources WHERE entry_id = ?", [id]);
      files = [e.audio_file_id, ...res.map((r) => r.file_id)];
      await j.db.run("DELETE FROM entries WHERE id = ?", [id]);
      await j.cancelJobsFor(id);
      await j.db.run("INSERT OR REPLACE INTO tombstones (kind, id, deleted_at) VALUES ('entry', ?, ?)", [id, this.iso()]);
      return true;
    });
    if (deleted && collectFiles) await this.collect(files);
    return deleted;
  }

  private async cancelJobsFor(entryId: string) {
    const remote = await this.db.all<{ id: string; remote_id: string | null }>(
      "SELECT id, remote_id FROM jobs WHERE entry_id = ? AND kind = 'transcribe' AND status IN ('queued','running','remote','failed')",
      [entryId],
    );
    await this.db.run("UPDATE jobs SET status = 'cancelled' WHERE entry_id = ? AND status NOT IN ('done','cancelled')", [entryId]);
    // Ask the server to drop any uploaded audio/result for those jobs (best effort, retried).
    for (const j of remote) await this.enqueue("remote-cancel", j.id, 0);
  }

  // ---------- day photo ----------

  /**
   * Replaces the day photo atomically. The new file must already be stored; if anything fails
   * before commit the previous photo is untouched. Returns the previous file for cleanup.
   */
  async setDayPhoto(day: DayKey, fileId: string, meta: { width?: number | null; height?: number | null }): Promise<void> {
    const now = this.clock.now();
    let previous: string | null = null;
    await this.inTx(async (j) => {
      const old = await j.db.first<{ file_id: string }>("SELECT file_id FROM day_photos WHERE day = ?", [day]);
      previous = old?.file_id ?? null;
      const localTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      await j.db.run(
        `INSERT INTO day_photos (day, file_id, local_time, time_zone, width, height, created_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(day) DO UPDATE SET file_id=excluded.file_id, local_time=excluded.local_time, time_zone=excluded.time_zone,
         width=excluded.width, height=excluded.height, created_at=excluded.created_at`,
        [day, fileId, localTime, this.clock.timeZone(), meta.width ?? null, meta.height ?? null, now.toISOString()],
      );
    });
    if (previous && previous !== fileId) await this.collect([previous]);
  }

  async deleteDayPhoto(day: DayKey): Promise<void> {
    const p = await this.db.first<{ file_id: string }>("SELECT file_id FROM day_photos WHERE day = ?", [day]);
    if (!p) return;
    await this.db.run("DELETE FROM day_photos WHERE day = ?", [day]);
    await this.db.run("INSERT OR REPLACE INTO tombstones (kind, id, deleted_at) VALUES ('photo', ?, ?)", [day, this.iso()]);
    await this.collect([p.file_id]);
  }

  async deleteDay(day: DayKey): Promise<void> {
    const ids = await this.db.all<{ id: string }>("SELECT id FROM entries WHERE day = ?", [day]);
    for (const { id } of ids) await this.deleteEntry(id);
    await this.deleteDayPhoto(day);
  }

  /** Explicit promotion of an image resource to day photo: both reference the same file. */
  async useResourceAsDayPhoto(resourceId: string, day: DayKey): Promise<void> {
    const r = await this.db.first<{ file_id: string | null; kind: string }>("SELECT file_id, kind FROM resources WHERE id = ?", [resourceId]);
    if (!r?.file_id || r.kind !== "image") throw new Error("not_an_image");
    await this.setDayPhoto(day, r.file_id, {});
  }

  // ---------- jobs ----------

  async enqueue(kind: JobRow["kind"], entryId: string, revision: number): Promise<string> {
    const existing = await this.db.first<{ id: string }>("SELECT id FROM jobs WHERE kind = ? AND entry_id = ? AND revision = ?", [kind, entryId, revision]);
    if (existing) return existing.id;
    const id = this.newId();
    await this.db.run(
      "INSERT INTO jobs (id, kind, entry_id, revision, status, attempts, next_run_at, created_at) VALUES (?,?,?,?, 'queued', 0, ?, ?)",
      [id, kind, entryId, revision, this.iso(), this.iso()],
    );
    return id;
  }

  async runnableJobs(): Promise<JobRow[]> {
    return this.db.all<JobRow>(
      "SELECT * FROM jobs WHERE status IN ('queued','remote','running') AND next_run_at <= ? ORDER BY created_at",
      [this.iso()],
    );
  }

  async pendingJobCount(): Promise<number> {
    const r = await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running','remote','failed') AND kind <> 'remote-cancel'");
    return r?.n ?? 0;
  }

  async job(id: string): Promise<JobRow | null> {
    return this.db.first<JobRow>("SELECT * FROM jobs WHERE id = ?", [id]);
  }

  async updateJob(id: string, patch: Partial<Pick<JobRow, "status" | "attempts" | "next_run_at" | "remote_id" | "last_error">>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    await this.db.run(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ? AND status <> 'cancelled'`, [...keys.map((k) => patch[k] as Param), id]);
  }

  async setTranscriptStatus(entryId: string, status: TranscriptStatus) {
    await this.db.run("UPDATE entries SET transcript_status = ? WHERE id = ? AND transcript_status <> 'ready'", [status, entryId]);
  }

  /** Applies a late transcript according to the invariants. Returns what was done. */
  async applyTranscript(jobId: string, result: { text: string; language?: string | null; uncertain?: TranscriptSpan[] }): Promise<"apply" | "alternative" | "discard"> {
    return this.inTx(async (j) => {
      const job = await j.job(jobId);
      if (!job || job.status === "cancelled") return "discard";
      const e = await j.db.first<Row>("SELECT body_revision, body_manual, body, transcript_status FROM entries WHERE id = ?", [job.entry_id]);
      // A requested retranscription is offered for review even if the existing text was automatic.
      const hasReadingText = e?.transcript_status === "ready" && !!e?.body?.trim();
      const decision = decideTranscript({ exists: !!e, bodyRevision: e?.body_revision ?? 0, bodyManual: !!e?.body_manual || hasReadingText }, job.revision);
      if (decision === "apply") {
        await j.db.run(
          "UPDATE entries SET body = ?, transcript_auto = ?, transcript_language = ?, transcript_uncertain = ?, transcript_status = 'ready', updated_at = ? WHERE id = ?",
          [result.text, result.text, result.language ?? null, JSON.stringify(result.uncertain ?? []), this.iso(), job.entry_id],
        );
        await j.enqueue("classify", job.entry_id, job.revision);
      } else if (decision === "alternative") {
        await j.db.run(
          "UPDATE entries SET transcript_auto = ?, transcript_alternative = ?, transcript_language = ?, transcript_alternative_uncertain = ?, transcript_status = 'ready' WHERE id = ?",
          [result.text, result.text, result.language ?? null, JSON.stringify(result.uncertain ?? []), job.entry_id],
        );
      }
      await j.db.run("UPDATE jobs SET status = 'done' WHERE id = ?", [jobId]);
      return decision;
    });
  }

  /** Replaces the reading text with the alternative only on explicit request. */
  async acceptAlternative(entryId: string): Promise<void> {
    const e = await this.entry(entryId);
    if (!e?.transcriptAlternative) return;
    await this.db.run(
      "UPDATE entries SET body = ?, body_revision = body_revision + 1, transcript_uncertain = transcript_alternative_uncertain, transcript_alternative = NULL, transcript_alternative_uncertain = NULL, updated_at = ? WHERE id = ?",
      [e.transcriptAlternative, this.iso(), entryId],
    );
    await this.enqueue("classify", entryId, e.bodyRevision + 1);
  }

  async dismissAlternative(entryId: string): Promise<void> {
    await this.db.run("UPDATE entries SET transcript_alternative = NULL, transcript_alternative_uncertain = NULL WHERE id = ?", [entryId]);
  }

  async applyClassification(jobId: string, s: Suggestions): Promise<boolean> {
    return this.inTx(async (j) => {
      const job = await j.job(jobId);
      if (!job || job.status === "cancelled") return false;
      const e = await j.entry(job.entry_id);
      if (!e || e.bodyRevision !== job.revision) {
        await j.db.run("UPDATE jobs SET status = 'done' WHERE id = ?", [jobId]);
        return false;
      }
      const merged = mergeSuggestions(e.tags, s, await j.rejections(e.id));
      for (const t of merged.removeSuggested) await j.db.run("DELETE FROM entry_tags WHERE entry_id = ? AND tag_id = ?", [e.id, t.id]);
      let position = merged.keep.length;
      for (const a of merged.add) {
        const tagId = await j.upsertTag(a.kind, a.name);
        await j.db.run("INSERT OR IGNORE INTO entry_tags (entry_id, tag_id, origin, position) VALUES (?,?, 'suggested', ?)", [e.id, tagId, position++]);
      }
      await j.db.run("UPDATE jobs SET status = 'done' WHERE id = ?", [jobId]);
      return true;
    });
  }

  async contextTarget(entryId: string): Promise<{ lat: number; lon: number; at: string } | null> {
    const r = await this.db.first<Row>("SELECT geo_lat, geo_lon, context_at, context_status FROM entries WHERE id = ?", [entryId]);
    if (!r || r.context_status !== "pending" || r.geo_lat == null || r.geo_lon == null || !r.context_at) return null;
    return { lat: r.geo_lat, lon: r.geo_lon, at: r.context_at };
  }

  /** Stores context observed for the recording's start; drops coordinates afterwards. */
  async applyContext(jobId: string, c: { city?: string | null; temperatureC?: number | null; condition?: WeatherCondition | null }): Promise<boolean> {
    return this.inTx(async (j) => {
      const job = await j.job(jobId);
      if (!job || job.status === "cancelled") return false;
      const r = await j.db.first<Row>("SELECT context_status, city FROM entries WHERE id = ?", [job.entry_id]);
      if (!r || r.context_status !== "pending") {
        await j.db.run("UPDATE jobs SET status = 'done' WHERE id = ?", [jobId]);
        return false;
      }
      const any = c.city || c.temperatureC != null || c.condition;
      await j.db.run(
        `UPDATE entries SET city = COALESCE(city, ?), temperature_c = ?, weather_condition = ?, geo_lat = NULL, geo_lon = NULL,
         context_status = ? WHERE id = ?`,
        [c.city ?? null, c.temperatureC ?? null, c.condition ?? null, any ? "resolved" : "unavailable", job.entry_id],
      );
      await j.db.run("UPDATE jobs SET status = 'done' WHERE id = ?", [jobId]);
      return true;
    });
  }

  async entryRevision(id: string): Promise<{ revision: number; body: string; language: string | null } | null> {
    const r = await this.db.first<Row>("SELECT body_revision, body, transcript_language FROM entries WHERE id = ?", [id]);
    return r ? { revision: r.body_revision, body: r.body, language: r.transcript_language } : null;
  }

  async audioFor(entryId: string): Promise<{ uri: string; mime: string } | null> {
    const r = await this.db.first<Row>("SELECT f.rel_path, f.mime FROM entries e JOIN files f ON f.id = e.audio_file_id WHERE e.id = ?", [entryId]);
    return r ? { uri: this.files.uri(r.rel_path), mime: r.mime } : null;
  }

  // ---------- key/value settings ----------

  async get<T>(key: string, fallback: T): Promise<T> {
    const r = await this.db.first<{ value: string }>("SELECT value FROM kv WHERE key = ?", [key]);
    return r ? (JSON.parse(r.value) as T) : fallback;
  }
  async set(key: string, value: unknown): Promise<void> {
    await this.db.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, JSON.stringify(value)]);
  }
}

export type { Resource, EntryOrigin, TagOrigin };
