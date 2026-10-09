/**
 * The direct link of a file that needs request headers: /s/<token>/direct.
 *
 * A 302 cannot carry the signed Cookie or Referer such a source needs, so the
 * relay used to refuse the direct link for these files. Now it serves the bytes
 * itself, through its upstream proxy, which replays the headers on every request
 * and answers Range requests. A player that seeks asks for "bytes=N-" and gets
 * the film from there. This file runs the real app against a fake CDN that
 * refuses requests without the signed headers, and checks what a player sees.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-direct-seek-'));
process.env.CONFIG_FILE = path.join(tempDir, 'vumovie.json');
process.env.TMP_DIR = path.join(tempDir, 'tmp');
process.env.LOG_LEVEL = 'error';
const stub = path.join(tempDir, 'ffmpeg-stub.sh');
fs.writeFileSync(stub, '#!/bin/sh\nif [ "$1" = "-version" ]; then echo "ffmpeg version 7.0-test"; fi\nexit 0\n', { mode: 0o755 });
process.env.FFMPEG_PATH = stub;
process.env.FFPROBE_PATH = stub;

const config = await import('../src/core/config.js');
config.loadConfig();
config.saveConfig({ transcode: { hardware: false, upstreamProxy: true } });
const store = await import('../src/streams/store.js');
const recovery = await import('../src/streams/recovery.js');
const upstream = await import('../src/streams/upstream.js');
const { createApp } = await import('../src/http/server.js');

const SIZE = 4 * 1024 * 1024;
/** A film whose byte at every offset is different, so a wrong offset shows. */
const FILM = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i += 1) FILM[i] = (i * 31 + (i >>> 13)) & 0xff;

const SIGNED_HEADERS = { Cookie: 'sig=abc', Referer: 'https://site.example/' };
const cdnLog = [];

/* -------------------------------------------------------------- fake CDN */

const cdn = http.createServer((req, res) => {
  const signed = (req.headers.cookie || '').includes('sig=abc') && req.headers.referer === 'https://site.example/';
  cdnLog.push({ method: req.method, url: req.url, range: req.headers.range || '', cookie: Boolean(req.headers.cookie) });
  if (req.url.startsWith('/auth/') && !signed) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden: the signed cookie and referer are required');
    return;
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', req.url.endsWith('.mpd') ? 'application/dash+xml' : 'video/mp4');
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (range && !req.url.endsWith('.mpd')) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), SIZE - 1) : SIZE - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${SIZE}`, 'Content-Length': end - start + 1 });
    res.end(req.method === 'HEAD' ? undefined : FILM.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { 'Content-Length': req.url.endsWith('.mpd') ? 7 : SIZE });
  if (req.method === 'HEAD') res.end();
  else res.end(req.url.endsWith('.mpd') ? '<MPD/>' : FILM);
});
await new Promise((resolve) => cdn.listen(0, '127.0.0.1', resolve));
const cdnBase = `http://127.0.0.1:${cdn.address().port}`;

