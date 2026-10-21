// Calendar dates of the journal are plain local date keys ("YYYY-MM-DD"). They are assigned once,
// when content is created, and never recomputed from instants: a timezone change cannot move a memory.
export type DayKey = string;
export type Lang = "es" | "en";

const MONTHS: Record<Lang, string[]> = {
  es: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};
const MONTHS_SHORT: Record<Lang, string[]> = {
  es: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"],
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
};
const WEEKDAYS: Record<Lang, string[]> = {
  // Monday first
  es: ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"],
  en: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
};
export const WEEKDAY_INITIALS: Record<Lang, string[]> = {
  es: ["L", "M", "X", "J", "V", "S", "D"],
  en: ["M", "T", "W", "T", "F", "S", "S"],
};

const pad = (n: number) => String(n).padStart(2, "0");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function dayKeyOf(date: Date): DayKey {
  // Local calendar date of the device at that instant.
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function timeOf(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function parseDay(day: DayKey): { y: number; m: number; d: number } {
  const [y, m, d] = day.split("-").map(Number);
  return { y, m: m - 1, d };
}
export function makeDay(y: number, m: number, d: number): DayKey {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}
/** Monday-first index (0 = Monday) of a calendar date, independent of any timezone. */
export function weekdayIndex(day: DayKey): number {
  const { y, m, d } = parseDay(day);
  return (new Date(Date.UTC(y, m, d)).getUTCDay() + 6) % 7;
}
export function addDays(day: DayKey, n: number): DayKey {
  const { y, m, d } = parseDay(day);
  const t = new Date(Date.UTC(y, m, d + n));
  return makeDay(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}
export function daysBetween(a: DayKey, b: DayKey): number {
  const pa = parseDay(a), pb = parseDay(b);
  return Math.round((Date.UTC(pb.y, pb.m, pb.d) - Date.UTC(pa.y, pa.m, pa.d)) / 86400000);
}

/** "5 de octubre" / "October 5" (+ year when asked). */
export function formatDate(day: DayKey, lang: Lang, withYear = false): string {
  const { y, m, d } = parseDay(day);
  if (lang === "en") return `${MONTHS.en[m]} ${d}${withYear ? `, ${y}` : ""}`;
  return `${d} de ${MONTHS.es[m]}${withYear ? ` de ${y}` : ""}`;
}
/** "Lunes, 5 de octubre" / "Monday, October 5". */
export function formatLongDate(day: DayKey, lang: Lang): string {
  return `${cap(WEEKDAYS[lang][weekdayIndex(day)])}, ${formatDate(day, lang)}`;
}
/** "5 oct" / "Oct 5". */
export function formatShortDate(day: DayKey, lang: Lang): string {
  const { m, d } = parseDay(day);
  return lang === "en" ? `${MONTHS_SHORT.en[m]} ${d}` : `${d} ${MONTHS_SHORT.es[m]}`;
}
/** Calendar heading: "Octubre de 2026" / "October 2026". */
export function formatMonthTitle(y: number, m: number, lang: Lang): string {
  return lang === "en" ? `${MONTHS.en[m]} ${y}` : `${cap(MONTHS.es[m])} de ${y}`;
}
/** Album group heading (lowercase in Spanish, as the mock renders Intl output): "octubre de 2026". */
export function formatMonthGroup(y: number, m: number, lang: Lang): string {
  return lang === "en" ? `${MONTHS.en[m]} ${y}` : `${MONTHS.es[m]} de ${y}`;
}

/** Relative reference computed at read time; never stored. */
export function relativeReference(day: DayKey, today: DayKey, lang: Lang): string {
  const diff = daysBetween(day, today);
  const a = parseDay(day), b = parseDay(today);
  const es = lang === "es";
  if (diff <= 0) return es ? "Hoy" : "Today";
  if (diff === 1) return es ? "Ayer" : "Yesterday";
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) months -= 1;
  const years = Math.floor(months / 12);
  if (years >= 1) return years === 1 ? (es ? "Hace un año" : "A year ago") : es ? `Hace ${years} años` : `${years} years ago`;
  if (months >= 1) return months === 1 ? (es ? "Hace un mes" : "A month ago") : es ? `Hace ${months} meses` : `${months} months ago`;
  if (diff >= 7) {
    const w = Math.floor(diff / 7);
    return w === 1 ? (es ? "Hace una semana" : "A week ago") : es ? `Hace ${w} semanas` : `${w} weeks ago`;
  }
  return es ? `Hace ${diff} días` : `${diff} days ago`;
}

/** Monday-first month grid: leading nulls then 1..N. */
export function monthCells(y: number, m: number): (number | null)[] {
  const first = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return [...Array(first).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

export function currentTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
