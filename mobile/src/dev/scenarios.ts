// DEVELOPMENT ONLY: scenario → screen and data set, mirroring tools/visual/scenarios.js.
import type { Href } from "expo-router";

const today = "2026-10-05";
export const routes: Record<string, Href> = {
  empty: "/day/today", entries: "/day/today", photo: "/day/today", "photo-only": "/day/today", past: `/day/2025-10-05`,
  detail: "/entry/walk", processing: "/entry/walk", offline: "/entry/walk", error: "/entry/walk",
  "detail-bottom": "/entry/walk?scroll=bottom",
  edit: "/editor?mode=edit&id=walk", "edit-bottom": "/editor?mode=edit&id=walk&scroll=bottom",
  labels: "/editor?mode=edit&id=walk&next=labels", resources: "/editor?mode=edit&id=walk&next=resources",
  write: `/editor?mode=new&day=${today}`, record: `/record?day=${today}&still=1`, "record-paused": `/record?day=${today}&still=1&paused=1`,
  import: `/import?day=${today}&fixture=1`, access: "/access?email=hola@ejemplo.com", code: "/code?email=hola@ejemplo.com",
  settings: "/settings", reminders: "/settings/reminders", data: "/settings/data", account: "/settings/account",
  language: "/settings/language", location: "/settings/location", "manage-days": "/settings/manage-days",
  calendar: "/memories?tab=calendar", album: "/memories?tab=album", search: "/search", "photo-view": `/photo/${today}`,
  "photo-preview": `/photo-preview?day=${today}&fixture=1`,
  "sheet-create": "/day/today?sheet=create", "sheet-help": "/day/today?sheet=help", "sheet-photo": "/day/today?sheet=photo",
  "sheet-photo-menu": `/photo/${today}?sheet=menu`, "sheet-entry-menu": "/entry/walk?sheet=menu", "sheet-delete-entry": "/entry/walk?sheet=delete",
  "sheet-leave-draft": `/editor?mode=new&day=${today}&sheet=leave`, "sheet-leave-edit": "/editor?mode=edit&id=walk&sheet=leave",
  "sheet-leave-recording": `/record?day=${today}&still=1&sheet=leave`, "sheet-filters": "/search?sheet=filters",
  "sheet-add-tag": "/editor?mode=edit&id=walk&next=labels&sheet=addTopic", "sheet-photo-window": "/settings/reminders?sheet=window",
  "sheet-delete-account": "/settings/data?sheet=delete",
};
export const dataFor: Record<string, string> = {
  "detail-bottom": "entries", "edit-bottom": "entries", "record-paused": "entries", "sheet-create": "empty", "sheet-help": "empty",
  "sheet-photo": "entries", "sheet-photo-menu": "photo", "sheet-filters": "search",
};

