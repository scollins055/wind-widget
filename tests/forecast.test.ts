import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModel,
  cardinal,
  conditionsAt,
  dominantDirection,
  firstGustAtOrAbove,
  fromMph,
  hourShort,
  levelFor,
  niceScale,
  nowIndex,
  peakGust,
  toMph,
  whenLabel,
  type Hour,
} from '../src/forecast.ts';
import { sampleForecast } from './sample.ts';

test('groups hours into days with weekday labels', () => {
  const m = buildModel(sampleForecast(7));
  assert.equal(m.hours.length, 168);
  assert.equal(m.days.length, 7);
  assert.deepEqual(
    m.days.map((d) => d.weekday),
    ['Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu'],
  );
  assert.equal(m.days[2].dateLabel, 'Nov 1');
  assert.equal(m.days[1].start, 24);
  assert.equal(m.days[1].end, 48);
  assert.ok(m.days.every((d) => !d.lowConfidence));
});

test('days after the first week are marked lower confidence', () => {
  const m = buildModel(sampleForecast(10));
  assert.deepEqual(
    m.days.map((d) => d.lowConfidence),
    [false, false, false, false, false, false, false, true, true, true],
  );
});

test('finds "now" from the current block and moves it with the clock', () => {
  const m = buildModel(sampleForecast(7, '2026-10-30', 17));
  assert.equal(m.baseNowIdx, 17);
  assert.equal(m.nowMinute, 15);
  const fetchedAt = Date.UTC(2026, 9, 30, 21, 15);
  assert.equal(nowIndex(m, fetchedAt, fetchedAt), 17);
  assert.equal(nowIndex(m, fetchedAt, fetchedAt + 44 * 60_000), 17);
  assert.equal(nowIndex(m, fetchedAt, fetchedAt + 46 * 60_000), 18);
  assert.equal(nowIndex(m, fetchedAt, fetchedAt + 12 * 3_600_000), 29);
  // Never runs off the end of the forecast.
  assert.equal(nowIndex(m, fetchedAt, fetchedAt + 30 * 86_400_000), 167);
});

test('"now" uses live conditions for the fetch hour, then the hourly forecast', () => {
  const raw = sampleForecast(7);
  const m = buildModel(raw);
  assert.deepEqual(conditionsAt(m, 17), { s: 14.2, g: 22.6, dir: 214 });
  assert.equal(conditionsAt(m, 18).s, raw.hourly.wind_speed_10m[18]);
});

test('drops trailing hours with no data and tolerates gaps', () => {
  const raw = sampleForecast(3);
  for (let i = 60; i < 72; i++) {
    raw.hourly.wind_speed_10m[i] = null;
    raw.hourly.wind_gusts_10m[i] = null;
  }
  raw.hourly.wind_gusts_10m[10] = null;
  const m = buildModel(raw);
  assert.equal(m.hours.length, 60);
  assert.equal(m.hours[10].g, null);
  assert.equal(m.days.length, 3);
  assert.equal(m.days[2].end, 60);
});

test('daily max and dominant direction', () => {
  const m = buildModel(sampleForecast(7));
  const d = m.days[3];
  const seg = m.hours.slice(d.start, d.end);
  assert.equal(d.maxS, Math.max(...seg.map((h) => h.s!)));
  assert.equal(d.maxG, Math.max(...seg.map((h) => h.g!)));
  const hrs = (dirs: number[]): Hour[] => dirs.map((dir, i) => ({ i, time: '', date: '', hour: 0, s: 10, g: 12, dir }));
  // Wraps correctly around north instead of averaging to south.
  assert.equal(dominantDirection(hrs([350, 10])), 0);
  assert.equal(dominantDirection(hrs([80, 100])), 90);
});

test('compass points', () => {
  assert.equal(cardinal(0), 'N');
  assert.equal(cardinal(214), 'SW');
  assert.equal(cardinal(248), 'WSW');
  assert.equal(cardinal(359), 'N');
  assert.equal(cardinal(-90), 'W');
  assert.equal(cardinal(null), '–');
});

test('levels scale with the windy threshold', () => {
  assert.equal(levelFor(5, 20).key, 'calm');
  assert.equal(levelFor(12, 20).key, 'breezy');
  assert.equal(levelFor(20, 20).key, 'windy');
  assert.equal(levelFor(31, 20).key, 'strong');
  assert.equal(levelFor(null, 20).key, 'calm');
});

test('unit conversion round-trips', () => {
  for (const u of ['mph', 'kn', 'kmh', 'ms'] as const) {
    assert.ok(Math.abs(toMph(fromMph(30, u), u) - 30) < 1e-9);
  }
  assert.ok(Math.abs(fromMph(30, 'kmh') - 48.28) < 0.01);
});

test('gust alerts and peaks', () => {
  const m = buildModel(sampleForecast(7));
  const i = firstGustAtOrAbove(m, 17, 30);
  assert.ok(i > 17);
  assert.ok(m.hours[i].g! >= 30);
  assert.ok(m.hours.slice(17, i).every((h) => h.g! < 30));
  assert.equal(firstGustAtOrAbove(m, 0, 999), -1);
  const p = peakGust(m, 17, 24)!;
  assert.equal(p.g, Math.max(...m.hours.slice(17, 42).map((h) => h.g!)));
});

test('labels', () => {
  const m = buildModel(sampleForecast(7));
  assert.equal(hourShort(0), '12a');
  assert.equal(hourShort(12), '12p');
  assert.equal(hourShort(15), '3p');
  assert.equal(hourShort(27), '3a');
  assert.equal(whenLabel(m, 17), 'Today 5 PM');
  assert.equal(whenLabel(m, 24 + 15), 'Sat 3 PM');
});

test('y axis scale always lands on round tick values', () => {
  for (const v of [3, 12, 29.5, 38, 47, 63, 120]) {
    const [max, step] = niceScale(v);
    assert.ok(max >= v, `max ${max} covers ${v}`);
    assert.equal(max % step, 0);
    assert.ok(max / step <= 8 && max / step >= 2, `${max / step} ticks for ${v}`);
  }
});
