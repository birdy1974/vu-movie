/**
 * Tests for the chunked upstream proxy (src/streams/upstream.js) — the
 * MovieBox-TUI-style fetcher that keeps a complete movie playing when the CDN
 * ends chunked transfers early — plus the relay's restart/resume decisions.
 *
 * The integration part runs a fake CDN that supports HTTP Range but destroys
 * every connection after a few hundred KB (the failure the proxy exists for)
 * and asserts that a client of the proxy still receives every byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { EventEmitter } from 'node:events';
import {
  createUpstreamProxy, closeUpstreamProxy, rewriteDashManifest, parseClientRange,
  shouldProxyUpstream, upstreamProxyMiddleware, proxyStats, listUpstreamProxies,
} from '../src/streams/upstream.js';
import { decideRestart, argsWithResume, releaseUpstreamProxy } from '../src/streams/relay.js';
import { getConfig } from '../src/core/config.js';

/* ------------------------------------------------------------------ *
 * pure helpers
 * ------------------------------------------------------------------ */

test('parseClientRange understands the usual shapes (and unknown totals)', () => {
  assert.deepEqual(parseClientRange('bytes=0-499', 1000), { start: 0, end: 499 });
  assert.deepEqual(parseClientRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseClientRange('bytes=999-999', 1000), { start: 999, end: 999 });
  assert.equal(parseClientRange('bytes=1000-', 1000), null); // past EOF
  assert.equal(parseClientRange('bytes=500-400', 1000), null); // inverted
  assert.equal(parseClientRange('items=1-2', 1000), null);
  assert.equal(parseClientRange(undefined, 1000), null);
  // Unknown total (null): the start is all we can validate.
  assert.deepEqual(parseClientRange('bytes=12345-', null), { start: 12345, end: Infinity });
});

test('decideRestart: restarts on errors and on early clean EOFs, not on the real end', () => {
  const base = { clients: 1, restarts: 0, code: 0, signal: null, outTimeMs: null, durationSec: null, maxRestarts: 3 };
  assert.equal(decideRestart({ ...base, clients: 0 }).restart, false, 'nobody watching');
  assert.equal(decideRestart({ ...base, signal: 'SIGTERM' }).restart, false, 'deliberate stop');
  assert.equal(decideRestart({ ...base, restarts: 3 }).restart, false, 'budget exhausted');
  assert.equal(decideRestart({ ...base, code: 1 }).restart, true, 'transient error exit');
  // The chunked-CDN case: "clean" EOF 2 hours before the movie ends.
  assert.equal(decideRestart({ ...base, code: 0, outTimeMs: 180000, durationSec: 7200 }).restart, true);
  // Genuine end: play head at >= 99 % of the known duration.
  assert.equal(decideRestart({ ...base, code: 0, outTimeMs: 7195000, durationSec: 7200 }).restart, false);
  // Unknown duration + clean EOF → better to try once more than go black.
  assert.equal(decideRestart({ ...base, code: 0 }).restart, true);
});

test('argsWithResume splices an input-side -ss in front of the first -i', () => {
  const args = ['-hide_banner', '-reconnect', '1', '-i', 'http://x/in', '-f', 'mpegts', 'pipe:1'];
  assert.deepEqual(argsWithResume(args, 63), ['-hide_banner', '-reconnect', '1', '-ss', '63', '-i', 'http://x/in', '-f', 'mpegts', 'pipe:1']);
  assert.deepEqual(argsWithResume(args, 2), args, 'tiny resumes are skipped');
  assert.deepEqual(argsWithResume(args, NaN), args);
});

