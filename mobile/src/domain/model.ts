import type { DayKey } from "./dates";

export type EntryKind = "text" | "audio";
export type EntryOrigin = "written" | "recorded" | "imported";
export type TranscriptStatus = "none" | "pending" | "offline" | "processing" | "ready" | "error";
export interface TranscriptSpan { start: number; end: number }
export type ContextStatus = "none" | "pending" | "resolved" | "unavailable" | "removed";
export type TagKind = "topic" | "emotion";
export type TagOrigin = "suggested" | "manual";
export type WeatherCondition = "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "storm";

export interface Tag {
  id: string;
  kind: TagKind;
  name: string;
}
export interface EntryTag extends Tag {
  origin: TagOrigin;
}

export interface Resource {
  id: string;
  entryId: string;
  kind: "link" | "image" | "video";
  title: string;
  url?: string | null;
  fileId?: string | null;
  fileUri?: string | null;
  status: "ready" | "error";
  position: number;
}

export interface Entry {
  id: string;
  day: DayKey;
  createdAt: string; // ISO UTC instant of creation
  timeZone: string; // IANA zone where it was created
  localTime: string; // "HH:MM" local time at creation (display)
  kind: EntryKind;
  origin: EntryOrigin;
  title: string;
  titleAuto: boolean;
  body: string; // current reading text (written text or edited transcript)
  bodyRevision: number;
  bodyManual: boolean; // true once the person edited the transcript/text after automatic processing
  transcriptAuto?: string | null; // latest automatic transcript, stored apart from the reading text
  transcriptAlternative?: string | null; // a late automatic result that arrived after a manual correction
  transcriptUncertain?: TranscriptSpan[];
  transcriptAlternativeUncertain?: TranscriptSpan[];
  transcriptLanguage?: string | null;
  transcriptStatus: TranscriptStatus;
  audioFileId?: string | null;
  audioUri?: string | null;
  audioDurationMs?: number | null;
  waveform?: number[] | null; // normalized peaks captured while recording
  city?: string | null;
  temperatureC?: number | null;
  weatherCondition?: WeatherCondition | null;
  contextStatus: ContextStatus;
  updatedAt: string;
  tags: EntryTag[];
  resources: Resource[];
}

export interface DayPhoto {
  day: DayKey;
  fileId: string;
  uri: string;
  localTime: string;
  city?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface DraftResource {
  id: string;
  kind: "link" | "image" | "video";
  title: string;
  url?: string | null;
  fileId?: string | null;
  fileUri?: string | null;
  status: "ready" | "error";
}

export interface Draft {
  id: string;
  day: DayKey;
  prompt?: string | null;
  title: string;
  body: string;
  resources: DraftResource[];
  updatedAt: string;
}