const server = await new Promise((resolve) => {
  const instance = createApp().listen(0, '127.0.0.1', () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.closeAllConnections?.();
  server.close();
  cdn.closeAllConnections?.();
  cdn.close();
});

/* ------------------------------------------------------------- helpers */

const probe = {
  container: 'mp4',
  durationSec: 60,
  video: { codec: 'h264', width: 1280, height: 720, fps: 25 },
  audio: [{ codec: 'aac', channels: 2 }],
  subtitles: [],
};

async function makeStream(title, { pathname, kind = 'file', headers = {} }) {
  const stream = await store.createStream({
    title,
    candidate: { url: `${cdnBase}${pathname}`, kind, headers, probe },
  });
  // The route checks the source before it answers. A working check is cached,
  // so the test does not depend on a network probe.
  const ready = await recovery.ensureStreamReady(stream, {
    initialCheck: { state: 'working', ok: true, error: null, sourceId: '' },
  });
  assert.equal(ready.ok, true, 'the test stream is primed as working');
  return stream;
}

function request(method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, { method, headers, agent: false }, (res) => {
      const parts = [];
      res.on('data', (chunk) => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/* ------------------------------------------------------------- tests */

test('a header-protected file is served on the direct link, and a player can seek on it', async () => {
  const stream = await makeStream('Signed film', { pathname: '/auth/movie.mp4', headers: SIGNED_HEADERS });
  const direct = `/s/${stream.token}/direct`;

  const head = await request('HEAD', direct);
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], String(SIZE), 'the real length, so the player knows the film size');
  assert.equal(head.headers['accept-ranges'], 'bytes');

  // A player that seeks to 1 MB asks for that byte onwards.
  const seek = await request('GET', direct, { Range: 'bytes=1000000-1000099' });
  assert.equal(seek.status, 206);
  assert.equal(seek.headers['content-range'], `bytes 1000000-1000099/${SIZE}`);
  assert.ok(seek.body.equals(FILM.subarray(1000000, 1000100)), 'the 100 bytes are the film at that offset');

  const tail = await request('GET', direct, { Range: 'bytes=3000000-' });
  assert.equal(tail.status, 206);
  assert.ok(tail.body.equals(FILM.subarray(3000000)), 'from 3 MB to the end of the film');

  const whole = await request('GET', direct);
  assert.equal(whole.status, 200);
  assert.ok(whole.body.equals(FILM), 'the whole film, byte for byte');

  const fromRelay = cdnLog.filter((entry) => entry.url === '/auth/movie.mp4');
  assert.ok(fromRelay.length > 1, 'the relay fetched the film from the CDN');
  assert.ok(fromRelay.every((entry) => entry.cookie), 'the signed Cookie went with every CDN request, not just the first');
});

test('a file that needs no headers keeps its 302 redirect to the CDN', async () => {
  const stream = await makeStream('Open film', { pathname: '/open/movie.mp4' });
  const res = await request('GET', `/s/${stream.token}/direct`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `${cdnBase}/open/movie.mp4`);
});

test('a DASH manifest that needs headers is still refused on the direct link', async () => {
  const stream = await makeStream('Signed dash', { pathname: '/auth/movie.mpd', kind: 'dash', headers: SIGNED_HEADERS });
  const res = await request('GET', `/s/${stream.token}/direct`);
  assert.equal(res.status, 409);
  assert.match(JSON.parse(res.body.toString('utf8')).error, /request headers/);
});

test('the direct link is offered for header-protected files, with a note that the relay serves it', async () => {
  const file = await makeStream('Offered film', { pathname: '/auth/movie.mp4', headers: SIGNED_HEADERS });
  const urls = store.urlsFor(file, base);
  assert.equal(urls.direct, `${base}/s/${file.token}/direct`);
  assert.match(urls.directNote, /served through the relay/);
  assert.match(urls.directNote, /seek/);

  const dash = await makeStream('Offered dash', { pathname: '/auth/movie.mpd', kind: 'dash', headers: SIGNED_HEADERS });
  const dashUrls = store.urlsFor(dash, base);
  assert.equal(dashUrls.direct, null);
  assert.match(dashUrls.directNote, /signed cookie|request headers/);
});

test('the direct proxy is reused while the link is the same, and replaced when the signed link changes', async () => {
  const stream = await makeStream('Refreshed signature', { pathname: '/auth/movie.mp4', headers: SIGNED_HEADERS });
  let current = { id: stream.id, upstream: { url: stream.upstream.url, headers: SIGNED_HEADERS } };
  // Express, as in the app: the proxy answers with res.status(), an Express API.
  const miniApp = express();
  miniApp.get('/d', (req, res) => {
    upstream.serveDirectFile(current, req, res).catch((err) => res.destroy(err));
  });
  const relayServer = http.createServer(miniApp);
  await new Promise((resolve) => relayServer.listen(0, '127.0.0.1', resolve));
  const relayBase = `http://127.0.0.1:${relayServer.address().port}`;
  const fetchRange = (range) => new Promise((resolve, reject) => {
    http.get(`${relayBase}/d`, { headers: { Range: range }, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
  const directProxies = () => upstream.listUpstreamProxies().filter((entry) => entry.streamId === stream.id);

  try {
    assert.equal(await fetchRange('bytes=0-9'), 206);
    const first = directProxies();
    assert.equal(first.length, 1, 'one proxy serves the stream');

    assert.equal(await fetchRange('bytes=10-19'), 206);
    assert.deepEqual(directProxies().map((entry) => entry.id), first.map((entry) => entry.id), 'the same proxy serves the next request');

    // The stream's signature was refreshed: the next request must go to the new link.
    current = { id: stream.id, upstream: { url: `${stream.upstream.url}?sig=2`, headers: SIGNED_HEADERS } };
    assert.equal(await fetchRange('bytes=20-29'), 206);
    const renewed = directProxies();
    assert.equal(renewed.length, 1, 'the old proxy is gone, one proxy remains');
    assert.notEqual(renewed[0].id, first[0].id, 'a new proxy was made for the new link');
    assert.ok(cdnLog.some((entry) => entry.url === '/auth/movie.mp4?sig=2' && entry.cookie), 'the new link was fetched with the signed headers');
  } finally {
    relayServer.closeAllConnections?.();
    relayServer.close();
  }
});
