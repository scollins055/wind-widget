import './styles.css';
import { fetchForecast, searchPlaces, type PlaceResult } from './api.ts';
import { createChart, type ChartHandle, type ChartView } from './chart.ts';
import {
  buildModel,
  cardinal,
  conditionsAt,
  firstGustAtOrAbove,
  fromMph,
  levelFor,
  nowIndex,
  peakGust,
  toMph,
  UNIT_LABEL,
  whenLabel,
  type Model,
  type RawForecast,
  type Unit,
} from './forecast.ts';
import * as platform from './platform.ts';
import {
  cacheKey,
  loadCache,
  loadNotified,
  loadSettings,
  saveCache,
  saveNotified,
  saveSettings,
  type ForecastDays,
  type Place,
} from './settings.ts';

const REFRESH_MS = 12 * 60 * 60 * 1000;
const RETRY_MINUTES = [1, 2, 5, 15, 30];
const SIZE = { expanded: { w: 720, h: 760 }, compact: { w: 380, h: 260 } } as const;
const SHORT_HOURS = 48;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
};

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmt = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '–' : String(Math.round(v)));

const state = {
  settings: loadSettings(),
  model: null as Model | null,
  fetchedAt: null as number | null,
  error: null as string | null,
  loading: false,
  range: 'short' as 'short' | 'all',
  /** First hour shown in the 48 h view; null = start just before now. */
  start: null as number | null,
  hover: null as number | null,
  menuOpen: false,
  settingsOpen: false,
  retryCount: 0,
  retryAt: null as number | null,
  lastTick: Date.now(),
  lastNowIdx: -1,
  results: [] as PlaceResult[],
};

let chart: ChartHandle | null = null;
let fetchCtl: AbortController | null = null;

const unit = (): Unit => state.settings.unit;
const unitLabel = (): string => UNIT_LABEL[unit()];
const gustLimit = (): number => Math.round(fromMph(state.settings.gustLimitMph, unit()));
const curIdx = (): number =>
  state.model && state.fetchedAt != null ? nowIndex(state.model, state.fetchedAt, Date.now()) : 0;

function persist(): void {
  saveSettings(state.settings);
}

