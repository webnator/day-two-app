import { norm, type Change, type JournalEntry } from './store.js';

const round = (v: number) => Math.round(v * 10000) / 10000;
const days = (entries: JournalEntry[]) => new Set(entries.map(e => e.day)).size;
type Dimension = 'topic' | 'emotion' | 'city' | 'weather' | 'temperature';
export function values(e: JournalEntry, d: Dimension): string[] {
  if (d === 'topic' || d === 'emotion') return [...new Set(e.tags.filter(t => t.kind === d).map(t => norm(t.name)))];
  if (d === 'city') return e.city ? [norm(e.city)] : [];
  if (d === 'weather') return e.weatherCondition ? [e.weatherCondition] : [];
  if (e.temperatureC === null) return [];
  return [e.temperatureC < 10 ? '<10 °C' : e.temperatureC < 20 ? '10–<20 °C' : e.temperatureC < 30 ? '20–<30 °C' : '≥30 °C'];
}
function distribution(entries: JournalEntry[], d: Dimension) {
  const known = entries.filter(e => values(e, d).length > 0), denominatorDays = days(entries);
  return [...new Set(known.flatMap(e => values(e, d)))].map(value => {
    const match = known.filter(e => values(e, d).includes(value));
    return { value, entries: match.length, days: days(match), shareOfRecordedDays: denominatorDays ? round(days(match) / denominatorDays) : null };
  }).sort((a, b) => b.days - a.days || a.value.localeCompare(b.value));
}
function bucket(day: string, by: 'day' | 'week' | 'month') {
  if (by === 'day') return day;
  if (by === 'month') return day.slice(0, 7);
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}
export function summary(changes: Change[], start: string, end: string, by: 'day' | 'week' | 'month') {
  const entries = changes.flatMap(c => c.entry ? [c.entry] : []), groups = new Map<string, JournalEntry[]>();
  // Include empty calendar intervals; zero entries does not mean neutral or low mood.
  for (let t = Date.parse(start); t <= Date.parse(end); t += 86400000) groups.set(bucket(new Date(t).toISOString().slice(0, 10), by), []);
  for (const e of entries) groups.get(bucket(e.day, by))!.push(e);
  const metrics = (es: JournalEntry[]) => ({
    entries: es.length, recordedDays: days(es), topics: distribution(es, 'topic'), emotions: distribution(es, 'emotion'),
    cities: distribution(es, 'city'), weather: distribution(es, 'weather'), temperature: distribution(es, 'temperature'),
    coverage: { withEmotions: es.filter(e => values(e, 'emotion').length).length, withCity: es.filter(e => !!e.city).length,
      withWeather: es.filter(e => !!e.weatherCondition).length, withTemperature: es.filter(e => e.temperatureC !== null).length },
  });
  return { start, end, granularity: by, ...metrics(entries), timeline: [...groups].map(([period, es]) => ({ period, ...metrics(es) })),
    methodology: 'Local journal dates. Label prevalence counts distinct recorded days, not all calendar days; labels can coexist so percentages need not sum to 100%. Missing context stays missing. No mood score or causal inference. Only synchronized entries.' };
}
export function associations(changes: Change[], a: Dimension, b: Dimension, minSupport: number, limit: number) {
  const entries = changes.flatMap(c => c.entry ? [c.entry] : []);
  // Context must be observed on both sides. For labels, an empty set means no label, not a missing sensor value.
  const eligible = entries.filter(e => ([a, b] as Dimension[]).every(d => d === 'topic' || d === 'emotion' || values(e, d).length));
  const av = [...new Set(eligible.flatMap(e => values(e, a)))].sort(), bv = [...new Set(eligible.flatMap(e => values(e, b)))].sort();
  const rows = [];
  for (const left of av) for (const right of bv) {
    if (a === b && left >= right) continue;
    const withA = eligible.filter(e => values(e, a).includes(left)), withoutA = eligible.filter(e => !values(e, a).includes(left));
    const both = withA.filter(e => values(e, b).includes(right)), rest = withoutA.filter(e => values(e, b).includes(right));
    if (days(both) < minSupport) continue;
    const withRate = both.length / withA.length, otherRate = withoutA.length ? rest.length / withoutA.length : null;
    rows.push({ a: left, b: right, together: both.length, togetherDays: days(both), withA: withA.length, withoutA: withoutA.length,
      bWithoutA: rest.length, shareWithA: round(withRate), shareWithoutA: otherRate === null ? null : round(otherRate),
      difference: otherRate === null ? null : round(withRate - otherRate) });
  }
  rows.sort((x, y) => y.togetherDays - x.togetherDays || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return { dimensions: [a, b], eligibleEntries: eligible.length, excludedMissingContext: entries.length - eligible.length,
    pairs: rows.slice(0, limit), totalPairs: rows.length, truncated: rows.length > limit,
    methodology: 'Observed co-occurrence; sorted by distinct days together, not statistical significance. Shares use entries as denominator. Minimum support uses distinct days. Associations do not establish causation.' };
}
