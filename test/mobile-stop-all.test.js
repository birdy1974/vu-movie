/**
 * The Mobile tab's "stop all sessions" card (public/app.js + index.html), driven
 * through the real functions in a vm context with a small DOM stub, the same way
 * find-ui.test.js drives the Search panel. No browser, no network.
 *
 * What it pins: the button is live only while relay sessions run; a stop asks
 * first and lists what it will stop; a confirmed stop posts once and reports the
 * count the server returns; a failed stop says so and keeps the list on screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const source = (file) => fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');

/* ---------------- DOM stub (as in find-ui.test.js) ---------------- */

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
    // `loading` keeps bootstrap() from running: the test drives the panel itself.
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

const TITLES = { 'stream-a': 'The Smurfs', 'stream-b': 'Dune: Part Two' };
const json = (data, status = 200) => ({ ok: data?.ok !== false && status < 400, status, json: async () => data });

function loadApp({ confirmAnswer = true, stopResponse = { ok: true, stopped: 0 }, stopStatus = 200 } = {}) {
  const { document, elementFor } = makeDom();
  // The stream tab is not on screen, so renderSessions skips its monitor.
  elementFor('#p-stream').classList.add('hide');
  const calls = [];
  const confirms = [];
  const store = new Map();
  const sandbox = {
    console,
    document,
    window: {
      addEventListener() {}, removeEventListener() {}, location: { hash: '' }, innerWidth: 1280, innerHeight: 800,
      confirm: (message) => { confirms.push(String(message)); return confirmAnswer; },
    },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    AbortController, URL, URLSearchParams, TextEncoder, TextDecoder, Blob, performance,
    VMPlaylist: {
      load: async () => {}, items: () => [], templates: () => [],
      refresh: async () => {}, wire() {}, assignTemplate: async () => {},
      itemFor: (streamId) => (TITLES[streamId] ? { streamId, title: TITLES[streamId] } : null),
    },
    fetch: (url, init = {}) => {
      const request = {
        url: String(url),
        method: init.method || 'GET',
        body: init.body ? JSON.parse(init.body) : null,
      };
      calls.push(request);
      if (request.url === '/api/sessions/stop-all') return Promise.resolve(json(stopResponse, stopStatus));
      return Promise.resolve(json({ ok: true, sources: [] }));
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source('core.js'), context, { filename: 'public/core.js' });
  vm.runInContext(source('app.js'), context, { filename: 'public/app.js' });
  return {
    run: (code) => vm.runInContext(code, context),
    el: elementFor,
    calls,
    confirms,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settleAll() {
  for (let i = 0; i < 8; i += 1) await tick();
}

/** Fire the real click listener registered on an element. */
function click(element) {
  const event = { target: element, key: '', preventDefault() {}, stopPropagation() {} };
  for (const fn of [...(element.handlers.click || [])]) fn(event);
}

/** Capture toasts in the sandbox so the test can read what the user was told. */
function captureToasts(app) {
  app.run('globalThis.__toasts = []; toast = (message, kind) => { __toasts.push([String(message), kind]); };');
}
const toastsOf = (app) => JSON.stringify(app.run('__toasts'));

const TWO_SESSIONS = "[{ streamId: 'stream-a', clients: 1, web: false }, { streamId: 'stream-b', clients: 0, web: true }]";

/* -------------------------------------------------------------------- tests */

test('before the first session event the card says it is checking, and cannot stop anything', async () => {
  const app = loadApp();
  await app.run('initMobile()');
  await settleAll();
  assert.match(app.el('#mob-sessions').innerHTML, /checking/);
  assert.equal(app.el('#btn-mob-stop-all').disabled, true);
});

test('running sessions are listed by title, a web preview is marked, and the button is live', async () => {
  const app = loadApp();
  await app.run('initMobile()');
  app.run(`renderSessions(${TWO_SESSIONS})`);
  const html = app.el('#mob-sessions').innerHTML;
  assert.match(html, /The Smurfs/);
  assert.match(html, /Dune: Part Two/);
  assert.match(html, /\(web preview\)/);
  assert.equal(app.el('#mob-sessions-count').textContent, '· 2 running');
  assert.equal(app.el('#btn-mob-stop-all').disabled, false);
});

test('with nothing running the card says so, and the button stays off', async () => {
  const app = loadApp();
  await app.run('initMobile()');
  app.run(`renderSessions(${TWO_SESSIONS})`);
  app.run('renderSessions([])');
  assert.match(app.el('#mob-sessions').innerHTML, /Nothing is playing through the relay/);
  assert.equal(app.el('#mob-sessions-count').textContent, '· none running');
  assert.equal(app.el('#btn-mob-stop-all').disabled, true);
});

test('a declined confirmation stops nothing, and the message names what would stop', async () => {
  const app = loadApp({ confirmAnswer: false });
  await app.run('initMobile()');
  app.run(`renderSessions(${TWO_SESSIONS})`);
  click(app.el('#btn-mob-stop-all'));
  await settleAll();
  assert.equal(app.calls.filter((call) => call.url === '/api/sessions/stop-all').length, 0);
  assert.equal(app.confirms.length, 1);
  assert.match(app.confirms[0], /Stop 2 running sessions\?/);
  assert.match(app.confirms[0], /The Smurfs/);
  assert.match(app.confirms[0], /Dune: Part Two/);
  assert.equal(app.el('#btn-mob-stop-all').disabled, false, 'still live: nothing happened');
});

test('a confirmed stop posts once and reports the count the server returns', async () => {
  const app = loadApp({ confirmAnswer: true, stopResponse: { ok: true, stopped: 2 } });
  await app.run('initMobile()');
  app.run(`renderSessions(${TWO_SESSIONS})`);
  captureToasts(app);
  click(app.el('#btn-mob-stop-all'));
  await settleAll();
  const posts = app.calls.filter((call) => call.url === '/api/sessions/stop-all');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].method, 'POST');
  assert.equal(toastsOf(app), JSON.stringify([['Stopped 2 sessions', 'ok']]));
  assert.equal(app.el('#mob-sessions-count').textContent, '· none running');
  assert.equal(app.el('#btn-mob-stop-all').disabled, true);
});

test('a failed stop says so, and the list stays on screen so it can be tried again', async () => {
  const app = loadApp({ confirmAnswer: true, stopResponse: { ok: false, error: 'relay is busy' }, stopStatus: 500 });
  await app.run('initMobile()');
  app.run(`renderSessions(${TWO_SESSIONS})`);
  captureToasts(app);
  click(app.el('#btn-mob-stop-all'));
  await settleAll();
  assert.equal(toastsOf(app), JSON.stringify([['Could not stop the sessions: relay is busy', 'err']]));
  assert.match(app.el('#mob-sessions').innerHTML, /The Smurfs/);
  assert.equal(app.el('#btn-mob-stop-all').disabled, false);
});

test('the stop-all card sits on the Mobile tab, above the search pane', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const start = html.indexOf('<section id="p-mobile">');
  const end = html.indexOf('</section>', start);
  assert.ok(start >= 0 && end > start, 'the Mobile section is there');
  const mobile = html.slice(start, end);
  assert.match(mobile, /id="btn-mob-stop-all"/);
  assert.ok(mobile.indexOf('id="btn-mob-stop-all"') < mobile.indexOf('1 · Search'), 'the card comes before the search pane');
});
