import type { ImageSourcePropType } from "react-native";
import type { Journal } from "../data/journal";
import type { DayKey, Lang } from "../domain/dates";
import { pickForDay, type RotationState } from "../domain/illustrations";
import { PLATE_DATA } from "./plates.generated";

/**
 * Local bank of ink illustrations with their coherent headline and supporting copy.
 * Assets ship with the app (no network, no generation at runtime). Provenance: assets/illustrations/PROVENANCE.md.
 */
export interface Plate {
  id: string;
  image: ImageSourcePropType;
  headline: Record<Lang, string>;
  copy: Record<Lang, [string, string]>;
  alt: Record<Lang, string>;
}

export const PLATES: Plate[] = PLATE_DATA as unknown as Plate[];

/** Stable for the whole journal day; rotates without avoidable repeats (state persisted per account). */
export async function plateForDay(j: Journal, day: DayKey, fixed?: string): Promise<Plate> {
  if (fixed) return PLATES.find((p) => p.id === fixed) ?? PLATES[0];
  const state = await j.get<RotationState | null>("plateRotation", null);
  const { id, state: next } = pickForDay(state, day, PLATES.map((p) => p.id), Math.random);
  if (next !== state) await j.set("plateRotation", next);
  return PLATES.find((p) => p.id === id) ?? PLATES[0];
}
