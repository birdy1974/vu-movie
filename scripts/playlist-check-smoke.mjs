/**
 * jsdom end-to-end check for the Playlist tab's “⚡ check streams” (dev-only,
 * not part of the app bundle and not part of `npm test` — it needs the optional
 * jsdom dependency):
 *
 *   npm install --no-save jsdom
 *   node scripts/playlist-check-smoke.mjs
 *
 * Loads the real `public/index.html` with the four real scripts inlined (same
 * convention as scripts/gui-harness.mjs) against a mocked API whose
 * `/api/playlist/check` answers like the server does — one working stream, one
 * dead one, one without an upstream URL — and walks the tab: press the button,
 * watch the rows and the note fill in, then press a single row's ⚡.
 *
 * Exits non-zero on the first failed check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(import.meta.dirname, '..', 'public');

/* ---------------- fixtures + mocked API ---------------- */

const items = [
  { streamId: 's1', enabled: true, templateId: '', title: 'Dune: Part Two', year: 2024, kind: 'movie', sourceId: 'cinejoy', quality: '1080p', hasTemplate: false, urls: { ts: 'http://h/pl/a.ts' }, order: 0 },
  { streamId: 's2', enabled: true, templateId: '', title: 'Alien: Romulus', year: 2024, kind: 'movie', sourceId: 'cinevo', quality: '720p', hasTemplate: false, urls: { ts: 'http://h/pl/b.ts' }, order: 1 },
  { streamId: 's3', enabled: false, templateId: '', title: 'Old Smurfs', year: 1981, kind: 'series', sourceId: 'redflix', quality: '480p', hasTemplate: false, urls: { ts: 'http://h/pl/c.ts' }, order: 2 },
];

const PROBE = {
  container: 'matroska',
  durationSec: 5520,
  video: { codec: 'h264', width: 1920, height: 1080 },
  audio: [{ codec: 'aac', channels: 2 }],
  subtitleTracks: 0,
};

/** What the server would answer for each id (mirrors src/playlist/check.js states). */
const ANSWERS = {
  s1: { streamId: 's1', title: 'Dune: Part Two', sourceId: 'cinejoy', enabled: true, state: 'working', ok: true, error: null, probeMs: 820, probe: PROBE, variants: 0 },
  s2: { streamId: 's2', title: 'Alien: Romulus', sourceId: 'cinevo', enabled: true, state: 'dead', ok: false, error: 'probe failed (dead mirror, expired token, geo-block or unsupported container)', probeMs: 4300, probe: null, variants: 0 },
  s3: { streamId: 's3', title: 'Old Smurfs', sourceId: 'redflix', enabled: false, state: 'expired', ok: false, error: 'the upstream token expired at 2026-01-01 00:00 — re-resolve the title for a fresh URL', probeMs: null, probe: null, variants: 0 },
};

const checkCalls = [];
const json = (data, status = 200) => ({ ok: status < 400 && data?.ok !== false, status, json: async () => data });
function fetchMock(url, options = {}) {
  const u = String(url);
  const method = options.method || 'GET';
  if (u.startsWith('/api/playlist/check')) {
    const body = JSON.parse(options.body || '{}');
    const ids = body.streamIds || items.map((item) => item.streamId);
    checkCalls.push(ids);
    const results = ids.map((id) => ANSWERS[id]).filter(Boolean);
    return json({
      ok: true,
      results,
      summary: { checked: results.length, checkedAt: '2026-10-06T20:15:00.000Z', ms: 1234, probing: true, concurrency: 1, requested: ids.length, working: 0, dead: 0, expired: 0, unverified: 0, skipped: 0, broken: 0 },
    });
  }
  if (u.startsWith('/api/playlist')) {
    return json({
      ok: true,
      name: 'vu-movie',
      summary: { total: items.length, enabled: 2, withTemplate: 0, withSubtitle: 0 },
      items,
      available: [],
      templates: [],
      defaultTemplateId: '',
      urls: { page: 'http://h/pl/tok/', m3u: 'http://h/pl/tok/playlist.m3u' },
      storage: { writable: true },
    });
  }
  if (u.startsWith('/api/streams')) return json({ ok: true, streams: [], stream: { title: 'x' } });
  if (u.startsWith('/api/health')) return json({ ok: true, version: '1.0.0', uptimeSec: 1, ffmpeg: { ok: true, version: '6.0' }, hwaccel: { available: false, reason: 'test' }, postgres: false, enigma2: { configured: false } });
  if (u.startsWith('/api/config')) return json({ ok: true, config: { app: {}, transcode: {}, subtitles: {}, enigma2: {}, scraper: {}, storage: {} } });
  void method;
  return json({ ok: true });
}

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
for (const file of ['core.js', 'playlist.js', 'ffmpeg-editor.js', 'app.js']) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/<\/script/gi, '<\\/script');
  html = html.replace(`<script src="/${file}"></script>`, () => `<script>${code}</script>`);
}

