import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-plots-'));
process.env.CONFIG_FILE = path.join(directory, 'vumovie.json');
process.env.LOG_LEVEL = 'error';

const config = await import('../src/core/config.js');
config.loadConfig();
config.saveConfig({ subtitles: { autoSearch: false }, enigma2: { autoPush: false }, scraper: { probeCandidates: false }, playlist: { prewarmEnabled: false, autoRepairEnabled: false } });
const store = await import('../src/streams/store.js');
const plots = await import('../src/metadata/plots.js');
const { enrichEpgPlots } = await import('../src/enigma2/epg-metadata.js');
const { createApp } = await import('../src/http/server.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function memoryCache() {
  const saved = new Map();
  return { saved, cacheGet: async (key) => saved.get(key) ?? null, cacheSet: async (key, value) => { saved.set(key, value); } };
}
const candidate = (n) => ({ url: `https://cdn.example/${n}.m3u8`, sourceId: 'cinejoy', kind: 'hls', quality: '1080p' });

test('the plot shown in the meta details view is reused as the stored plot, without a second lookup', async () => {
  const cache = memoryCache();
  // The details endpoint is called with the group's title/year; the add path
  // only knows the stream's title/year (no ids) — both must hit the same key.
  await plots.rememberEnrichedPlot({ title: 'The Movie', year: 2024, kind: 'movie' }, {
    tmdb: { overview: 'The plot the user saw', tmdbId: 42, imdbId: 'tt0000042' }, tmdbId: 42, imdbId: 'tt0000042',
  }, { cache });
  let lookups = 0;
  const lookup = async () => { lookups += 1; return { plot: 'a different first hit' }; };
  const byTitle = await plots.resolvePlot({ title: 'the movie', year: 2024, kind: 'movie' }, { cache, lookup });
  assert.equal(byTitle.plot, 'The plot the user saw');
  assert.equal(byTitle.tmdbId, 42);
  // A stream that only carries the provider id (scraper metadata) finds it too.
  const byId = await plots.resolvePlot({ title: 'Localised Name', kind: 'movie', payload: { meta: { tmdbId: 42 } } }, { cache, lookup });
  assert.equal(byId.plot, 'The plot the user saw');
  const byImdb = await plots.resolvePlot({ title: 'Other Name', imdbId: 'tt0000042' }, { cache, lookup });
  assert.equal(byImdb.plot, 'The plot the user saw');
  assert.equal(lookups, 0);
  // A different year is a different title.
  assert.equal((await plots.resolvePlot({ title: 'The Movie', year: 1999, kind: 'movie' }, { cache, lookup })).plot, 'a different first hit');
  assert.equal(lookups, 1);
});

test('a confirmed miss is cached for the day, a provider failure or abort is not', async () => {
  const cache = memoryCache();
  let calls = 0;
  const miss = async () => { calls += 1; return null; };
  assert.equal(await plots.resolvePlot({ title: 'Unknown', year: 2020 }, { cache, lookup: miss }), null);
  assert.equal(await plots.resolvePlot({ title: 'Unknown', year: 2020 }, { cache, lookup: miss }), null);
  assert.equal(calls, 1);
  const failing = async () => { calls += 1; throw new Error('HTTP 500'); };
  await assert.rejects(plots.resolvePlot({ title: 'Flaky', year: 2020 }, { cache, lookup: failing }));
  await assert.rejects(plots.resolvePlot({ title: 'Flaky', year: 2020 }, { cache, lookup: failing }));
  assert.equal(calls, 3);
  assert.equal([...cache.saved.values()].filter((value) => value.miss).length, 1);
});

test('ensureStreamPlot stores the plot and ids on the record, updates the held object, and skips previews', async () => {
  const cache = memoryCache();
  const stream = await store.createStream({ title: 'Stored Movie', year: 2021, description: 'scraper text', candidate: candidate('stored') });
  const lookup = async (query) => ({ plot: `Plot for ${query.title}`, tmdbId: 7, imdbId: 'tt7', source: 'tmdb' });
  assert.equal(plots.storedPlot(stream), 'scraper text');
  const result = await plots.ensureStreamPlot(stream, { cache, lookup });
  assert.equal(result.state, 'stored');
  const saved = await store.getStream(stream.id);
  assert.equal(saved.payload.meta.plot, 'Plot for Stored Movie');
  assert.equal(saved.payload.meta.tmdbId, 7);
  assert.equal(saved.payload.meta.imdbId, 'tt7');
  assert.equal(saved.description, 'scraper text', 'the scraper description is kept');
  assert.equal(plots.storedPlot(saved), 'Plot for Stored Movie', 'the metadata plot wins over the scraper text, like the details view');
  assert.equal(stream.payload.meta.plot, 'Plot for Stored Movie', 'the caller\'s object is updated in place');
  // Re-saving the held object (as the subtitle chore does) keeps the plot.
  await store.createStream({ ...stream, candidate: candidate('stored'), title: stream.title, year: stream.year, kind: stream.kind });
  assert.equal((await store.getStream(stream.id)).payload.meta.plot, 'Plot for Stored Movie');
  assert.equal((await plots.ensureStreamPlot(stream, { cache, lookup: async () => { throw new Error('not called'); } })).state, 'exists');

  const preview = await store.createStream({ title: 'Preview', candidate: candidate('preview'), ephemeral: true });
  assert.equal((await plots.ensureStreamPlot(preview, { cache, lookup })).state, 'skipped');
  assert.equal((await store.getStream(preview.id)).payload.meta.plot, undefined);

  const missing = await store.createStream({ title: 'Nowhere', candidate: candidate('nowhere') });
  assert.equal((await plots.ensureStreamPlot(missing, { cache, lookup: async () => null })).state, 'missing');
  assert.equal((await plots.ensureStreamPlot(missing, { cache, lookup: async () => { throw new Error('boom'); } })).state, 'missing', 'the cached miss is not retried');
});

