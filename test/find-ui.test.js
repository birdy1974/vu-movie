/**
 * The Search panel's result list — the three behaviours a user actually sees:
 *
 *   1. a new search never shows the previous answer, not even while it runs;
 *   2. clicking a result resolves the formats of *every* provider on the card,
 *      clicking a provider chip inside the result resolves only that provider;
 *   3. “Filter found title” filters the list — it does not select the title.
 *
 * public/*.js are classic browser scripts sharing one global scope (core.js
 * defines `state`, `$`, `escapeHtml`, `api()`; app.js owns the Search panel),
 * so the test evaluates the *real* files in a vm context — the same trick
 * test/ffmpeg-editor-advice.test.js uses — with a small DOM stub, and drives
 * the real functions. No browser, no jsdom, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const source = (file) => fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');

/* ---------------- DOM stub ---------------- */

function makeElement(selector = '') {
  const classes = new Set();
  const handlers = {};
  return {
    selector,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    dataset: {},
    style: {},
    handlers,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, on) => {
        const next = on === undefined ? !classes.has(name) : Boolean(on);
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) { this[name] = String(value); },
    getAttribute(name) { return this[name] ?? null; },
    removeAttribute(name) { delete this[name]; },
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    removeEventListener(type, fn) { handlers[type] = (handlers[type] || []).filter((entry) => entry !== fn); },
    appendChild() {}, remove() {}, focus() {}, blur() {}, click() {}, select() {}, setSelectionRange() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  };
}

function makeDom() {
  const elements = new Map();
  const elementFor = (selector) => {
    if (!elements.has(selector)) elements.set(selector, makeElement(selector));
    return elements.get(selector);
  };
  const document = {
    // `loading` (plus a no-op addEventListener) keeps bootstrap() from running:
    // the test drives the panel itself.
    readyState: 'loading',
    hidden: false,
    body: elementFor('body'),
    querySelector: elementFor,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    createElement: () => makeElement(),
    execCommand: () => false,
  };
  return { document, elementFor };
}

/* ---------------- app loader ---------------- */

