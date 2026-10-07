import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-discovery-'));
process.env.CONFIG_FILE = path.join(directory, 'vumovie.json');
process.env.TMDB_API_KEY = 'test-tmdb-key';
process.env.LOG_LEVEL = 'warn';

const discovery = await import('../src/metadata/discovery.js');

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

test('trending and Top 10 return normalized lists and use the shared cache', async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === '/3/trending/all/week') {
      return jsonResponse({ results: [
        { id: 71, media_type: 'movie', title: 'Trending Film', release_date: '2026-01-02', vote_average: 8.1, vote_count: 900 },
        { id: 72, media_type: 'tv', name: 'Trending Series', first_air_date: '2025-04-01', vote_average: 8.4, vote_count: 500 },
      ] });
    }
    if (url.pathname === '/3/movie/top_rated') {
      return jsonResponse({ results: [
        { id: 81, title: 'Top Film', release_date: '2020-01-01', vote_average: 9.1, vote_count: 800 },
      ] });
    }
    if (url.pathname === '/3/tv/top_rated') {
      return jsonResponse({ results: [
        { id: 82, name: 'Top Series', first_air_date: '2020-01-01', vote_average: 9.4, vote_count: 700 },
      ] });
    }
    throw new Error(`unexpected TMDB request: ${url.pathname}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const trending = await discovery.trendingTitles({ type: 'all', window: 'week', limit: 10 });
  assert.deepEqual(trending.items.map((item) => [item.title, item.type]), [
    ['Trending Film', 'movie'], ['Trending Series', 'series'],
  ]);
  await discovery.trendingTitles({ type: 'all', window: 'week', limit: 10 });
  assert.equal(calls.filter((url) => url.pathname === '/3/trending/all/week').length, 1, 'trending uses the TTL cache');

  const top = await discovery.topTenTitles({ type: 'all', limit: 10 });
  assert.deepEqual(top.items.map((item) => [item.title, item.type]), [
    ['Top Series', 'series'], ['Top Film', 'movie'],
  ], 'the combined Top 10 is sorted by rating across movies and series');
});

test('For You uses all playlist-addition events, weights repeats and excludes already-added titles', async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === '/3/search/movie' && url.searchParams.get('query') === 'Arrival') {
      return jsonResponse({ results: [{ id: 101, title: 'Arrival', release_date: '2016-11-11', vote_average: 7.9, vote_count: 2000 }] });
    }
    if (url.pathname === '/3/search/tv' && url.searchParams.get('query') === 'Severance') {
      return jsonResponse({ results: [{ id: 202, name: 'Severance', first_air_date: '2022-02-18', vote_average: 8.7, vote_count: 1800 }] });
    }
    if (url.pathname === '/3/movie/101/recommendations') {
      return jsonResponse({ results: [
        { id: 101, title: 'Arrival', release_date: '2016-11-11', vote_average: 7.9, vote_count: 2000 },
        { id: 303, title: 'Shared Film', release_date: '2024-01-01', vote_average: 8.2, vote_count: 700 },
      ] });
    }
    if (url.pathname === '/3/tv/202/recommendations') {
      return jsonResponse({ results: [
        { id: 404, name: 'Series Suggestion', first_air_date: '2025-01-01', vote_average: 8.4, vote_count: 500 },
      ] });
    }
    throw new Error(`unexpected TMDB request: ${url.pathname} ${url.searchParams.get('query') || ''}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  // Arrival was added twice, with an old event timestamp; Severance is another
  // historical addition. The entire history, not only the current playlist,
  // is passed into the recommender.
  const history = [
    { eventId: 'old-arrival-add', streamId: 'deleted-1', title: 'Arrival', year: 2016, kind: 'movie', addedAt: '2020-01-01T00:00:00.000Z' },
    { eventId: 'arrival-readd', streamId: 'deleted-2', title: 'Arrival', year: 2016, kind: 'movie', addedAt: '2024-01-01T00:00:00.000Z' },
    { eventId: 'severance-add', streamId: 'removed-3', title: 'Severance', year: 2022, kind: 'series', addedAt: '2025-01-01T00:00:00.000Z' },
  ];
  const result = await discovery.playlistRecommendations(history, { type: 'all', limit: 20 });
  assert.equal(result.historyCount, 3);
  assert.equal(result.uniqueHistoryTitles, 2);
  assert.equal(result.resolvedHistoryTitles, 2);
  assert.equal(result.seedCount, 2);
  assert.equal(result.partialFailures, 0);
  assert.deepEqual(result.items.map((item) => item.title), ['Shared Film', 'Series Suggestion']);
  assert.equal(result.items[0].historyMatches, 2, 'repeated additions increase recommendation weight');
  assert.ok(calls.some((url) => url.pathname === '/3/search/movie'), 'older added titles are resolved as seeds');
  assert.ok(calls.some((url) => url.pathname === '/3/search/tv'), 'all media kinds in the history are considered');
});
