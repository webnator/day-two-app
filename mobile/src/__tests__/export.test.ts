import { describe, expect, it } from "vitest";
import { buildExport, EXPORT_VERSION } from "../domain/exportFormat";
import { makeJournal } from "./helpers";

describe("export (A37)", () => {
  it("contains text, dates, tags, context, originals and resolvable resources", async () => {
    const { j, db } = await makeJournal();
    const img = await j.importFile("file://r.jpg", "resources", ".jpg", "image/jpeg");
    await j.commitDraft({ id: "d1", day: "2026-10-05", prompt: null, title: "Paseo", body: "Con la niña.", resources: [{ id: "r1", kind: "image", title: "Foto", fileId: img.id, status: "ready" }, { id: "r2", kind: "link", title: "Podcast", url: "https://ejemplo.com", status: "ready" }] }, { title: "Paseo", auto: false });
    await j.updateEntry("d1", { title: "Paseo", titleAuto: false, body: "Con la niña.", topics: ["Familia"], emotions: ["Alegría"], resources: [{ id: "r1", kind: "image", title: "Foto", fileId: img.id, status: "ready" }, { id: "r2", kind: "link", title: "Podcast", url: "https://ejemplo.com", status: "ready" }], removeContext: false });
    await j.beginRecording({ id: "a1", tempUri: "file://c/a.wav", mime: "audio/wav", day: "2026-10-04", startedAt: new Date("2026-10-04T10:00:00Z"), timeZone: "Europe/Madrid", localTime: "12:00" });
    await j.attachRecordingFile("a1", ".wav");
    await j.setRecordingContext("a1", { status: "resolved", city: "Madrid", temperatureC: 18, condition: "cloudy" });
    await j.finishRecording("a1", 5000, "Nota");
    const p = await j.importFile("file://p.jpg", "photos", ".jpg", "image/jpeg");
    await j.setDayPhoto("2026-10-05", p.id, {});
    const files = await db.all<any>("SELECT id, rel_path, mime, size FROM files");
    const out = buildExport({ entries: await j.allEntries(), photos: await j.photos(), files, email: "a@b.co", exportedAt: "2026-10-05T20:00:00Z" });
    expect(out.manifest.version).toBe(EXPORT_VERSION);
    const d5 = out.json.days.find((d) => d.date === "2026-10-05")!;
    expect(d5.photo?.path).toMatch(/^media\/photos\//);
    const e = d5.entries[0];
    expect(e.text).toBe("Con la niña.");
    expect(e.topics.map((t) => t.name)).toEqual(["Familia"]);
    expect(e.resources[0].path).toMatch(/^media\/resources\//);
    expect(e.resources[1].url).toBe("https://ejemplo.com");
    const a = out.json.days.find((d) => d.date === "2026-10-04")!.entries[0];
    expect(a.audio?.path).toMatch(/^media\/audio\/a1\.wav$/);
    expect(a.context).toEqual({ city: "Madrid", temperatureC: 18, condition: "cloudy" });
    // every referenced path is in the manifest and maps to a stored file
    const paths = new Set(out.manifest.files.map((f: any) => f.path));
    for (const m of out.media) expect(paths.has(m.path)).toBe(true);
    expect(out.media).toHaveLength(3);
    expect(out.markdown).toContain("### Paseo");
  });
});
