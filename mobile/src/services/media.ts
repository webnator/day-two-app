import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";

export class PermissionDenied extends Error {}
export class Unavailable extends Error {}

export interface Picked {
  uri: string;
  width?: number;
  height?: number;
  mime: string;
  ext: string;
  name?: string;
  size?: number;
  durationMs?: number | null;
}

const extOf = (name: string | null | undefined, fallback: string) => {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name ?? "");
  return m ? "." + m[1].toLowerCase() : fallback;
};

/** Camera or library, original quality (no destructive crop: presentation crop is done when displaying). */
export async function pickImage(source: "camera" | "library", kind: "image" | "video" = "image"): Promise<Picked | null> {
  if (source === "camera") {
    const p = await ImagePicker.requestCameraPermissionsAsync();
    if (!p.granted) throw new PermissionDenied();
  }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: [kind === "image" ? "images" : "videos"], quality: 1, allowsEditing: false, exif: false };
  let r: ImagePicker.ImagePickerResult;
  try {
    r = source === "camera" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  } catch (e) {
    if (source === "camera") throw new Unavailable();
    throw e;
  }
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  const mime = a.mimeType ?? (kind === "image" ? "image/jpeg" : "video/mp4");
  return { uri: a.uri, width: a.width, height: a.height, mime, ext: extOf(a.fileName ?? a.uri, kind === "image" ? ".jpg" : ".mp4"), name: a.fileName ?? undefined, size: a.fileSize, durationMs: a.duration ?? null };
}

export const AUDIO_EXTS = [".m4a", ".mp3", ".wav", ".aac", ".ogg", ".opus", ".flac", ".webm", ".mp4", ".caf"];
export const MAX_AUDIO_MB = 50;

export type AudioPick = { ok: true; file: Picked } | { ok: false; reason: "cancel" | "format" | "size" };

/** Native file picker. Cancelling creates nothing. The file is copied so the original stays untouched. */
export async function pickAudio(): Promise<AudioPick> {
  const r = await DocumentPicker.getDocumentAsync({ type: ["audio/*", "video/mp4"], copyToCacheDirectory: true, multiple: false });
  if (r.canceled || !r.assets?.[0]) return { ok: false, reason: "cancel" };
  const a = r.assets[0];
  const ext = extOf(a.name, "");
  const mimeOk = (a.mimeType ?? "").startsWith("audio/") || a.mimeType === "video/mp4";
  if (!AUDIO_EXTS.includes(ext) && !mimeOk) return { ok: false, reason: "format" };
  if ((a.size ?? 0) > MAX_AUDIO_MB * 1024 * 1024) return { ok: false, reason: "size" };
  return { ok: true, file: { uri: a.uri, mime: a.mimeType ?? "audio/mp4", ext: ext || ".m4a", name: a.name, size: a.size } };
}