test('a deliberate stop closes the upstream proxy only after ffmpeg has exited', async (t) => {
  // The regression this guards: stopSession() used to close the proxy in the
  // same tick as the SIGTERM, aborting the in-flight ranged transfer under
  // ffmpeg. ffmpeg then reconnected to a 404, exited with an I/O error and the
  // log showed a crash for what was a clean idle stop.
  const proxy = await createUpstreamProxy({
    streamId: 'stop-test', url: 'https://cdn.example.com/movie.mp4', headers: {}, kind: 'file',
  });
  t.after(() => closeUpstreamProxy(proxy, 'test done'));

  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const session = { streamId: 'stop-test', child, upProxy: proxy };

  releaseUpstreamProxy(session, 'idle for 45s');
  assert.equal(proxy.closed, false, 'the proxy stays up while ffmpeg may still be reading it');

  child.exitCode = 0;
  child.signalCode = 'SIGTERM';
  child.emit('close', 0, 'SIGTERM');
  assert.equal(proxy.closed, true, 'the proxy is closed once the child is gone');
  assert.ok(!listUpstreamProxies().some((p) => p.id === proxy.id));
});

test('a child that never exits cannot keep the upstream proxy alive forever', async (t) => {
  const proxy = await createUpstreamProxy({
    streamId: 'stuck-test', url: 'https://cdn.example.com/movie.mp4', headers: {}, kind: 'file',
  });
  t.after(() => closeUpstreamProxy(proxy, 'test done'));
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;

  releaseUpstreamProxy({ streamId: 'stuck-test', child, upProxy: proxy }, 'stuck', { graceMs: 20 });
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  assert.equal(proxy.closed, true, 'the grace timer is the safety net');
});

test('shouldProxyUpstream picks files and DASH, leaves HLS direct, honours the switch', () => {
  const on = { transcode: { upstreamProxy: true } };
  const off = { transcode: { upstreamProxy: false } };
  assert.equal(shouldProxyUpstream({ url: 'https://cdn/movie.mp4', kind: 'file' }, on), true);
  assert.equal(shouldProxyUpstream({ url: 'https://cdn/dash/index.mpd', kind: 'dash' }, on), true);
  assert.equal(shouldProxyUpstream({ url: 'https://cdn/hls/master.m3u8', kind: 'hls' }, on), false);
  assert.equal(shouldProxyUpstream({ url: 'https://cdn/movie.mp4', kind: 'file' }, off), false);
  assert.equal(shouldProxyUpstream({ url: 'not-a-url' }, on), false);
});

/* ------------------------------------------------------------------ *
 * MPD rewriting
 * ------------------------------------------------------------------ */

const MPD_RELATIVE = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT2H">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="0" bandwidth="2000000">
        <SegmentTemplate initialization="init-stream$RepresentationID$.m4s"
                         media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

test('rewriteDashManifest reroutes relative templates and keeps the $Tokens$', () => {
  const registered = [];
  const out = rewriteDashManifest(MPD_RELATIVE, {
    mpdUrl: 'https://cdn.example/dash/movie/index.mpd?sig=abc',
    localPrefix: 'http://127.0.0.1:8080/up/secret1',
    register: (entry) => { registered.push(entry); return `r${registered.length}`; },
  });
  assert.match(out, /initialization="http:\/\/127\.0\.0\.1:8080\/up\/secret1\/dash\/t\/r1\/init-stream\$RepresentationID\$\.m4s"/);
  assert.match(out, /media="http:\/\/127\.0\.0\.1:8080\/up\/secret1\/dash\/t\/r2\/chunk-stream\$RepresentationID\$-\$Number%05d\$\.m4s"/);
  assert.equal(registered.length, 2);
  assert.equal(registered[0].type, 'template');
  assert.equal(registered[0].dir, 'https://cdn.example/dash/movie/?sig=abc', 'template keeps the MPD query for signed CDNs');
  // The proxy resolves template r2 + an expanded filename back to the CDN URL.
  // (resolveRef is internal; the integration test below exercises it end-to-end.)
});

