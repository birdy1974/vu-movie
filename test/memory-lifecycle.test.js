/**
 * Memory lifecycle: what a started movie allocates must be released when the
 * movie stops, and what the app spawns must be dead when the app stops.
 *
 * Each test pins one of the leaks found in the memory audit (docs/MEMORY.md):
 *   1. a closed upstream proxy kept its full 64 MB chunk/segment cache for as
 *      long as anything referenced the session object;
 *   2. a range-less direct link kept downloading the whole movie in the
 *      background after the player disconnected (and its own progress kept
 *      the idle sweep from ever closing it);
 *   3. the in-memory api_cache mirror grew by one entry per key forever;
 *   4. a relay session whose ffmpeg failed to spawn was never unregistered
 *      (Node does not guarantee 'close' after a spawn 'error');
 *   5. shutdown helpers: cancelAllJobs / waitForChildrenToExit actually kill
 *      the children instead of leaving them as orphans.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import express from 'express';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-memory-'));
process.env.CONFIG_FILE = path.join(tempDir, 'vumovie.json');
process.env.TMP_DIR = path.join(tempDir, 'tmp');
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL = '';
process.env.FFMPEG_PROBE_TIMEOUT_MS = '2000';
// A "ffmpeg" that exists but cannot be executed (bad interpreter): spawn()
// fails with an 'error' event and Node does not guarantee 'close' after it.
const brokenFfmpeg = path.join(tempDir, 'ffmpeg-broken');
fs.writeFileSync(brokenFfmpeg, '#!/nonexistent/interpreter\necho never\n', { mode: 0o755 });
process.env.FFMPEG_PATH = brokenFfmpeg;
process.env.FFPROBE_PATH = brokenFfmpeg;

const config = await import('../src/core/config.js');
config.loadConfig();
config.ensureDirs();
config.saveConfig({ transcode: { hardware: false } });
const upstream = await import('../src/streams/upstream.js');
const { repo, dbState } = await import('../src/core/db.js');
const { JobQueue, cancelAllJobs, activeJobHandles } = await import('../src/core/jobs.js');
const { memorySnapshot } = await import('../src/core/memory.js');
const store = await import('../src/streams/store.js');
const relay = await import('../src/streams/relay.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

after(() => {
  upstream.closeAllUpstreamProxies('test done');
});

/* ------------------------------------------------------------------ *
 * 1 — closing a proxy frees its cache even while references survive
 * ------------------------------------------------------------------ */

test('closeUpstreamProxy drops the file chunk cache immediately', async () => {
  const proxy = await upstream.createUpstreamProxy({
    streamId: 'mem-file', url: 'https://cdn.example.com/movie.mp4', headers: {}, kind: 'file',
  });
  // One complete chunk, exactly what a few seconds of playback leaves behind.
  proxy.store.put(0, Buffer.alloc(proxy.tune.chunkBytes, 1));
  assert.ok(upstream.proxyStats(proxy).cacheBytes > 0, 'the cache holds bytes while open');

  upstream.closeUpstreamProxy(proxy, 'test stop');
  // `proxy` is still referenced right here — the bytes must be gone anyway.
  assert.equal(upstream.proxyStats(proxy).cacheBytes, 0, 'closing freed the cache bytes');
  assert.equal(proxy.store.chunks.size, 0);
  assert.equal(proxy.store.size, 0);
});

test('closeUpstreamProxy drops the DASH segment cache and manifest refs', async () => {
  const proxy = await upstream.createUpstreamProxy({
    streamId: 'mem-dash', url: 'https://cdn.example.com/movie.mpd', headers: {}, kind: 'dash',
  });
  await proxy.segments.obtain('https://cdn.example.com/seg1.m4s', async () => ({
    buf: Buffer.alloc(4096, 2), contentType: 'video/iso.segment',
  }));
  proxy.refs.byId.set('r1', { type: 'url', url: 'https://cdn.example.com/seg1.m4s' });
  assert.ok(upstream.proxyStats(proxy).cacheBytes > 0);

  upstream.closeUpstreamProxy(proxy, 'test stop');
  assert.equal(upstream.proxyStats(proxy).cacheBytes, 0);
  assert.equal(proxy.segments.done.size, 0);
  assert.equal(proxy.refs.byId.size, 0);
});

