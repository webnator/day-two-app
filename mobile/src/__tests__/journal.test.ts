import { describe, expect, it } from "vitest";
import { makeJournal } from "./helpers";

const draft = (over: Partial<{ id: string; day: string; title: string; body: string }> = {}) => ({
  id: "d1", day: "2026-10-05", prompt: null, title: "", body: "Hoy salí a caminar con la niña.", resources: [], ...over,
});

async function audioEntry(j: Awaited<ReturnType<typeof makeJournal>>["j"], id = "rec1") {
  await j.beginRecording({ id, tempUri: "file://cache/a.wav", mime: "audio/wav", day: "2026-10-05", startedAt: new Date("2026-10-05T18:48:00Z"), timeZone: "Europe/Madrid", localTime: "20:48" });
  const fileId = await j.attachRecordingFile(id, ".wav", [0.2, 0.5]);
  await j.finishRecording(id, 154000, "Una nota de voz");
  return { id, fileId };
}

describe("text entries (A03, A04)", () => {
  it("saves a draft once even if saved twice, body intact", async () => {
    const { j } = await makeJournal();
    await j.saveDraft(draft());
    const a = await j.commitDraft(draft(), { title: "Hoy salí a caminar con la niña", auto: true });
    const b = await j.commitDraft(draft(), { title: "Hoy salí a caminar con la niña", auto: true });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    const list = await j.entriesForDay("2026-10-05");
    expect(list).toHaveLength(1);
    expect(list[0].body).toBe("Hoy salí a caminar con la niña.");
    expect(await j.draft()).toBeNull();
  });
  it("keeps the draft until an explicit discard", async () => {
    const { j } = await makeJournal();
    await j.saveDraft(draft({ body: "a medias" }));
    expect((await j.draft())?.body).toBe("a medias");
    await j.discardDraft("d1");
    expect(await j.draft()).toBeNull();
  });
});

describe("audio & transcription (A09, A10, A19)", () => {
  it("creates one entry per recording, idempotent finish, original kept", async () => {
    const { j, files } = await makeJournal();
    const { id } = await audioEntry(j);
    expect(await j.finishRecording(id, 154000, "x")).toBe(id); // retry after crash → same entry
    const e = await j.entry(id);
    expect(e?.transcriptStatus).toBe("pending");
    expect(files.stored.size).toBe(1);
    expect(e?.waveform).toEqual([0.2, 0.5]);
    expect((await j.runnableJobs()).filter((x) => x.kind === "transcribe")).toHaveLength(1);
  });
  it("applies the transcript when nothing changed", async () => {
    const { j } = await makeJournal();
    const { id } = await audioEntry(j);
    const job = (await j.runnableJobs()).find((x) => x.kind === "transcribe")!;
    expect(await j.applyTranscript(job.id, { text: "Hola", language: "es" })).toBe("apply");
    expect((await j.entry(id))?.body).toBe("Hola");
  });
  it("a late automatic result never overwrites a manual correction", async () => {
    const { j } = await makeJournal();
    const { id } = await audioEntry(j);
    const job = (await j.runnableJobs()).find((x) => x.kind === "transcribe")!;
    await j.updateEntry(id, { title: "Mi nota", titleAuto: false, body: "Lo que yo escribí", topics: [], emotions: [], resources: [], removeContext: false });
    expect(await j.applyTranscript(job.id, { text: "Texto automático", language: "es" })).toBe("alternative");
    const e = await j.entry(id);
    expect(e?.body).toBe("Lo que yo escribí");
    expect(e?.transcriptAlternative).toBe("Texto automático");
  });
  it("keeps uncertainty with its version and applies it only when the alternative is accepted", async () => {
    const { j, files } = await makeJournal();
    const { id } = await audioEntry(j);
    const job = (await j.runnableJobs()).find((x) => x.kind === "transcribe")!;
    const first = [{ start: 1, end: 4 }];
    await j.applyTranscript(job.id, { text: "Primera versión", uncertain: first });
    await j.updateJob(job.id, { status: "remote" });
    const next = [{ start: 10, end: 12 }];
    expect(await j.applyTranscript(job.id, { text: "Segunda versión", uncertain: next })).toBe("alternative");
    let e = (await j.entry(id))!;
    expect(e.body).toBe("Primera versión");
    expect(e.transcriptUncertain).toEqual(first);
    expect(e.transcriptAlternativeUncertain).toEqual(next);
    await j.acceptAlternative(id);
    e = (await j.entry(id))!;
    expect(e.body).toBe("Segunda versión");
    expect(e.transcriptUncertain).toEqual(next);
    expect(e.transcriptAlternativeUncertain).toEqual([]);
    expect(e.transcriptAlternative).toBeNull();
    expect(files.stored.size).toBe(1);
  });
  it("discarding an alternative clears only that version's uncertainty", async () => {
    const { j } = await makeJournal();
    const { id } = await audioEntry(j);
    const job = (await j.runnableJobs()).find((x) => x.kind === "transcribe")!;
    await j.applyTranscript(job.id, { text: "Original" });
    await j.updateJob(job.id, { status: "remote" });
    await j.applyTranscript(job.id, { text: "Alternativa", uncertain: [{ start: 0, end: 2 }] });
    await j.dismissAlternative(id);
    expect(await j.entry(id)).toMatchObject({ body: "Original", transcriptUncertain: [], transcriptAlternativeUncertain: [], transcriptAlternative: null });
  });
  it("a late result after deletion resurrects nothing", async () => {
    const { j, files } = await makeJournal();
    const { id } = await audioEntry(j);
    const job = (await j.runnableJobs()).find((x) => x.kind === "transcribe")!;
    await j.deleteEntry(id);
    expect(await j.applyTranscript(job.id, { text: "tarde" })).toBe("discard");
    expect(await j.entry(id)).toBeNull();
    expect(files.stored.size).toBe(0);
    expect((await j.job(job.id))?.status).toBe("cancelled");
  });
});

