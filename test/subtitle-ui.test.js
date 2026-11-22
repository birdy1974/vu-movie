/**
 * The Subtitles tab's result list — what the "show N hidden subtitles"
 * button and the attach buttons address:
 *
 *   1. blocks are addressed by position, not title — a series' episodes all
 *      share one title, and the toggle on the second block used to flip the
 *      first (which looked like "the button does nothing");
 *   2. rows keep their position in block.results / block.hidden under the
 *      language filter, so "attach" sends the row that was clicked;
 *   3. the hidden hits render as a section of their own, after the toggle.
 *
 * Same technique as test/find-ui.test.js: the real public/*.js evaluated in
 * a vm context with a small DOM stub; the registered click handler is
 * driven with synthetic events.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const source = (file) => fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');

function makeElement(selector = '') {
  const classes = new Set();
  const handlers = {};
  return {
    selector, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, dataset: {}, style: {}, handlers,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, on) => { const next = on === undefined ? !classes.has(name) : Boolean(on); if (next) classes.add(name); else classes.delete(name); return next; },
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) { this[name] = String(value); },
    getAttribute(name) { return this[name] ?? null; },
    removeAttribute(name) { delete this[name]; },
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    removeEventListener() {},
    appendChild() {}, remove() {}, focus() {}, blur() {}, click() {},
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  };
}

function loadApp({ onFetch = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) } = {}) {
  const elements = new Map();
  const elementFor = (selector) => {
    if (!elements.has(selector)) elements.set(selector, makeElement(selector));
    return elements.get(selector);
  };
  const document = {
    readyState: 'loading', hidden: false, body: elementFor('body'),
    querySelector: elementFor, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, createElement: () => makeElement(), execCommand: () => false,
  };
  const calls = [];
  const sandbox = {
    console, document,
    window: { addEventListener() {}, removeEventListener() {}, location: { hash: '' }, innerWidth: 1280, innerHeight: 800 },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    AbortController, URL, URLSearchParams, TextEncoder, TextDecoder, Blob, performance,
    VMPlaylist: { load: async () => {}, items: () => [], itemFor: () => null, templates: () => [], refresh: async () => {}, wire() {}, assignTemplate: async () => {} },
    fetch: (url, init = {}) => {
      const request = { url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null };
      calls.push(request);
      return Promise.resolve(onFetch(request));
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source('core.js'), context, { filename: 'public/core.js' });
  vm.runInContext(source('app.js'), context, { filename: 'public/app.js' });
  return { run: (code) => vm.runInContext(code, context), el: elementFor, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A click on an element matched by `selector` with these data-* values. */
const clickOn = (selector, dataset) => ({
  target: { closest: (wanted) => (wanted === selector ? { dataset, disabled: false } : null) },
});

const HIT_NL = { providerId: 'fake', id: 'nl1', url: 'http://x/nl1', language: 'nl', title: 'Cold Case', release: 'Cold.Case.S01E01.NL', notes: [] };
const HIT_EN = { providerId: 'fake', id: 'en1', url: 'http://x/en1', language: 'en', title: 'Cold Case', release: 'Cold.Case.S01E01.EN', notes: [] };
const HIDDEN = { providerId: 'fake', id: 'h1', url: 'http://x/h1', language: 'nl', title: 'Cold Case Files', release: 'Cold.Case.Files.2017', hidden: true, hiddenReason: '"Cold Case Files" is more than "Cold Case"', score: 12, notes: [] };

function twoEpisodes(app) {
  app.run(`state.subResults = ['s1', 's2'].map((streamId) => ({
    streamId, title: 'Cold Case', year: 2003,
    results: [${JSON.stringify(HIT_EN)}, ${JSON.stringify(HIT_NL)}],
    hidden: [${JSON.stringify(HIDDEN)}],
    attached: null, video: null, dropped: 1, droppedExamples: [], relaxed: null, attempts: [],
  }));`);
}

test('the show-hidden toggle addresses its own block, also when two blocks share a title', async () => {
  const app = loadApp();
  app.run('wireSubtitles()');
  twoEpisodes(app);
  app.run('renderSubResults()');
  const host = app.el('#sub-results');
  assert.match(host.innerHTML, /data-toggle-hidden="tab" data-block="0"/);
  assert.match(host.innerHTML, /data-toggle-hidden="tab" data-block="1"/);
  assert.doesNotMatch(host.innerHTML, /sub-hidden-tab-/, 'hidden hits start folded');

  const [onClick] = host.handlers.click;
  onClick(clickOn('[data-toggle-hidden]', { toggleHidden: 'tab', block: '1' }));
  assert.equal(app.run('JSON.stringify(state.subResults.map((b) => Boolean(b.showHidden)))'), '[false,true]', 'the second block opened, not the first');
  assert.match(host.innerHTML, /id="sub-hidden-tab-1"/);
  assert.doesNotMatch(host.innerHTML, /id="sub-hidden-tab-0"/);
  assert.match(host.innerHTML, /hidden: &quot;Cold Case Files&quot; is more than &quot;Cold Case&quot;/);
  assert.match(host.innerHTML, /hide 1 hidden subtitle/);

  onClick(clickOn('[data-toggle-hidden]', { toggleHidden: 'tab', block: '1' }));
  assert.equal(app.run('JSON.stringify(state.subResults.map((b) => Boolean(b.showHidden)))'), '[false,false]');
  assert.doesNotMatch(host.innerHTML, /sub-hidden-tab-/);
});

test('rows keep their real index under the language filter, and a hidden hit can be attached', async () => {
  const attached = [];
  const app = loadApp({
    onFetch: (request) => {
      if (/\/subtitle$/.test(request.url) && request.method === 'POST') {
        attached.push(request);
        return { ok: true, status: 200, json: async () => ({ ok: true, language: 'nl', cues: 10, check: { verdict: 'good', reasons: [] } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, items: [] }) };
    },
  });
  app.run('wireSubtitles()');
  twoEpisodes(app);
  app.el('#sub-lang-filter').value = 'nl';
  app.run('state.subResults[1].showHidden = true; renderSubResults()');
  const host = app.el('#sub-results');
  // Under "NL only" the one visible row is results[1] — the button must say so.
  assert.match(host.innerHTML, /data-attach="1" data-list="results" data-stream="s2" data-block="1"/);
  assert.doesNotMatch(host.innerHTML, /data-attach="0" data-list="results"/);
  assert.match(host.innerHTML, /data-attach="0" data-list="hidden" data-stream="s2" data-block="1"/);

  const [onClick] = host.handlers.click;
  onClick(clickOn('[data-attach]', { attach: '0', list: 'hidden', stream: 's2', block: '1' }));
  await tick(); await tick(); await tick();
  assert.equal(attached.length, 1);
  assert.equal(attached[0].url, '/api/playlist/items/s2/subtitle');
  assert.equal(attached[0].body.result.release, 'Cold.Case.Files.2017', 'the hidden hit that was clicked');
  assert.equal(app.run('state.subResults[1].attached?.release'), 'Cold.Case.Files.2017');
  assert.equal(app.run('state.subResults[0].attached'), null, 'the first episode is untouched');
  assert.match(host.innerHTML, /✓ attached now/);
});
