// DEVELOPMENT ONLY — visual comparison harness. Reproduces mock/model.js `fixture(name)` inside a
// throwaway account ("visual-fixture") with the clock frozen at the mock's moment (5 Oct 2026, 21:06).
// Never reachable in release builds (guarded by __DEV__ in the route). Not product data.
import { Asset } from "expo-asset";
import { Directory, Paths } from "expo-file-system";
import type { Clock, Journal } from "../data/journal";
import { openJournal, wipeAccount } from "../services/storage";

export let FIXTURE_USER = "visual-fixture";
export const fixtureClock: Clock = {
  now: () => new Date(2026, 9, 5, 21, 6, 0),
  timeZone: () => "Europe/Madrid",
};

const sampleText =
  "Hoy me hizo bien salir a caminar con la niña. Estuve más presente y me reí mucho con ella.\n\nAl volver seguía preocupado por la reunión de mañana. No tengo claro cómo plantearla, pero ahora la siento un poco más pequeña.\n\nQuería dejar esto aquí: hoy hubo preocupación, y también un rato muy bueno.";

async function assetUri(mod: number): Promise<string> {
  const a = Asset.fromModule(mod);
  await a.downloadAsync();
  return a.localUri!;
}

let chain: Promise<unknown> = Promise.resolve();
/** Seeds are serialized: a scenario never starts while the previous one is still writing. */
export function seedFixture(name: string): Promise<Journal> {
  const run = chain.then(() => seed(name), () => seed(name));
  chain = run.catch(() => undefined);
  return run;
}

async function seed(name: string): Promise<Journal> {
  // A fresh throwaway account per scenario: never reuses a connection to a deleted database.
  const previous = FIXTURE_USER;
  FIXTURE_USER = `visual-${Date.now()}`;
  await wipeAccount(previous).catch(() => undefined);
  const root = new Directory(Paths.document, "accounts");
  if (root.exists) for (const d of root.list()) if (d instanceof Directory && d.name.startsWith("visual-") && d.name !== FIXTURE_USER) { try { d.delete(); } catch {} }
  const j = await openJournal(FIXTURE_USER, fixtureClock);
  const photoSrc = await assetUri(require("../../assets/fixtures/daily-photo.png"));
  const audioSrc = await assetUri(require("../../assets/fixtures/walk.m4a"));
  const db = j.db;
  const now = "2026-10-05T19:06:00.000Z";

  const addPhoto = async (day: string) => {
    const f = await j.importFile(photoSrc, "photos", ".png", "image/png");
    await db.run("INSERT OR REPLACE INTO day_photos (day, file_id, local_time, time_zone, width, height, created_at) VALUES (?,?,?,?,?,?,?)", [day, f.id, "09:08", "Europe/Madrid", 1536, 1024, now]);
  };
  const tag = async (entryId: string, kind: "topic" | "emotion", name: string, pos: number) => {
    const norm = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    let t = await db.first<{ id: string }>("SELECT id FROM tags WHERE kind = ? AND norm = ?", [kind, norm]);
    if (!t) {
      await db.run("INSERT INTO tags (id, kind, name, norm) VALUES (?,?,?,?)", [`${kind}-${norm}`, kind, name, norm]);
      t = { id: `${kind}-${norm}` };
    }
    await db.run("INSERT OR IGNORE INTO entry_tags (entry_id, tag_id, origin, position) VALUES (?,?, 'suggested', ?)", [entryId, t.id, pos]);
  };
  const textEntry = async (id: string, day: string, title: string, body: string) => {
    await db.run(
      `INSERT INTO entries (id, day, created_at, time_zone, local_time, kind, origin, title, title_auto, body, body_revision, body_manual, transcript_status, context_status, updated_at)
       VALUES (?,?,?,?, '09:12', 'text', 'written', ?, 0, ?, 1, 1, 'none', 'none', ?)`,
      [id, day, now, "Europe/Madrid", title, body, now],
    );
    await tag(id, "topic", "Familia", 0);
    await tag(id, "emotion", "Alegría", 1);
  };
  const audioEntry = async (id: string, day: string, status: string) => {
    const f = await j.importFile(audioSrc, "audio", ".m4a", "audio/mp4");
    await db.run(
      `INSERT INTO entries (id, day, created_at, time_zone, local_time, kind, origin, title, title_auto, body, body_revision, body_manual, transcript_auto,
        transcript_status, audio_file_id, audio_duration_ms, city, temperature_c, weather_condition, context_status, updated_at)
       VALUES (?,?,?,?, '20:48', 'audio', 'recorded', 'Después del paseo', 0, ?, 1, 0, ?, ?, ?, 154000, 'Madrid', 18, 'cloudy', 'resolved', ?)`,
      [id, day, now, "Europe/Madrid", status === "ready" ? sampleText : "", status === "ready" ? sampleText : null, status, f.id, now],
    );
    if (status === "ready") {
      await tag(id, "topic", "Familia", 0);
      await tag(id, "topic", "Trabajo", 1);
      await tag(id, "emotion", "Alegría", 2);
      await tag(id, "emotion", "Preocupación", 3);
      await db.run(
        "INSERT INTO resources (id, entry_id, kind, title, url, status, position, created_at) VALUES (?,?, 'link', 'El valor de estar presente', 'https://ejemplo.com/podcast', 'ready', 0, ?)",
        [id + "-podcast", id, now],
      );
    }
  };

  const today = "2026-10-05";
  if (name !== "empty" && name !== "photo-only") {
    await textEntry("breakfast", today, "Un desayuno sin prisa", "Dejé el móvil lejos. La niña me contó su sueño. Quería recordar esta mañana.");
    await audioEntry("walk", today, ["processing", "offline", "error"].includes(name) ? name : "ready");
  }
  if (["photo", "photo-only", "past", "calendar", "album"].includes(name)) await addPhoto(today);
  if (["past", "calendar", "album", "search"].includes(name)) {
    for (const d of ["2026-10-01", "2026-10-02", "2026-10-04", "2026-09-30", "2025-10-05"]) await addPhoto(d);
    await audioEntry("old-walk", "2025-10-05", "ready");
    await textEntry("first-day", "2026-10-01", "El camino de vuelta", "Dimos un paseo con la niña antes de volver.");
  }
  // The mock's filter vocabulary (mock/app.js filters sheet) as catalog tags.
  for (const [kind, name] of [["topic", "Descanso"], ["emotion", "Tranquilidad"]] as const) {
    const norm = name.toLowerCase();
    await db.run("INSERT OR IGNORE INTO tags (id, kind, name, norm) VALUES (?,?,?,?)", [`${kind}-${norm}`, kind, name, norm]);
  }
  // Mock settings for reminders/location screens.
  await j.set("reminders", {
    journalEnabled: true,
    times: [
      { id: "t1", at: "07:00", days: [0, 1, 2, 3, 4, 5, 6] },
      { id: "t2", at: "13:30", days: [0, 1, 2, 3, 4] },
    ],
    photoEnabled: true,
    from: "09:00",
    to: "20:00",
  });
  await j.set("locationEnabled", true);
  return j;
}

/** Which mock data set each scenario uses (mock/app.js `seedFor`). */
export function seedFor(s: string): string {
  if (["empty", "photo", "photo-only", "past", "calendar", "album", "search", "processing", "offline", "error", "entries"].includes(s)) return s;
  return s === "photo-view" ? "photo" : "entries";
}