describe("tags (A11, A12)", () => {
  it("keeps several topics/emotions, removed suggestions are not reintroduced, manual tags stay", async () => {
    const { j } = await makeJournal();
    await j.commitDraft(draft(), { title: "t", auto: false });
    const c1 = (await j.runnableJobs()).find((x) => x.kind === "classify")!;
    await j.applyClassification(c1.id, { topics: ["Familia", "Trabajo"], emotions: ["Alegría", "Preocupación"] });
    let e = (await j.entry("d1"))!;
    expect(e.tags.map((t) => t.name).sort()).toEqual(["Alegría", "Familia", "Preocupación", "Trabajo"]);
    // Person removes "Trabajo" (suggested) and adds "Descanso" (manual)
    await j.updateEntry("d1", { title: "t", titleAuto: false, body: e.body + " Más.", topics: ["Familia", "Descanso"], emotions: ["Alegría", "Preocupación"], resources: [], removeContext: false });
    const c2 = (await j.runnableJobs()).find((x) => x.kind === "classify" && x.revision === 2)!;
    await j.applyClassification(c2.id, { topics: ["Trabajo", "Paseo"], emotions: [] });
    e = (await j.entry("d1"))!;
    const names = e.tags.map((t) => t.name);
    expect(names).not.toContain("Trabajo");
    expect(names).toContain("Descanso");
    expect(e.tags.find((t) => t.name === "Descanso")?.origin).toBe("manual");
    expect(names).toContain("Paseo");
  });
  it("a stale classification is ignored", async () => {
    const { j } = await makeJournal();
    await j.commitDraft(draft(), { title: "t", auto: false });
    const c1 = (await j.runnableJobs()).find((x) => x.kind === "classify")!;
    await j.updateEntry("d1", { title: "t", titleAuto: false, body: "otro texto", topics: [], emotions: [], resources: [], removeContext: false });
    expect(await j.applyClassification(c1.id, { topics: ["Familia"], emotions: [] })).toBe(false);
    expect((await j.entry("d1"))!.tags).toHaveLength(0);
  });
  it("renaming keeps identity on every entry", async () => {
    const { j } = await makeJournal();
    await j.commitDraft(draft(), { title: "t", auto: false });
    await j.updateEntry("d1", { title: "t", titleAuto: false, body: "x", topics: ["Curro"], emotions: [], resources: [], removeContext: false });
    const tag = (await j.entry("d1"))!.tags[0];
    await j.renameTag(tag.id, "Trabajo");
    expect((await j.entry("d1"))!.tags[0]).toMatchObject({ id: tag.id, name: "Trabajo" });
  });
});

