import type { DayPhoto, Entry } from "./model";

export const EXPORT_FORMAT = "daytwo-export";
export const EXPORT_VERSION = 1;

const extOf = (p: string) => (/\.[a-z0-9]+$/i.exec(p)?.[0] ?? "");

/** Pure builder of the export documents; media paths are relative to the archive root. */
export function buildExport(input: {
  entries: Entry[];
  photos: DayPhoto[];
  files: { id: string; rel_path: string; mime: string; size: number }[];
  email: string;
  exportedAt: string;
}) {
  const media: { path: string; source: string; mime: string; size: number }[] = [];
  const add = (fileId: string | null | undefined, folder: string, name: string) => {
    const f = input.files.find((x) => x.id === fileId);
    if (!f) return null;
    const path = `media/${folder}/${name}${extOf(f.rel_path)}`;
    if (!media.some((m) => m.path === path)) media.push({ path, source: f.rel_path, mime: f.mime, size: f.size });
    return path;
  };
  const days = [...new Set([...input.entries.map((e) => e.day), ...input.photos.map((p) => p.day)])].sort();
  const json = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    days: days.map((day) => {
      const photo = input.photos.find((p) => p.day === day);
      return {
        date: day,
        photo: photo ? { path: add(photo.fileId, "photos", day), localTime: photo.localTime } : null,
        entries: input.entries
          .filter((e) => e.day === day)
          .sort((a, b) => a.localTime.localeCompare(b.localTime))
          .map((e) => ({
            id: e.id,
            title: e.title,
            createdAt: e.createdAt,
            timeZone: e.timeZone,
            localTime: e.localTime,
            kind: e.kind,
            origin: e.origin,
            text: e.body,
            transcriptAutomatic: e.transcriptAuto ?? null,
            transcriptLanguage: e.transcriptLanguage ?? null,
            topics: e.tags.filter((t) => t.kind === "topic").map((t) => ({ name: t.name, origin: t.origin })),
            emotions: e.tags.filter((t) => t.kind === "emotion").map((t) => ({ name: t.name, origin: t.origin })),
            context: e.city || e.temperatureC != null || e.weatherCondition ? { city: e.city ?? null, temperatureC: e.temperatureC ?? null, condition: e.weatherCondition ?? null } : null,
            audio: e.audioFileId ? { path: add(e.audioFileId, "audio", e.id), durationMs: e.audioDurationMs ?? null } : null,
            resources: e.resources.map((r, i) => ({ kind: r.kind, title: r.title, url: r.url ?? null, path: r.fileId ? add(r.fileId, "resources", `${e.id}-${i + 1}`) : null })),
          })),
      };
    }),
  };
  const md: string[] = ["# Day Two", "", `Exportado: ${input.exportedAt}`, ""];
  for (const d of json.days) {
    md.push(`## ${d.date}`, "");
    if (d.photo?.path) md.push(`![Foto del día](${d.photo.path})`, "");
    for (const e of d.entries) {
      const ctx = e.context ? ` · ${[e.context.city, e.context.temperatureC != null ? `${Math.round(e.context.temperatureC)}°` : null].filter(Boolean).join(" · ")}` : "";
      md.push(`### ${e.title}`, "", `${e.localTime} · ${e.kind === "audio" ? "Audio" : "Texto"}${ctx}`, "");
      if (e.topics.length || e.emotions.length) md.push(`Temas: ${e.topics.map((t) => t.name).join(", ") || "—"} · Emociones: ${e.emotions.map((t) => t.name).join(", ") || "—"}`, "");
      if (e.audio?.path) md.push(`[Audio original](${e.audio.path})`, "");
      if (e.text) md.push(e.text, "");
      for (const r of e.resources) md.push(`- ${r.title}: ${r.url ?? r.path ?? ""}`);
      md.push("");
    }
  }
  const manifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: input.exportedAt,
    account: input.email,
    counts: { days: json.days.length, entries: input.entries.length, photos: input.photos.length, media: media.length },
    files: [{ path: "journal.json" }, { path: "journal.md" }, ...media.map((m) => ({ path: m.path, mime: m.mime, size: m.size }))],
  };
  return { manifest, json, markdown: md.join("\n"), media };
}