const errors = [];
const dom = new JSDOM(html, {
  url: 'http://127.0.0.1:8080/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = fetchMock;
    window.EventSource = class { constructor() { this.readyState = 0; } addEventListener() {} close() {} };
    window.mpegts = { Events: { ERROR: 'error' }, isSupported: () => true, createPlayer: () => ({ attachMediaElement() {}, on() {}, load() {}, play() { return Promise.resolve(); }, pause() {}, unload() {}, detachMediaElement() {}, destroy() {} }) };
    window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
    window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled: ${e.reason}`));
  },
});

const win = dom.window;
const doc = win.document;
const $ = (sel) => doc.querySelector(sel);
const $$ = (sel) => [...doc.querySelectorAll(sel)];
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, extra = '') => {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${extra}`}`;
  results.push(line);
  console.log(line);
};

await tick(150);
win.App.go('list');
await tick(160);
check('the Playlist tab renders its rows', $$('#playlist-items [data-pl-row]').length === 3, $$('#playlist-items [data-pl-row]').length);
check('every row offers a per-row ⚡ check', $$('#playlist-items [data-pl-check]').length === 3);
check('no health is claimed before a check', $$('#playlist-items .pl-health .tag').length === 0, $('#playlist-items').innerHTML.slice(0, 120));
check('the note starts empty', $('#list-check-note').textContent === '', $('#list-check-note').textContent);

/* the whole list */
$('#btn-list-check').click();
await tick(120);
check('one request per row', checkCalls.length === 3 && checkCalls.every((ids) => ids.length === 1), JSON.stringify(checkCalls));
const rowHtml = () => $$('#playlist-items [data-pl-row]').map((row) => row.innerHTML).join('\n');
const first = $$('#playlist-items [data-pl-row]')[0];
const second = $$('#playlist-items [data-pl-row]')[1];
const third = $$('#playlist-items [data-pl-row]')[2];
check('s1 is “working” with what ffprobe found', /working 1920×1080 h264 · 1h 32m/.test(first.innerHTML), first.innerHTML.slice(0, 200));
check('the working tag explains itself in its tooltip', /title="checked [^"]*container matroska · video h264 1920×1080/.test(first.innerHTML), first.innerHTML.slice(0, 400));
check('s2 is “not working” and its row is flagged', /not working/.test(second.innerHTML) && second.classList.contains('bad'), second.className);
check('the dead reason is in the row tooltip', /dead mirror, expired token, geo-block/.test(second.innerHTML), second.innerHTML.slice(0, 300));
check('s3 is “token expired” even with no newer probe', /token expired/.test(third.innerHTML) && third.classList.contains('bad'));
check('the note summarises the check', /1\/3 working · 2 not working: Alien: Romulus \(.*dead mirror.*Old Smurfs \(the upstream token expired/.test($('#list-check-note').textContent), $('#list-check-note').textContent);
check('the note is marked as carrying broken items', $('#list-check-note').classList.contains('has-broken'));
check('the button is usable again', $('#btn-list-check').disabled === false);
check('rows keep their data (nothing is removed by a check)', $$('#playlist-items [data-pl-row]').length === 3 && rowHtml().length > 0);
check('a disabled item is still checked and keeps its switch off', third.querySelector('[data-pl-enabled]').checked === false);

/* a single row, after the list was already checked */
$$('#playlist-items [data-pl-check]')[1].click();
await tick(80);
check('the per-row ⚡ checks only that row', checkCalls.length === 4 && checkCalls[3].join() === 's2', JSON.stringify(checkCalls));
check('the other rows keep their state', /working 1920×1080/.test($$('#playlist-items [data-pl-row]')[0].innerHTML));

console.log(errors.length ? `\nJS errors:\n${errors.join('\n')}` : '\nno page errors');
const failed = results.filter((line) => line.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || errors.length ? 1 : 0);