function timeLabel(t: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

// ---------- Data ----------

/**
 * Development-only demo with built-in sample data, for working on the UI offline:
 * run `npm run dev` and open http://localhost:1420/?demo (or set VITE_DEMO=1).
 * Never included in release builds.
 */
const DEMO =
  import.meta.env.DEV &&
  (import.meta.env.VITE_DEMO === '1' || new URLSearchParams(location.search).has('demo'));

async function demoForecast(days: number): Promise<RawForecast> {
  const { sampleForecast } = await import('../tests/sample.ts');
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return sampleForecast(days, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, d.getHours());
}

function applyForecast(raw: RawForecast, fetchedAt: number): void {
  state.model = buildModel(raw);
  state.fetchedAt = fetchedAt;
  state.hover = null;
  state.lastNowIdx = curIdx();
}

async function refresh(reason: string): Promise<void> {
  const s = state.settings;
  const loc = s.location;
  if (!loc) {
    render();
    return;
  }
  fetchCtl?.abort();
  const ctl = new AbortController();
  fetchCtl = ctl;
  state.loading = true;
  renderHeader();
  try {
    const raw = DEMO ? await demoForecast(s.days) : await fetchForecast(loc.lat, loc.lon, s.unit, s.days, ctl.signal);
    if (ctl.signal.aborted) return;
    const now = Date.now();
    applyForecast(raw, now);
    saveCache({ key: cacheKey(s), fetchedAt: now, raw });
    state.error = null;
    state.retryCount = 0;
    state.retryAt = null;
    maybeNotify();
  } catch (e) {
    if (ctl.signal.aborted) return;
    state.error = e instanceof Error ? e.message : String(e);
    const wait = RETRY_MINUTES[Math.min(state.retryCount, RETRY_MINUTES.length - 1)];
    state.retryCount++;
    state.retryAt = Date.now() + wait * 60_000;
    console.warn(`Forecast refresh (${reason}) failed:`, e);
  } finally {
    if (fetchCtl === ctl) {
      fetchCtl = null;
      state.loading = false;
      render();
    }
  }
}

/** Runs every 30 s: the 12-hour refresh, retries, wake-from-sleep, and moving "now" along. */
function tick(): void {
  const now = Date.now();
  const gap = now - state.lastTick;
  state.lastTick = now;
  const s = state.settings;
  if (!s.location || state.loading) return;
  const age = state.fetchedAt == null ? Infinity : now - state.fetchedAt;

  if (age >= REFRESH_MS) return void refresh('schedule');
  if (state.retryAt != null && now >= state.retryAt) return void refresh('retry');
  // A long gap between ticks means the PC was asleep.
  if (gap > 3 * 60_000 && s.refreshOnWake && age > 30 * 60_000) return void refresh('wake');

  const idx = curIdx();
  if (idx !== state.lastNowIdx) {
    state.lastNowIdx = idx;
    render();
    maybeNotify();
  }
}

function maybeNotify(): void {
  const s = state.settings;
  const m = state.model;
  if (!s.notify || !m || !s.location) return;
  const from = curIdx();
  const first = firstGustAtOrAbove(m, from, gustLimit(), 24);
  if (first < 0) return;
  // One notification per location per day the limit is crossed.
  const key = `${s.location.lat.toFixed(2)},${s.location.lon.toFixed(2)}|${m.hours[first].date}`;
  if (loadNotified() === key) return;
  saveNotified(key);
  const peak = peakGust(m, from, 24);
  void platform.notify(
    `Gusts up to ${fmt(peak?.g)} ${unitLabel()} expected`,
    `${s.location.name}: gusts reach ${gustLimit()} ${unitLabel()} or more from ${whenLabel(m, first)}.`,
  );
}

function setLocation(p: Place): void {
  const s = state.settings;
  s.location = p;
  const same = (f: Place) => Math.abs(f.lat - p.lat) < 0.01 && Math.abs(f.lon - p.lon) < 0.01;
  if (!s.favorites.some(same)) s.favorites = [...s.favorites, p].slice(-8);
  persist();
  state.model = null;
  state.fetchedAt = null;
  state.start = null;
  state.error = null;
  state.retryAt = null;
  state.retryCount = 0;
  state.menuOpen = false;
  render();
  void refresh('location');
}

// ---------- Rendering ----------

function render(): void {
  renderHeader();
  renderMenu();
  const compact = state.settings.mode === 'compact' && !state.settingsOpen;
  $('expanded').hidden = compact;
  $('compact').hidden = !compact;
  document.querySelectorAll<HTMLElement>('.unit-label').forEach((el) => (el.textContent = unitLabel()));
  if (compact) renderCompact();
  else renderExpanded();
  if (state.settingsOpen) renderSettings();
}

function renderHeader(): void {
  const s = state.settings;
  const compact = s.mode === 'compact' && !state.settingsOpen;
  $('widget').classList.toggle('is-compact', compact);
  $('widget').classList.toggle('is-loading', state.loading);
  $('loc-name').textContent = s.location?.name ?? 'Choose a location';
  $('loc-btn').setAttribute('aria-expanded', String(state.menuOpen));

  let text = '';
  if (!s.location) text = '';
  else if (state.fetchedAt == null) text = state.loading ? 'Loading…' : state.error ? 'Couldn’t load forecast' : '';
  else if (state.error) text = `Offline · data from ${timeLabel(state.fetchedAt)}`;
  else if (compact) text = timeLabel(state.fetchedAt);
  else text = `Updated ${timeLabel(state.fetchedAt)} · next update ${timeLabel(state.fetchedAt + REFRESH_MS)}`;
  $('updated').textContent = text;

  const modeBtn = $('mode-btn');
  modeBtn.setAttribute('aria-label', compact ? 'Expand to full forecast' : 'Collapse to compact');
  modeBtn.title = compact ? 'Full forecast' : 'Compact view';

  const banner = $('banner');
  if (state.error && s.location && !compact) {
    const retry = state.retryAt ? ` Trying again at ${timeLabel(state.retryAt)}.` : '';
    banner.textContent = `Couldn’t refresh the forecast (${state.error}).${retry}`;
    banner.hidden = false;
  } else banner.hidden = true;

  // Dragging the header moves the widget, unless the position is locked.
  for (const id of ['bar', 'updated']) {
    const el = $(id);
    if (s.lockPosition) el.removeAttribute('data-tauri-drag-region');
    else el.setAttribute('data-tauri-drag-region', '');
  }
  const left = document.querySelector('.bar-left');
  if (s.lockPosition) left?.removeAttribute('data-tauri-drag-region');
  else left?.setAttribute('data-tauri-drag-region', '');
}

function renderMenu(): void {
  const menu = $('loc-menu');
  menu.hidden = !state.menuOpen;
  if (!state.menuOpen) return;
  const s = state.settings;
  const tick = (on: boolean) =>
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${on ? '#9CC6E8' : 'transparent'}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>`;
  const favs = s.favorites
    .map((f, i) => {
      const on = !!s.location && f.lat === s.location.lat && f.lon === s.location.lon;
      return `<button class="menu-item" role="menuitem" type="button" data-fav="${i}"><span>${esc(f.name)}</span>${tick(on)}</button>`;
    })
    .join('');
  menu.innerHTML = `
    ${favs ? `<span class="menu-label">Favorites</span>${favs}<div class="menu-sep"></div>` : ''}
    <button class="menu-item link" role="menuitem" type="button" data-action="search">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>
      Search or add a location…
    </button>`;
}

function arrowSvg(dir: number | null, size: number): string {
  const rot = dir == null ? 0 : (dir + 180) % 360;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(${rot} 12 12)"><path d="M12,3 L16.5,13 L12.8,11.6 L12.8,21 L11.2,21 L11.2,11.6 L7.5,13 Z" fill="#B7C4D0"/></g></svg>`;
}

function renderExpanded(): void {
  const m = state.model;
  const hasLoc = !!state.settings.location;
  $('empty').hidden = hasLoc;
  for (const id of ['now', 'days', 'graph']) $(id).hidden = !hasLoc;
  if (!hasLoc) return;

  const idx = curIdx();
  const cur = m ? conditionsAt(m, idx) : { s: null, g: null, dir: null };
  const lvl = levelFor(cur.s == null ? null : toMph(cur.s, unit()), state.settings.windyMph);
  $('now-s').textContent = fmt(cur.s);
  $('now-g').textContent = fmt(cur.g);
  const level = $('now-level');
  level.textContent = m ? lvl.name : '';
  level.style.color = lvl.color;
  $('now-card').textContent = cardinal(cur.dir);
  $('now-deg').textContent = cur.dir == null ? '' : `${Math.round(cur.dir)}°`;
  $('compass').setAttribute('aria-label', `Wind from ${cardinal(cur.dir)}`);
  $('compass-arrow').setAttribute('transform', `rotate(${cur.dir == null ? 0 : (cur.dir + 180) % 360} 48 48)`);

  const peak = m ? peakGust(m, idx, 24) : null;
  $('peak').textContent = m && peak ? `${fmt(peak.g)} ${unitLabel()} · ${whenLabel(m, peak.idx)}` : '–';
  const alertIdx = m ? firstGustAtOrAbove(m, idx, gustLimit()) : -1;
  $('alert').hidden = alertIdx < 0;
  if (m && alertIdx >= 0) $('alert-text').textContent = `Gusts ≥ ${gustLimit()} ${unitLabel()} from ${whenLabel(m, alertIdx)}`;

  renderDays();
  renderGraph();
}

function viewWindow(m: Model): Omit<ChartView, 'nowIdx' | 'unit' | 'windyMph' | 'gustLimit'> {
  const n = m.hours.length;
  if (state.range === 'all' || n <= SHORT_HOURS + 1) {
    const long = n > 7 * 24 + 1;
    const hourStep = long ? 12 : n > 72 ? 6 : 3;
    return {
      a: 0,
      b: Math.max(hourStep, Math.ceil((n - 1) / hourStep) * hourStep),
      hourStep,
      arrowStep: long ? 12 : n > 72 ? 6 : 2,
      longDayLabels: n <= 72,
    };
  }
  const a = clampStart(m, state.start ?? Math.floor(Math.max(0, curIdx() - 3) / 3) * 3);
  return { a, b: a + SHORT_HOURS, hourStep: 3, arrowStep: 2, longDayLabels: true };
}

function maxStart(m: Model): number {
  return Math.max(0, Math.floor((m.hours.length - 1 - SHORT_HOURS) / 3) * 3);
}

function clampStart(m: Model, start: number): number {
  return Math.min(Math.max(0, start), maxStart(m));
}

function renderDays(): void {
  const m = state.model;
  const el = $('days');
  if (!m) {
    el.innerHTML = '';
    return;
  }
  const w = viewWindow(m);
  const selectedDay = state.range === 'short' ? m.days.find((d) => w.a >= d.start && w.a < d.end)?.index : -1;
  el.innerHTML = m.days
    .map((d) => {
      const lvl = levelFor(d.maxS == null ? null : toMph(d.maxS, unit()), state.settings.windyMph);
      const cls = ['tile', d.index === selectedDay ? 'selected' : '', d.lowConfidence ? 'low' : ''].join(' ');
      const title = d.lowConfidence ? ' title="More than a week out: lower confidence"' : '';
      return `<button type="button" class="${cls}" data-day="${d.index}" aria-label="Show ${d.index === 0 ? 'today' : d.weekday} in graph"${title}>
        <span class="tile-day">${d.index === 0 ? 'Today' : d.weekday}</span>
        <span class="tile-date">${d.dateLabel}</span>
        ${arrowSvg(d.domDir, 22)}
        <span class="tile-wind"><b>${fmt(d.maxS)}</b><small>${esc(unitLabel())}</small></span>
        <span class="tile-gust">gust <b>${fmt(d.maxG)}</b> · ${cardinal(d.domDir)}</span>
        <span class="tile-bar" style="background:${lvl.color}"></span>
        <span class="tile-level" style="color:${lvl.color}">${lvl.name}</span>
      </button>`;
    })
    .join('');
}

function renderGraph(): void {
  const m = state.model;
  const s = state.settings;
  $('range-all').textContent = `${m ? m.days.length : s.days} days`;
  $('range-short').classList.toggle('on', state.range === 'short');
  $('range-all').classList.toggle('on', state.range === 'all');
  $('range-short').setAttribute('aria-pressed', String(state.range === 'short'));
  $('range-all').setAttribute('aria-pressed', String(state.range === 'all'));
  if (!m) {
    $('readout').textContent = state.loading ? 'Loading forecast…' : '';
    $('pan-prev').toggleAttribute('disabled', true);
    $('pan-next').toggleAttribute('disabled', true);
    return;
  }
  const w = viewWindow(m);
  $('pan-prev').toggleAttribute('disabled', state.range === 'all' || w.a <= 0);
  $('pan-next').toggleAttribute('disabled', state.range === 'all' || w.a >= maxStart(m));
  $('tz-note').textContent = m.tzAbbr ? `Times in ${m.tzAbbr} (the location’s local time)` : 'Times in the location’s local time';

  chart ??= createChart($('chart'), (idx) => {
    state.hover = idx;
    renderReadout();
  });
  chart.render(m, {
    ...w,
    nowIdx: curIdx(),
    unit: unit(),
    windyMph: s.windyMph,
    gustLimit: gustLimit(),
  });
  renderReadout();
}

function renderReadout(): void {
  const m = state.model;
  if (!m) return;
  const w = viewWindow(m);
  const now = curIdx();
  let idx = state.hover ?? (now >= w.a && now <= w.b ? now : w.a);
  idx = Math.min(Math.max(idx, 0), m.hours.length - 1);
  const h = m.hours[idx];
  const u = esc(unitLabel());
  $('readout').innerHTML = `
    <span class="when">${esc(whenLabel(m, idx))}</span>
    <span class="k">Wind <span class="s">${fmt(h.s)} ${u}</span></span>
    <span class="k">Gust <span class="g">${fmt(h.g)} ${u}</span></span>
    <span class="k">From <span class="d">${cardinal(h.dir)} ${h.dir == null ? '' : Math.round(h.dir) + '°'}</span></span>
    <span class="muted small" style="margin-left:auto">Hover the graph for any hour</span>`;
}

function renderCompact(): void {
  const m = state.model;
  const cur = m ? conditionsAt(m, curIdx()) : { s: null, g: null, dir: null };
  $('c-now-s').textContent = fmt(cur.s);
  $('c-now-g').textContent = fmt(cur.g);
  $('c-now-card').textContent = cardinal(cur.dir);
  $('c-compass').setAttribute('aria-label', `Wind from ${cardinal(cur.dir)}`);
  $('c-compass-arrow').setAttribute('transform', `rotate(${cur.dir == null ? 0 : (cur.dir + 180) % 360} 48 48)`);
  $('c-days').innerHTML = (m?.days.slice(0, 7) ?? [])
    .map((d) => {
      const lvl = levelFor(d.maxS == null ? null : toMph(d.maxS, unit()), state.settings.windyMph);
      return `<div class="c-tile"><span class="d">${d.index === 0 ? 'Today' : d.weekday}</span><span class="w">${fmt(d.maxS)}</span><span class="gg">G ${fmt(d.maxG)}</span><span class="bar" style="background:${lvl.color}"></span></div>`;
    })
    .join('');
}

function renderSettings(): void {
  const s = state.settings;
  $('fav-list').innerHTML = s.favorites.length
    ? s.favorites
        .map((f, i) => {
          const on = !!s.location && f.lat === s.location.lat && f.lon === s.location.lon;
          return `<div class="fav${on ? ' on' : ''}">
            <button type="button" class="fav-pick" data-fav="${i}"><span>${esc(f.name)}</span>${on ? '<span class="fav-tag">Showing</span>' : ''}</button>
            <button type="button" class="fav-remove" data-remove="${i}" aria-label="Remove ${esc(f.name)}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>
            </button>
          </div>`;
        })
        .join('')
    : '<p class="muted small">Locations you pick are saved here.</p>';

  document.querySelectorAll<HTMLButtonElement>('#unit-seg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.value === s.unit);
    b.setAttribute('aria-pressed', String(b.dataset.value === s.unit));
  });
  document.querySelectorAll<HTMLButtonElement>('#days-seg button').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.value) === s.days);
    b.setAttribute('aria-pressed', String(Number(b.dataset.value) === s.days));
  });
  $('len-note').textContent =
    s.days > 7
      ? `Days 8–${s.days} are shown faded: forecasts get much less reliable after about a week.`
      : 'Hourly detail for every day shown.';

  const windy = $<HTMLInputElement>('th-windy');
  const gust = $<HTMLInputElement>('th-gust');
  if (document.activeElement !== windy) windy.value = String(Math.round(fromMph(s.windyMph, s.unit)));
  if (document.activeElement !== gust) gust.value = String(gustLimit());
  $<HTMLInputElement>('opt-notify').checked = s.notify;
  $<HTMLInputElement>('opt-wake').checked = s.refreshOnWake;
  $<HTMLInputElement>('opt-opacity').value = String(s.opacity);
  $('opacity-val').textContent = `${s.opacity}%`;
  $<HTMLInputElement>('opt-behind').checked = s.keepBehind;
  $<HTMLInputElement>('opt-lock').checked = s.lockPosition;
  $<HTMLInputElement>('opt-login').checked = s.launchAtLogin;
}

