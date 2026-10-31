// Synthetic Open-Meteo responses for tests and for scripts/render-chart.ts.
import type { RawForecast } from '../src/forecast.ts';

const pad = (n: number) => String(n).padStart(2, '0');

export function sampleForecast(days = 7, startDate = '2026-10-30', nowHour = 17): RawForecast {
  const [y, m, d] = startDate.split('-').map(Number);
  const time: string[] = [];
  const s: number[] = [];
  const g: number[] = [];
  const dir: number[] = [];
  for (let h = 0; h < days * 24; h++) {
    const date = new Date(Date.UTC(y, m - 1, d + Math.floor(h / 24)));
    time.push(`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(h % 24)}:00`);
    const diurnal = 4 * Math.sin((2 * Math.PI * (h - 9)) / 24);
    const front = 13 * Math.exp(-Math.pow((h - 86) / 9, 2));
    const sv = Math.max(2, +(11 + diurnal + 5 * Math.sin(h / 26) + front).toFixed(1));
    s.push(sv);
    g.push(+(sv * 1.4 + 3 + 2 * Math.sin(h * 1.7)).toFixed(1));
    dir.push(Math.round((200 + 100 / (1 + Math.exp(-(h - 88) / 6)) + 18 * Math.sin(h / 9)) % 360));
  }
  return {
    timezone: 'America/New_York',
    timezone_abbreviation: 'EDT',
    current: {
      time: `${startDate}T${pad(nowHour)}:15`,
      wind_speed_10m: 14.2,
      wind_gusts_10m: 22.6,
      wind_direction_10m: 214,
    },
    hourly: { time, wind_speed_10m: s, wind_gusts_10m: g, wind_direction_10m: dir },
  };
}
