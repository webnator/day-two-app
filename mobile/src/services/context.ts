import * as Location from "expo-location";
import type { ContextSnapshot } from "../data/journal";
import type { WeatherCondition } from "../domain/model";
import { api } from "./api";

const round2 = (n: number) => Math.round(n * 100) / 100;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/**
 * Snapshot of place and weather for the START of a recording. Precision is reduced to ~1 km
 * before anything leaves the device. Missing permission, coverage or provider → fields omitted.
 * If weather can't be fetched now, coordinates are kept (status "pending") so a deferred job asks
 * for that same instant later — never for the current weather.
 */
export async function captureContext(startedAt: Date, enabled: boolean, lang: string, askIfUndetermined = true): Promise<ContextSnapshot> {
  if (!enabled) return { status: "none" };
  try {
    let perm = await Location.getForegroundPermissionsAsync();
    if (perm.status === "undetermined" && askIfUndetermined) perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== "granted") return { status: "unavailable" };
    // Never interrupt a recording with system dialogs: if location services are off, omit context.
    if (!(await Location.hasServicesEnabledAsync())) return { status: "unavailable" };
    const pos =
      (await Location.getLastKnownPositionAsync({ maxAge: 15 * 60_000, requiredAccuracy: 3000 })) ??
      (await withTimeout(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low, mayShowUserSettingsDialog: false }), 10_000));
    if (!pos) return { status: "unavailable" };
    const lat = round2(pos.coords.latitude);
    const lon = round2(pos.coords.longitude);
    let city: string | null = null;
    try {
      const geo = await withTimeout(Location.reverseGeocodeAsync({ latitude: lat, longitude: lon }), 6_000);
      const g = geo?.[0];
      city = g?.city ?? g?.subregion ?? g?.district ?? null;
    } catch {}
    try {
      const c = await withTimeout(api.context(lat, lon, startedAt.toISOString(), lang), 8_000);
      if (c && (c.temperatureC != null || c.condition)) {
        return { status: "resolved", city: city ?? c.city ?? null, temperatureC: c.temperatureC ?? null, condition: (c.condition as WeatherCondition) ?? null };
      }
    } catch {}
    return { status: "pending", lat, lon, city };
  } catch {
    return { status: "unavailable" };
  }
}

export async function locationPermission(): Promise<Location.PermissionStatus> {
  return (await Location.getForegroundPermissionsAsync()).status;
}
export async function requestLocationPermission(): Promise<boolean> {
  return (await Location.requestForegroundPermissionsAsync()).status === "granted";
}