test('closeAllUpstreamProxies closes every registered proxy (shutdown net)', async () => {
  const a = await upstream.createUpstreamProxy({ streamId: 'mem-all-a', url: 'https://cdn.example.com/a.mp4', headers: {}, kind: 'file' });
  const b = await upstream.createUpstreamProxy({ streamId: 'mem-all-b', url: 'https://cdn.example.com/b.mp4', headers: {}, kind: 'file' });
  const closed = upstream.closeAllUpstreamProxies('test shutdown');
  assert.ok(closed >= 2);
  assert.equal(a.closed, true);
  assert.equal(b.closed, true);
  assert.ok(!upstream.listUpstreamProxies().some((p) => p.id === a.id || p.id === b.id));
});

/* ------------------------------------------------------------------ *
 * 2 — a stopped direct player stops the range-less background capture
 * ------------------------------------------------------------------ */

test('range-less direct capture pauses when the player leaves and resumes on reconnect', async (t) => {
  // A range-less CDN: plain chunked 200, ~6 MB/s, effectively endless.
  const cdn = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    const piece = Buffer.alloc(64 * 1024, 9);
    const iv = setInterval(() => { res.write(piece); }, 10);
    req.on('close', () => clearInterval(iv));
  });
  await new Promise((r) => cdn.listen(0, '127.0.0.1', r));
  const app = express();
  app.use(upstream.upstreamProxyMiddleware);
  app.get('/direct', async (req, res) => {
    const stream = {
      id: 'mem-capture',
      upstream: { url: `http://127.0.0.1:${cdn.address().port}/movie.mp4`, headers: {}, kind: 'file' },
    };
    await upstream.serveDirectFile(stream, req, res);
  });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => {
    srv.closeAllConnections?.(); srv.close();
    cdn.closeAllConnections?.(); cdn.close();
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cdnBytes = () => upstream.listUpstreamProxies().find((p) => p.streamId === 'mem-capture')?.stats.cdnBytes ?? -1;

  // Player reads ~1 MB and stops.
  const ctrl = new AbortController();
  const res1 = await fetch(`${base}/direct`, { signal: ctrl.signal });
  let read1 = 0;
  for await (const part of res1.body) { read1 += part.byteLength; if (read1 >= 1024 * 1024) break; }
  ctrl.abort();
  assert.ok(read1 >= 1024 * 1024);

  // The capture must stop growing (before the fix it downloaded forever).
  await sleep(400); // let the pause land / in-flight chunk settle
  const stoppedAt = cdnBytes();
  await sleep(800);
  assert.equal(cdnBytes(), stoppedAt, 'no CDN traffic after the player stopped');

  // A reconnect that reads past the captured frontier resumes the capture.
  const ctrl2 = new AbortController();
  const res2 = await fetch(`${base}/direct`, { signal: ctrl2.signal });
  let read2 = 0;
  for await (const part of res2.body) { read2 += part.byteLength; if (read2 >= 8 * 1024 * 1024) break; }
  ctrl2.abort();
  assert.ok(read2 >= 8 * 1024 * 1024, `the reconnect could read past the frontier (${read2} bytes)`);
  assert.ok(cdnBytes() > stoppedAt, 'the capture resumed fetching for the new reader');
});

/* ------------------------------------------------------------------ *
 * 3 — the api_cache memory mirror is bounded
 * ------------------------------------------------------------------ */

test('the in-memory cache mirror evicts expired/oldest entries instead of growing forever', async () => {
  for (let i = 0; i < 600; i += 1) {
    await repo.cacheSet(`mem-test-${i}`, { i }, 3600);
  }
  assert.ok(dbState().memCacheEntries <= 500, `mirror is capped (got ${dbState().memCacheEntries})`);
  assert.equal(await repo.cacheGet('mem-test-0'), null, 'the oldest entry was evicted');
  assert.deepEqual(await repo.cacheGet('mem-test-599'), { i: 599 }, 'the newest entry is still there');

  // An expired entry is dropped on the next write, not only on its own read:
  // adding a fresh entry after the short-lived one expired must not grow the
  // entry count (one in, the expired one out).
  await repo.cacheSet('mem-test-expired', { gone: true }, 0.01);
  await sleep(25);
  const beforeFresh = dbState().memCacheEntries;
  await repo.cacheSet('mem-test-fresh', { kept: true }, 3600);
  assert.equal(dbState().memCacheEntries, beforeFresh, 'the write pruned the expired entry');
  assert.equal(await repo.cacheGet('mem-test-expired'), null);
  assert.deepEqual(await repo.cacheGet('mem-test-fresh'), { kept: true });
});

