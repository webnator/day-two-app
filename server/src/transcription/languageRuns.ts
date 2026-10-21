/**
 * Code-switching support for whisper.cpp in auto mode.
 *
 * whisper detects ONE language per decode. Evaluated on this machine (docs/EVAL-TRANSCRIPTION.md):
 * when a recording starts in English and continues in Spanish, the whole clip is detected as
 * Spanish and the English sentence is silently dropped. To avoid omissions we split the audio at
 * pauses, detect the language of each chunk, and decode each same-language run separately.
 */

export interface Interval {
  start: number;
  end: number;
}

/** Pauses (from ffmpeg silencedetect) -> detection chunks of roughly sentence size. */
export function planChunks(silences: Interval[], durationSec: number, opts = { minChunk: 2.5, maxChunk: 28 }): Interval[] {
  const cuts = silences
    .map((s) => (s.start + s.end) / 2)
    .filter((c) => c > 0.2 && c < durationSec - 0.2)
    .sort((a, b) => a - b);
  const chunks: Interval[] = [];
  let start = 0;
  for (const c of [...cuts, durationSec]) {
    // Hard-split overlong stretches without pauses (detection only looks at 30 s windows).
    while (c - start > opts.maxChunk) {
      chunks.push({ start, end: start + opts.maxChunk });
      start += opts.maxChunk;
    }
    if (c - start >= opts.minChunk || c === durationSec) {
      if (c > start) chunks.push({ start, end: c });
      start = c;
    }
  }
  // A too-short tail is merged into the previous chunk.
  const last = chunks.at(-1);
  if (chunks.length > 1 && last && last.end - last.start < opts.minChunk) {
    chunks.pop();
    chunks.at(-1)!.end = last.end;
  }
  return chunks;
}

export interface Detection extends Interval {
  language: string;
  p: number;
}

export interface Run extends Interval {
  language: string;
}

/**
 * Groups chunks into same-language runs. A chunk only starts a run in a language different from
 * the dominant one when detection is confident and the chunk is long enough: decoding Spanish
 * audio with a forced "en" makes whisper translate, which is worse than missing a switch.
 */
export function groupRuns(dets: Detection[], opts = { minP: 0.8, minRunSec: 1.5 }): Run[] {
  if (!dets.length) return [];
  const byLang = new Map<string, number>();
  for (const d of dets) byLang.set(d.language, (byLang.get(d.language) ?? 0) + (d.end - d.start));
  const dominant = [...byLang.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const labeled = dets.map((d) => ({
    ...d,
    language: d.language !== dominant && (d.p < opts.minP || d.end - d.start < opts.minRunSec) ? dominant : d.language,
  }));
  const runs: Run[] = [];
  for (const d of labeled) {
    const prev = runs.at(-1);
    if (prev && prev.language === d.language) prev.end = d.end;
    else runs.push({ start: d.start, end: d.end, language: d.language });
  }
  return runs;
}

export function parseSilences(ffmpegStderr: string): Interval[] {
  const out: Interval[] = [];
  let start: number | null = null;
  for (const line of ffmpegStderr.split('\n')) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (e && start !== null) {
      out.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  return out;
}

export function parseDetections(whisperStderr: string): { language: string; p: number }[] {
  return [...whisperStderr.matchAll(/auto-detected language: ([a-z]{2,3}) \(p = ([\d.]+)\)/g)].map((m) => ({
    language: m[1]!,
    p: Number(m[2]),
  }));
}
