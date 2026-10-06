/**
 * jsdom end-to-end check for the Search panel (dev-only, not part of the app
 * bundle and not part of `npm test` — it needs the optional jsdom dependency):
 *
 *   npm install --no-save jsdom
 *   node scripts/find-panel-smoke.mjs
 *
 * Loads the real `public/index.html` with the four real scripts inlined (the
 * same trick `scripts/gui-harness.mjs` uses, so jsdom gives them classic-script
 * semantics) against a mocked API, and walks the panel the way an operator
 * does: search, watch the old cards disappear while the next search runs, click
 * the card (all providers) and a provider chip (one provider) on both the
 * desktop Search tab and the Mobile tab, then drive the two title filters.
 *
 * Exits non-zero on the first failed check, so it can be used as a gate after
 * touching public/app.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(import.meta.dirname, '..', 'public');

/* ---------------- fixtures + mocked API ---------------- */

const sources = [
  { id: 'cinejoy', name: 'Cinejoy', home: 'https://cinejoy.pk', enabled: true, kind: 'scraper' },
  { id: 'redflix', name: 'Redflix', home: 'https://redflix.club', enabled: true, kind: 'scraper' },
  { id: 'cinevo', name: 'Cinevo', home: 'https://cinevo.nl', enabled: true, kind: 'scraper' },
];
const smurfs = [
  { title: 'The Smurfs', year: 2025, kind: 'movie', url: 'https://cinejoy.pk/movie/smurfs-2025', sourceId: 'cinejoy' },
  { title: 'The Smurfs', year: 2025, kind: 'movie', url: 'https://redflix.club/play?id=936108', sourceId: 'redflix' },
  { title: 'The Smurfs', year: 1981, kind: 'series', url: 'https://cinevo.nl/tv/the-smurfs-1981', sourceId: 'cinevo' },
];
const dune = [{ title: 'Dune: Part Two', year: 2024, kind: 'movie', url: 'https://cinejoy.pk/movie/dune-2024', sourceId: 'cinejoy' }];

const resolves = [];
let searchAnswer = { results: smurfs, providerErrors: [] };
let deferNextSearch = false;
let releaseSearch = null;

const json = (data, status = 200) => ({ ok: status < 400 && data?.ok !== false, status, json: async () => data });
function fetchMock(url, options = {}) {
  const u = String(url);
  if (u.startsWith('/api/sources')) return json({ ok: true, sources });
  if (u.startsWith('/api/find/search')) {
    if (deferNextSearch) {
      deferNextSearch = false;
      return new Promise((resolve) => { releaseSearch = () => resolve(json({ ok: true, ...searchAnswer })); });
    }
    return json({ ok: true, ...searchAnswer });
  }
  if (u.startsWith('/api/find/resolve')) {
    const body = JSON.parse(options.body || '{}');
    resolves.push(body);
    return json({
      ok: true,
      candidates: [{ url: `${body.url}#1080`, quality: '1080p', label: '1080p', sourceId: body.sourceId, ok: true, probe: { video: { width: 1920, height: 1080, codec: 'h264' }, durationSec: 5400 } }],
    });
  }
  if (u.startsWith('/api/streams')) return json({ ok: true, stream: { title: 'The Smurfs' } });
  if (u.startsWith('/api/playlist')) return json({ ok: true, items: [], available: [], templates: [], urls: { page: 'http://h/pl/' } });
  if (u.startsWith('/api/health')) return json({ ok: true, version: '1.0.0', uptimeSec: 1, ffmpeg: { ok: true, version: '6.0' }, hwaccel: { available: false, reason: 'test' }, postgres: false, enigma2: { configured: false } });
  return json({ ok: true });
}

/* ---------------- load the real page ---------------- */

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
for (const file of ['core.js', 'web-codecs.js', 'playlist.js', 'ffmpeg-editor.js', 'app.js']) {
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
    window.mpegts = {
      Events: { ERROR: 'error' },
      isSupported: () => true,
      createPlayer: () => ({
        attachMediaElement() {}, on() {}, load() {}, play() { return Promise.resolve(); },
        pause() {}, unload() {}, detachMediaElement() {}, destroy() {},
      }),
    };
    window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
    window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled: ${e.reason}`));
  },
});

const win = dom.window;
const doc = win.document;
const $ = (sel) => doc.querySelector(sel);
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, extra = '') => {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${extra}`}`;
  results.push(line);
  console.log(line);
};
const click = (sel) => {
  const el = $(sel);
  if (!el) { check(`element ${sel}`, false, `not found; #results=${$('#results').innerHTML.slice(0, 200)}`); return false; }
  el.click();
  return true;
};

await tick(150);                                  // bootstrap → go('mobile')
check('page booted on the Mobile tab', Boolean(win.App) && doc.body.dataset.page === 'mobile', doc.body.dataset.page);

/* ---------------- desktop Search tab ---------------- */

win.App.go('find');
await tick(30);
$('#q').value = 'smurfs';
$('#btn-search').click();
await tick(60);
check('Search: cards rendered', /The Smurfs/.test($('#results').innerHTML), $('#results').innerHTML.slice(0, 120));
check('Search: two title groups', win.eval('state.groups.length') === 2, win.eval('state.groups.length'));

// A new search must drop the old cards at once, not when the response arrives.
deferNextSearch = true;
searchAnswer = { results: dune, providerErrors: [] };
$('#q').value = 'dune part two';
$('#btn-search').click();
await tick(10);
check('Search: old cards gone while the new search runs',
  !/Smurfs/.test($('#results').innerHTML) && /searching/.test($('#results').innerHTML),
  $('#results').innerHTML.slice(0, 160));
