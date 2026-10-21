import { AudioQuality, IOSOutputFormat, type RecordingOptions } from "expo-audio";
import { File } from "expo-file-system";
import { Platform } from "react-native";
import type { Journal } from "../data/journal";
import { repairWavHeader, wavDurationMs } from "../domain/wav";
import { emitChange } from "./events";

/**
 * iOS: 16-bit PCM WAV, mono 24 kHz — the header is repairable after an abrupt stop.
 * Android: AAC in an ADTS stream — a sequence of self-contained frames, readable up to the last one written.
 */
export const RECORDING: RecordingOptions = {
  extension: Platform.OS === "ios" ? ".wav" : ".aac",
  sampleRate: Platform.OS === "ios" ? 24000 : 44100,
  numberOfChannels: 1,
  bitRate: 96000,
  isMeteringEnabled: true,
  android: { outputFormat: "aac_adts", audioEncoder: "aac" },
  ios: {
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.HIGH,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {},
};
export const RECORDING_MIME = Platform.OS === "ios" ? "audio/wav" : "audio/aac";

/** Byte size of an AAC ADTS stream → approximate duration at 96 kbps. */
const adtsDurationMs = (size: number) => Math.round((size / (96000 / 8)) * 1000);

export async function fileDurationMs(uri: string, mime: string): Promise<number | null> {
  const f = new File(uri);
  if (!f.exists) return null;
  const size = f.size ?? 0;
  if (mime === "audio/wav") {
    const h = f.open();
    try {
      const head = h.readBytes(Math.min(size, 4096));
      return wavDurationMs(head, size);
    } finally {
      h.close();
    }
  }
  return adtsDurationMs(size);
}

/** Rewrites a WAV header whose sizes were never finalized (app killed while recording). */
export function repairWav(uri: string): boolean {
  const f = new File(uri);
  if (!f.exists) return false;
  const size = f.size ?? 0;
  const h = f.open();
  try {
    const head = h.readBytes(Math.min(size, 4096));
    const fixed = repairWavHeader(head, size);
    if (!fixed) return false;
    h.offset = 0;
    h.writeBytes(fixed.subarray(0, Math.min(fixed.length, 4096)));
    return true;
  } finally {
    h.close();
  }
}

/**
 * At launch: recordings left open by a crash or kill become audio entries (nothing already
 * written is lost). A recording with no audio on disk is dropped.
 */
export async function recoverRecordings(journal: Journal, title = "Una nota de voz"): Promise<number> {
  const open = await journal.openRecordings();
  let recovered = 0;
  for (const r of open) {
    try {
      if (!r.file_id) {
        const temp = new File(r.temp_uri);
        if (!temp.exists || (temp.size ?? 0) < 64) {
          await journal.discardRecording(r.id, () => undefined);
          continue;
        }
        if (r.mime === "audio/wav") repairWav(r.temp_uri);
        await journal.attachRecordingFile(r.id, r.mime === "audio/wav" ? ".wav" : ".aac");
      }
      const audio = await journal.db.first<{ rel_path: string }>("SELECT f.rel_path FROM recordings r JOIN files f ON f.id = r.file_id WHERE r.id = ?", [r.id]);
      const duration = audio ? await fileDurationMs(journal.files.uri(audio.rel_path), r.mime) : null;
      await journal.finishRecording(r.id, duration ?? 0, title);
      recovered++;
    } catch {
      // Leave the row for the next launch; never delete audio we could not process.
    }
  }
  if (recovered) emitChange();
  return recovered;
}

/** Downsamples metering samples (dBFS) into `count` normalized peaks for the waveform. */
export function peaksFrom(samples: number[], count = 39): number[] {
  if (!samples.length) return [];
  const norm = samples.map((db) => Math.max(0, Math.min(1, (db + 55) / 50)));
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = Math.floor((i * norm.length) / count);
    const b = Math.max(a + 1, Math.floor(((i + 1) * norm.length) / count));
    out.push(+Math.max(...norm.slice(a, b)).toFixed(3));
  }
  return out;
}