test('rewriteDashManifest handles absolute media URLs, BaseURL stacks and single quotes', () => {
  const mpd = `<MPD><BaseURL>https://cdn.example/prefix/</BaseURL>
  <Period><AdaptationSet>
    <SegmentTemplate media='seg-$Number$.m4s'/>
    <Representation><BaseURL>https://other.example/alt/</BaseURL></Representation>
  </AdaptationSet></Period></MPD>`;
  const registered = [];
  const out = rewriteDashManifest(mpd, {
    mpdUrl: 'https://cdn.example/index.mpd',
    localPrefix: 'http://127.0.0.1:8080/up/s2',
    register: (entry) => { registered.push(entry); return `r${registered.length}`; },
  });
  // First BaseURL becomes a local prefix; the template that follows it is
  // registered against that base (the rewriter normalises attribute quotes to
  // double quotes, which is equally valid XML). The second BaseURL becomes a
  // second local prefix for whatever would follow it.
  assert.match(out, /<BaseURL>http:\/\/127\.0\.0\.1:8080\/up\/s2\/dash\/b\/r1\/<\/BaseURL>/);
  assert.match(out, /media="http:\/\/127\.0\.0\.1:8080\/up\/s2\/dash\/t\/r2\/seg-\$Number\$\.m4s"/);
  assert.equal(registered[0].type, 'base');
  assert.equal(registered[0].url, 'https://cdn.example/prefix/');
  assert.equal(registered[1].type, 'template');
  assert.equal(registered[1].dir, 'https://cdn.example/prefix/', 'the template belongs to the base in scope at its position');
  assert.equal(registered[2].type, 'base');
  assert.equal(registered[2].url, 'https://other.example/alt/');

  const registered2 = [];
  const absolute = rewriteDashManifest('<SegmentTemplate media="https://seg.example/a/b-00001.m4s" initialization="https://seg.example/a/init.mp4"/>', {
    mpdUrl: 'https://cdn.example/x.mpd',
    localPrefix: 'http://127.0.0.1:8080/up/s3',
    register: (entry) => { registered2.push(entry); return `r${registered2.length}`; },
  });
  assert.match(absolute, /media="http:\/\/127\.0\.0\.1:8080\/up\/s3\/dash\/u\/r1"/);
  assert.match(absolute, /initialization="http:\/\/127\.0\.0\.1:8080\/up\/s3\/dash\/u\/r2"/);
  assert.equal(registered2[0].url, 'https://seg.example/a/b-00001.m4s');
  assert.equal(registered2[1].url, 'https://seg.example/a/init.mp4');
});

/* ------------------------------------------------------------------ *
 * integration: a CDN that cuts every connection early
 * ------------------------------------------------------------------ */

