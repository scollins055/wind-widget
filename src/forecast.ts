// Pure data logic: turns an Open-Meteo response into the model the UI draws.
// No DOM access here, so it can be unit-tested with Node.

export type Unit = 'mph' | 'kn' | 'kmh' | 'ms';

export const UNIT_LABEL: Record<Unit, string> = { mph: 'mph', kn: 'kn', kmh: 'km/h', ms: 'm/s' };

/** How many of `unit` make one mph. */
const PER_MPH: Record<Unit, number> = { mph: 1, kn: 0.868976, kmh: 1.609344, ms: 0.44704 };

export const toMph = (v: number, unit: Unit): number => v / PER_MPH[unit];
export const fromMph = (v: number, unit: Unit): number => v * PER_MPH[unit];

export interface RawForecast {
  timezone?: string;
  timezone_abbreviation?: string;
  current?: {
    time: string;
    wind_speed_10m: number | null;
    wind_gusts_10m: number | null;
    wind_direction_10m: number | null;
  };
  hourly: {
    time: string[];
    wind_speed_10m: (number | null)[];
    wind_gusts_10m: (number | null)[];
    wind_direction_10m: (number | null)[];
  };
}

export interface Hour {
  i: number;
  /** Location-local ISO time, e.g. "2026-10-30T17:00". */
  time: string;
  date: string;
  hour: number;
  s: number | null;
  g: number | null;
  dir: number | null;
}

export interface Day {
  index: number;
  date: string;
  weekday: string;
  dateLabel: string;
  start: number;
  /** Exclusive. */
  end: number;
  maxS: number | null;
  maxG: number | null;
  domDir: number | null;
  /** Forecasts beyond about a week are much less reliable. */
  lowConfidence: boolean;
}

export interface Conditions {
  s: number | null;
  g: number | null;
  dir: number | null;
}

