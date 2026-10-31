// Settings and the last good forecast live in localStorage, which the Tauri
// webview keeps between launches.
import type { RawForecast, Unit } from './forecast.ts';

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

export type ForecastDays = 3 | 7 | 10 | 16;
export type Mode = 'expanded' | 'compact';

export interface Settings {
  location: Place | null;
  favorites: Place[];
  unit: Unit;
  days: ForecastDays;
  /** Sustained speed (mph) at which a day counts as "Windy". Stored in mph whatever the display unit. */
  windyMph: number;
  /** Gust limit (mph): drawn on the graph and used for notifications. */
  gustLimitMph: number;
  notify: boolean;
  refreshOnWake: boolean;
  /** Background opacity, 40–100. */
  opacity: number;
  keepBehind: boolean;
  lockPosition: boolean;
  launchAtLogin: boolean;
  mode: Mode;
}

export const DEFAULTS: Settings = {
  location: null,
  favorites: [],
  unit: 'mph',
  days: 7,
  windyMph: 20,
  gustLimitMph: 30,
  notify: true,
  refreshOnWake: true,
  opacity: 92,
  keepBehind: true,
  lockPosition: false,
  launchAtLogin: true,
  mode: 'expanded',
};

const KEY_SETTINGS = 'windwidget.settings.v1';
const KEY_CACHE = 'windwidget.cache.v1';
const KEY_NOTIFIED = 'windwidget.notified.v1';

const UNITS: Unit[] = ['mph', 'kn', 'kmh', 'ms'];
const DAY_CHOICES: ForecastDays[] = [3, 7, 10, 16];

function isPlace(p: unknown): p is Place {
  const o = p as Place;
  return !!o && typeof o.name === 'string' && Number.isFinite(o.lat) && Number.isFinite(o.lon);
}

function read<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable: the widget still works for this session */
  }
}

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;

const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);

export function loadSettings(): Settings {
  const s = read<Partial<Settings>>(KEY_SETTINGS) ?? {};
  return {
    location: isPlace(s.location) ? s.location : null,
    favorites: Array.isArray(s.favorites) ? s.favorites.filter(isPlace).slice(0, 8) : [],
    unit: UNITS.includes(s.unit as Unit) ? (s.unit as Unit) : DEFAULTS.unit,
    days: DAY_CHOICES.includes(s.days as ForecastDays) ? (s.days as ForecastDays) : DEFAULTS.days,
    windyMph: clamp(s.windyMph, 1, 200, DEFAULTS.windyMph),
    gustLimitMph: clamp(s.gustLimitMph, 1, 250, DEFAULTS.gustLimitMph),
    notify: bool(s.notify, DEFAULTS.notify),
    refreshOnWake: bool(s.refreshOnWake, DEFAULTS.refreshOnWake),
    opacity: clamp(s.opacity, 40, 100, DEFAULTS.opacity),
    keepBehind: bool(s.keepBehind, DEFAULTS.keepBehind),
    lockPosition: bool(s.lockPosition, DEFAULTS.lockPosition),
    launchAtLogin: bool(s.launchAtLogin, DEFAULTS.launchAtLogin),
    mode: s.mode === 'compact' ? 'compact' : 'expanded',
  };
}

export function saveSettings(s: Settings): void {
  write(KEY_SETTINGS, s);
}

export interface CachedForecast {
  /** Location, unit and length the forecast was fetched for. */
  key: string;
  fetchedAt: number;
  raw: RawForecast;
}

export function cacheKey(s: Settings): string {
  const l = s.location;
  return l ? `${l.lat.toFixed(3)},${l.lon.toFixed(3)}|${s.unit}|${s.days}` : '';
}

export function loadCache(): CachedForecast | null {
  const c = read<CachedForecast>(KEY_CACHE);
  return c && typeof c.key === 'string' && Number.isFinite(c.fetchedAt) && c.raw?.hourly ? c : null;
}

export function saveCache(c: CachedForecast): void {
  write(KEY_CACHE, c);
}

export function loadNotified(): string | null {
  return read<string>(KEY_NOTIFIED);
}

export function saveNotified(key: string): void {
  write(KEY_NOTIFIED, key);
}
