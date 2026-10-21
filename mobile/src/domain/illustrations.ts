import type { DayKey } from "./dates";

/**
 * Daily illustration rotation. The choice changes once per journal day and stays stable
 * while that day lasts (reloads, restarts). A shuffled cycle is consumed without repeats;
 * a new cycle never starts with the last item of the previous one.
 */
export interface RotationState {
  cycle: string[];
  index: number; // index in cycle of the current pick
  day: DayKey | null;
}

export function shuffle<T>(items: T[], rng: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function pickForDay(state: RotationState | null, today: DayKey, bank: string[], rng: () => number): { id: string; state: RotationState } {
  if (!bank.length) throw new Error("empty bank");
  const valid = state && state.cycle.length === bank.length && state.cycle.every((id) => bank.includes(id));
  if (valid && state!.day === today) return { id: state!.cycle[state!.index], state: state! };
  if (valid && state!.index + 1 < state!.cycle.length) {
    const next = { ...state!, index: state!.index + 1, day: today };
    return { id: next.cycle[next.index], state: next };
  }
  const last = valid ? state!.cycle[state!.index] : null;
  let cycle = shuffle(bank, rng);
  if (last && cycle.length > 1 && cycle[0] === last) cycle = [...cycle.slice(1), cycle[0]];
  const next: RotationState = { cycle, index: 0, day: today };
  return { id: cycle[0], state: next };
}

/** Small deterministic PRNG for tests. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
