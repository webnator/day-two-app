import { describe, expect, it } from "vitest";
import {
  formatDate, formatLongDate, formatMonthGroup, formatMonthTitle, formatShortDate, monthCells, relativeReference, weekdayIndex,
} from "../domain/dates";
import { pickForDay, seeded } from "../domain/illustrations";
import { defaultReminderSettings, localInstant, planJournal, planPhoto, resetFuturePhotoPlan } from "../domain/reminders";
import { deriveTitle, isSavable, validateLink } from "../domain/rules";
import { emptyFilters, search } from "../domain/search";
import { repairWavHeader, wavDurationMs } from "../domain/wav";

describe("dates (A22)", () => {
  it("formats like the mock", () => {
    expect(formatLongDate("2026-10-05", "es")).toBe("Lunes, 5 de octubre");
    expect(formatDate("2026-10-05", "es")).toBe("5 de octubre");
    expect(formatDate("2026-10-05", "es", true)).toBe("5 de octubre de 2026");
    expect(formatShortDate("2026-10-05", "es")).toBe("5 oct");
    expect(formatMonthTitle(2026, 9, "es")).toBe("Octubre de 2026");
    expect(formatMonthGroup(2026, 9, "es")).toBe("octubre de 2026");
    expect(formatLongDate("2026-10-05", "en")).toBe("Monday, October 5");
  });
  it("October 2026 starts on Thursday; the 5th is a Monday; leap February 2028", () => {
    expect(monthCells(2026, 9).slice(0, 4)).toEqual([null, null, null, 1]);
    expect(weekdayIndex("2026-10-05")).toBe(0);
    expect(monthCells(2028, 1).filter(Boolean)).toHaveLength(29);
    expect(monthCells(2027, 1).filter(Boolean)).toHaveLength(28);
  });
  it("relative reference is computed at read time", () => {
    expect(relativeReference("2025-10-05", "2026-10-05", "es")).toBe("Hace un año");
    expect(relativeReference("2024-10-05", "2026-10-05", "es")).toBe("Hace 2 años");
    expect(relativeReference("2026-10-04", "2026-10-05", "es")).toBe("Ayer");
    expect(relativeReference("2026-09-05", "2026-10-05", "es")).toBe("Hace un mes");
    expect(relativeReference("2026-09-28", "2026-10-05", "es")).toBe("Hace una semana");
  });
});

describe("titles and validation", () => {
  it("derives a title without touching the body; empty never saves", () => {
    expect(deriveTitle("", "Un desayuno sin prisa. Luego…", false, "Un momento guardado")).toEqual({ title: "Un desayuno sin prisa", auto: true });
    expect(deriveTitle("  ", "", true, "Un momento guardado")).toEqual({ title: "Un momento guardado", auto: true });
    expect(isSavable("", "  ", 0)).toBe(false);
    expect(isSavable("", "", 1)).toBe(true);
  });
  it("only http(s) links", () => {
    expect(validateLink("https://ejemplo.com/podcast")).toBe("https://ejemplo.com/podcast");
    expect(validateLink("javascript:alert(1)")).toBeNull();
    expect(validateLink("ftp://x.com")).toBeNull();
  });
});

describe("search (A25)", () => {
  const items = [
    { id: "a", day: "2026-09-10", localTime: "10:00", title: "Reunión", body: "curro y preocupación", tags: [{ kind: "topic" as const, name: "Trabajo" }, { kind: "emotion" as const, name: "Preocupación" }] },
    { id: "b", day: "2026-09-12", localTime: "10:00", title: "Paseo", body: "con la niña", tags: [{ kind: "topic" as const, name: "Familia" }, { kind: "emotion" as const, name: "Alegría" }] },
    { id: "c", day: "2026-10-01", localTime: "10:00", title: "Cena", body: "familia, preocupado", tags: [{ kind: "topic" as const, name: "Familia" }, { kind: "emotion" as const, name: "Preocupación" }] },
  ];
  it("OR within a category, AND across categories and dates", () => {
    const f = { ...emptyFilters(), topics: ["Familia", "Trabajo"], emotions: ["Preocupación"], from: "2026-09-01", to: "2026-09-30" };
    expect(search(items, "", f).map((e) => e.id)).toEqual(["a"]);
    expect(search(items, "", { ...f, to: "" }).map((e) => e.id)).toEqual(["c", "a"]);
  });
  it("text search ignores accents and case and uses the corrected body", () => {
    expect(search(items, "NIÑA", emptyFilters()).map((e) => e.id)).toEqual(["b"]);
    expect(search(items, "reunion", emptyFilters()).map((e) => e.id)).toEqual(["a"]);
  });
});

