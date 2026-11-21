import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-relevance-'));
process.env.CONFIG_FILE = path.join(tmp, 'config.json');
process.env.SOURCES_DIR = path.join(tmp, 'sources');
process.env.LOG_LEVEL = 'error';
fs.mkdirSync(process.env.SOURCES_DIR);

// A fake "API" provider: answers at once, and a slow twin that pads its title
// matches with unrelated recommendations.
const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const slow = url.pathname.startsWith('/slow');
  const q = String(url.searchParams.get('q') || '').toLowerCase();
  const results = q.includes('runner') ? [
    { id: 1, t: 'Runner', y: 2026, mediaType: 'movie', overview: 'A courier runs.' },
    { id: 2, t: 'Blade Runner', y: 1982, mediaType: 'movie', overview: 'Replicants.' },
    ...(slow ? [{ id: 3, t: 'Completely Different Film', y: 2020, mediaType: 'movie', overview: 'Recommended for you.' }] : []),
  ] : [];
  setTimeout(() => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ results }));
  }, slow ? 400 : 0);
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
const recipe = (id, pathname) => ({
  id, name: id, home: upstreamBase, enabled: true, kind: 'api',
  search: { kind: 'api', url: `${upstreamBase}${pathname}?q={query}`, items: 'results', resultUrl: '/movie/{id}', map: { id: 'id', title: 't', year: 'y', kind: 'mediaType', description: 'overview' } },
  resolve: { kind: 'browser' },
});
fs.writeFileSync(path.join(process.env.SOURCES_DIR, 'fake.json'), JSON.stringify([recipe('fast', '/fast'), recipe('slow', '/slow')]));

const config = await import('../src/core/config.js');
config.loadConfig();
const relevance = await import('../src/scrapers/search-relevance.js');
const { normalizeSearchRows } = await import('../src/scrapers/browser.js');
const registry = await import('../src/scrapers/registry.js');
const { default: apiRouter } = await import('../src/http/api.js');