/** Deterministic pseudo-random bytes (so failures are reproducible). */
function pseudoBytes(n, seed = 42) {
  const buf = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i += 1) {
    x = (x * 1664525 + 1013904223) >>> 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

/**
 * A CDN that honours Range but destroys the socket after `cutAfterBytes`
 * bytes of every response — the exact "chunked transfer ends early" failure.
 * `files` maps pathname → { buf: Buffer, type: string }.
 */
function startTruncatingCdn(files, { cutAfterBytes = Infinity, supportRange = true, countResponseSizes = false } = {}) {
  const stats = { requests: 0, bytes: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://cdn.local');
    const file = files.get(u.pathname);
    stats.requests += 1;
    if (!file) { res.writeHead(404, { 'Content-Length': 0 }); return res.end(); }
    const { buf, type = 'application/octet-stream' } = file;
    let start = 0;
    let end = buf.length - 1;
    const range = supportRange ? req.headers.range : null;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (!m) { res.writeHead(416, { 'Content-Range': `bytes */${buf.length}` }); return res.end(); }
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), buf.length - 1);
      if (start >= buf.length) { res.writeHead(416, { 'Content-Range': `bytes */${buf.length}` }); return res.end(); }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${buf.length}`,
        'Content-Length': String(end - start + 1),
      });
    } else {
      res.writeHead(200, {
        'Content-Type': type,
        ...(countResponseSizes ? { 'Content-Length': String(buf.length) } : {}),
      });
    }
    let pos = start;
    let sent = 0;
    const tick = () => {
      if (req.socket.destroyed) return;
      if (sent >= cutAfterBytes) return req.socket.destroy(); // the CDN "ends the chunked transfer"
      if (pos > end) return res.end();
      const slice = buf.subarray(pos, Math.min(pos + 16384, end + 1));
      pos += slice.length;
      sent += slice.length;
      stats.bytes += slice.length;
      res.write(slice, () => setTimeout(tick, 1));
    };
    tick();
    return undefined;
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, stats, port: server.address().port }));
  });
}

/** The vu-movie side: express app with the /up/ middleware on an ephemeral port. */
function startProxyApp() {
  const app = express();
  app.use(upstreamProxyMiddleware);
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function get(url, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

test('file source: the complete file arrives even though the CDN cuts every 300 KB', { timeout: 60000 }, async () => {
  const source = pseudoBytes(3 * 1024 * 1024);
  const cdn = await startTruncatingCdn(new Map([['/movie.mp4', { buf: source, type: 'video/mp4' }]]), { cutAfterBytes: 300 * 1024 });
  const proxy = await startProxyApp();
  const cfg = getConfig();
  cfg.transcode.upstreamChunkBytes = 1024 * 1024;
  cfg.transcode.upstreamRequestTimeoutMs = 10000;
  cfg.transcode.upstreamCacheMb = 8;

  const session = await createUpstreamProxy({
    streamId: 'test-file',
    url: `http://127.0.0.1:${cdn.port}/movie.mp4`,
    headers: { Cookie: 'Edge-Cache-Cookie=urlprefix=x', Referer: 'https://moviebox.example/' },
    kind: 'file',
    baseOverride: proxy.base,
  });

  try {
    // The header the CDN demands must arrive on every ranged request.
    let missingHeaders = 0;
    const origListeners = cdn.server.listeners('request');
    cdn.server.removeAllListeners('request');
    cdn.server.on('request', (req, res) => {
      if (!req.headers.cookie || !req.headers.referer) missingHeaders += 1;
      origListeners[0](req, res);
    });

    const res = await get(session.inputUrl);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, source.length, 'every byte of the movie arrived');
    assert.ok(res.body.equals(source), 'bytes are identical to the source');
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.ok(cdn.stats.requests >= 10, `expected many small ranged requests, saw ${cdn.stats.requests}`);
    assert.equal(missingHeaders, 0, 'the signed headers were replayed on every request');
    assert.ok(session.stats.truncations >= 5, `expected the proxy to notice the cuts (${session.stats.truncations})`);

    // A second client reading a middle range is served from cache / re-fetch.
    const mid = await get(session.inputUrl, { headers: { Range: 'bytes=1048576-2097151' } });
    assert.equal(mid.status, 206);
    assert.equal(mid.headers['content-range'], `bytes 1048576-2097151/${source.length}`);
    assert.ok(mid.body.equals(source.subarray(1048576, 2097152)));
    const stats = proxyStats(session);
    assert.equal(stats.mode, 'file');
    assert.equal(stats.total, source.length);
  } finally {
    closeUpstreamProxy(session, 'test done');
    cdn.server.close();
    proxy.server.close();
  }
});

test('file source: a range-less CDN (plain 200) still plays to the end', { timeout: 60000 }, async () => {
  const source = pseudoBytes(700 * 1024, 7);
  const cdn = await startTruncatingCdn(new Map([['/plain.mp4', { buf: source, type: 'video/mp4' }]]), { supportRange: false, countResponseSizes: true });
  const proxy = await startProxyApp();
  const cfg = getConfig();
  cfg.transcode.upstreamChunkBytes = 256 * 1024;

  const session = await createUpstreamProxy({
    streamId: 'test-plain',
    url: `http://127.0.0.1:${cdn.port}/plain.mp4`,
    headers: {},
    kind: 'file',
    baseOverride: proxy.base,
  });
  try {
    const res = await get(session.inputUrl);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, source.length);
    assert.ok(res.body.equals(source));
  } finally {
    closeUpstreamProxy(session, 'test done');
    cdn.server.close();
    proxy.server.close();
  }
});

const TEST_MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT1H30M">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="0" bandwidth="2000000" width="1920" height="1080">
        <SegmentTemplate initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1" duration="4000" timescale="1000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

