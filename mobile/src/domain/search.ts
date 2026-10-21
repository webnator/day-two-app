import type { DayKey } from "./dates";
import { normalize } from "./rules";

export interface SearchFilters {
  topics: string[];
  emotions: string[];
  from: DayKey | "";
  to: DayKey | "";
}
export const emptyFilters = (): SearchFilters => ({ topics: [], emotions: [], from: "", to: "" });

export interface Searchable {
  id: string;
  day: DayKey;
  localTime: string;
  title: string;
  body: string; // current (corrected) text — never the stale automatic transcript
  tags: { kind: "topic" | "emotion"; name: string }[];
}

/** OR inside a category, AND across categories and dates. Newest first. */
export function search<T extends Searchable>(items: T[], query: string, f: SearchFilters): T[] {
  const q = normalize(query);
  const words = q.split(/\s+/).filter(Boolean);
  const inAny = (item: T, kind: "topic" | "emotion", wanted: string[]) =>
    !wanted.length || item.tags.some((t) => t.kind === kind && wanted.some((w) => normalize(w) === normalize(t.name)));
  return items
    .filter((e) => {
      const text = normalize(e.title + " " + e.body);
      return (
        words.every((w) => text.includes(w)) &&
        inAny(e, "topic", f.topics) &&
        inAny(e, "emotion", f.emotions) &&
        (!f.from || e.day >= f.from) &&
        (!f.to || e.day <= f.to)
      );
    })
    .sort((a, b) => (b.day + b.localTime).localeCompare(a.day + a.localTime));
}

export function hasFilters(f: SearchFilters): boolean {
  return Boolean(f.topics.length || f.emotions.length || f.from || f.to);
}
