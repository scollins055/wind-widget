// Open-Meteo: free, no API key. Attribution required (CC BY 4.0), shown in the widget.
// https://open-meteo.com/en/docs and https://open-meteo.com/en/docs/geocoding-api
import type { RawForecast, Unit } from './forecast.ts';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WIND_VARS = 'wind_speed_10m,wind_gusts_10m,wind_direction_10m';
const TIMEOUT_MS = 15_000;

export interface PlaceResult {
  name: string;
  detail: string;
  lat: number;
  lon: number;
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal: withTimeout(signal) });
  if (!res.ok) {
    let reason = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { reason?: string };
      if (body?.reason) reason = body.reason;
    } catch {
      /* not JSON */
    }
    throw new Error(reason);
  }
  return res.json();
}

export async function fetchForecast(
  lat: number,
  lon: number,
  unit: Unit,
  days: number,
  signal?: AbortSignal,
): Promise<RawForecast> {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: WIND_VARS,
    current: WIND_VARS,
    wind_speed_unit: unit,
    timezone: 'auto',
    forecast_days: String(days),
  });
  const data = (await getJson(`${FORECAST_URL}?${params}`, signal)) as RawForecast;
  if (!data?.hourly?.time?.length) throw new Error('The forecast came back empty');
  return data;
}

interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  country_code?: string;
  admin1?: string;
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceResult[]> {
  const params = new URLSearchParams({ name: query, count: '6', language: 'en', format: 'json' });
  const data = (await getJson(`${GEOCODING_URL}?${params}`, signal)) as { results?: GeoResult[] };
  return (data.results ?? []).map((r) => ({
    // Short name for the widget header: "Portland, Maine" / "Paris, France".
    name: [r.name, r.admin1 ?? r.country].filter(Boolean).join(', '),
    detail: [r.admin1, r.country].filter(Boolean).join(', ') + ` · ${r.latitude.toFixed(2)}, ${r.longitude.toFixed(2)}`,
    lat: r.latitude,
    lon: r.longitude,
  }));
}