test('dash source: the rewritten MPD plus chunked segment fetches deliver every byte', { timeout: 60000 }, async () => {
  const init = pseudoBytes(120 * 1024, 1);
  const seg1 = pseudoBytes(400 * 1024, 2);
  const seg2 = pseudoBytes(400 * 1024, 3);
  const files = new Map([
    ['/dash/movie/index.mpd', { buf: Buffer.from(TEST_MPD), type: 'application/dash+xml' }],
    ['/dash/movie/init-stream0.m4s', { buf: init, type: 'video/mp4' }],
    ['/dash/movie/chunk-stream0-00001.m4s', { buf: seg1, type: 'video/mp4' }],
    ['/dash/movie/chunk-stream0-00002.m4s', { buf: seg2, type: 'video/mp4' }],
  ]);
  // Cut every connection at 64 KB — smaller than one 95 KB sub-request would
  // fetch, so the segment assembly must resume repeatedly.
  const cdn = await startTruncatingCdn(files, { cutAfterBytes: 64 * 1024 });
  const proxy = await startProxyApp();
  const cfg = getConfig();
  cfg.transcode.upstreamSegmentChunkBytes = 95 * 1024;
  cfg.transcode.upstreamParallel = 4;
  cfg.transcode.upstreamCacheMb = 8;

  const session = await createUpstreamProxy({
    streamId: 'test-dash',
    url: `http://127.0.0.1:${cdn.port}/dash/movie/index.mpd`,
    headers: { Cookie: 'CloudFront-Policy=abc; CloudFront-Signature=def' },
    kind: 'dash',
    baseOverride: proxy.base,
  });

  try {
    const mpdRes = await get(session.inputUrl);
    assert.equal(mpdRes.status, 200);
    assert.match(mpdRes.headers['content-type'], /dash\+xml/);
    const rewritten = mpdRes.body.toString('utf8');
    assert.ok(!/https?:\/\/127\.0\.0\.1:\d+\/dash\/movie/.test(rewritten), 'no CDN URLs remain in the manifest');

    const initMatch = /initialization="([^"]+)"/.exec(rewritten);
    const mediaMatch = /media="([^"]+)"/.exec(rewritten);
    assert.ok(initMatch && mediaMatch, 'both template attributes were rewritten');
    assert.match(initMatch[1], /\/up\/[0-9a-f]+\/dash\/t\/r\d+\/init-stream\$RepresentationID\$\.m4s$/);

    // Expand the tokens the way ffmpeg would and fetch through the proxy.
    const dir = mediaMatch[1].slice(0, mediaMatch[1].lastIndexOf('/') + 1);
    const initUrl = initMatch[1].replace('$RepresentationID$', '0');
    const segUrl = (n) => `${dir}chunk-stream0-${String(n).padStart(5, '0')}.m4s`;

    const initRes = await get(initUrl);
    assert.equal(initRes.status, 200);
    assert.ok(initRes.body.equals(init), 'init segment reassembled byte-exactly');

    const r1 = await get(segUrl(1));
    const r2 = await get(segUrl(2));
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.ok(r1.body.equals(seg1), 'segment 1 reassembled byte-exactly');
    assert.ok(r2.body.equals(seg2), 'segment 2 reassembled byte-exactly');

    // The segment cache serves a Range request out of the assembled bytes.
    const ranged = await get(segUrl(1), { headers: { Range: 'bytes=100-199' } });
    assert.equal(ranged.status, 206);
    assert.ok(ranged.body.equals(seg1.subarray(100, 200)));
    assert.equal(ranged.headers['content-range'], `bytes 100-199/${seg1.length}`);

    assert.ok(cdn.stats.requests >= 10, `expected many small ranged requests, saw ${cdn.stats.requests}`);
    const stats = proxyStats(session);
    assert.equal(stats.mode, 'dash');
    assert.ok(stats.truncations >= 3);
  } finally {
    closeUpstreamProxy(session, 'test done');
    cdn.server.close();
    proxy.server.close();
  }
});

test('unknown proxy secrets and wrong routes are refused', async () => {
  const proxy = await startProxyApp();
  try {
    const res = await get(`${proxy.base}/up/deadbeef/f`);
    assert.equal(res.status, 404);
  } finally {
    proxy.server.close();
  }
});