describe("day photo and deletion scope (A15–A18, A20, A21)", () => {
  it("one photo per day; replacing keeps uniqueness and cleans the old file", async () => {
    const { j, files } = await makeJournal();
    const a = await j.importFile("file://a.jpg", "photos", ".jpg", "image/jpeg");
    await j.setDayPhoto("2026-10-05", a.id, {});
    const b = await j.importFile("file://b.jpg", "photos", ".jpg", "image/jpeg");
    await j.setDayPhoto("2026-10-05", b.id, {});
    expect((await j.photos())).toHaveLength(1);
    expect((await j.photo("2026-10-05"))?.fileId).toBe(b.id);
    expect(files.exists(a.relPath)).toBe(false);
  });
  it("a failure storing the new photo keeps the previous one", async () => {
    const { j, files } = await makeJournal();
    const a = await j.importFile("file://a.jpg", "photos", ".jpg", "image/jpeg");
    await j.setDayPhoto("2026-10-05", a.id, {});
    files.failNextPut = true;
    await expect(j.importFile("file://b.jpg", "photos", ".jpg", "image/jpeg")).rejects.toThrow();
    expect((await j.photo("2026-10-05"))?.fileId).toBe(a.id);
  });
  it("an image resource does not count as day photo", async () => {
    const { j } = await makeJournal();
    const img = await j.importFile("file://r.jpg", "resources", ".jpg", "image/jpeg");
    await j.commitDraft({ ...draft(), resources: [{ id: "r1", kind: "image", title: "Una imagen", fileId: img.id, status: "ready" }] }, { title: "t", auto: false });
    expect(await j.photo("2026-10-05")).toBeNull();
  });
  it("deleting the last entry of a day with photo leaves only the photo; resources removed", async () => {
    const { j, files } = await makeJournal();
    const p = await j.importFile("file://p.jpg", "photos", ".jpg", "image/jpeg");
    await j.setDayPhoto("2026-10-05", p.id, {});
    const img = await j.importFile("file://r.jpg", "resources", ".jpg", "image/jpeg");
    await j.commitDraft({ ...draft(), resources: [{ id: "r1", kind: "image", title: "Una imagen", fileId: img.id, status: "ready" }] }, { title: "t", auto: false });
    const { id } = await audioEntry(j);
    await j.deleteEntry("d1");
    expect(files.exists(img.relPath)).toBe(false);
    expect(await j.entry(id)).not.toBeNull(); // other entry stays
    await j.deleteEntry(id);
    expect(await j.entriesForDay("2026-10-05")).toHaveLength(0);
    expect((await j.photo("2026-10-05"))?.fileId).toBe(p.id);
    expect(files.exists(p.relPath)).toBe(true);
  });
  it("deleting the photo keeps the entries; deleting the day removes both and only that day", async () => {
    const { j } = await makeJournal();
    const p = await j.importFile("file://p.jpg", "photos", ".jpg", "image/jpeg");
    await j.setDayPhoto("2026-10-05", p.id, {});
    await j.commitDraft(draft(), { title: "t", auto: false });
    await j.commitDraft(draft({ id: "d2", day: "2026-10-04" }), { title: "t", auto: false });
    await j.deleteDayPhoto("2026-10-05");
    expect(await j.entriesForDay("2026-10-05")).toHaveLength(1);
    const p2 = await j.importFile("file://p2.jpg", "photos", ".jpg", "image/jpeg");
    await j.setDayPhoto("2026-10-05", p2.id, {});
    await j.deleteDay("2026-10-05");
    expect(await j.entriesForDay("2026-10-05")).toHaveLength(0);
    expect(await j.photo("2026-10-05")).toBeNull();
    expect(await j.entriesForDay("2026-10-04")).toHaveLength(1);
  });
  it("a file with two references survives until the last one goes", async () => {
    const { j, files } = await makeJournal();
    const img = await j.importFile("file://r.jpg", "resources", ".jpg", "image/jpeg");
    await j.commitDraft({ ...draft(), resources: [{ id: "r1", kind: "image", title: "Una imagen", fileId: img.id, status: "ready" }] }, { title: "t", auto: false });
    await j.useResourceAsDayPhoto("r1", "2026-10-05");
    await j.deleteEntry("d1");
    expect(files.exists(img.relPath)).toBe(true);
    expect((await j.photo("2026-10-05"))?.fileId).toBe(img.id);
    await j.deleteDayPhoto("2026-10-05");
    expect(files.exists(img.relPath)).toBe(false);
  });
  it("removing a resource keeps the text and the other resources", async () => {
    const { j, files } = await makeJournal();
    const img = await j.importFile("file://r.jpg", "resources", ".jpg", "image/jpeg");
    const res = [
      { id: "r1", kind: "image" as const, title: "Una imagen", fileId: img.id, status: "ready" as const },
      { id: "r2", kind: "link" as const, title: "Podcast", url: "https://ejemplo.com", status: "ready" as const },
    ];
    await j.commitDraft({ ...draft(), resources: res }, { title: "t", auto: false });
    await j.updateEntry("d1", { title: "t", titleAuto: false, body: draft().body, topics: [], emotions: [], resources: [res[1]], removeContext: false });
    const e = (await j.entry("d1"))!;
    expect(e.body).toBe(draft().body);
    expect(e.resources.map((r) => r.id)).toEqual(["r2"]);
    expect(files.exists(img.relPath)).toBe(false);
  });
});

