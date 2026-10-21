import type { EntryTag, TagKind } from "./model";

export function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Title used when the person leaves it empty. The body is never altered. */
export function deriveTitle(title: string, body: string, hasResources: boolean, fallback: string): { title: string; auto: boolean } {
  const t = title.trim();
  if (t) return { title: t, auto: false };
  const first = body.trim().split(/[.\n!?]/)[0]?.trim().slice(0, 70) ?? "";
  if (first) return { title: first, auto: true };
  return { title: fallback, auto: true };
}

/** A completely empty draft must not create an accidental entry. */
export function isSavable(title: string, body: string, resourceCount: number): boolean {
  return Boolean(title.trim() || body.trim() || resourceCount > 0);
}

export interface TranscriptTarget {
  exists: boolean;
  bodyRevision: number;
  bodyManual: boolean;
}
export type TranscriptDecision = "apply" | "alternative" | "discard";

/**
 * Decide what to do with an automatic transcript that arrives for `jobRevision`.
 * - Deleted entry → discard (never resurrect).
 * - Manual correction or newer revision → keep only as alternative, never replace.
 */
export function decideTranscript(target: TranscriptTarget, jobRevision: number): TranscriptDecision {
  if (!target.exists) return "discard";
  if (target.bodyManual || target.bodyRevision !== jobRevision) return "alternative";
  return "apply";
}

export interface Suggestions {
  topics: string[];
  emotions: string[];
}

/**
 * Merge a classification result into the current tags of an entry.
 * Manual tags always stay; previous automatic suggestions are recomputed; rejected
 * names are never reintroduced; a name already present (any origin) is not duplicated.
 */
export function mergeSuggestions(
  current: EntryTag[],
  suggestions: Suggestions,
  rejected: { kind: TagKind; norm: string }[],
): { keep: EntryTag[]; add: { kind: TagKind; name: string }[]; removeSuggested: EntryTag[] } {
  const manual = current.filter((t) => t.origin === "manual");
  const suggested = current.filter((t) => t.origin === "suggested");
  const isRejected = (kind: TagKind, name: string) => rejected.some((r) => r.kind === kind && r.norm === normalize(name));
  const wanted: { kind: TagKind; name: string }[] = [];
  const push = (kind: TagKind, name: string) => {
    const n = normalize(name);
    if (!n || isRejected(kind, name)) return;
    if (manual.some((t) => t.kind === kind && normalize(t.name) === n)) return;
    if (wanted.some((w) => w.kind === kind && normalize(w.name) === n)) return;
    wanted.push({ kind, name: name.trim() });
  };
  suggestions.topics.slice(0, 3).forEach((n) => push("topic", n));
  suggestions.emotions.slice(0, 3).forEach((n) => push("emotion", n));
  const keepSuggested = suggested.filter((t) => wanted.some((w) => w.kind === t.kind && normalize(w.name) === normalize(t.name)));
  const removeSuggested = suggested.filter((t) => !keepSuggested.includes(t));
  const add = wanted.filter((w) => !keepSuggested.some((t) => t.kind === w.kind && normalize(t.name) === normalize(w.name)));
  return { keep: [...manual, ...keepSuggested], add, removeSuggested };
}

/** Accepts only http(s) URLs; returns the normalized href or null. */
export function validateLink(raw: string): string | null {
  const s = raw.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    // URL is available in Hermes; fall back to the raw value if parsing is unavailable.
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}