export interface Model {
  hours: Hour[];
  days: Day[];
  /** Index of the hour that contained "now" when the forecast was fetched. */
  baseNowIdx: number;
  /** Minutes past that hour at fetch time. */
  nowMinute: number;
  current: Conditions;
  tzAbbr: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function parseLocalTime(t: string): { date: string; hour: number; minute: number } {
  const [date, hm = '00:00'] = t.split('T');
  const [h, m] = hm.split(':').map(Number);
  return { date, hour: h || 0, minute: m || 0 };
}

function weekdayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function dateLabelOf(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function cardinal(deg: number | null): string {
  if (deg == null) return '–';
  return CARDINALS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** Speed-weighted mean direction, so a calm hour barely counts. */
export function dominantDirection(hours: Hour[]): number | null {
  let x = 0;
  let y = 0;
  let any = false;
  for (const h of hours) {
    if (h.dir == null) continue;
    const w = Math.max(h.s ?? 0, 0.1);
    x += Math.sin((h.dir * Math.PI) / 180) * w;
    y += Math.cos((h.dir * Math.PI) / 180) * w;
    any = true;
  }
  if (!any) return null;
  return (Math.round((Math.atan2(x, y) * 180) / Math.PI) + 360) % 360;
}

function maxOf(vals: (number | null)[]): number | null {
  let m: number | null = null;
  for (const v of vals) if (v != null && (m == null || v > m)) m = v;
  return m;
}

export function buildModel(raw: RawForecast): Model {
  const H = raw.hourly;
  const hours: Hour[] = H.time.map((time, i) => {
    const p = parseLocalTime(time);
    return {
      i,
      time,
      date: p.date,
      hour: p.hour,
      s: num(H.wind_speed_10m[i]),
      g: num(H.wind_gusts_10m[i]),
      dir: num(H.wind_direction_10m[i]),
    };
  });
  // Some models stop early: drop trailing hours that have no data at all.
  while (hours.length && hours[hours.length - 1].s == null && hours[hours.length - 1].g == null) hours.pop();

  const days: Day[] = [];
  for (const h of hours) {
    let d = days[days.length - 1];
    if (!d || d.date !== h.date) {
      d = {
        index: days.length,
        date: h.date,
        weekday: weekdayOf(h.date),
        dateLabel: dateLabelOf(h.date),
        start: h.i,
        end: h.i + 1,
        maxS: null,
        maxG: null,
        domDir: null,
        lowConfidence: days.length >= 7,
      };
      days.push(d);
    }
    d.end = h.i + 1;
  }
  for (const d of days) {
    const seg = hours.slice(d.start, d.end);
    d.maxS = maxOf(seg.map((h) => h.s));
    d.maxG = maxOf(seg.map((h) => h.g));
    d.domDir = dominantDirection(seg);
  }

  let baseNowIdx = 0;
  let nowMinute = 0;
  const cur = raw.current;
  if (cur?.time) {
    const p = parseLocalTime(cur.time);
    const idx = hours.findIndex((h) => h.date === p.date && h.hour === p.hour);
    if (idx >= 0) {
      baseNowIdx = idx;
      nowMinute = p.minute;
    }
  }
  const fallback = hours[baseNowIdx];
  const current: Conditions = {
    s: num(cur?.wind_speed_10m) ?? fallback?.s ?? null,
    g: num(cur?.wind_gusts_10m) ?? fallback?.g ?? null,
    dir: num(cur?.wind_direction_10m) ?? fallback?.dir ?? null,
  };

  return { hours, days, baseNowIdx, nowMinute, current, tzAbbr: raw.timezone_abbreviation ?? '' };
}

/** Which hour is "now", allowing for time passed since the forecast was fetched. */
export function nowIndex(model: Model, fetchedAt: number, now: number): number {
  const elapsed = Math.max(0, now - fetchedAt) + model.nowMinute * 60_000;
  const idx = model.baseNowIdx + Math.floor(elapsed / 3_600_000);
  return Math.min(idx, Math.max(0, model.hours.length - 1));
}

/** Conditions to show as "now": the live reading for the fetch hour, the hourly forecast after that. */
export function conditionsAt(model: Model, idx: number): Conditions {
  if (idx === model.baseNowIdx) return model.current;
  const h = model.hours[idx];
  return h ? { s: h.s, g: h.g, dir: h.dir } : model.current;
}

export type LevelKey = 'calm' | 'breezy' | 'windy' | 'strong';
export interface Level {
  key: LevelKey;
  name: string;
  color: string;
}

const LEVELS: Record<LevelKey, Level> = {
  calm: { key: 'calm', name: 'Calm', color: '#5E9BC9' },
  breezy: { key: 'breezy', name: 'Breezy', color: '#9CC6E8' },
  windy: { key: 'windy', name: 'Windy', color: '#F2A541' },
  strong: { key: 'strong', name: 'Strong', color: '#E8673C' },
};

/** Classify a sustained speed (in mph) against the user's "windy" threshold. */
export function levelFor(speedMph: number | null, windyMph: number): Level {
  const v = speedMph ?? 0;
  if (v < windyMph * 0.5) return LEVELS.calm;
  if (v < windyMph) return LEVELS.breezy;
  if (v < windyMph * 1.5) return LEVELS.windy;
  return LEVELS.strong;
}

export function hourShort(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  const n = hh % 12 === 0 ? 12 : hh % 12;
  return `${n}${hh < 12 ? 'a' : 'p'}`;
}

export function hourLong(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  const n = hh % 12 === 0 ? 12 : hh % 12;
  return `${n} ${hh < 12 ? 'AM' : 'PM'}`;
}

/** "Today 3 PM", "Sat 3 PM". */
export function whenLabel(model: Model, idx: number): string {
  const h = model.hours[idx];
  if (!h) return '';
  const day = model.days.find((d) => idx >= d.start && idx < d.end);
  const name = !day ? '' : day.index === 0 ? 'Today' : day.weekday;
  return `${name} ${hourLong(h.hour)}`.trim();
}

/** First hour from `from` (within `hoursAhead`, or to the end) with gusts at or above `limit`. */
export function firstGustAtOrAbove(model: Model, from: number, limit: number, hoursAhead = Infinity): number {
  const end = Math.min(model.hours.length, from + hoursAhead + 1);
  for (let i = Math.max(0, from); i < end; i++) {
    const g = model.hours[i].g;
    if (g != null && g >= limit) return i;
  }
  return -1;
}

/** Highest gust in [from, from + hoursAhead]. */
export function peakGust(model: Model, from: number, hoursAhead: number): { idx: number; g: number } | null {
  let best: { idx: number; g: number } | null = null;
  const end = Math.min(model.hours.length, from + hoursAhead + 1);
  for (let i = Math.max(0, from); i < end; i++) {
    const g = model.hours[i].g;
    if (g != null && (!best || g > best.g)) best = { idx: i, g };
  }
  return best;
}

/** A y-axis scale where every tick gets a round value: returns [max, step]. */
export function niceScale(maxValue: number): [number, number] {
  const target = Math.max(maxValue * 1.08, 1);
  for (const step of [1, 2, 5, 10, 20, 25, 50, 100]) {
    const ticks = Math.ceil(target / step);
    if (ticks <= 8) return [Math.max(ticks, 2) * step, step];
  }
  return [Math.ceil(target / 200) * 200, 200];
}