function renderResults(message = ''): void {
  const box = $('search-results');
  box.hidden = state.results.length === 0;
  box.innerHTML = state.results
    .map((r, i) => `<button type="button" class="result" data-result="${i}"><span>${esc(r.name)}</span><span>${esc(r.detail)}</span></button>`)
    .join('');
  const msg = $('search-msg');
  msg.textContent = message;
  msg.hidden = !message;
}

function applyOpacity(): void {
  document.documentElement.style.setProperty('--alpha', String(state.settings.opacity / 100));
}

async function applyMode(): Promise<void> {
  const compact = state.settings.mode === 'compact' && !state.settingsOpen;
  const size = compact ? SIZE.compact : SIZE.expanded;
  await platform.setWindowSize(size.w, size.h);
  render();
  chart?.resize();
}

// ---------- Settings overlay ----------

function openSettings(focusSearch = false): void {
  state.settingsOpen = true;
  state.menuOpen = false;
  $('settings').hidden = false;
  void applyMode();
  if (focusSearch || !state.settings.location) setTimeout(() => $('loc-search').focus(), 0);
}

function closeSettings(): void {
  state.settingsOpen = false;
  $('settings').hidden = true;
  $<HTMLInputElement>('loc-search').value = '';
  state.results = [];
  renderResults();
  void applyMode();
}