releaseSearch();
await tick(60);
check('Search: new cards rendered', /Dune: Part Two/.test($('#results').innerHTML) && !/Smurfs/.test($('#results').innerHTML));

searchAnswer = { results: smurfs, providerErrors: [] };
$('#q').value = 'smurfs';
$('#btn-search').click();
await tick(60);

/* card = every provider, chip = one provider */
resolves.length = 0;
click('#results [data-group]');
await tick(80);
check('card click resolves all providers',
  resolves.length === 2 && new Set(resolves.map((r) => r.sourceId)).size === 2,
  JSON.stringify(resolves.map((r) => r.sourceId)));
check('formats list has both providers', ($('#candidates').innerHTML.match(/data-candidate=/g) || []).length === 2, $('#candidates').innerHTML.slice(0, 100));

resolves.length = 0;
const chip = $('#results [data-provider="redflix"]');
check('provider chip exists in the card', Boolean(chip), `#results=${$('#results').innerHTML.slice(0, 200)}`);
if (chip) chip.click();
await tick(80);
check('chip click resolves one provider', resolves.length === 1 && resolves[0].sourceId === 'redflix', JSON.stringify(resolves.map((r) => r.sourceId)));
check('selection remembers the provider scope', win.eval('state.selection.activeSource') === 'redflix' && win.eval('state.selection.entries.length') === 1);
check('chip is marked pressed',
  $('#results [data-provider="redflix"]').classList.contains('on') && $('#results [data-provider="redflix"]').getAttribute('aria-pressed') === 'true');
check('“all providers” chip exists', Boolean($('#sel-providers [data-sel-provider=""]')));

resolves.length = 0;
click('#sel-providers [data-sel-provider=""]');
await tick(80);
check('“all providers” resolves both again', resolves.length === 2, JSON.stringify(resolves.map((r) => r.sourceId)));

/* the Kind filter: All / movie / series */
const kindOptions = [...$('#results-kind-filter').options].map((option) => `${option.value}:${option.textContent}`);
check('the Kind control offers all / movie / series', kindOptions.join(',') === ':All,movie:movie,series:series', kindOptions.join(','));
$('#results-kind-filter').value = 'series';
$('#results-kind-filter').dispatchEvent(new win.Event('change'));
await tick(30);
check('Kind=series keeps only the series card',
  doc.querySelectorAll('#results [data-group]').length === 1 && /\(1981\)/.test($('#results').innerHTML),
  $('#results').innerHTML.slice(0, 160));
check('the count accounts for the Kind filter', /1 of 2 title\(s\)/.test($('#results-count').textContent), $('#results-count').textContent);
$('#results-kind-filter').value = 'movie';
$('#results-kind-filter').dispatchEvent(new win.Event('change'));
await tick(30);
check('Kind=movie drops the series card', !/\(1981\)/.test($('#results').innerHTML) && /The Smurfs/.test($('#results').innerHTML));
$('#results-kind-filter').value = '';
$('#results-kind-filter').dispatchEvent(new win.Event('change'));
await tick(30);
check('Kind=All restores every card', doc.querySelectorAll('#results [data-group]').length === 2, doc.querySelectorAll('#results [data-group]').length);
check('the count is unfiltered again', /^2 title\(s\)/.test($('#results-count').textContent), $('#results-count').textContent);

/* the Found-titles box filters; it must not select */
const selectedBefore = $('#sel-name').textContent;
const options = [...$('#results-title-select').options];
const smurfs1981 = options.find((option) => /1981/.test(option.textContent));
check('the select lists every found title', options.length === 3 && Boolean(smurfs1981), options.map((o) => o.textContent).join(' | '));
$('#results-title-select').value = smurfs1981.value;
$('#results-title-select').dispatchEvent(new win.Event('change'));
await tick(30);
check('picking a title filters the list', doc.querySelectorAll('#results [data-group]').length === 1, doc.querySelectorAll('#results [data-group]').length);
check('the count says “1 of 2”', /1 of 2 title\(s\)/.test($('#results-count').textContent), $('#results-count').textContent);
check('filtering did not select a title', $('#sel-name').textContent === selectedBefore && win.eval('state.selection.activeSource') === '');
check('“All titles” still listed', options[0].textContent.includes('All titles'));

$('#results-title-filter').value = 'dune';
$('#results-title-filter').dispatchEvent(new win.Event('input'));
await tick(260);                                  // the filter is debounced
check('typing in the title filter drops the pick', win.eval('ui.titlePick') === '' && $('#results-title-select').value === '', `${win.eval('ui.titlePick')}/${$('#results-title-select').value}`);
check('text filter applies to the current results', !/Smurfs/.test($('#results').innerHTML) && /Nothing matches these filters/.test($('#results').innerHTML), $('#results').innerHTML.slice(0, 160));

/* ---------------- Mobile tab ---------------- */

win.App.go('mobile');
await tick(40);
$('#mob-q').value = 'smurfs';
$('#btn-mob-search').click();
await tick(60);
check('mobile search renders rows', /The Smurfs/.test($('#mob-results').innerHTML), $('#mob-results').innerHTML.slice(0, 120));
check('mobile rows offer provider chips', Boolean($('#mob-results [data-mprovider="redflix"]')));
resolves.length = 0;
click('#mob-results [data-mprovider="redflix"]');
await tick(80);
check('mobile chip resolves one provider', resolves.length === 1 && resolves[0].sourceId === 'redflix', JSON.stringify(resolves.map((r) => r.sourceId)));

console.log(errors.length ? `\nJS errors:\n${errors.join('\n')}` : '\nno page errors');
const failed = results.filter((line) => line.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || errors.length ? 1 : 0);