test('the backfill fills every stream that lacks a plot, one lookup at a time and without a push deadline', async () => {
  const cache = memoryCache();
  const streams = [];
  for (let n = 0; n < 30; n += 1) streams.push(await store.createStream({ title: `Backfill ${n}`, year: 2000 + n, candidate: candidate(`bf${n}`) }));
  let active = 0; let peak = 0;
  const lookup = async (query) => {
    active += 1; peak = Math.max(peak, active);
    await sleep(5);
    active -= 1;
    return { plot: `Plot ${query.title}` };
  };
  const first = plots.backfillStoredPlots({ reason: 'test', streams, cache, lookup });
  const second = plots.backfillStoredPlots({ reason: 'test', streams, cache, lookup });
  assert.equal(first, second, 'a concurrent call joins the run in progress');
  const summary = await first;
  assert.equal(summary.stored, 30);
  assert.equal(summary.missing, 0);
  assert.equal(peak, 1);
  for (const stream of streams) assert.equal((await store.getStream(stream.id)).payload.meta.plot, `Plot ${stream.title}`);
  assert.equal(plots.backfillStatus().running, false);
  assert.equal(plots.backfillStatus().lastSummary.stored, 30);
  // A second run has nothing left to do.
  assert.equal((await plots.backfillStoredPlots({ reason: 'test', streams, cache, lookup })).checked, 0);
});

test('a push-time lookup stores its find on the stream so no later push repeats it', async () => {
  const cache = memoryCache();
  const stream = await store.createStream({ title: 'Late Movie', year: 2019, candidate: candidate('late') });
  let lookups = 0;
  const lookup = async () => { lookups += 1; return 'Found at push time'; };
  const entries = [{ title: stream.title, year: stream.year, kind: 'movie', plot: plots.storedPlot(stream), streamId: stream.id, url: 'http://nas/a.ts' }];
  const [enriched] = await enrichEpgPlots(entries, { cache, lookup });
  assert.equal(enriched.plot, 'Found at push time');
  assert.equal((await store.getStream(stream.id)).payload.meta.plot, 'Found at push time');
  const again = await enrichEpgPlots([{ ...entries[0], plot: plots.storedPlot(await store.getStream(stream.id)) }], { cache, lookup });
  assert.equal(again[0].plot, 'Found at push time');
  assert.equal(lookups, 1);
});

test('adding a title through the API stores the plot the details view showed, with no provider call', async (t) => {
  const metadata = config.getConfig().metadata;
  const oldKey = metadata.tmdbApiKey;
  const originalFetch = globalThis.fetch;
  metadata.tmdbApiKey = 'fixture-key';
  const providerCalls = [];
  globalThis.fetch = async (url, options) => {
    const text = String(url);
    if (text.includes('api.themoviedb.org')) {
      providerCalls.push(text);
      if (text.includes('/search/movie')) {
        return new Response(JSON.stringify({ results: [{ id: 99, title: 'Details Movie', release_date: '2022-03-04', overview: 'Overview from the details view' }] }), { status: 200 });
      }
      if (text.includes('/movie/99')) {
        return new Response(JSON.stringify({ id: 99, title: 'Details Movie', release_date: '2022-03-04', overview: 'Overview from the details view', external_ids: { imdb_id: 'tt99' }, credits: { cast: [], crew: [] }, videos: { results: [] } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }
    return originalFetch(url, options);
  };
  const server = await new Promise((resolve) => { const instance = createApp().listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(async () => {
    metadata.tmdbApiKey = oldKey;
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const details = await (await originalFetch(`${base}/api/metadata/tmdb?title=Details%20Movie&year=2022&type=movie`)).json();
  assert.equal(details.tmdb.overview, 'Overview from the details view');
  await sleep(20);
  const callsAfterDetails = providerCalls.length;
  const created = await (await originalFetch(`${base}/api/streams`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Details Movie', year: 2022, kind: 'movie', description: '', sourceId: 'cinejoy', candidate: candidate('details') }),
  })).json();
  assert.equal(created.ok, true);
  let saved;
  for (let i = 0; i < 100; i += 1) {
    saved = await store.getStream(created.stream.id);
    if (saved?.payload?.meta?.plot) break;
    await sleep(20);
  }
  assert.equal(saved.payload.meta.plot, 'Overview from the details view');
  assert.equal(saved.payload.meta.imdbId, 'tt99');
  assert.equal(providerCalls.length, callsAfterDetails, 'the add path reused the details lookup');

  // A title the user never opened is looked up at add time instead.
  const other = await (await originalFetch(`${base}/api/streams`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Details Movie', year: 2023, kind: 'movie', sourceId: 'cinejoy', candidate: candidate('other') }),
  })).json();
  for (let i = 0; i < 100; i += 1) {
    saved = await store.getStream(other.stream.id);
    if (saved?.payload?.meta?.plot) break;
    await sleep(20);
  }
  assert.equal(saved.payload.meta.plot, 'Overview from the details view');
  assert.ok(providerCalls.length > callsAfterDetails);
});
