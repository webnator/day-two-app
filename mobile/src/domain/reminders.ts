import { addDays, type DayKey, parseDay } from "./dates";

/** Weekdays use Monday-first indexes 0..6. */
export interface JournalTime {
  id: string;
  at: string; // "HH:MM"
  days: number[];
}
export interface ReminderSettings {
  journalEnabled: boolean;
  times: JournalTime[];
  photoEnabled: boolean;
  from: string; // "HH:MM"
  to: string; // "HH:MM"
}
export const defaultReminderSettings = (): ReminderSettings => ({
  journalEnabled: false,
  times: [
    { id: "t1", at: "07:00", days: [0, 1, 2, 3, 4, 5, 6] },
    { id: "t2", at: "13:30", days: [0, 1, 2, 3, 4] },
  ],
  photoEnabled: false,
  from: "09:00",
  to: "20:00",
});

export const toMinutes = (at: string) => {
  const [h, m] = at.split(":").map(Number);
  return h * 60 + m;
};
export const fromMinutes = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

export function validWindow(from: string, to: string): boolean {
  return /^\d\d:\d\d$/.test(from) && /^\d\d:\d\d$/.test(to) && toMinutes(from) < toMinutes(to);
}

export interface WeeklySlot {
  identifier: string;
  weekday: number; // expo-notifications convention: 1 = Sunday … 7 = Saturday
  hour: number;
  minute: number;
}
/** One OS weekly trigger per distinct (weekday, time): overlapping schedules never duplicate. */
export function planJournal(s: ReminderSettings): WeeklySlot[] {
  if (!s.journalEnabled) return [];
  const seen = new Set<string>();
  const out: WeeklySlot[] = [];
  for (const t of s.times) {
    const [hour, minute] = t.at.split(":").map(Number);
    for (const d of [...t.days].sort()) {
      const weekday = ((d + 1) % 7) + 1; // Monday(0) → 2, Sunday(6) → 1
      const key = `${weekday}-${t.at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ identifier: `journal-${weekday}-${t.at.replace(":", "")}`, weekday, hour, minute });
    }
  }
  return out;
}

export interface PhotoPlanItem {
  at: string; // drawn local time, fixed once per day
  timeZone: string;
  fireAt: string; // ISO instant computed for timeZone
  identifier: string;
  state: "scheduled" | "cancelled" | "skipped";
}
export type PhotoPlan = Record<DayKey, PhotoPlanItem>;

export interface PhotoPlanInput {
  plan: PhotoPlan;
  settings: ReminderSettings;
  today: DayKey;
  now: Date;
  timeZone: string;
  hasPhoto: (day: DayKey) => boolean;
  rng: () => number;
  horizonDays?: number;
  /** Local wall time → instant in the current zone (DST handled by the platform). */
  toInstant?: (day: DayKey, at: string) => Date;
}
export interface PhotoPlanResult {
  plan: PhotoPlan;
  schedule: { identifier: string; fireAt: Date }[];
  cancel: string[];
}

export const localInstant = (day: DayKey, at: string): Date => {
  const { y, m, d } = parseDay(day);
  const [h, min] = at.split(":").map(Number);
  return new Date(y, m, d, h, min, 0, 0);
};

/**
 * Plan the random photo reminder. The random time is drawn once per day and kept:
 * opening the app again never re-draws it; a delivered or cancelled day is never re-armed,
 * so deleting the photo after the reminder does not trigger another one that day.
 */
export function planPhoto(input: PhotoPlanInput): PhotoPlanResult {
  const { settings, today, now, timeZone, hasPhoto, rng } = input;
  const toInstant = input.toInstant ?? localInstant;
  const horizon = input.horizonDays ?? 7;
  const plan: PhotoPlan = {};
  const schedule: PhotoPlanResult["schedule"] = [];
  const cancel: string[] = [];
  // Drop past days, keep history of today.
  for (const [day, item] of Object.entries(input.plan)) if (day >= today) plan[day] = { ...item };

  for (const [day, item] of Object.entries(plan)) {
    const pending = item.state === "scheduled" && new Date(item.fireAt) > now;
    if (!pending) continue;
    if (!settings.photoEnabled || hasPhoto(day)) {
      cancel.push(item.identifier);
      item.state = "cancelled";
    } else if (item.timeZone !== timeZone) {
      // Zone changed: same local wall time in the new zone, same identifier → replaces, never duplicates.
      const fire = toInstant(day, item.at);
      cancel.push(item.identifier);
      item.timeZone = timeZone;
      item.fireAt = fire.toISOString();
      if (fire > now) schedule.push({ identifier: item.identifier, fireAt: fire });
      else item.state = "skipped";
    }
  }
  if (!settings.photoEnabled) return { plan, schedule, cancel };

  const from = toMinutes(settings.from), to = toMinutes(settings.to);
  for (let i = 0; i < horizon; i++) {
    const day = addDays(today, i);
    if (plan[day] || hasPhoto(day)) continue;
    // Today: draw only within what is left of the window, so enabling late still gives a reminder.
    const nowMin = now.getHours() * 60 + now.getMinutes() + 1;
    const start = i === 0 ? Math.max(from, nowMin) : from;
    if (start >= to) {
      plan[day] = { at: fromMinutes(from), timeZone, fireAt: toInstant(day, fromMinutes(from)).toISOString(), identifier: `photo-${day}`, state: "skipped" };
      continue;
    }
    const at = fromMinutes(start + Math.floor(rng() * (to - start)));
    const fire = toInstant(day, at);
    const identifier = `photo-${day}`;
    const item: PhotoPlanItem = { at, timeZone, fireAt: fire.toISOString(), identifier, state: fire > now ? "scheduled" : "skipped" };
    plan[day] = item;
    if (item.state === "scheduled") schedule.push({ identifier, fireAt: fire });
  }
  return { plan, schedule, cancel };
}

/**
 * Window or switch changed: forget undelivered draws (pending or skipped) so the new window applies.
 * A reminder already delivered (scheduled and past) is kept: deleting the photo never re-arms that day.
 */
export function resetFuturePhotoPlan(plan: PhotoPlan, now: Date): { plan: PhotoPlan; cancel: string[] } {
  const next: PhotoPlan = {};
  const cancel: string[] = [];
  for (const [day, item] of Object.entries(plan)) {
    if (item.state === "scheduled" && new Date(item.fireAt) > now) cancel.push(item.identifier);
    else if (item.state === "skipped" || item.state === "cancelled") continue;
    else next[day] = item;
  }
  return { plan: next, cancel };
}
