import { afterEach, describe, expect, it } from 'vitest';
import { fetchWeatherAt, pickNearestHour, ReverseGeocoder, wmoToCondition, type Hourly } from '../src/context/context.js';
import { auth, login, makeApp, makeFetchMock, type TestCtx } from './helpers.js';

const H = 3600;

describe('WMO mapping', () => {
  it.each([
    [0, 'clear'], [1, 'clear'], [2, 'partly'], [3, 'cloudy'], [45, 'fog'], [48, 'fog'],
    [51, 'drizzle'], [57, 'drizzle'], [61, 'rain'], [67, 'rain'], [80, 'rain'], [82, 'rain'],
    [71, 'snow'], [77, 'snow'], [85, 'snow'], [86, 'snow'], [95, 'storm'], [96, 'storm'], [99, 'storm'],
  ])('%i -> %s', (code, cond) => expect(wmoToCondition(code)).toBe(cond));

  it('unknown codes -> undefined (field omitted)', () => {
    expect(wmoToCondition(4)).toBeUndefined();
    expect(wmoToCondition(100)).toBeUndefined();
  });
});

describe('hour selection', () => {
  const base = 1_790_000_000 - (1_790_000_000 % H);
  const hourly: Hourly = {
    time: [base, base + H, base + 2 * H],
    temperature_2m: [10, 12.34, 14],
    weather_code: [0, 61, 3],
  };

  it('picks the nearest hour, not the latest', () => {
    expect(pickNearestHour(hourly, base + H + 29 * 60)).toEqual({
      temperatureC: 12.3,
      weatherCode: 61,
      condition: 'rain',
      observedAt: new Date((base + H) * 1000).toISOString(),
    });
    expect(pickNearestHour(hourly, base + H + 31 * 60).weatherCode).toBe(3);
  });

  it('omits null fields and returns nothing when too far from any sample', () => {
    const withNull: Hourly = { time: [base], temperature_2m: [null], weather_code: [2] };
    expect(pickNearestHour(withNull, base)).toEqual({ weatherCode: 2, condition: 'partly', observedAt: new Date(base * 1000).toISOString() });
    expect(pickNearestHour(hourly, base + 10 * H)).toEqual({});
    expect(pickNearestHour({ time: [base], temperature_2m: [null], weather_code: [null] }, base)).toEqual({});
  });
});

