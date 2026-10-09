/**
 * The Enigma2 box is a receiver (its `.ts.enigma2` bouquet URL). A pause keeps
 * the box's connection open, so the film waits and continues from the same
 * point. A box that closes its connection has changed channel, stopped or gone
 * off: nothing is kept for it, and the next play starts at the beginning. Other
 * players keep the pause window and the resume memory (see pause-resume.test.js).
 *
 * Real HTTP connections and a real pipe, as in pause-resume.test.js; only ffmpeg
 * is a stub that writes one numbered 16-byte line per second of film.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-receiver-'));
const argvLog = path.join(tempDir, 'ffmpeg-argv.log');
process.env.CONFIG_FILE = path.join(tempDir, 'vumovie.json');
process.env.TMP_DIR = path.join(tempDir, 'tmp');
process.env.LOG_LEVEL = 'error';
// A developer's shell must not change what each test sets for itself.
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
config.saveConfig({ transcode: { hardware: false } });
const store = await import('../src/streams/store.js');
const relay = await import('../src/streams/relay.js');
const { createApp } = await import('../src/http/server.js');
const { ensureStreamReady } = await import('../src/streams/recovery.js');

/* ------------------------------------------------------------------ helpers */

/** The bytes the stub writes for seconds first … first+count-1. */
function linesFrom(first, count) {
  const out = Buffer.alloc(count * 16);
  for (let k = 0; k < count; k += 1) out.write(`${String(first + k).padStart(15, '0')}\n`, k * 16, 'latin1');
  return out;
}

/** True when `bytes` is exactly the start of the film: no gap, no repeat. */
function isTheFilmFromStart(bytes) {
  const expected = linesFrom(1, Math.ceil(bytes.length / 16));
  return bytes.equals(expected.subarray(0, bytes.length));
}

