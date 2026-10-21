import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseSilences, planChunks, type Interval } from './languageRuns.js';

const execFileP = promisify(execFile);

export interface ProbeResult {
  formatName: string;
  durationSec: number;
}

// ffprobe format_name values we accept (wav, m4a/mp4, aac/ADTS, mp3, ogg/opus, flac, webm/mkv).
const ACCEPTED = new Set(['wav', 'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'aac', 'mp3', 'ogg', 'flac', 'matroska', 'webm']);

/** Returns null when the file is not a supported audio container with an audio stream. */
export async function probeAudio(ffprobeBin: string, file: string): Promise<ProbeResult | null> {
  try {
    const { stdout } = await execFileP(
      ffprobeBin,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const info = JSON.parse(stdout) as {
      format?: { format_name?: string; duration?: string };
      streams?: { codec_type?: string; duration?: string; disposition?: { attached_pic?: number } }[];
    };
    const names = (info.format?.format_name ?? '').split(',');
    if (!names.some((n) => ACCEPTED.has(n))) return null;
    const audio = info.streams?.find((s) => s.codec_type === 'audio');
    if (!audio) return null;
    // m4a/mp3 may carry cover art as a still "video" stream; real video is rejected.
    if (info.streams?.some((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)) return null;
    const durationSec = Number(info.format?.duration ?? audio.duration ?? 0);
    return { formatName: names[0]!, durationSec: Number.isFinite(durationSec) ? durationSec : 0 };
  } catch {
    return null;
  }
}

/** Converts any accepted input to 16 kHz mono PCM WAV, as whisper.cpp expects. */
export async function toWav16kMono(ffmpegBin: string, input: string, output: string, signal?: AbortSignal) {
  await execFileP(
    ffmpegBin,
    ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output],
    { timeout: 10 * 60_000, signal },
  );
}

/** 16 kHz mono FLAC: lossless for speech and ~5x smaller than WAV (fits inline requests). */
export async function toFlac16kMono(ffmpegBin: string, input: string, output: string, signal?: AbortSignal) {
  await execFileP(
    ffmpegBin,
    ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'flac', output],
    { timeout: 10 * 60_000, signal },
  );
}

/**
 * Splits a recording at pauses (threshold relative to its loudness, so quiet recordings still
 * split) into sentence-sized chunks. Returns null when there is nothing to split.
 */
export async function splitAtPauses(
  ffmpegBin: string,
  input: string,
  outPrefix: string,
  durationSec: number,
  opts: { signal?: AbortSignal; ext: 'wav' | 'flac'; minChunk?: number; maxChunk?: number },
): Promise<{ chunks: Interval[]; files: string[] } | null> {
  const ff = (args: string[]) =>
    execFileP(ffmpegBin, ['-nostdin', '-hide_banner', ...args], { timeout: 60_000, signal: opts.signal, maxBuffer: 16 * 1024 * 1024 });
  const vol = await ff(['-i', input, '-af', 'volumedetect', '-f', 'null', '-']);
  const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(vol.stderr)?.[1] ?? -25);
  const threshold = Math.max(-70, Math.min(-25, mean - 18));
  const sil = await ff(['-i', input, '-af', `silencedetect=noise=${threshold}dB:d=0.3`, '-f', 'null', '-']);
  const chunks = planChunks(parseSilences(sil.stderr), durationSec, { minChunk: opts.minChunk ?? 2.5, maxChunk: opts.maxChunk ?? 28 });
  if (chunks.length < 2) return null;
  const times = chunks.slice(1).map((c) => c.start.toFixed(3)).join(',');
  const codec = opts.ext === 'flac' ? ['-c:a', 'flac'] : ['-c', 'copy'];
  await ff(['-loglevel', 'error', '-y', '-i', input, '-f', 'segment', '-segment_times', times, ...codec, `${outPrefix}.c%03d.${opts.ext}`]);
  return { chunks, files: chunks.map((_, i) => `${outPrefix}.c${String(i).padStart(3, '0')}.${opts.ext}`) };
}
