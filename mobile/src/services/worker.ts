import * as Network from "expo-network";
import { AppState } from "react-native";
import type { Journal, JobRow } from "../data/journal";
import type { WeatherCondition } from "../domain/model";
import { normalize } from "../domain/rules";
import { api, ApiError } from "./api";
import { emitChange } from "./events";

const MAX_ATTEMPTS = 6;
const backoff = (attempts: number) => Math.min(600_000, 5_000 * 2 ** attempts);
const POLL_MS = 3_000;

function extFor(mime: string) {
  if (mime.includes("wav")) return "wav";
  if (mime.includes("aac")) return "aac";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("flac")) return "flac";
  if (mime.includes("webm")) return "webm";
  return "m4a";
}

async function online(): Promise<boolean> {
  try {
    const s = await Network.getNetworkStateAsync();
    return !!s.isConnected && s.isInternetReachable !== false;
  } catch {
    return true;
  }
}

/**
 * Processes the local job queue. Saving never waits for it: originals are already on disk.
 * Results go through Journal.apply*, which enforce revisions, manual corrections and deletions.
 */
export class Worker {
  private running = false;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private subs: { remove(): void }[] = [];
  private stopped = false;

  constructor(private journal: Journal, private lang: () => string) {}

  start() {
    this.stopped = false;
    this.subs.push(Network.addNetworkStateListener((s) => s.isConnected && this.kick()));
    this.subs.push(AppState.addEventListener("change", (s) => s === "active" && this.kick()));
    this.kick();
  }
  stop() {
    this.stopped = true;
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    if (this.timer) clearTimeout(this.timer);
  }