/** Poll with setImmediate so it also works while the clock is mocked. */
async function until(check, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Real time, for the tests that do not mock timers. */
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A player: an HTTP GET whose body is collected as it arrives. */
function openPlayer(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, (res) => {
      const parts = [];
      const player = {
        req,
        res,
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

/** Every ffmpeg command line the stub has been started with, oldest first. */
function argvLines() {
  return fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').trim().split('\n') : [];
}

function lastArgv() {
  return argvLines().pop();
}

/** Start a session and wait until its ffmpeg has actually been launched. */
async function startSession(stream) {
  const before = argvLines().length;
  const session = await relay.ensureSession(stream, { container: 'mpegts' });
  await until(() => argvLines().length > before, 'the stub to be launched');
  return session;
}

const probe = {
  container: 'mpegts',
  video: { codec: 'h264', width: 1280, height: 720, fps: 25 },
  audio: [{ codec: 'aac', channels: 2 }],
  subtitles: [],
};

async function makeStream(title) {
  return store.createStream({
    title,
    profile: { mode: 'copy' },
    candidate: { url: 'https://cdn.example/live.m3u8', kind: 'hls', headers: {}, probe },
  });
}

/** Relay-level server: /box.ts is the Enigma2 receiver, /stream.ts any other player. */
let serveStreamId = null;
const server = http.createServer((req, res) => {
  const session = relay.getSession(serveStreamId);
  if (!session) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'video/mp2t' });
  relay.attachClient(session, req, res, { receiver: req.url.startsWith('/box') });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
after(() => {
  server.closeAllConnections?.();
  server.close();
  relay.stopAll('receiver tests finished');
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ the receiver */

test('the box zapping away while the film flows: the movie stops at once, and the next play starts at the beginning', async () => {
  const stream = await makeStream('Zapped while flowing');
  serveStreamId = stream.id;
  await startSession(stream);
  try {
    const box = await openPlayer(port, '/box.ts');
    await until(() => box.length >= 16 * 50, 'the box to receive the film');
    box.req.destroy(); // zapped to another channel: its connection closes
    await until(() => relay.getSession(stream.id) === null, 'the movie to stop');

    const next = await startSession(stream);
    assert.equal(next.resumeSeconds, 0, 'nothing was kept');
    assert.doesNotMatch(lastArgv(), /-ss /, 'ffmpeg starts at the beginning');
    const again = await openPlayer(port, '/box.ts');
    await until(() => again.length >= 16, 'the film to arrive');
    assert.ok(isTheFilmFromStart(again.bytes()), 'the box gets the film from its first second');
    again.req.destroy();
  } finally {
    relay.stopSession(stream.id, 'test done');
  }
});

test('the box leaving while paused also ends the movie: only a pause that keeps the connection keeps the place', async () => {
  const stream = await makeStream('Left while paused');
  serveStreamId = stream.id;
  const session = await startSession(stream);
  try {
    const box = await openPlayer(port, '/box.ts');
    await until(() => box.length >= 16 * 50, 'the box to receive the film');
    box.res.pause();
    await until(() => session.held, 'the film to be held');
    box.req.destroy(); // the box went off or changed channel while paused
    await until(() => relay.getSession(stream.id) === null, 'the movie to stop');

    const next = await startSession(stream);
    assert.equal(next.resumeSeconds, 0, 'nothing was kept');
    const again = await openPlayer(port, '/box.ts');
    await until(() => again.length >= 16, 'the film to arrive');
    assert.ok(isTheFilmFromStart(again.bytes()), 'the film starts again from its first second');
    again.req.destroy();
  } finally {
    relay.stopSession(stream.id, 'test done');
  }
});

test('a paused box that keeps its connection continues from the same point when it resumes', async () => {
  const stream = await makeStream('Paused box');
  serveStreamId = stream.id;
  const session = await startSession(stream);
  try {
    const box = await openPlayer(port, '/box.ts');
    await until(() => box.length >= 16 * 50, 'the box to receive the film');
    box.res.pause();
    await until(() => session.held, 'the film to be held');
    await settle(400);
    assert.equal(relay.getSession(stream.id), session, 'the movie is kept while the box is paused');

    const before = box.length;
    box.res.resume();
    await until(() => box.length >= before + 16 * 50, 'the film to continue');
    assert.ok(isTheFilmFromStart(box.bytes()), 'nothing skipped or repeated: the film carries on from where it paused');
    assert.equal(session.resumeSeconds, 0, 'the film was not restarted');
    box.req.destroy();
  } finally {
    relay.stopSession(stream.id, 'test done');
  }
});

test('a paused box the relay drops for stalling keeps its place: the next play resumes there', async (t) => {
  config.saveConfig({ transcode: { clientStallSeconds: 5, pauseKeepSeconds: 5, resumeHours: 12 } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  const stream = await makeStream('Stalled box');
  serveStreamId = stream.id;
  const session = await startSession(stream);
  try {
    const box = await openPlayer(port, '/box.ts');
    await until(() => box.length >= 16 * 50, 'the box to receive the film');
    box.res.pause();
    await until(() => session.held, 'the film to be held');

    t.mock.timers.tick(5000); // the box has not read for 5 s: the relay drops it
    await until(() => session.clients.size === 0, 'the box to be dropped');
    assert.equal(relay.getSession(stream.id), session, 'kept for the pause window');

    t.mock.timers.tick(5000); // the window ends: the play head is kept
    assert.equal(relay.getSession(stream.id), null, 'stopped at the end of the window');
    const next = await startSession(stream);
    assert.ok(next.resumeSeconds > 0, 'the next play resumes at the kept play head');
  } finally {
    relay.stopSession(stream.id, 'test done');
    config.saveConfig({ transcode: { clientStallSeconds: 1800, pauseKeepSeconds: 900, resumeHours: 12 } });
  }
});

test('a box that leaves while another player still watches: once that player leaves too, the film is not kept for the box', async (t) => {
  config.saveConfig({ transcode: { pauseKeepSeconds: 5, resumeHours: 12 } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  const stream = await makeStream('Shared film');
  serveStreamId = stream.id;
  const session = await startSession(stream);
  try {
    const other = await openPlayer(port, '/stream.ts');
    const box = await openPlayer(port, '/box.ts');
    await until(() => box.length >= 16 * 50 && other.length >= 16 * 50, 'both players to receive the film');

    box.req.destroy(); // the box zapped away; the other player still watches
    await until(() => session.clients.size === 1, 'the box to leave');
    assert.equal(relay.getSession(stream.id), session, 'the film still runs for the other player');

    other.req.destroy(); // then the other player leaves too: the pause window runs
    await until(() => session.clients.size === 0, 'the other player to leave');
    t.mock.timers.tick(5000);
    assert.equal(relay.getSession(stream.id), null, 'stopped when the window ends');
    const next = await startSession(stream);
    assert.equal(next.resumeSeconds, 0, 'nothing was kept for the box');
  } finally {
    relay.stopSession(stream.id, 'test done');
    config.saveConfig({ transcode: { pauseKeepSeconds: 900, resumeHours: 12 } });
  }
});

/* -------------------------------------------- the real .ts.enigma2 route */

test('the .ts.enigma2 route is the receiver: the box leaving starts the movie over, a plain .ts player keeps its place', async (t) => {
  const app = createApp();
  const appServer = http.createServer(app);
  await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
  const appPort = appServer.address().port;
  t.after(() => {
    appServer.closeAllConnections?.();
    appServer.close();
  });

  const stream = await makeStream('Via the route');
  // The playback preflight would probe the upstream. A working check (what a
  // probe returns) is recorded for the route, so the test needs no network.
  await ensureStreamReady(stream, { initialCheck: { state: 'working', ok: true, error: null } });
  try {
    const box = await openPlayer(appPort, `/s/${stream.token}/Via-the-route.ts.enigma2`);
    const session = relay.getSession(stream.id);
    assert.ok(session, 'the box started the session through the route');
    await until(() => box.length >= 16 * 50, 'the box to receive the film');
    box.req.destroy(); // the box zapped away
    await until(() => relay.getSession(stream.id) === null, 'the movie to stop when the box leaves');

    const again = await openPlayer(appPort, `/s/${stream.token}/Via-the-route.ts.enigma2`);
    await until(() => again.length >= 16, 'the film to arrive');
    assert.ok(isTheFilmFromStart(again.bytes()), 'the box starts the film over');
    again.req.destroy();
    await until(() => relay.getSession(stream.id) === null, 'the movie to stop again');

    const plain = await openPlayer(appPort, `/s/${stream.token}/Via-the-route.ts`);
    await until(() => plain.length >= 16 * 50, 'the plain player to receive the film');
    const plainSession = relay.getSession(stream.id);
    plain.req.destroy();
    await until(() => plainSession.clients.size === 0, 'the plain player to leave');
    await settle(200);
    assert.equal(relay.getSession(stream.id), plainSession, 'a plain .ts player is kept for the pause window, as before');
  } finally {
    relay.stopSession(stream.id, 'test done');
  }
});
