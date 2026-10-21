export type Condition = 'clear' | 'partly' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';

/** WMO weather interpretation codes (as used by Open-Meteo) -> app condition. */
export function wmoToCondition(code: number): Condition | undefined {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2) return 'partly';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'storm';
  return undefined;
}

export interface Hourly {
  time: number[]; // unix seconds
  temperature_2m: (number | null)[];
  weather_code: (number | null)[];
}

export interface Observation {
  temperatureC?: number;
  weatherCode?: number;
  condition?: Condition;
  observedAt?: string;
}

/** An hour farther than this from `at` is not an observation of that instant. */
const MAX_DISTANCE_SEC = 90 * 60;

/** Picks the hourly sample nearest to `atSec`; omits fields that are null. */
export function pickNearestHour(h: Hourly, atSec: number): Observation {
  let best = -1;
  let bestDist = Infinity;
  h.time.forEach((t, i) => {
    const d = Math.abs(t - atSec);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  if (best < 0 || bestDist > MAX_DISTANCE_SEC) return {};
  const obs: Observation = { observedAt: new Date(h.time[best]! * 1000).toISOString() };
  const temp = h.temperature_2m[best];
  const code = h.weather_code[best];
  if (typeof temp === 'number') obs.temperatureC = Math.round(temp * 10) / 10;
  if (typeof code === 'number') {
    obs.weatherCode = code;
    const c = wmoToCondition(code);
    if (c) obs.condition = c;
  }
  if (obs.temperatureC === undefined && obs.weatherCode === undefined) return {};
  return obs;
}

const DAY = 86_400_000;
export const FORECAST_PAST_DAYS_MAX = 92;

export interface ContextDeps {
  fetchImpl: typeof fetch;
  now: () => number;
  userAgent: string;
}

/** Open-Meteo: forecast API (past_days) for recent instants, archive API for older ones. */
export async function fetchWeatherAt(deps: ContextDeps, lat: number, lon: number, atMs: number): Promise<Observation> {
  const ageDays = (deps.now() - atMs) / DAY;
  const common = `latitude=${lat}&longitude=${lon}&hourly=temperature_2m,weather_code&timezone=GMT&timeformat=unixtime`;
  let url: string;
  if (ageDays <= FORECAST_PAST_DAYS_MAX - 1) {
    const pastDays = Math.min(FORECAST_PAST_DAYS_MAX, Math.max(1, Math.ceil(ageDays) + 1));
    url = `https://api.open-meteo.com/v1/forecast?${common}&past_days=${pastDays}&forecast_days=1`;
  } else {
    const day = new Date(atMs).toISOString().slice(0, 10);
    const next = new Date(atMs + DAY).toISOString().slice(0, 10);
    url = `https://archive-api.open-meteo.com/v1/archive?${common}&start_date=${day}&end_date=${next}`;
  }
  const res = await deps.fetchImpl(url, { headers: { 'user-agent': deps.userAgent }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return {};
  const body = (await res.json()) as { hourly?: Hourly };
  if (!body.hourly?.time) return {};
  return pickNearestHour(body.hourly, Math.round(atMs / 1000));
}

/** Nominatim reverse geocoder with a 1 req/s global throttle and an in-memory cache. */
export class ReverseGeocoder {
  private cache = new Map<string, string | null>();
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(
    private deps: ContextDeps & { sleep?: (ms: number) => Promise<void> },
    private maxEntries = 5_000,
  ) {}

  async city(lat: number, lon: number, lang: string): Promise<string | undefined> {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)},${lang}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? undefined;
    const run = this.chain.then(() => this.lookup(lat, lon, lang));
    this.chain = run.catch(() => undefined);
    const city = await run.catch(() => undefined);
    if (city !== undefined) this.remember(key, city);
    return city ?? undefined;
  }

  private async lookup(lat: number, lon: number, lang: string): Promise<string | null | undefined> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const wait = this.lastAt + 1_000 - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastAt = Date.now();
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`;
    const res = await this.deps.fetchImpl(url, {
      headers: { 'user-agent': this.deps.userAgent, 'accept-language': lang },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined; // transient: don't cache
    const body = (await res.json()) as { address?: Record<string, string>; error?: string };
    const a = body.address ?? {};
    return a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? null;
  }

  private remember(key: string, city: string | null) {
    if (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, city);
  }
}