let searchTimer = 0;
let searchCtl: AbortController | null = null;

function onSearchInput(): void {
  clearTimeout(searchTimer);
  const q = $<HTMLInputElement>('loc-search').value.trim();
  if (q.length < 2) {
    state.results = [];
    renderResults();
    return;
  }
  searchTimer = window.setTimeout(async () => {
    searchCtl?.abort();
    const ctl = new AbortController();
    searchCtl = ctl;
    try {
      state.results = await searchPlaces(q, ctl.signal);
      if (!ctl.signal.aborted) renderResults(state.results.length ? '' : `No places found for “${q}”.`);
    } catch (e) {
      if (!ctl.signal.aborted) {
        state.results = [];
        renderResults('Search isn’t available right now. Check your internet connection.');
        console.warn(e);
      }
    }
  }, 300);
}

function useMyLocation(): void {
  if (!('geolocation' in navigator)) {
    renderResults('Location isn’t available on this PC. Search for a place instead.');
    return;
  }
  renderResults('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      renderResults();
      setLocation({ name: `My location (${lat.toFixed(2)}, ${lon.toFixed(2)})`, lat, lon });
    },
    () => renderResults('Couldn’t get your location (Windows location may be off). Search for a place instead.'),
    { timeout: 10_000, maximumAge: 10 * 60_000 },
  );
}