describe('Open-Meteo endpoint choice', () => {
  const now = Date.UTC(2026, 9, 5, 12);
  const hourlyAt = (ms: number) => ({ hourly: { time: [Math.round(ms / 1000)], temperature_2m: [20], weather_code: [1] } });

  it('uses forecast + past_days within the last 92 days', async () => {
    const at = now - 3 * 86_400_000;
    const f = makeFetchMock(() => hourlyAt(at));
    const obs = await fetchWeatherAt({ fetchImpl: f as unknown as typeof fetch, now: () => now, userAgent: 'ua' }, 40.42, -3.7, at);
    expect(f.urls[0]).toMatch(/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
    expect(f.urls[0]).toContain('past_days=4');
    expect(f.urls[0]).toContain('hourly=temperature_2m,weather_code');
    expect(obs).toMatchObject({ temperatureC: 20, condition: 'clear' });
  });

  it('uses the archive API for older instants', async () => {
    const at = Date.UTC(2025, 0, 15, 9, 20);
    const f = makeFetchMock(() => hourlyAt(Date.UTC(2025, 0, 15, 9)));
    const obs = await fetchWeatherAt({ fetchImpl: f as unknown as typeof fetch, now: () => now, userAgent: 'ua' }, 40.42, -3.7, at);
    expect(f.urls[0]).toMatch(/^https:\/\/archive-api\.open-meteo\.com\/v1\/archive\?/);
    expect(f.urls[0]).toContain('start_date=2025-01-15&end_date=2025-01-16');
    expect(obs.observedAt).toBe('2025-01-15T09:00:00.000Z');
  });

  it('provider error -> no fields (never invented)', async () => {
    const f = makeFetchMock(() => new Response('nope', { status: 500 }));
    expect(await fetchWeatherAt({ fetchImpl: f as unknown as typeof fetch, now: () => now, userAgent: 'ua' }, 1, 1, now)).toEqual({});
  });
});

describe('ReverseGeocoder', () => {
  it('sends User-Agent + accept-language, zoom=10, caches, and throttles to 1 req/s', async () => {
    const seen: RequestInit[] = [];
    const f = makeFetchMock((_u, init) => {
      seen.push(init!);
      return { address: { city: 'Madrid' } };
    });
    const sleeps: number[] = [];
    const g = new ReverseGeocoder({ fetchImpl: f as unknown as typeof fetch, now: Date.now, userAgent: 'DayTwo/test', sleep: async (ms) => void sleeps.push(ms) });
    expect(await g.city(40.42, -3.7, 'es')).toBe('Madrid');
    expect(await g.city(40.42, -3.7, 'es')).toBe('Madrid');
    expect(f.urls).toHaveLength(1);
    expect(f.urls[0]).toContain('zoom=10');
    expect((seen[0]!.headers as Record<string, string>)['user-agent']).toBe('DayTwo/test');
    expect((seen[0]!.headers as Record<string, string>)['accept-language']).toBe('es');
    await g.city(41.39, 2.17, 'es');
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(900);
  });

  it('falls back to town/village', async () => {
    const f = makeFetchMock(() => ({ address: { village: 'Valdemorillo' } }));
    const g = new ReverseGeocoder({ fetchImpl: f as unknown as typeof fetch, now: Date.now, userAgent: 'ua', sleep: async () => {} });
    expect(await g.city(40.5, -4.07, 'es')).toBe('Valdemorillo');
  });
});

describe('GET /v1/context', () => {
  let ctx: TestCtx;
  afterEach(async () => ctx.app.close());

  it('returns weather for the instant and city; rounds coordinates to 2 decimals', async () => {
    const at = Date.UTC(2026, 9, 4, 18, 10);
    const fetchMock = makeFetchMock((url) => {
      if (url.includes('nominatim')) return { address: { city: 'Madrid' } };
      return { hourly: { time: [Date.UTC(2026, 9, 4, 18) / 1000, Date.UTC(2026, 9, 4, 19) / 1000], temperature_2m: [21.4, 19], weather_code: [2, 3] } };
    });
    ctx = await makeApp({ fetchMock });
    const { token } = await login(ctx, 'ctx@example.com');
    const r = await ctx.app.inject({
      method: 'GET',
      url: `/v1/context?lat=40.41678&lon=-3.70379&at=${new Date(at).toISOString()}`,
      headers: { ...auth(token), 'accept-language': 'es-ES,es;q=0.9' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      city: 'Madrid',
      temperatureC: 21.4,
      weatherCode: 2,
      condition: 'partly',
      observedAt: '2026-10-04T18:00:00.000Z',
      source: 'open-meteo',
    });
    for (const u of fetchMock.urls) {
      expect(u).toContain('40.42');
      expect(u).not.toContain('40.416');
    }
  });

  it('missing data -> only source', async () => {
    ctx = await makeApp();
    const { token } = await login(ctx, 'ctx@example.com');
    const r = await ctx.app.inject({ method: 'GET', url: `/v1/context?lat=1&lon=1&at=2026-10-01T10:00:00Z`, headers: auth(token) });
    expect(r.json()).toEqual({ source: 'open-meteo' });
  });

  it('rejects invalid input', async () => {
    ctx = await makeApp();
    const { token } = await login(ctx, 'ctx@example.com');
    for (const q of ['lat=91&lon=0&at=2026-10-01T10:00:00Z', 'lat=0&lon=0&at=yesterday', 'lat=0&lon=0&at=2030-01-01T00:00:00Z']) {
      expect((await ctx.app.inject({ method: 'GET', url: `/v1/context?${q}`, headers: auth(token) })).statusCode).toBe(400);
    }
  });
});