  kick = () => {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.loop()
      .catch(() => undefined)
      .finally(() => {
        this.running = false;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  };

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(this.kick, ms);
  }

  private async loop() {
    const jobs = await this.journal.runnableJobs();
    if (!jobs.length) return;
    const isOnline = await online();
    if (__DEV__) console.log("WORKER", jobs.length, "jobs; online:", isOnline);
    let polling = false;
    for (const job of jobs) {
      if (this.stopped) return;
      if (!isOnline) {
        if (job.kind === "transcribe") await this.journal.setTranscriptStatus(job.entry_id, "offline");
        continue;
      }
      try {
        const keepPolling = await this.run(job);
        polling ||= keepPolling;
      } catch (e) {
        await this.fail(job, e);
      }
      emitChange();
    }
    emitChange();
    if (polling) this.schedule(POLL_MS);
    else {
      // Wake up for the next backoff slot, if any.
      const next = await this.journal.db.first<{ t: string }>("SELECT MIN(next_run_at) AS t FROM jobs WHERE status IN ('queued','remote')");
      if (next?.t) this.schedule(Math.max(1000, new Date(next.t).getTime() - Date.now()));
    }
  }

  /** Returns true when the job is waiting on the server and should be polled. */
  private async run(job: JobRow): Promise<boolean> {
    const j = this.journal;
    switch (job.kind) {
      case "transcribe": {
        const remoteId = job.remote_id ?? job.id;
        if (job.status === "queued") {
          const audio = await j.audioFor(job.entry_id);
          if (!audio) {
            await j.updateJob(job.id, { status: "cancelled" });
            return false;
          }
          await j.setTranscriptStatus(job.entry_id, "processing");
          emitChange();
          await api.uploadTranscription(remoteId, { uri: audio.uri, name: `audio.${extFor(audio.mime)}`, type: audio.mime });
          await j.updateJob(job.id, { status: "remote", remote_id: remoteId });
          return true;
        }
        const r = await api.transcription(remoteId);
        if (r.status === "done" && r.result) {
          await j.applyTranscript(job.id, { text: r.result.text.trim(), language: r.result.language, uncertain: r.result.uncertain });
          return false;
        }
        if (r.status === "failed") throw new ApiError(422, r.error || "transcription_failed");
        await j.setTranscriptStatus(job.entry_id, "processing");
        return true;
      }
      case "classify": {
        const cur = await j.entryRevision(job.entry_id);
        if (!cur || cur.revision !== job.revision) {
          await j.updateJob(job.id, { status: "done" });
          return false;
        }
        const entry = await j.entry(job.entry_id);
        const catalog = await j.tagCatalog();
        const rejected = await j.rejections(job.entry_id);
        const text = [entry?.titleAuto ? "" : entry?.title, cur.body].filter(Boolean).join("\n\n");
        if (!text.trim()) {
          await j.updateJob(job.id, { status: "done" });
          return false;
        }
        const s = await api.classify({
          jobId: job.id,
          text,
          ...(cur.language ? { language: cur.language } : {}),
          vocabulary: { topics: catalog.filter((t) => t.kind === "topic").map((t) => t.name), emotions: catalog.filter((t) => t.kind === "emotion").map((t) => t.name) },
          rejected: {
            topics: rejected.filter((r) => r.kind === "topic").map((r) => catalog.find((t) => t.kind === "topic" && normalize(t.name) === r.norm)?.name ?? r.norm),
            emotions: rejected.filter((r) => r.kind === "emotion").map((r) => catalog.find((t) => t.kind === "emotion" && normalize(t.name) === r.norm)?.name ?? r.norm),
          },
        });
        await j.applyClassification(job.id, s);
        return false;
      }
      case "context": {
        const target = await j.contextTarget(job.entry_id);
        if (!target) {
          await j.updateJob(job.id, { status: "done" });
          return false;
        }
        const c = await api.context(target.lat, target.lon, target.at, this.lang());
        await j.applyContext(job.id, { city: c.city ?? null, temperatureC: c.temperatureC ?? null, condition: (c.condition as WeatherCondition) ?? null });
        return false;
      }
      case "remote-cancel": {
        try {
          const original = await j.job(job.entry_id);
          await api.cancelTranscription(original?.remote_id ?? job.entry_id);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        }
        await j.updateJob(job.id, { status: "done" });
        return false;
      }
    }
  }

  private async fail(job: JobRow, e: unknown) {
    const j = this.journal;
    if (__DEV__) console.log("WORKER fail", job.kind, String(e), (e as any)?.code, (e as any)?.status);
    const err = e instanceof ApiError ? e : new ApiError(0, "unknown");
    if (err.status === 401) return; // session handler signs out; job stays for the next session
    const permanent = err.status === 413 || err.status === 415 || err.status === 422 || err.status === 400;
    const attempts = job.attempts + 1;
    if (err.status === 0 && job.kind === "transcribe") {
      // No connection: keep the job, show "pending" state, retry when the network returns.
      await j.updateJob(job.id, { attempts, status: "queued", next_run_at: new Date(Date.now() + backoff(Math.min(attempts, 3))).toISOString() });
      await j.setTranscriptStatus(job.entry_id, "offline");
      return;
    }
    if (permanent || attempts >= MAX_ATTEMPTS) {
      await j.updateJob(job.id, { attempts, status: "failed", last_error: err.code });
      if (job.kind === "transcribe") await j.setTranscriptStatus(job.entry_id, "error");
      if (job.kind === "context") await j.applyContext(job.id, {});
      return;
    }
    await j.updateJob(job.id, { attempts, status: job.status === "remote" ? "remote" : "queued", next_run_at: new Date(Date.now() + backoff(attempts)).toISOString(), last_error: err.code });
  }

  /** "Reintentar ahora" while pending: run the queued jobs of this entry immediately (skip backoff). */
  async retryNow(entryId: string) {
    await this.journal.db.run("UPDATE jobs SET next_run_at = ? WHERE entry_id = ? AND status IN ('queued','remote')", [new Date().toISOString(), entryId]);
    this.kick();
  }

  /** "Reintentar": same job (no duplicate entry), new server id so a failed remote job is not reused. */
  async retryTranscription(entryId: string, newId: string) {
    const j = this.journal;
    const job = await j.db.first<JobRow>("SELECT * FROM jobs WHERE entry_id = ? AND kind = 'transcribe' ORDER BY created_at DESC LIMIT 1", [entryId]);
    if (job && ['queued', 'running', 'remote'].includes(job.status)) { this.kick(); return; }
    if (job) await j.db.run("UPDATE jobs SET status = 'queued', attempts = 0, next_run_at = ?, remote_id = ?, last_error = NULL WHERE id = ?", [new Date().toISOString(), newId, job.id]);
    else await j.enqueue("transcribe", entryId, 1);
    await j.setTranscriptStatus(entryId, "pending");
    emitChange();
    this.kick();
  }
}
