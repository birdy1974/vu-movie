/**
 * Playlist and Xtream clients zap like the Enigma2 box. A pause keeps the
 * connection open, so the film continues from the same point. Zapping to
 * another stream — closing the connection, or opening the next title before
 * that close arrives — stops the session, and zapping back starts at the
 * beginning. A plain `.ts` link (VLC, the browser) keeps the pause window.
 *
 * Real HTTP connections and a real pipe, as in receiver-channel-change.test.js;
 * only ffmpeg is a stub that writes one numbered 16-byte line per second of film.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-zap-'));
const argvLog = path.join(tempDir, 'ffmpeg-argv.log');
process.env.CONFIG_FILE = path.join(tempDir, 'vumovie.json');
process.env.TMP_DIR = path.join(tempDir, 'tmp');
process.env.LOG_LEVEL = 'error';
for (const name of ['PAUSE_KEEP_SECONDS', 'RESUME_HOURS', 'CLIENT_STALL_SECONDS', 'STREAM_IDLE_SECONDS', 'MAX_CLIENT_BACKLOG']) {
  delete process.env[name];
}

const stub = path.join(tempDir, 'ffmpeg-stub.sh');
fs.writeFileSync(stub, [
  '#!/bin/sh',
  `printf '%s\\n' "$*" >> '${argvLog}'`,
  'if [ "$1" = "-version" ]; then echo "ffmpeg version 7.0-test"; exit 0; fi',
  'START=0; PREV=""',
  'for A in "$@"; do if [ "$PREV" = "-ss" ]; then START="${A%.*}"; fi; PREV="$A"; done',
  'awk -v s="$START" -v e="${STUB_SECONDS:-2000000}" \'BEGIN { for (i = s + 1; i <= e; i++) { printf "%015d\\n", i; if (i % 10 == 0 || i == e) printf "out_time_ms=%.0f\\n", (i - s) * 1000000 > "/dev/stderr" } }\'',
  'exec sleep 3600',
  '',
].join('\n'), { mode: 0o755 });
process.env.FFMPEG_PATH = stub;
process.env.FFPROBE_PATH = stub;

const config = await import('../src/core/config.js');
config.loadConfig();
config.saveConfig({
  transcode: { hardware: false },
  scraper: { probeCandidates: false },
  playlist: { autoRepairEnabled: false },
  subtitles: { autoSearch: false },
  enigma2: { autoPush: false },
});
const store = await import('../src/streams/store.js');
const relay = await import('../src/streams/relay.js');
const playlist = await import('../src/playlist/index.js');
const { createApp } = await import('../src/http/server.js');
const { ensureStreamReady } = await import('../src/streams/recovery.js');

function linesFrom(first, count) {
  const out = Buffer.alloc(count * 16);
  for (let k = 0; k < count; k += 1) out.write(`${String(first + k).padStart(15, '0')}\n`, k * 16, 'latin1');
  return out;
}

function isTheFilmFromStart(bytes) {
  const expected = linesFrom(1, Math.ceil(bytes.length / 16));
  return bytes.equals(expected.subarray(0, bytes.length));
}

async function until(check, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function openPlayer(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, (res) => {
      const parts = [];
      const player = {
        req,
        res,
        status: res.statusCode,
        get length() { return parts.reduce((n, part) => n + part.length, 0); },
        bytes: () => Buffer.concat(parts),
      };
      res.on('data', (chunk) => parts.push(chunk));
      res.on('error', () => {});
      resolve(player);
    });
    req.on('error', reject);
  });
}

const probe = {
  container: 'mpegts',
  video: { codec: 'h264', width: 1280, height: 720, fps: 25 },
  audio: [{ codec: 'aac', channels: 2 }],
  subtitles: [],
};

async function makeStream(title) {
  const stream = await store.createStream({
    title,
    profile: { mode: 'copy' },
    candidate: { url: 'https://cdn.example/live.m3u8', kind: 'hls', headers: {}, probe },
  });
  await playlist.addItems([stream.id]);
  await ensureStreamReady(stream, { initialCheck: { state: 'working', ok: true, error: null } });
  return stream;
}

function zapPath(stream, kind) {
  const urls = store.urlsFor(stream, 'http://nas:8080');
  return new URL(store.zapPlaybackUrl(urls.ts, kind)).pathname;
}

function plainPath(stream) {
  return new URL(store.urlsFor(stream, 'http://nas:8080').ts).pathname;
}

const appServer = http.createServer(createApp());
await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
const port = appServer.address().port;
after(() => {
  appServer.closeAllConnections?.();
  appServer.close();
  relay.stopAll('zap tests finished');
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a zap URL keeps a media extension and the VLC template slot', () => {
  assert.equal(store.zapPlaybackUrl('http://nas/s/tok/Dune.ts', 'playlist'), 'http://nas/s/tok/Dune.playlist.ts');
  assert.equal(store.zapPlaybackUrl('http://nas/s/tok/Dune.mkv?x=1', 'xtream'), 'http://nas/s/tok/Dune.xtream.mkv?x=1');
  assert.equal(store.zapKindForPath('/s/tok/Dune.playlist.ts'), 'playlist');
  assert.equal(store.zapKindForPath('/s/tok/Dune.xtream.mkv'), 'xtream');
  assert.equal(store.zapKindForPath('/s/tok/Dune.ts'), '');
  assert.equal(store.outputTypeForPath('/s/tok/Dune.playlist.ts'), 'vlcTs');
  assert.equal(store.outputTypeForPath('/s/tok/Dune.xtream.mkv'), 'vlcMkv');
  assert.equal(store.outputTypeForPath('/s/tok/Dune.ts.enigma2'), 'enigma2');
});

test('the playlist publishes the zap link, and Xtream redirects to one', async () => {
  const stream = await makeStream('Catalogue Movie');
  const m3u = await fetch(`http://127.0.0.1:${port}/pl/${playlist.token()}/playlist.m3u`);
  const text = await m3u.text();
  assert.match(text, new RegExp(`/s/${stream.token}/Catalogue-Movie\\.playlist\\.ts`));
  assert.equal(text.includes(`/s/${stream.token}/Catalogue-Movie.ts`), false, 'the plain VLC link is not the playlist entry');

  const api = await fetch(`http://127.0.0.1:${port}/xtream/${playlist.token()}/player_api.php?username=vumovie&password=${playlist.token()}&action=get_vod_streams`);
  const vod = await api.json();
  const item = vod.find((row) => row.name.startsWith('Catalogue Movie'));
  const playback = await fetch(item.direct_source, { redirect: 'manual' });
  assert.equal(playback.status, 302);
  assert.equal(playback.headers.get('location'), `http://127.0.0.1:${port}/s/${stream.token}/Catalogue-Movie.xtream.ts`);
});

test('zapping away on the playlist stops the movie, and zapping back starts at the beginning', async () => {
  const stream = await makeStream('Playlist zap');
  const urlPath = zapPath(stream, 'playlist');
  try {
    const player = await openPlayer(port, urlPath);
    await until(() => player.length >= 16 * 50, 'the playlist client to receive the film');
    player.req.destroy();
    await until(() => relay.getSession(stream.id) === null, 'the movie to stop when the client zaps away');

    const again = await openPlayer(port, urlPath);
    await until(() => again.length >= 16, 'the film to arrive');
    assert.equal(relay.getSession(stream.id).resumeSeconds, 0, 'nothing was kept');
    assert.ok(isTheFilmFromStart(again.bytes()), 'zapping back starts at the first second');
    again.req.destroy();
  } finally {
    relay.stopSession(stream.id, 'test done');
  }
});

test('a paused playlist client continues from the same point', async () => {
  const stream = await makeStream('Playlist pause');
  const urlPath = zapPath(stream, 'playlist');
  const sessionPromise = until(() => relay.getSession(stream.id), 'the session');
  try {
    const player = await openPlayer(port, urlPath);
    await sessionPromise;
    const session = relay.getSession(stream.id);
    await until(() => player.length >= 16 * 50, 'the playlist client to receive the film');
    player.res.pause();
    await until(() => session.held, 'the film to be held');
    await settle(300);
    assert.equal(relay.getSession(stream.id), session, 'a pause keeps the movie');

    const before = player.length;
    player.res.resume();
    await until(() => player.length >= before + 16 * 50, 'the film to continue');
    assert.ok(isTheFilmFromStart(player.bytes()), 'nothing skipped: it carries on from the pause');
    assert.equal(session.resumeSeconds, 0, 'the film was not restarted');
    player.req.destroy();
  } finally {
    relay.stopSession(stream.id, 'test done');
  }
});

test('opening another playlist title stops the previous one even if its connection is still open', async () => {
  const first = await makeStream('Left behind');
  const next = await makeStream('Zapped to');
  const vlc = await makeStream('Still in VLC');
  try {
    const left = await openPlayer(port, zapPath(first, 'playlist'));
    const plain = await openPlayer(port, plainPath(vlc));
    await until(() => left.length >= 16 * 50 && plain.length >= 16 * 20, 'both players to receive the film');

    const moved = await openPlayer(port, zapPath(next, 'playlist'));
    await until(() => relay.getSession(first.id) === null, 'the movie that was zapped away to stop');
    await until(() => moved.length >= 16, 'the new title to start');
    assert.equal(relay.getSession(vlc.id) !== null && relay.getSession(vlc.id).alive, true, 'a plain VLC link is not a zap');

    const back = await openPlayer(port, zapPath(first, 'playlist'));
    await until(() => back.length >= 16, 'the film to arrive on zap back');
    assert.equal(relay.getSession(first.id).resumeSeconds, 0);
    assert.ok(isTheFilmFromStart(back.bytes()), 'zapping back starts at the beginning');
    left.req.destroy();
    plain.req.destroy();
    moved.req.destroy();
    back.req.destroy();
  } finally {
    relay.stopSession(first.id, 'test done');
    relay.stopSession(next.id, 'test done');
    relay.stopSession(vlc.id, 'test done');
  }
});

test('Xtream zapping stops the movie; a pause continues', async () => {
  const stream = await makeStream('Xtream zap');
  const urlPath = zapPath(stream, 'xtream');
  try {
    const player = await openPlayer(port, urlPath);
    await until(() => player.length >= 16 * 50, 'the xtream client to receive the film');
    player.res.pause();
    const session = relay.getSession(stream.id);
    await until(() => session.held, 'the film to be held for the pause');
    await settle(200);
    assert.equal(relay.getSession(stream.id), session, 'a pause keeps the connection, so the movie stays');
    player.req.destroy(); // zapped or stopped: the connection closes
    await until(() => relay.getSession(stream.id) === null, 'the movie to stop');

    const again = await openPlayer(port, urlPath);
    await until(() => again.length >= 16, 'the film to arrive');
    assert.equal(relay.getSession(stream.id).resumeSeconds, 0);
    assert.ok(isTheFilmFromStart(again.bytes()), 'the next play starts at the beginning');
    again.req.destroy();
  } finally {
    relay.stopSession(stream.id, 'test done');
  }
});

test('a plain .ts player is still kept for the pause window', async () => {
  const stream = await makeStream('Plain VLC');
  try {
    const player = await openPlayer(port, plainPath(stream));
    await until(() => player.length >= 16 * 50, 'the plain player to receive the film');
    const session = relay.getSession(stream.id);
    player.req.destroy();
    await until(() => session.clients.size === 0, 'the plain player to leave');
    await settle(200);
    assert.equal(relay.getSession(stream.id), session, 'a direct VLC link keeps the pause window');
  } finally {
    relay.stopSession(stream.id, 'test done');
  }
});
