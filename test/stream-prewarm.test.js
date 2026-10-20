import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-prewarm-'));
process.env.CONFIG_FILE = path.join(directory, 'vumovie.json');
process.env.LOG_LEVEL = 'error';
process.env.PLAYLIST_PREWARM_TRUST_MINUTES = '25';

const config = await import('../src/core/config.js');
config.loadConfig();
const store = await import('../src/streams/store.js');
const recovery = await import('../src/streams/recovery.js');
const readiness = await import('../src/streams/readiness.js');
const playlist = await import('../src/playlist/index.js');
const maintenance = await import('../src/playlist/maintenance.js');

const probe = {
  container: 'mpegts',
  durationSec: 90,
  video: { codec: 'h264', width: 1920, height: 1080, fps: 24 },
  audio: [{ codec: 'aac', channels: 2 }],
  subtitles: [],
};

const okProber = (counter) => async (candidates) => candidates.map((candidate) => {
  if (counter) counter.urls.push(candidate.url);
  return { ...candidate, ok: true, probe, probeMs: 10 };
});

async function makeStream(id, url) {
  return store.createStream({
    id,
    token: `token-${id}`,
    title: `Title ${id}`,
    year: 2024,
    kind: 'movie',
    sourceId: 'cinejoy',
    candidate: { url, sourceId: 'cinejoy', kind: 'hls', headers: {} },
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function untilSettled(streamId, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    if (!readiness.isChecking(streamId)) return;
    await sleep(20);
  }
  throw new Error(`stream ${streamId} never settled`);
}

/* ---------------- signed-URL expiry parsing ---------------- */

test('upstreamUrlExpiresAt reads the expiry a signed URL carries', () => {
  const expSec = 1893456000; // 2030-01-01
  assert.equal(readiness.upstreamUrlExpiresAt(`https://cdn.example/v.m3u8?exp=${expSec}&sig=abc`), expSec * 1000);
  assert.equal(readiness.upstreamUrlExpiresAt(`https://cdn.example/v.m3u8?expires=${expSec * 1000}`), expSec * 1000, 'millisecond epochs');

  // The bridge shape from the field: the real signed CDN URL nested in ?url=
  const inner = `https://sacdn.example/dash/x.mpd?exp=${expSec}&token=abc`;
  assert.equal(
    readiness.upstreamUrlExpiresAt(`https://dash-hls-bridge.example/?url=${encodeURIComponent(inner)}`),
    expSec * 1000,
    'the nested URL expiry is the binding one',
  );

  // JWT in a query parameter
  const jwtPayload = Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url');
  assert.equal(
    readiness.upstreamUrlExpiresAt(`https://cdn.example/v.m3u8?token=eyJhbGciOiJIUzI1NiJ9.${jwtPayload}.sig`),
    expSec * 1000,
  );

  // AWS SigV4: start + duration
  assert.equal(
    readiness.upstreamUrlExpiresAt('https://s3.example/v.mp4?X-Amz-Date=20261020T120000Z&X-Amz-Expires=3600&X-Amz-Signature=x'),
    Date.UTC(2026, 9, 20, 13, 0, 0),
  );

  // Akamai-style token packed inside one parameter value
  const akamai = new URLSearchParams({ hdnea: `st=1790000000~exp=${expSec}~acl=/*` });
  assert.equal(readiness.upstreamUrlExpiresAt(`https://cdn.example/v.m3u8?${akamai}`), expSec * 1000);
});

test('upstreamUrlExpiresAt ignores values that are not an epoch expiry', () => {
  assert.equal(readiness.upstreamUrlExpiresAt('https://cdn.example/v.m3u8'), null);
  assert.equal(readiness.upstreamUrlExpiresAt('https://cdn.example/v.m3u8?expires=3600'), null, 'a relative duration is not an expiry');
  assert.equal(readiness.upstreamUrlExpiresAt('https://cdn.example/v.mp4?e=720'), null, 'a small e= is not an epoch');
  assert.equal(readiness.upstreamUrlExpiresAt('https://cdn.example/v.mp4?t=1893456000'), null, 't= is an issue time, not an expiry');
  assert.equal(readiness.upstreamUrlExpiresAt(''), null);
  assert.equal(readiness.upstreamUrlExpiresAt(null), null);
});

test('prewarm settings are known config options and environment-overridable', () => {
  assert.ok(config.knownOptionPaths().includes('playlist.prewarmEnabled'));
  assert.ok(config.knownOptionPaths().includes('playlist.prewarmTrustMinutes'));
  assert.equal(config.getConfig().playlist.prewarmTrustMinutes, 25, 'PLAYLIST_PREWARM_TRUST_MINUTES wins');
  assert.equal(readiness.prewarmConfig().trustMinutes, 25);
  assert.equal(readiness.prewarmConfig().enabled, true);
});

test('an empty PLAYLIST_PREWARM (the compose default) does not override Settings', () => {
  // docker-compose forwards these names with `:-}` — an empty value inside
  // the container must mean "not set", or saving "keep-warm off" in the
  // Settings tab would silently flip back on at every restart.
  config.saveConfig({ playlist: { prewarmEnabled: false } });
  process.env.PLAYLIST_PREWARM = '';
  try {
    config.loadConfig();
    assert.equal(config.getConfig().playlist.prewarmEnabled, false, 'the saved Settings value survives the empty env var');
  } finally {
    delete process.env.PLAYLIST_PREWARM;
    config.saveConfig({ playlist: { prewarmEnabled: true } });
    config.loadConfig();
  }
});

/* ---------------- proofs, trust and backoff ---------------- */

test('a verified stream is trusted at playback without a second probe', async () => {
  const stream = await makeStream('trust-basic', 'https://cdn.example/trust.m3u8');
  const first = await recovery.ensureStreamReady(stream, { forceCheck: true, prober: okProber() });
  assert.equal(first.ok, true);

  const ready = readiness.getReadiness(first.stream);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.ready, true);
  assert.ok(Date.parse(ready.trustedUntil) > Date.now() + 20 * 60_000, 'trusted for roughly the configured window');

  const cached = await recovery.ensureStreamReady(stream.id, {
    prober: async () => { throw new Error('a trusted proof must not be re-probed'); },
  });
  assert.equal(cached.ok, true);
  assert.equal(cached.result.cached, true);

  readiness.forget(stream.id);
  const counter = { urls: [] };
  const rechecked = await recovery.ensureStreamReady(stream.id, { prober: okProber(counter) });
  assert.equal(rechecked.ok, true);
  assert.equal(counter.urls.length, 1, 'forgetting the proof makes playback probe again');
});

test('a signed URL expiry caps the trust window', async () => {
  const expSec = Math.floor(Date.now() / 1000) + 10; // dies in 10 s
  const stream = await makeStream('trust-expiry', `https://cdn.example/soon-dead.m3u8?exp=${expSec}`);
  const counter = { urls: [] };
  const first = await recovery.ensureStreamReady(stream, { forceCheck: true, prober: okProber(counter) });
  assert.equal(first.ok, true, 'the link works right now');
  assert.equal(counter.urls.length, 1);

  const ready = readiness.getReadiness(first.stream);
  assert.equal(ready.upstreamExpiresAt, new Date(expSec * 1000).toISOString());
  assert.equal(ready.ready, false, 'but it is not trusted: the token dies before the movie would get going');
  assert.equal(ready.state, 'stale');

  await recovery.ensureStreamReady(stream.id, { prober: okProber(counter) });
  assert.equal(counter.urls.length, 2, 'playback re-checks instead of trusting a nearly-expired link');
});

test('failed repairs back off so keep-warm cannot become a search storm', () => {
  const fake = { id: 'fake-backoff', upstream: { url: 'https://cdn.example/x.m3u8' } };
  const at = Date.now();
  readiness.markFailed(fake, 'no playable match', { at });
  let ready = readiness.getReadiness(fake, { now: at });
  assert.equal(ready.state, 'failed');
  assert.equal(ready.failures, 1);
  assert.ok(Date.parse(ready.nextRetryAt) >= at + 14 * 60_000 && Date.parse(ready.nextRetryAt) <= at + 16 * 60_000);
  assert.equal(readiness.isDue(fake, { now: at + 60_000 }), false, 'not due inside the backoff');
  assert.equal(readiness.isDue(fake, { now: at + 16 * 60_000 }), true, 'due once the backoff has passed');

  readiness.markFailed(fake, 'still nothing', { at: at + 16 * 60_000 });
  ready = readiness.getReadiness(fake, { now: at + 16 * 60_000 });
  assert.equal(ready.failures, 2);
  assert.equal(Date.parse(ready.nextRetryAt) - (at + 16 * 60_000), 30 * 60_000, 'the backoff doubles');

  readiness.forget('fake-backoff');
  assert.equal(readiness.isDue(fake, { now: at }), true);
  assert.equal(readiness.getReadiness(fake, { now: at }).state, 'unknown');
});

/* ---------------- manual prepare ---------------- */

test('prewarmStream starts in the background and ends ready', async () => {
  const stream = await makeStream('prepare-one', 'https://cdn.example/prepare.m3u8');
  const slowProber = async (candidates) => {
    await sleep(80);
    return candidates.map((candidate) => ({ ...candidate, ok: true, probe, probeMs: 80 }));
  };
  const started = await recovery.prewarmStream(stream, { prober: slowProber });
  assert.equal(started.started, true);
  assert.equal(started.readiness.preparing, true, 'the caller is not blocked while the probe runs');

  const duplicate = await recovery.prewarmStream(stream.id, { prober: slowProber });
  assert.equal(duplicate.alreadyPreparing, true, 'a second prepare joins the running one');

  await untilSettled(stream.id);
  assert.equal(readiness.getReadiness(stream).state, 'ready');

  const again = await recovery.prewarmStream(stream, { prober: slowProber });
  assert.deepEqual([again.started, again.alreadyReady], [false, true], 'a trusted proof is not re-probed without force');

  const forced = await recovery.prewarmStream(stream, { prober: slowProber, force: true });
  assert.equal(forced.started, true);
  await untilSettled(stream.id);
});

/* ---------------- keep-warm pass over the playlist ---------------- */

test('runPlaylistPrewarmOnce proves due enabled items and leaves ready/disabled ones alone', async () => {
  const fresh = await makeStream('mw-fresh', 'https://cdn.example/fresh.m3u8');
  const stale = await makeStream('mw-stale', 'https://cdn.example/stale.m3u8');
  const disabled = await makeStream('mw-disabled', 'https://cdn.example/disabled.m3u8');
  // Earlier tests in this file created library streams too; restrict the
  // pass to these three so the counts are exact.
  await playlist.addItems([fresh.id, stale.id, disabled.id]);
  await playlist.updateItem(disabled.id, { enabled: false });
  readiness.markVerified(fresh, { state: 'working', probe, probeMs: 5 });
  readiness.forget(stale.id);

  const counter = { urls: [] };
  const outcome = await maintenance.runPlaylistPrewarmOnce({
    reason: 'test',
    streamIds: [fresh.id, stale.id, disabled.id],
    prober: okProber(counter),
    searchSource: async () => { throw new Error('no repair should be needed'); },
    searchAll: async () => { throw new Error('no repair should be needed'); },
  });

  assert.equal(outcome.skipped, false);
  assert.equal(outcome.summary.considered, 2, 'disabled items are not keep-warmed');
  assert.deepEqual(counter.urls, ['https://cdn.example/stale.m3u8'], 'only the due item was probed');
  assert.equal(outcome.summary.alreadyReady, 1);
  assert.equal(outcome.summary.warmed, 1);
  assert.equal(outcome.summary.ready, 2);
  assert.equal(readiness.getReadiness(stale).state, 'ready', 'the warmed item now plays instantly');

  const second = await maintenance.runPlaylistPrewarmOnce({
    reason: 'test',
    streamIds: [fresh.id, stale.id],
    prober: okProber(counter),
  });
  assert.equal(second.summary.due, 0, 'nothing is due while the proofs are trusted');
  assert.equal(counter.urls.length, 1, 'and nothing is probed again');
});

/* ---------------- HTTP surface ---------------- */

test('prepare endpoints start background work and report readiness', async () => {
  config.saveConfig({ playlist: { autoRepairEnabled: false } });
  const { createApp } = await import('../src/http/server.js');
  const stream = await makeStream('api-prepare', '');
  await playlist.addItems([stream.id]);

  const server = await new Promise((resolve) => {
    const instance = createApp().listen(0, '127.0.0.1', () => resolve(instance));
  });
  const json = async (response) => response.json();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;

    const missing = await fetch(`${base}/api/playlist/items/does-not-exist/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(missing.status, 404);

    const started = await fetch(`${base}/api/playlist/items/${stream.id}/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(started.status, 202, 'prepare answers at once; the work is in the background');
    const startedBody = await json(started);
    assert.equal(startedBody.ok, true);
    assert.equal(startedBody.started, true);

    await untilSettled(stream.id);
    const readinessResponse = await fetch(`${base}/api/playlist/readiness`);
    const readinessBody = await json(readinessResponse);
    assert.equal(readinessBody.ok, true);
    assert.equal(readinessBody.prewarm.trustMinutes, 25);
    assert.equal(readinessBody.items[stream.id].ready, false);
    assert.equal(readinessBody.items[stream.id].state, 'failed', 'an item with no upstream reports failed, with the reason attached');
    assert.match(readinessBody.items[stream.id].error, /no upstream URL/i);

    const waited = await fetch(`${base}/api/streams/${stream.id}/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"wait":true}' });
    assert.equal(waited.status, 503, 'wait:true blocks and then answers honestly');
    assert.equal((await json(waited)).readiness.streamId, stream.id);

    const bulk = await fetch(`${base}/api/playlist/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ streamIds: [stream.id] }) });
    assert.equal(bulk.status, 202);
    assert.ok((await json(bulk)).preparing[stream.id]);
    await untilSettled(stream.id);

    const list = await json(await fetch(`${base}/api/playlist`));
    const item = list.items.find((entry) => entry.streamId === stream.id);
    assert.ok(item.readiness, 'playlist items carry their readiness for the UI');
    assert.equal(item.readiness.streamId, stream.id);
    assert.ok(list.maintenance.prewarm, 'the maintenance status carries the keep-warm block');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    config.saveConfig({ playlist: { autoRepairEnabled: true } });
  }
});