describe("illustrations (A27)", () => {
  const bank = Array.from({ length: 32 }, (_, i) => `i${i}`);
  it("stable during a day, no repeats within a cycle, new cycle does not start with the last", () => {
    const rng = seeded(7);
    let { id, state } = pickForDay(null, "2026-10-05", bank, rng);
    expect(pickForDay(state, "2026-10-05", bank, rng).id).toBe(id);
    const seen = [id];
    let day = "2026-10-05";
    for (let i = 1; i < bank.length; i++) {
      day = `2026-11-${String(i).padStart(2, "0")}`;
      ({ id, state } = pickForDay(state, day, bank, rng));
      seen.push(id);
    }
    expect(new Set(seen).size).toBe(bank.length);
    const last = id;
    const next = pickForDay(state, "2027-01-01", bank, rng);
    expect(next.id).not.toBe(last);
  });
});

describe("reminders (A29–A32)", () => {
  const settings = { ...defaultReminderSettings(), journalEnabled: true, photoEnabled: true };
  it("journal: several times and weekdays, no duplicate triggers", () => {
    const slots = planJournal({ ...settings, times: [{ id: "a", at: "07:00", days: [0, 1, 2, 3, 4, 5, 6] }, { id: "b", at: "07:00", days: [0, 1] }] });
    expect(slots).toHaveLength(7);
    expect(slots.find((s) => s.weekday === 2)).toMatchObject({ hour: 7, minute: 0 }); // Monday
  });
  it("photo: one random time per day inside the window, kept on reopen", () => {
    const now = new Date(2026, 9, 5, 8, 0);
    const r1 = planPhoto({ plan: {}, settings, today: "2026-10-05", now, timeZone: "Europe/Madrid", hasPhoto: () => false, rng: seeded(1) });
    expect(r1.schedule).toHaveLength(7);
    const at = r1.plan["2026-10-05"].at;
    expect(at >= "09:00" && at < "20:00").toBe(true);
    const r2 = planPhoto({ plan: r1.plan, settings, today: "2026-10-05", now, timeZone: "Europe/Madrid", hasPhoto: () => false, rng: seeded(99) });
    expect(r2.plan["2026-10-05"].at).toBe(at);
    expect(r2.schedule).toHaveLength(0);
  });
  it("saving the photo cancels; deleting it after delivery does not re-arm", () => {
    const now = new Date(2026, 9, 5, 8, 0);
    const r1 = planPhoto({ plan: {}, settings, today: "2026-10-05", now, timeZone: "Europe/Madrid", hasPhoto: () => false, rng: seeded(1) });
    const withPhoto = planPhoto({ plan: r1.plan, settings, today: "2026-10-05", now, timeZone: "Europe/Madrid", hasPhoto: (d) => d === "2026-10-05", rng: seeded(2) });
    expect(withPhoto.cancel).toEqual(["photo-2026-10-05"]);
    const later = new Date(2026, 9, 5, 21, 0); // after delivery, photo deleted
    const after = planPhoto({ plan: r1.plan, settings, today: "2026-10-05", now: later, timeZone: "Europe/Madrid", hasPhoto: () => false, rng: seeded(3) });
    expect(after.schedule.find((s) => s.identifier === "photo-2026-10-05")).toBeUndefined();
  });
  it("timezone change keeps the local time and the identifier (no duplicates); DST handled by local instant", () => {
    const now = new Date(2026, 9, 5, 8, 0);
    const r1 = planPhoto({ plan: {}, settings, today: "2026-10-05", now, timeZone: "Europe/Madrid", hasPhoto: () => false, rng: seeded(1) });
    const moved = planPhoto({ plan: r1.plan, settings, today: "2026-10-05", now, timeZone: "Europe/London", hasPhoto: () => false, rng: seeded(5) });
    expect(new Set(moved.schedule.map((s) => s.identifier)).size).toBe(moved.schedule.length);
    expect(moved.plan["2026-10-06"].at).toBe(r1.plan["2026-10-06"].at);
    // 25 Oct 2026 is the European DST change: one plan item per day regardless
    const dst = planPhoto({ plan: {}, settings, today: "2026-10-24", now: new Date(2026, 9, 24, 0, 0), timeZone: "Europe/Madrid", hasPhoto: () => false, rng: seeded(4), horizonDays: 3 });
    expect(Object.keys(dst.plan)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
    expect(localInstant("2026-10-25", "10:00").getHours()).toBe(10);
  });
  it("enabling late in the day draws within the rest of today's window", () => {
    const now = new Date(2026, 9, 5, 18, 0);
    const r = planPhoto({ plan: {}, settings, today: "2026-10-05", now, timeZone: "Europe/Madrid", hasPhoto: () => false, rng: seeded(3) });
    const item = r.plan["2026-10-05"];
    expect(item.state).toBe("scheduled");
    expect(item.at >= "18:01" && item.at < "20:00").toBe(true);
    const late = planPhoto({ plan: {}, settings, today: "2026-10-05", now: new Date(2026, 9, 5, 20, 30), timeZone: "Europe/Madrid", hasPhoto: () => false, rng: seeded(3) });
    expect(late.plan["2026-10-05"].state).toBe("skipped");
  });
  it("a delivered reminder survives a window change; skipped days are redrawn", () => {
    const morning = new Date(2026, 9, 5, 8, 0);
    const r1 = planPhoto({ plan: {}, settings, today: "2026-10-05", now: morning, timeZone: "Europe/Madrid", hasPhoto: () => false, rng: seeded(1) });
    const evening = new Date(2026, 9, 5, 21, 0); // today's was delivered
    const reset = resetFuturePhotoPlan(r1.plan, evening);
    expect(reset.plan["2026-10-05"].state).toBe("scheduled");
    const skipped = { "2026-10-05": { ...r1.plan["2026-10-05"], state: "skipped" as const } };
    expect(resetFuturePhotoPlan(skipped, evening).plan["2026-10-05"]).toBeUndefined();
  });
  it("window change resets only undelivered future draws", () => {
    const now = new Date(2026, 9, 5, 8, 0);
    const r1 = planPhoto({ plan: {}, settings, today: "2026-10-05", now, timeZone: "Europe/Madrid", hasPhoto: () => false, rng: seeded(1) });
    const reset = resetFuturePhotoPlan(r1.plan, now);
    expect(reset.cancel).toHaveLength(7);
    expect(Object.keys(reset.plan)).toHaveLength(0);
  });
});

describe("wav repair (A06)", () => {
  it("rewrites sizes of a truncated recording", () => {
    const h = new Uint8Array(44);
    const v = new DataView(h.buffer);
    h.set([82, 73, 70, 70], 0); h.set([87, 65, 86, 69], 8); h.set([102, 109, 116, 32], 12);
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 24000, true); v.setUint32(28, 48000, true);
    h.set([100, 97, 116, 97], 36); v.setUint32(40, 0, true);
    const fixed = repairWavHeader(h, 44 + 48000 * 3)!;
    expect(new DataView(fixed.buffer).getUint32(40, true)).toBe(48000 * 3);
    expect(wavDurationMs(fixed, 44 + 48000 * 3)).toBe(3000);
  });
});