/* ------------------------------------------------------------------ *
 * 4 — a session whose ffmpeg cannot spawn is unregistered and freed
 * ------------------------------------------------------------------ */

test('a spawn failure unregisters the session and releases its upstream proxy', async (t) => {
  if (fs.existsSync('/usr/bin/ffmpeg') || fs.existsSync('/usr/local/bin/ffmpeg')) {
    t.skip('a system ffmpeg exists here, so the broken-stub spawn failure cannot be forced');
    return;
  }
  const stream = await store.createStream({
    title: 'Spawn failure',
    profile: { mode: 'copy' },
    candidate: {
      url: 'https://cdn.example/movie.mp4',
      kind: 'file',
      headers: {},
      probe: {
        container: 'mp4', durationSec: 3600,
        video: { codec: 'h264', width: 1280, height: 720, fps: 25 },
        audio: [{ codec: 'aac', channels: 2 }], subtitles: [],
      },
    },
  });
  const session = await relay.ensureSession(stream, { container: 'mpegts' });
  assert.ok(session.upProxy, 'a file source gets an upstream proxy');
  await until(() => relay.getSession(stream.id) === null, 'the dead session to be unregistered');
  assert.ok(
    !upstream.listUpstreamProxies().some((p) => p.streamId === stream.id),
    'its upstream proxy was released instead of being pinned forever',
  );
});

/* ------------------------------------------------------------------ *
 * 5 — shutdown helpers kill children instead of orphaning them
 * ------------------------------------------------------------------ */

test('cancelAllJobs kills a running job child; waitForChildrenToExit escalates to SIGKILL', async () => {
  // A fake ffmpeg that ignores SIGTERM: cancel must still be requested, and
  // the shutdown wait must escalate rather than give up and orphan it.
  const kills = [];
  const fakeChild = new EventEmitter();
  fakeChild.pid = 424242;
  fakeChild.exitCode = null;
  fakeChild.signalCode = null;
  fakeChild.kill = (signal) => {
    kills.push(signal);
    if (signal === 'SIGKILL') {
      fakeChild.signalCode = 'SIGKILL';
      fakeChild.emit('close', null, 'SIGKILL');
    }
    return true;
  };

  const queue = new JobQueue({ name: 'memtest', concurrency: 1 });
  const job = queue.submit({ type: 'download', title: 'stuck download' }, async (_job, ctx) => {
    ctx.setHandle(fakeChild);
    await new Promise((resolve) => fakeChild.once('close', resolve));
    return { done: true };
  });
  await until(() => activeJobHandles().includes(fakeChild), 'the job to hold its child');

  const children = activeJobHandles();
  const cancelled = cancelAllJobs();
  assert.ok(cancelled >= 1, 'the running job was cancelled');
  assert.ok(kills.includes('SIGTERM'), 'cancelling sent SIGTERM');

  const result = await relay.waitForChildrenToExit(children, { timeoutMs: 300 });
  assert.ok(kills.includes('SIGKILL'), 'the SIGTERM-ignoring child was escalated to SIGKILL');
  assert.equal(result.killed, 1);
  await until(() => queue.raw(job.id).status !== 'running', 'the job to settle');
});

test('waitForChildrenToExit resolves promptly when children exit on SIGTERM', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  const t0 = Date.now();
  const waiting = relay.waitForChildrenToExit([child], { timeoutMs: 5000 });
  child.exitCode = 0;
  child.emit('close', 0, 'SIGTERM');
  const result = await waiting;
  assert.equal(result.exited, 1);
  assert.equal(result.killed, 0);
  assert.ok(Date.now() - t0 < 1000, 'did not sit out the deadline');
});

test('memorySnapshot reports the five process numbers /api/health exposes', () => {
  const snap = memorySnapshot();
  for (const key of ['rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes', 'arrayBuffersBytes']) {
    assert.equal(typeof snap[key], 'number', key);
    assert.ok(snap[key] >= 0, key);
  }
  assert.ok(snap.rssBytes >= snap.heapUsedBytes);
});