const json = (data, status = 200) => ({ ok: data?.ok !== false && status < 400, status, json: async () => data });

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function loadApp({ onFetch = () => json({ ok: true }) } = {}) {
  const { document, elementFor } = makeDom();
  const calls = [];
  const store = new Map();
  const sandbox = {
    console,
    document,
    window: { addEventListener() {}, removeEventListener() {}, location: { hash: '' }, innerWidth: 1280, innerHeight: 800 },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    AbortController, URL, URLSearchParams, TextEncoder, TextDecoder, Blob, performance,
    // The real playlist module is not loaded here; the mobile helpers only call
    // into it when adding to the playlist.
    VMPlaylist: {
      load: async () => {}, items: () => [], templates: () => [],
      refresh: async () => {}, wire() {}, assignTemplate: async () => {},
    },
    fetch: (url, init = {}) => {
      const request = {
        url: String(url),
        method: init.method || 'GET',
        body: init.body ? JSON.parse(init.body) : null,
        signal: init.signal || null,
      };
      calls.push(request);
      return Promise.resolve(onFetch(request));
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source('core.js'), context, { filename: 'public/core.js' });
  vm.runInContext(source('app.js'), context, { filename: 'public/app.js' });
  return {
    run: (code) => vm.runInContext(code, context),
    el: elementFor,
    calls,
    resolves: () => calls.filter((call) => call.url.startsWith('/api/find/resolve')),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Fire the real delegated listener registered on an element. */
function fire(element, type, target) {
  const event = { target, key: '', preventDefault() {}, stopPropagation() {} };
  for (const fn of [...(element.handlers[type] || [])]) fn(event);
}

/* ---------------- fixtures ---------------- */

const SOURCES = [
  { id: 'cinejoy', name: 'Cinejoy', home: 'https://cinejoy.pk', enabled: true },
  { id: 'redflix', name: 'Redflix', home: 'https://redflix.club', enabled: true },
  { id: 'cinevo', name: 'Cinevo', home: 'https://cinevo.nl', enabled: true },
];

const SMURFS = [
  { title: 'The Smurfs', year: 2025, kind: 'movie', url: 'https://cinejoy.pk/movie/smurfs-2025', sourceId: 'cinejoy' },
  { title: 'The Smurfs', year: 2025, kind: 'movie', url: 'https://redflix.club/play?id=936108', sourceId: 'redflix' },
  { title: 'The Smurfs', year: 1981, kind: 'series', url: 'https://cinevo.nl/tv/the-smurfs-1981', sourceId: 'cinevo' },
];
const DUNE = [
  { title: 'Dune: Part Two', year: 2024, kind: 'movie', url: 'https://cinejoy.pk/movie/dune-2024', sourceId: 'cinejoy' },
];

/** The API a panel test needs: sources, a search that answers instantly, and resolves. */
function standardFetch({ search = () => json({ ok: true, results: [], providerErrors: [] }) } = {}) {
  return (request) => {
    if (request.url.startsWith('/api/sources')) return json({ ok: true, sources: SOURCES });
    if (request.url.startsWith('/api/find/search')) return search(request);
    if (request.url.startsWith('/api/find/resolve')) {
      return json({
        ok: true,
        candidates: [{ url: `${request.body.url}#1080`, quality: '1080p', label: '1080p', sourceId: request.body.sourceId, ok: true }],
      });
    }
    return json({ ok: true });
  };
}

/* ---------------- 1. no stale results ---------------- */

test('a new search clears the previous answer before the request comes back', async () => {
  const pending = deferred();
  const queries = [];
  const app = loadApp({
    onFetch: standardFetch({
      search: (request) => {
        queries.push(request.url);
        return pending.promise;
      },
    }),
  });
  app.run(`state.sources = ${JSON.stringify(SOURCES)}; state.selectedSources = ${JSON.stringify(SOURCES.map((s) => s.id))};`);
  app.run(`state.results = ${JSON.stringify(SMURFS)}; state.searched = true; renderResults();`);
  assert.match(app.el('#results').innerHTML, /The Smurfs/);

  app.el('#q').value = 'dune part two';
  const searching = app.run('doSearch()');

  // Still in flight: the old cards must be gone and the panel must say what runs.
  assert.doesNotMatch(app.el('#results').innerHTML, /Smurfs/);
  assert.match(app.el('#results').innerHTML, /searching .*dune part two/);
  assert.equal(app.el('#results')['aria-busy'], 'true');
  assert.equal(app.el('#results-count').textContent, 'searching…');
  assert.equal(app.run('state.results.length'), 0);
  assert.equal(queries.length, 1, 'the request went out after the panel was reset');

  pending.resolve(json({ ok: true, results: DUNE, providerErrors: [] }));
  await searching;

  assert.match(app.el('#results').innerHTML, /Dune: Part Two/);
  assert.doesNotMatch(app.el('#results').innerHTML, /Smurfs/);
  assert.equal(app.el('#results')['aria-busy'], 'false');
  assert.equal(app.el('#results-title-filter').value, '');
});

test('a failed search reports itself and does not fall back to the old cards', async () => {
  const app = loadApp({ onFetch: standardFetch({ search: () => json({ ok: false, error: 'nothing answered' }, 502) }) });
  app.run(`state.sources = ${JSON.stringify(SOURCES)}; state.selectedSources = [];`);
  app.run(`state.results = ${JSON.stringify(SMURFS)}; state.searched = true; renderResults();`);
  app.el('#q').value = 'dune';
  await app.run('doSearch()');

  assert.doesNotMatch(app.el('#results').innerHTML, /Smurfs/);
  assert.match(app.el('#results').innerHTML, /search failed — nothing answered/);
  assert.match(app.el('#find-errors').innerHTML, /nothing answered/);
});

/* ---------------- 2. card = all providers, chip = one provider ---------------- */

test('clicking a result resolves every provider on the card', async () => {
  const app = loadApp({ onFetch: standardFetch() });
  app.run(`state.sources = ${JSON.stringify(SOURCES)}; state.results = ${JSON.stringify(SMURFS)}; renderResults();`);
  await app.run('selectGroup(visibleGroups().find((group) => group.year === 2025))');

  const calls = app.resolves();
  assert.equal(calls.length, 2, 'one resolve per provider entry');
  assert.deepEqual(
    calls.map((call) => call.body.sourceId).sort(),
    ['cinejoy', 'redflix'],
  );
  assert.equal(app.run('state.selection.activeSource'), '');
  assert.equal(app.run('state.selection.entries.length'), 2);
  assert.match(app.el('#sel-meta').textContent, /2 format\(s\) from 2 provider\(s\)/);
  assert.match(app.el('#sel-note').textContent, /Formats come from every provider on this card/);
  assert.equal(app.run('state.candidates.length'), 2);
});

test('clicking a provider chip resolves only that provider', async () => {
  const app = loadApp({ onFetch: standardFetch() });
  app.run(`state.sources = ${JSON.stringify(SOURCES)}; state.results = ${JSON.stringify(SMURFS)}; renderResults();`);
  await app.run(`selectGroup(visibleGroups().find((group) => group.year === 2025), { sourceId: 'redflix' })`);

  const calls = app.resolves();
  assert.equal(calls.length, 1, 'only the clicked provider is resolved');
  assert.equal(calls[0].body.sourceId, 'redflix');
  assert.equal(calls[0].body.url, 'https://redflix.club/play?id=936108');
  assert.equal(app.run('state.selection.activeSource'), 'redflix');
  assert.equal(app.run('state.selection.entries.length'), 1);
  assert.match(app.el('#sel-meta').textContent, /Redflix only/);
  assert.equal(app.run('state.candidates.length'), 1);
  assert.equal(app.run('state.candidates[0].sourceId'), 'redflix');
});

test('the click on a provider chip in the DOM only resolves that provider', async () => {
  const app = loadApp({ onFetch: standardFetch() });
  app.run('initFind()');
  await tick();
  app.run(`state.results = ${JSON.stringify(SMURFS)}; renderResults();`);
  const key = app.run('visibleGroups().find((group) => group.year === 2025).key');

  const card = { dataset: { group: key } };
  const chip = {
    dataset: { provider: 'cinejoy' },
    closest: (selector) => (selector === '[data-provider]' ? chip : selector === '[data-group]' ? card : null),
  };
  fire(app.el('#results'), 'click', chip);
  await tick();

  const calls = app.resolves();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.sourceId, 'cinejoy');
  assert.equal(app.run('state.selection.activeSource'), 'cinejoy');
});

test('the card markup marks the active provider and keeps the chips clickable', async () => {
  const app = loadApp({ onFetch: standardFetch() });
  app.run(`state.sources = ${JSON.stringify(SOURCES)}; state.results = ${JSON.stringify(SMURFS)}; renderResults();`);
  await app.run(`selectGroup(visibleGroups().find((group) => group.year === 2025), { sourceId: 'redflix' })`);
  app.run('renderResults()');

  const html = app.el('#results').innerHTML;
  const cinejoy = html.match(/<button[^>]*data-provider="cinejoy"[^>]*>/)[0];
  const redflix = html.match(/<button[^>]*data-provider="redflix"[^>]*>/)[0];
  assert.match(cinejoy, /class="chip sm provider-chip"/);
  assert.match(cinejoy, /aria-pressed="false"/);
  assert.match(redflix, /class="chip sm provider-chip on"/);
  assert.match(redflix, /aria-pressed="true"/);
  assert.match(html, /Cinejoy<span class="mut">1<\/span>/);
});

test('the mobile result row narrows to one provider as well', async () => {
  const app = loadApp({ onFetch: standardFetch() });
  app.run(`state.sources = ${JSON.stringify(SOURCES)}; state.mobile.results = buildGroups(${JSON.stringify(SMURFS)});`);
  await app.run('mobileSelect(state.mobile.results[0], { sourceId: "cinevo" })');
  assert.equal(app.resolves().length, 0, 'the 1981 group lives on cinevo, the 2025 group does not');
  assert.match(app.el('#mob-search-hint').textContent, /no Cinevo format/);

  await app.run('mobileSelect(state.mobile.results[0], { sourceId: "redflix" })');
  assert.equal(app.resolves().length, 1);
  assert.equal(app.resolves()[0].body.sourceId, 'redflix');
  assert.equal(app.run('state.mobile.activeSource'), 'redflix');
  assert.match(app.el('#mob-formats').innerHTML, /Redflix/);
});

test('the mobile pane searches, drops the old rows, and can add a format', async () => {
  const pending = deferred();
  let answer = () => pending.promise;
  const app = loadApp({ onFetch: standardFetch({ search: () => answer() }) });
  app.run(`state.sources = ${JSON.stringify(SOURCES)};`);
  await app.run('initMobile()');
  app.el('#mob-q').value = 'smurfs';
  const first = app.run('mobileSearch()');
  pending.resolve(json({ ok: true, results: SMURFS, providerErrors: [] }));
  await first;
  assert.match(app.el('#mob-results').innerHTML, /The Smurfs/);
  assert.match(app.el('#mob-results').innerHTML, /data-mprovider="redflix"/);
  assert.equal(app.run('state.mobile.results.length'), 2);

  // A second search must not show the first answer while it runs…
  const second = deferred();
  answer = () => second.promise;
  app.el('#mob-q').value = 'dune';
  const running = app.run('mobileSearch()');
  assert.doesNotMatch(app.el('#mob-results').innerHTML, /Smurfs/);
  assert.match(app.el('#mob-results').innerHTML, /searching .*dune/);
  second.resolve(json({ ok: true, results: DUNE, providerErrors: [] }));
  await running;
  assert.match(app.el('#mob-results').innerHTML, /Dune: Part Two/);

  // …and a failed search must not leave the old rows either.
  answer = () => json({ ok: false, error: 'no source answered' }, 502);
  app.el('#mob-q').value = 'smurfs';
  await app.run('mobileSearch()');
  assert.doesNotMatch(app.el('#mob-results').innerHTML, /Dune/);
  assert.match(app.el('#mob-results').innerHTML, /search failed — no source answered/);

  // Picking a format still reaches the playlist endpoint.
  answer = () => json({ ok: true, results: DUNE, providerErrors: [] });
  await app.run('mobileSearch()');
  await app.run('mobileSelect(state.mobile.results[0])');
  await app.run('mobileAdd(0)');
  assert.equal(app.calls.filter((call) => call.url === '/api/streams' && call.method === 'POST').length, 1);
});

/* ---------------- 3. “Filter found title” filters ---------------- */

test('“Filter found title” narrows the list instead of selecting the title', () => {
  const app = loadApp({ onFetch: standardFetch() });
  app.run(`state.sources = ${JSON.stringify(SOURCES)}; state.results = ${JSON.stringify([...SMURFS, ...DUNE])}; renderResults();`);
  assert.equal(app.run('visibleGroups().length'), 3);

  const key = app.run('visibleGroups().find((group) => group.year === 1981).key');
  app.run(`applyTitlePick(${JSON.stringify(key)})`);

  assert.equal(app.run('ui.titlePick'), key);
  assert.equal(app.run('visibleGroups().length'), 1);
  assert.match(app.el('#results').innerHTML, /The Smurfs/);
  assert.doesNotMatch(app.el('#results').innerHTML, /Dune: Part Two/);
  assert.match(app.el('#results-count').textContent, /1 of 3 title\(s\)/);
  assert.equal(app.el('#results-title-select').value, key);
  // Filtering must not select: the panel keeps waiting for a card click.
  assert.ok(!app.run('state.selection'));
  assert.doesNotMatch(app.el('#sel-name').textContent, /The Smurfs/);
  // …and the other titles stay reachable from the same box.
  assert.match(app.el('#results-title-select').innerHTML, /Dune: Part Two \(2024\)/);

  // Choosing “All titles” goes back to the whole list.
  app.run('applyTitlePick("")');
  assert.equal(app.run('visibleGroups().length'), 3);
  assert.match(app.el('#results').innerHTML, /Dune: Part Two/);
});

test('the free-text filter and the title pick clear each other', () => {
  const app = loadApp({ onFetch: standardFetch() });
  app.run(`state.sources = ${JSON.stringify(SOURCES)}; state.results = ${JSON.stringify([...SMURFS, ...DUNE])}; renderResults();`);
  const key = app.run('visibleGroups().find((group) => group.year === 1981).key');
  app.run(`applyTitlePick(${JSON.stringify(key)})`);
  assert.equal(app.run('ui.titlePick'), key);

  app.run('applyTitleFilter("dune")');
  assert.equal(app.run('ui.titlePick'), '');
  assert.equal(app.run('ui.titleFilter'), 'dune');
  assert.equal(app.el('#results-title-select').value, '');
  assert.match(app.el('#results').innerHTML, /Dune: Part Two/);
  assert.doesNotMatch(app.el('#results').innerHTML, /The Smurfs/);

  // An empty result set while filtering says so — and mentions no old title.
  app.run('applyTitleFilter("nothing like this")');
  assert.match(app.el('#results').innerHTML, /Nothing matches these filters\./);
});

test('picking a title clears a provider filter that would hide it', () => {
  const app = loadApp({ onFetch: standardFetch() });
  app.run(`state.sources = ${JSON.stringify(SOURCES)}; state.results = ${JSON.stringify([...SMURFS, ...DUNE])}; renderResults();`);
  app.el('#results-provider-filter').value = 'cinevo';
  app.run('renderResults()');
  assert.equal(app.run('ui.providerFilter'), 'cinevo');
  assert.equal(app.run('visibleGroups().length'), 1);
  assert.doesNotMatch(app.el('#results').innerHTML, /Dune: Part Two/);

  const key = app.run('state.groups.find((group) => group.year === 2024).key');
  app.run(`applyTitlePick(${JSON.stringify(key)})`);
  assert.equal(app.run('ui.providerFilter'), '');
  assert.equal(app.run('visibleGroups().length'), 1);
  assert.match(app.el('#results').innerHTML, /Dune: Part Two/);
});
