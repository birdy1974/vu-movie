import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-recovery-'));
process.env.CONFIG_FILE = path.join(directory, 'vumovie.json');
process.env.LOG_LEVEL = 'error';

const config = await import('../src/core/config.js');
config.loadConfig();
// These tests cover renewing a positive token lifetime; 0 (the default) means
// the token never expires, so the lifetime is pinned explicitly here.
config.getConfig().app.tokenTtlMinutes = 4320;
const store = await import('../src/streams/store.js');
const recovery = await import('../src/streams/recovery.js');

const probe = {
  container: 'mpegts',
  durationSec: 90,
  video: { codec: 'h264', width: 1920, height: 1080, fps: 24 },
  audio: [{ codec: 'aac', channels: 2 }],
  subtitles: [],
};

async function makeStream(id, { sourceId = 'cinejoy', title = 'The Matrix', year = 1999 } = {}) {
  return store.createStream({
    id,
    token: `stable-token-${id}`,
    title,
    year,
    kind: 'movie',
    sourceId,
    candidate: {
      url: `https://dead.example/${id}.m3u8`,
      sourceId,
      kind: 'hls',
      headers: { Referer: 'https://cinejoy.pk/' },
    },
  });
}

function proberForFreshUrl(freshUrl) {
  return async (candidates) => candidates.map((candidate) => candidate.url === freshUrl
    ? { ...candidate, ok: true, probe, probeMs: 25 }
    : { ...candidate, ok: false, error: 'probe failed (expired token)' });
}

test('a dead upstream is refreshed on the same provider without changing the public stream URL', async () => {
  const stream = await makeStream('same-provider');
  let searched = 0;
  let resolved = 0;
  const freshUrl = 'https://cdn.example/matrix-fresh.m3u8';
  const outcome = await recovery.ensureStreamReady(stream, {
    forceCheck: true,
    reason: 'test',
    prober: proberForFreshUrl(freshUrl),
    searchSource: async (source, query) => {
      searched += 1;
      assert.equal(source.id, 'cinejoy');
      assert.equal(query, 'The Matrix');
      return [{ title: 'The Matrix (1999)', year: 1999, kind: 'movie', sourceId: 'cinejoy', url: 'https://cinejoy.pk/watch/matrix' }];
    },
    searchAll: async () => { throw new Error('fallback provider search should not run'); },
    resolveTarget: async (request) => {
      resolved += 1;
      assert.equal(request.url, 'https://cinejoy.pk/watch/matrix');
      return { candidates: [{ url: freshUrl, sourceId: 'cinejoy', kind: 'hls', headers: { Referer: request.url } }] };
    },
  });

  assert.equal(searched, 1);
  assert.equal(resolved, 1);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.repaired, true);
  assert.equal(outcome.result.state, 'working');
  assert.equal(outcome.result.sourceChanged, false);
  assert.equal(outcome.stream.id, stream.id);
  assert.equal(outcome.stream.token, stream.token, 'the generated stream token stays stable');
  assert.deepEqual(store.urlsFor(outcome.stream, 'http://nas.example'), store.urlsFor(stream, 'http://nas.example'), 'every generated output URL stays stable');
  assert.equal(outcome.stream.upstream.url, freshUrl);
  assert.equal(outcome.stream.source_id, 'cinejoy');
  assert.ok(Date.parse(outcome.stream.expires_at) > Date.now(), 'the stream URL lifetime is renewed');

  const cached = await recovery.ensureStreamReady(stream.id, {
    prober: async () => { throw new Error('a recent successful check should be cached'); },
  });
  assert.equal(cached.ok, true);
  assert.equal(cached.result.cached, true);
});

test('a dead same-provider result falls back to another enabled site and keeps the stream token', async () => {
  const stream = await makeStream('other-provider');
  const freshUrl = 'https://cdn.example/matrix-other-site.m3u8';
  let sameProviderSearches = 0;
  let otherProviderSearches = 0;
  const outcome = await recovery.ensureStreamReady(stream, {
    forceCheck: true,
    reason: 'test',
    prober: proberForFreshUrl(freshUrl),
    searchSource: async () => { sameProviderSearches += 1; return []; },
    searchAll: async (query, options) => {
      otherProviderSearches += 1;
      assert.equal(query, 'The Matrix');
      assert.ok(options.sources.includes('vidbox'));
      return { results: [{ title: 'The Matrix', year: 1999, kind: 'movie', sourceId: 'vidbox', url: 'https://vidbox.vc/watch/matrix' }] };
    },
    resolveTarget: async (request) => ({
      candidates: [{ url: freshUrl, sourceId: request.sourceId, kind: 'hls', headers: { Referer: request.url } }],
    }),
  });

  assert.equal(sameProviderSearches, 1);
  assert.equal(otherProviderSearches, 1);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.repaired, true);
  assert.equal(outcome.result.sourceChanged, true);
  assert.equal(outcome.result.previousSourceId, 'cinejoy');
  assert.equal(outcome.stream.token, stream.token);
  assert.equal(outcome.stream.source_id, 'vidbox');
  assert.equal(outcome.stream.upstream.url, freshUrl);
});

test('recovery rejects a same-title result whose known release year does not match', async () => {
  const stream = await makeStream('year-mismatch');
  let resolves = 0;
  const outcome = await recovery.ensureStreamReady(stream, {
    forceCheck: true,
    prober: async (candidates) => candidates.map((candidate) => ({ ...candidate, ok: false, error: 'dead' })),
    searchSource: async () => [{ title: 'The Matrix', year: 2003, kind: 'movie', sourceId: 'cinejoy', url: 'https://cinejoy.pk/watch/matrix-2003' }],
    searchAll: async () => ({ results: [{ title: 'The Matrix', year: 2003, kind: 'movie', sourceId: 'vidbox', url: 'https://vidbox.vc/watch/matrix-2003' }] }),
    resolveTarget: async () => { resolves += 1; throw new Error('a mismatched year must not be resolved'); },
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.repaired, false);
  assert.equal(resolves, 0);
  assert.equal(outcome.stream.upstream.url, stream.upstream.url);
  assert.match(outcome.error, /no playable match/);
});

test('failed checks do not resolve when auto-repair is disabled', async () => {
  const stream = await makeStream('repair-disabled');
  let searches = 0;
  const outcome = await recovery.ensureStreamReady(stream, {
    forceCheck: true,
    autoRepair: false,
    prober: async (candidates) => candidates.map((candidate) => ({ ...candidate, ok: false, error: 'dead' })),
    searchSource: async () => { searches += 1; return []; },
    searchAll: async () => { searches += 1; return { results: [] }; },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.repaired, false);
  assert.equal(outcome.result.state, 'dead');
  assert.equal(searches, 0);
});
