import { useEffect, useState } from "react";
import type { DraftResource, Entry, EntryKind } from "../domain/model";

/**
 * In-memory editing session shared by the editor, labels and resources screens.
 * New entries are mirrored to the `drafts` table on every change (survive app close);
 * edits of existing entries apply only on Save.
 */
export interface EditSession {
  mode: "new" | "edit";
  id: string; // draft id (new) = future entry id, or entry id (edit)
  day: string;
  prompt?: string | null;
  kind: EntryKind;
  localTime: string;
  title: string;
  titleAuto: boolean;
  body: string;
  topics: string[];
  emotions: string[];
  resources: DraftResource[];
  removeContext: boolean;
  // read-only context for display
  city?: string | null;
  temperatureC?: number | null;
  weatherCondition?: Entry["weatherCondition"];
  audioUri?: string | null;
  audioDurationMs?: number | null;
  waveform?: number[] | null;
  original?: { title: string; body: string; topics: string[]; emotions: string[]; resources: string; removeContext: boolean };
}

let current: EditSession | null = null;
const listeners = new Set<() => void>();

export const editor = {
  get: () => current,
  start(s: EditSession) {
    current = s;
    listeners.forEach((l) => l());
  },
  update(patch: Partial<EditSession>) {
    if (!current) return;
    current = { ...current, ...patch };
    listeners.forEach((l) => l());
  },
  end() {
    current = null;
    listeners.forEach((l) => l());
  },
  dirty(): boolean {
    const c = current;
    if (!c?.original) return !!c && (c.title.trim() !== "" || c.body.trim() !== "" || c.resources.length > 0);
    const o = c.original;
    return (
      c.title !== o.title || c.body !== o.body || c.removeContext !== o.removeContext ||
      c.topics.join("|") !== o.topics.join("|") || c.emotions.join("|") !== o.emotions.join("|") ||
      JSON.stringify(c.resources) !== o.resources
    );
  },
};

export function fromEntry(e: Entry): EditSession {
  const topics = e.tags.filter((t) => t.kind === "topic").map((t) => t.name);
  const emotions = e.tags.filter((t) => t.kind === "emotion").map((t) => t.name);
  const resources: DraftResource[] = e.resources.map((r) => ({ id: r.id, kind: r.kind, title: r.title, url: r.url, fileId: r.fileId, fileUri: r.fileUri, status: r.status }));
  return {
    mode: "edit", id: e.id, day: e.day, kind: e.kind, localTime: e.localTime, title: e.titleAuto && e.kind === "audio" && !e.body ? e.title : e.title,
    titleAuto: e.titleAuto, body: e.body, topics, emotions, resources, removeContext: false, city: e.city, temperatureC: e.temperatureC,
    weatherCondition: e.weatherCondition, audioUri: e.audioUri, audioDurationMs: e.audioDurationMs, waveform: e.waveform,
    original: { title: e.title, body: e.body, topics, emotions, resources: JSON.stringify(resources), removeContext: false },
  };
}

export function useEditor(): EditSession | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return current;
}
