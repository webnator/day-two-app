import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { strToU8, zipSync, type Zippable } from "fflate";
import type { Journal } from "../data/journal";
import { buildExport } from "../domain/exportFormat";

/**
 * Exports the whole journal of this account to a zip and opens the system share sheet.
 * Contents: manifest.json (format + version + file list), journal.json (structured), journal.md
 * (readable), and media/ with the original audio, day photos and resource files (relative paths).
 */
export async function exportJournal(j: Journal, email: string): Promise<void> {
  const [entries, photos] = await Promise.all([j.allEntries(), j.photos()]);
  const fileRows = await j.db.all<{ id: string; rel_path: string; mime: string; size: number }>("SELECT id, rel_path, mime, size FROM files");
  const { manifest, json, markdown, media } = buildExport({ entries, photos, files: fileRows, email, exportedAt: new Date().toISOString() });
  const zip: Zippable = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "journal.json": strToU8(JSON.stringify(json, null, 2)),
    "journal.md": strToU8(markdown),
  };
  for (const m of media) {
    const f = new File(j.files.uri(m.source));
    if (!f.exists) continue;
    zip[m.path] = [f.bytesSync(), { level: 0 }]; // media is already compressed
  }
  const out = new File(Paths.cache, `day-two-${manifest.exportedAt.slice(0, 10)}.zip`);
  if (out.exists) out.delete();
  out.create();
  out.write(zipSync(zip));
  await Sharing.shareAsync(out.uri, { mimeType: "application/zip", dialogTitle: "Day Two", UTI: "public.zip-archive" });
}