describe("dates and context (A23, A33, A35)", () => {
  it("an entry keeps its assigned day after a timezone change", async () => {
    const { j, clock } = await makeJournal();
    await j.commitDraft(draft({ day: "2026-10-05" }), { title: "t", auto: false });
    clock.zone = "America/New_York";
    clock.advance(6 * 3600 * 1000);
    expect((await j.entry("d1"))?.day).toBe("2026-10-05");
  });
  it("a past day keeps its date when written later", async () => {
    const { j } = await makeJournal();
    await j.commitDraft(draft({ day: "2025-10-05" }), { title: "t", auto: false });
    expect((await j.entry("d1"))?.day).toBe("2025-10-05");
  });
  it("context resolved later uses the recording start and drops coordinates", async () => {
    const { j } = await makeJournal();
    await j.beginRecording({ id: "r", tempUri: "file://cache/a.wav", mime: "audio/wav", day: "2026-10-05", startedAt: new Date("2026-10-05T18:48:00Z"), timeZone: "Europe/Madrid", localTime: "20:48" });
    await j.attachRecordingFile("r", ".wav");
    await j.setRecordingContext("r", { lat: 40.42, lon: -3.7, status: "pending" });
    await j.finishRecording("r", 1000, "n");
    expect(await j.contextTarget("r")).toEqual({ lat: 40.42, lon: -3.7, at: "2026-10-05T18:48:00.000Z" });
    const job = (await j.runnableJobs()).find((x) => x.kind === "context")!;
    await j.applyContext(job.id, { city: "Madrid", temperatureC: 18, condition: "cloudy" });
    const e = (await j.entry("r"))!;
    expect(e).toMatchObject({ city: "Madrid", temperatureC: 18, weatherCondition: "cloudy", contextStatus: "resolved" });
    expect(await j.contextTarget("r")).toBeNull();
  });
  it("removing context from Edit cancels the pending lookup", async () => {
    const { j } = await makeJournal();
    await j.beginRecording({ id: "r", tempUri: "file://cache/a.wav", mime: "audio/wav", day: "2026-10-05", startedAt: new Date(), timeZone: "Europe/Madrid", localTime: "20:48" });
    await j.attachRecordingFile("r", ".wav");
    await j.setRecordingContext("r", { lat: 40.42, lon: -3.7, status: "pending" });
    await j.finishRecording("r", 1000, "n");
    const job = (await j.runnableJobs()).find((x) => x.kind === "context")!;
    await j.updateEntry("r", { title: "n", titleAuto: true, body: "", topics: [], emotions: [], resources: [], removeContext: true });
    expect(await j.applyContext(job.id, { city: "Madrid" })).toBe(false);
    expect((await j.entry("r"))?.city).toBeNull();
  });
  it("imported audio receives no capture context", async () => {
    const { j } = await makeJournal();
    const f = await j.importFile("file://a.m4a", "audio", ".m4a", "audio/mp4");
    await j.createImportedAudio({ id: "imp", fileId: f.id, day: "2026-10-05", durationMs: 1000, title: "Una nota de voz" });
    const e = (await j.entry("imp"))!;
    expect(e.origin).toBe("imported");
    expect(e.city ?? null).toBeNull();
    expect(e.contextStatus).toBe("none");
    expect((await j.runnableJobs()).some((x) => x.kind === "context")).toBe(false);
  });
});
