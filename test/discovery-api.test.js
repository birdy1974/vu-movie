import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-discovery-api-'));
process.env.CONFIG_FILE = path.join(directory, 'vumovie.json');
process.env.TMDB_API_KEY = 'test-api-key';
process.env.LOG_LEVEL = 'warn';

const nativeFetch = globalThis.fetch;
const store = await import('../src/streams/store.js');
const { createApp } = await import('../src/http/server.js');

test('playlist history and discovery endpoints are available through the HTTP API', async (t) => {
  const externalCalls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    externalCalls.push(url);
    if (url.pathname === '/3/trending/all/week') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [{ id: 700, media_type: 'movie', title: 'Trending API Title', release_date: '2026-05-01', vote_average: 8.3, vote_count: 800 }] }),
      };
    }
    throw new Error(`unexpected TMDB request ${url.pathname}`);
  };
  const app = createApp();
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(async () => {
    globalThis.fetch = nativeFetch;
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await store.createStream({
    id: 'api-history-stream',
    title: 'Historical Addition',
    year: 2023,
    kind: 'movie',
    candidate: { url: 'https://cdn.example/history.m3u8', kind: 'hls' },
  });
  const playlistResponse = await nativeFetch(`${base}/api/playlist`);
  assert.equal(playlistResponse.status, 200);
  const historyResponse = await nativeFetch(`${base}/api/playlist/history`);
  const history = await historyResponse.json();
  assert.equal(historyResponse.status, 200);
  assert.equal(history.count, 1);
  assert.equal(history.history[0].title, 'Historical Addition');

  const discoveryResponse = await nativeFetch(`${base}/api/discovery/trending?type=all&window=week`);
  const data = await discoveryResponse.json();
  assert.equal(discoveryResponse.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.items[0].title, 'Trending API Title');
  assert.equal(externalCalls.length, 1);
});
