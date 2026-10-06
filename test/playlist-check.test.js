/**
 * “Check streams” — the Playlist tab's answer to “is any of this still playing?”
 *
 * The checker is deliberately pure: the caller passes plain targets and may
 * inject the prober, so every state can be tested without a network, ffprobe or
 * a real upstream. The endpoint test then proves the wiring (playlist →
 * targets → result JSON) using only states that need no network: a stream with
 * no upstream URL and one whose token TTL already passed.
 *
 * The module reads CONFIG_FILE at import time, so the fixture is set up first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-check-test-'));
process.env.CONFIG_FILE = path.join(dir, 'vumovie.json');
process.env.LOG_LEVEL = 'error';

const { checkStreams, summariseCheck, trimProbe, CHECK_STATES, BROKEN_STATES } = await import('../src/playlist/check.js');

/* ---------------- fixtures ---------------- */

const TARGETS = [
  { streamId: 's1', title: 'Dune: Part Two', sourceId: 'cinejoy', url: 'https://cdn.example/dune/master.m3u8', headers: { Referer: 'https://cinejoy.pk/' }, kind: 'movie', expiresAt: '2026-12-01T00:00:00.000Z' },
  { streamId: 's2', title: 'Alien: Romulus', sourceId: 'cinevo', url: 'https://cdn.example/alien.mkv', kind: 'movie', enabled: false },
  { streamId: 's3', title: 'Old Smurfs', sourceId: 'redflix', url: 'https://cdn.example/smurfs.ts', kind: 'movie', expiresAt: '2026-01-01T00:00:00.000Z' },
  { streamId: 's4', title: 'No upstream', sourceId: 'flixhub', url: '', kind: 'series' },
];

const probe = {
  container: 'matroska',
  durationSec: 5520,
  video: { codec: 'h264', width: 1920, height: 1080, fps: 24 },
  audio: [{ codec: 'aac', channels: 2 }, { codec: 'ac3', channels: 6 }],
  subtitles: [{ language: 'eng' }],
};

/** A prober that answers by URL, the way registry.probeCandidates does. */
const fakeProber = (answers) => async (candidates, { concurrency } = {}) => {
  assert.ok(candidates.length > 0, 'a prober is never called with an empty list');
  assert.equal(typeof concurrency, 'number', 'the caller passes a concurrency');
  return candidates.map((candidate) => ({ ...candidate, ...(answers[candidate.url] || {}) }));
};

/* ---------------- the pure checker ---------------- */

test('every state is reported per item, in playlist order', async () => {
  const now = () => new Date('2026-10-06T20:00:00.000Z').getTime();
  const prober = fakeProber({
    'https://cdn.example/dune/master.m3u8': {
      ok: true, probe, probeMs: 820,
      variants: [{ url: 'https://cdn.example/dune/1080.m3u8', height: 1080 }, { url: 'https://cdn.example/dune/720.m3u8', height: 720 }],
    },
    'https://cdn.example/alien.mkv': { ok: false, probe: null, probeMs: 4300, error: 'probe failed (dead mirror, expired token, geo-block or unsupported container)' },
  });
  const { results, summary } = await checkStreams(TARGETS, { prober, now, concurrency: 2 });

  assert.deepEqual(results.map((result) => result.streamId), ['s1', 's2', 's3', 's4'], 'playlist order is preserved');
  assert.deepEqual(results.map((result) => result.state), ['working', 'dead', 'expired', 'skipped']);

  const working = results[0];
  assert.equal(working.ok, true);
  assert.equal(working.error, null);
  assert.equal(working.sourceId, 'cinejoy');
  assert.equal(working.probeMs, 820);
  assert.equal(working.variants, 2, 'an expanded HLS master reports its rendition count');
  assert.deepEqual(working.probe, {
    container: 'matroska',
    durationSec: 5520,
    video: { codec: 'h264', width: 1920, height: 1080, fps: 24 },
    audio: [{ codec: 'aac', channels: 2 }, { codec: 'ac3', channels: 6 }],
    subtitleTracks: 1,
  }, 'the full ffprobe payload is trimmed to what the UI shows');

  const dead = results[1];
  assert.equal(dead.ok, false);
  assert.equal(dead.enabled, false, 'the item keeps its enabled flag so a disabled item is not mistaken for a broken one');
  assert.match(dead.error, /probe failed \(dead mirror/);

  const expired = results[2];
  assert.equal(expired.ok, false);
  assert.match(expired.error, /upstream token expired at 2026-01-01 00:00/);
  assert.match(expired.error, /re-resolve/);

  const skipped = results[3];
  assert.match(skipped.error, /no upstream URL/);

  assert.equal(summary.checked, 4);
  assert.equal(summary.working, 1);
  assert.equal(summary.dead, 1);
  assert.equal(summary.expired, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.unverified, 0);
  assert.equal(summary.broken, 2, 'dead + expired are the “needs a fresh resolve” states');
  assert.equal(summary.probing, true);
  assert.equal(typeof summary.ms, 'number');
  assert.equal(summary.checkedAt, '2026-10-06T20:00:00.000Z');
  for (const state of CHECK_STATES) assert.ok(state in summary, `${state} is counted in the summary`);
  assert.deepEqual(BROKEN_STATES, ['dead', 'expired']);
});

test('items that need no network never reach the prober', async () => {
  let probed = null;
  const prober = async (candidates) => { probed = candidates; return []; };
  const { results } = await checkStreams(TARGETS.slice(2), { prober, now: () => Date.parse('2026-10-06T20:00:00Z') });
  assert.equal(probed, null, 'an expired item and one without a URL are decided without probing');
  assert.equal(results.length, 2, 'both still get a result each');
  assert.deepEqual(results.map((result) => result.state), ['expired', 'skipped']);
});

test('switched-off probing is “unverified”, never “dead”', async () => {
  // Registry.probeCandidates answers `unverified: true` when probing is off.
  const prober = async (candidates) => candidates.map((candidate) => ({ ...candidate, ok: true, unverified: true, probe: null }));
  const { results, summary } = await checkStreams([TARGETS[0]], { prober });
  assert.equal(results[0].state, 'unverified');
  assert.equal(results[0].ok, false, 'unverified is not a pass');
  assert.equal(results[0].error, null, 'and it is not a failure either');
  assert.equal(summary.unverified, 1);
  assert.equal(summary.broken, 0);
});

test('an item the prober never answers for is unverified, not missing', async () => {
  const prober = async (candidates) => candidates.slice(0, 1).map((candidate) => ({ ...candidate, ok: true, probe }));
  const { results, summary } = await checkStreams(TARGETS.slice(0, 2), { prober });
  assert.equal(results.length, 2, 'every target has a result — no silent holes');
  assert.equal(results[0].state, 'working');
  assert.equal(results[1].state, 'unverified');
  assert.match(results[1].error, /did not answer/);
  assert.equal(summary.checked, 2);
});

test('an empty playlist checks nothing and stays quiet', async () => {
  const { results, summary } = await checkStreams([], { prober: async () => { throw new Error('must not be called'); } });
  assert.deepEqual(results, []);
  assert.equal(summary.checked, 0);
  assert.equal(summary.broken, 0);
  assert.equal(summary.probing, false, 'nothing needed a probe');
});

test('one probe keeps its own call; the headers travel with the candidate', async () => {
  let seen = null;
  const prober = async (candidates) => { seen = candidates; return candidates.map((candidate) => ({ ...candidate, ok: true, probe: null })); };
  await checkStreams([TARGETS[0]], { prober, concurrency: 1 });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].headers, { Referer: 'https://cinejoy.pk/' }, 'the signed headers reach ffprobe');
  assert.equal(seen[0].kind, 'movie');
  assert.equal(seen[0]._checkIndex, 0);
});