function wireEvents(): void {
  $('loc-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.settings.location && !state.settings.favorites.length) return openSettings(true);
    state.menuOpen = !state.menuOpen;
    renderMenu();
    renderHeader();
  });
  $('loc-menu').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!btn) return;
    e.stopPropagation();
    if (btn.dataset.action === 'search') return openSettings(true);
    const fav = state.settings.favorites[Number(btn.dataset.fav)];
    if (fav) setLocation(fav);
  });
  document.addEventListener('click', () => {
    if (!state.menuOpen) return;
    state.menuOpen = false;
    renderMenu();
    renderHeader();
  });

  $('refresh-btn').addEventListener('click', () => void refresh('manual'));
  $('settings-btn').addEventListener('click', () => openSettings());
  $('empty-btn').addEventListener('click', () => openSettings(true));
  $('mode-btn').addEventListener('click', () => {
    if (state.settingsOpen) closeSettings();
    state.settings.mode = state.settings.mode === 'compact' ? 'expanded' : 'compact';
    persist();
    void applyMode();
  });

  $('days').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-day]');
    const m = state.model;
    if (!btn || !m) return;
    const day = m.days[Number(btn.dataset.day)];
    if (!day) return;
    state.range = 'short';
    state.start = clampStart(m, Math.floor(day.start / 3) * 3);
    state.hover = null;
    renderExpanded();
  });
  $('range-short').addEventListener('click', () => {
    state.range = 'short';
    state.start = null;
    state.hover = null;
    renderExpanded();
  });
  $('range-all').addEventListener('click', () => {
    state.range = 'all';
    state.hover = null;
    renderExpanded();
  });
  const pan = (delta: number) => {
    const m = state.model;
    if (!m) return;
    state.start = clampStart(m, viewWindow(m).a + delta);
    state.hover = null;
    renderExpanded();
  };
  $('pan-prev').addEventListener('click', () => pan(-24));
  $('pan-next').addEventListener('click', () => pan(24));
  $('attribution').addEventListener('click', (e) => {
    e.preventDefault();
    void platform.openExternal('https://open-meteo.com/');
  });

  // Settings
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-done').addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.settingsOpen) closeSettings();
    else if (state.menuOpen) {
      state.menuOpen = false;
      renderMenu();
    }
  });
  $('loc-search').addEventListener('input', onSearchInput);
  $('search-results').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-result]');
    const r = btn ? state.results[Number(btn.dataset.result)] : undefined;
    if (!r) return;
    $<HTMLInputElement>('loc-search').value = '';
    state.results = [];
    renderResults();
    setLocation({ name: r.name, lat: r.lat, lon: r.lon });
  });
  $('geo-btn').addEventListener('click', useMyLocation);
  $('fav-list').addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const s = state.settings;
    const pick = el.closest<HTMLElement>('[data-fav]');
    const remove = el.closest<HTMLElement>('[data-remove]');
    if (pick) {
      const f = s.favorites[Number(pick.dataset.fav)];
      if (f) setLocation(f);
    } else if (remove) {
      s.favorites = s.favorites.filter((_, i) => i !== Number(remove.dataset.remove));
      persist();
      renderSettings();
    }
  });
  $('unit-seg').addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')?.dataset.value as Unit | undefined;
    if (!v || v === state.settings.unit) return;
    state.settings.unit = v;
    persist();
    render();
    void refresh('unit');
  });
  $('days-seg').addEventListener('click', (e) => {
    const v = Number((e.target as HTMLElement).closest<HTMLElement>('[data-value]')?.dataset.value) as ForecastDays;
    if (!v || v === state.settings.days) return;
    state.settings.days = v;
    persist();
    render();
    void refresh('length');
  });
  const threshold = (id: string, key: 'windyMph' | 'gustLimitMph') =>
    $<HTMLInputElement>(id).addEventListener('change', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(v) && v > 0) {
        state.settings[key] = toMph(v, state.settings.unit);
        persist();
      }
      render();
    });
  threshold('th-windy', 'windyMph');
  threshold('th-gust', 'gustLimitMph');
  const toggle = (id: string, key: 'notify' | 'refreshOnWake' | 'keepBehind' | 'lockPosition' | 'launchAtLogin', after?: () => void) =>
    $<HTMLInputElement>(id).addEventListener('change', (e) => {
      state.settings[key] = (e.target as HTMLInputElement).checked;
      persist();
      after?.();
      render();
    });
  toggle('opt-notify', 'notify', () => {
    saveNotified('');
    maybeNotify();
  });
  toggle('opt-wake', 'refreshOnWake');
  toggle('opt-behind', 'keepBehind', () => void platform.setKeepBehind(state.settings.keepBehind));
  toggle('opt-lock', 'lockPosition');
  toggle('opt-login', 'launchAtLogin', () => void platform.syncAutostart(state.settings.launchAtLogin));
  $<HTMLInputElement>('opt-opacity').addEventListener('input', (e) => {
    state.settings.opacity = Number((e.target as HTMLInputElement).value);
    applyOpacity();
    $('opacity-val').textContent = `${state.settings.opacity}%`;
  });
  $<HTMLInputElement>('opt-opacity').addEventListener('change', persist);

  // Tray menu
  void platform.onTray('tray-refresh', () => void refresh('tray'));
  void platform.onTray('tray-settings', () => openSettings());

  window.addEventListener('online', () => {
    if (state.error) void refresh('online');
  });
  window.addEventListener('resize', () => chart?.resize());
}

// ---------- Start ----------

function start(): void {
  if (platform.isTauri) document.documentElement.classList.add('tauri');
  applyOpacity();
  wireEvents();

  const s = state.settings;
  if (DEMO) s.location ??= { name: 'Demo (sample data)', lat: 0, lon: 0 };
  const cache = DEMO ? null : loadCache();
  if (cache && s.location && cache.key === cacheKey(s)) {
    try {
      applyForecast(cache.raw, cache.fetchedAt);
    } catch (e) {
      console.warn('Ignoring unreadable cached forecast', e);
    }
  }

  void platform.setKeepBehind(s.keepBehind);
  void platform.syncAutostart(s.launchAtLogin);
  void applyMode().then(() => platform.showWindow());

  if (!s.location) openSettings(true);
  else if (state.fetchedAt == null || Date.now() - state.fetchedAt >= REFRESH_MS) void refresh('startup');

  window.setInterval(tick, 30_000);
}

start();