test.after(async () => {
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('query coverage: typos, short words, stop words and multi-word titles', () => {
  const { coversQuery, queryTerms } = relevance;
  assert.deepEqual(queryTerms('The Beast'), ['beast']);
  assert.deepEqual(queryTerms('Up'), ['up']);
  assert.ok(coversQuery('monolith', 'Monolith (2024)'));
  assert.ok(coversQuery('monolit', 'Monolith'), 'one typo still matches');
  assert.ok(coversQuery('smurfs', 'The Smurf'), 'plural vs singular');
  assert.ok(coversQuery('Amélie', 'Le Fabuleux Destin d\'Amelie Poulain'));
  assert.ok(coversQuery('Up', 'Up'));
  assert.ok(!coversQuery('Up', 'Upgrade'), 'short words must match a whole word');
  assert.ok(coversQuery('dune part two', 'Dune: Part Two'));
  assert.ok(coversQuery('dune part two', 'Dune: Part One'), 'two of three words is enough');
  assert.ok(!coversQuery('dune part two', 'Dune'), 'one of three words is not');
  assert.ok(coversQuery('monolith 2024', 'Monolith'), 'a year in the query does not hide the title');
  assert.ok(!coversQuery('dune part two', 'Part of the Family'));
  assert.ok(!coversQuery('monolith', 'The Shawshank Redemption'));
  assert.ok(!coversQuery('monolith', 'Comedy'));
});

test('navigation and genre links are recognised', () => {
  const { isNavigationUrl, isGenreTitle } = relevance;
  assert.ok(isNavigationUrl('https://cinezo.st/movie/genre/comedy'));
  assert.ok(isNavigationUrl('https://cinezo.st/genre/35-comedy'));
  assert.ok(isNavigationUrl('https://site.test/movies?genre=35'));
  assert.ok(isNavigationUrl('https://site.test/tv/trending'));
  assert.ok(!isNavigationUrl('https://cinezo.st/movie/1367648'));
  assert.ok(!isNavigationUrl('https://site.test/movie/the-new-world-2005'));
  assert.ok(isGenreTitle('Animation'));
  assert.ok(isGenreTitle('Sci-Fi'));
  assert.ok(!isGenreTitle('Crime Story'));
});

test('a scraped search page keeps the hits and drops the trending rail and the genre menu', () => {
  const card = (href, title, extra = {}) => ({ href, title, titleRank: 4, text: title, cardText: `${title} 2024 HD`, hasImage: true, cardLike: true, ...extra });
  const results = normalizeSearchRows([
    card('/movie/1367648', 'Monolith'),
    card('/movie/99', 'Monolith', { cardText: 'Monolith 2022' }),
    // trending rail: same route shape, nothing to do with the query
    card('/movie/550', 'Fight Club'),
    card('/tv/1399', 'Game of Thrones'),
    card('/movie/27205', 'Inception'),
    // genre navigation
    { href: '/movie/genre/comedy', title: 'Comedy', titleRank: 4, text: 'Comedy' },
    { href: '/tv/animation', title: 'Animation', titleRank: 4, text: 'Animation' },
    { href: '/genre/80', title: 'Crime', titleRank: 4, text: 'Crime' },
    // a card whose title the collector could not read, but whose slug says it all
    { href: '/movie/1234-monolith-2024', title: 'HD', titleRank: 0, text: 'HD', hasImage: true },
  ], {
    pageUrl: 'https://cinezo.st/search?q=monolith',
    baseUrl: 'https://cinezo.st/',
    query: 'monolith',
    resultPattern: '/(movie|tv|watch)/',
    siteId: 'cinezo',
    siteName: 'Cinezo',
  });
  assert.deepEqual(results.map((r) => r.url), [
    'https://cinezo.st/movie/1367648',
    'https://cinezo.st/movie/99',
    'https://cinezo.st/movie/1234-monolith-2024',
  ]);
  // A page with no hit for the query returns nothing — not the trending rail.
  const none = normalizeSearchRows([card('/movie/550', 'Fight Club'), card('/movie/27205', 'Inception')], {
    pageUrl: 'https://cinezo.st/search?q=monolith', baseUrl: 'https://cinezo.st/', query: 'monolith', resultPattern: '/(movie|tv|watch)/', siteId: 'cinezo', siteName: 'Cinezo',
  });
  assert.equal(none.length, 0);
});

test('a structured provider loses its unrelated padding only when it matched something', () => {
  const { trimUnrelatedResults } = relevance;
  const rows = [{ title: 'Monolith' }, { title: 'Monolith' }, { title: 'Recommended Thing' }];
  assert.deepEqual(trimUnrelatedResults(rows, 'monolith').map((r) => r.title), ['Monolith', 'Monolith']);
  // Alternative-title or actor searches: no title matched, keep the provider's answer.
  const alt = [{ title: 'The Smurfs' }, { title: 'The Smurfs 2' }];
  assert.equal(trimUnrelatedResults(alt, 'de smurfen').length, 2);
});

test('searchAll reports each provider as it answers and trims API padding', async () => {
  const events = [];
  const outcome = await registry.searchAll('runner', {
    sources: ['fast', 'slow'], includeMoviebox: false, detailed: true,
    onSource: (event) => events.push({ ...event, at: Date.now() }),
  });
  assert.deepEqual(events.map((e) => e.sourceId), ['fast', 'slow'], 'the fast provider is reported before the slow one');
  assert.deepEqual(events.map((e) => e.pending), [1, 0]);
  assert.equal(events[0].results.length, 2);
  assert.deepEqual(events[1].results.map((r) => r.title), ['Runner', 'Blade Runner'], 'the slow provider\'s recommendation is dropped');
  assert.equal(outcome.results.length, 4);
  assert.ok(outcome.results.every((r) => /runner/i.test(r.title)));
});

test('the streaming search endpoint sends a source event per provider and a final merged answer', async (t) => {
  const app = express();
  app.use('/api', apiRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/find/search/stream?q=runner&sources=fast,slow&moviebox=false`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = [];
  for (const chunk of (await response.text()).split('\n\n')) {
    const name = /^event: (.+)$/m.exec(chunk)?.[1];
    const data = /^data: (.+)$/m.exec(chunk)?.[1];
    if (name && data) events.push({ name, data: JSON.parse(data) });
  }
  assert.deepEqual(events.map((e) => e.name), ['start', 'source', 'source', 'done']);
  assert.equal(events[1].data.sourceId, 'fast');
  assert.equal(events[2].data.sourceId, 'slow');
  assert.equal(events[3].data.ok, true);
  assert.equal(events[3].data.results.length, 4);
  // The plain endpoint still answers the same list.
  const plain = await (await fetch(`http://127.0.0.1:${server.address().port}/api/find/search?q=runner&sources=fast,slow&moviebox=false`)).json();
  assert.deepEqual(plain.results.map((r) => `${r.sourceId}:${r.title}`), events[3].data.results.map((r) => `${r.sourceId}:${r.title}`));
});