test('trimProbe never invents data', () => {
  assert.equal(trimProbe(null), null);
  assert.deepEqual(trimProbe({}), { container: null, durationSec: null, video: null, audio: [], subtitleTracks: 0 });
  assert.equal(trimProbe({ audio: { codec: 'aac' } }).audio.length, 1, 'a single audio track is a list of one');
  assert.equal(trimProbe({ audio: [1, 2, 3, 4].map((n) => ({ codec: `c${n}` })) }).audio.length, 3, 'at most three tracks are reported');
});

test('summariseCheck counts what it is given', () => {
  const summary = summariseCheck([{ state: 'working' }, { state: 'working' }, { state: 'dead' }], { ms: 12, checkedAt: 0 });
  assert.equal(summary.checked, 3);
  assert.equal(summary.working, 2);
  assert.equal(summary.dead, 1);
  assert.equal(summary.expired, 0);
  assert.equal(summary.broken, 1);
  assert.equal(summary.ms, 12);
  assert.equal(summary.checkedAt, '1970-01-01T00:00:00.000Z');
});

/* ---------------- the endpoint ---------------- */

test('POST /api/playlist/check answers per item, without a network', async () => {
  const { createApp } = await import('../src/http/server.js');
  const store = await import('../src/streams/store.js');
  const playlist = await import('../src/playlist/index.js');

  // Two streams whose check needs no network: one with no upstream URL, one
  // whose token TTL passed long ago.
  const noUrl = await store.createStream({ title: 'No upstream', candidate: { url: '', sourceId: 'test', quality: '1080p' } });
  // `expires_at` is the upstream-token TTL (set from app.tokenTtlMinutes when a
  // stream is created) — backdating it simulates a playlist that has aged out.
  const expired = await store.createStream({
    title: 'Expired Smurfs',
    candidate: { url: 'https://up.invalid/smurfs.m3u8', sourceId: 'test' },
    expires_at: new Date(Date.now() - 86_400_000).toISOString(),
  });
  await playlist.addItems([noUrl.id, expired.id]);

  const app = createApp();
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/playlist/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamIds: [noUrl.id, expired.id, 'does-not-exist'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.results.map((result) => result.streamId), [noUrl.id, expired.id]);
    assert.deepEqual(body.results.map((result) => result.state), ['skipped', 'expired']);
    assert.deepEqual(body.unknown, ['does-not-exist'], 'an id that is not in the playlist is named, not silently dropped');
    assert.equal(body.summary.checked, 2);
    assert.equal(body.summary.broken, 1);
    assert.equal(body.summary.requested, 3);
    assert.equal(body.summary.concurrency, 2, 'the default concurrency is two probes at a time');

    // A single-id request is what the UI sends per row.
    const one = await (await fetch(`${base}/api/playlist/check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ streamIds: [expired.id] }),
    })).json();
    assert.equal(one.results.length, 1);
    assert.equal(one.results[0].title, 'Expired Smurfs');
    assert.match(one.results[0].error, /token expired/);
    assert.equal(one.summary.requested, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
