/**
 * Pause and resume on the relay, with real HTTP connections and a real pipe.
 *
 * A player that stops reading must not cost the movie its place, and a player
 * that comes back must find it there. The stub "ffmpeg" writes one 16-byte line
 * per second of film, numbered, so every test can check each byte a player
 * receives: a gap or a repeat fails it. The stub counts from the input seek
 * (-ss) and reports progress from there, as ffmpeg does. Only the source is fake:
 * the sockets, the backpressure that holds the source, and the resume position
 * are the real thing.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const MB = 1024 * 1024;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-pause-resume-'));
const argvLog = path.join(tempDir, 'ffmpeg-argv.log');
process.env.CONFIG_FILE = path.join(tempDir, 'vumovie.json');
process.env.TMP_DIR = path.join(tempDir, 'tmp');
process.env.LOG_LEVEL = 'error';
// A developer's shell must not change what each test sets for itself.
for (const name of ['PAUSE_KEEP_SECONDS', 'RESUME_HOURS', 'CLIENT_STALL_SECONDS', 'STREAM_IDLE_SECONDS', 'MAX_CLIENT_BACKLOG']) {
  delete process.env[name];
}

// 2,000,000 seconds is 32 MB of output: more than the socket buffers can hold,
// so a player that stops reading really does hold the source.
const stub = path.join(tempDir, 'ffmpeg-stub.sh');
fs.writeFileSync(stub, [
  '#!/bin/sh',
  `printf '%s\\n' "$*" >> '${argvLog}'`,
  'if [ "$1" = "-version" ]; then echo "ffmpeg version 7.0-test"; exit 0; fi',
  'START=0; PREV=""',
  'for A in "$@"; do if [ "$PREV" = "-ss" ]; then START="${A%.*}"; fi; PREV="$A"; done',
  // Progress every 10 s and at the end: the play head is what the tests read.
  'awk -v s="$START" -v e="${STUB_SECONDS:-2000000}" \'BEGIN { for (i = s + 1; i <= e; i++) { printf "%015d\\n", i; if (i % 10 == 0 || i == e) printf "out_time_ms=%.0f\\n", (i - s) * 1000000 > "/dev/stderr" } }\'',
  // Still "running" once the film is written, like a live encoder with nothing
  // left to do: the session ends by the relay's rules, not by ffmpeg exiting.
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

/**
 * True when `bytes` is one unbroken run of the film, from wherever it starts:
 * a player that joins a running session gets the film from that point on.
 */
function isUnbrokenRunOfTheFilm(bytes) {
  if (bytes.length < 32) return false;
  const film = linesFrom(1, 2000000); // the stub's default length
  const at = film.indexOf(bytes.subarray(0, 32));
  return at >= 0 && film.subarray(at, at + bytes.length).equals(bytes);
}

/** Poll with setImmediate so it also works while the clock is mocked. */
async function until(check, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Wait until value() has not changed for `quietMs`. */
async function untilStableFor(value, quietMs, what, timeoutMs = 15000) {
  let last = value();
  let since = Date.now();
  const deadline = since + timeoutMs;
  while (Date.now() - since < quietMs) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
    const now = value();
    if (now !== last) { last = now; since = Date.now(); }
  }
}

/** Real time, for the tests that do not mock timers. */
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A player: an HTTP GET whose body is collected as it arrives. */
function openPlayer(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/stream.ts', agent: false }, (res) => {
      const parts = [];
      const player = {
        req,
        res,
        ended: false,
        closed: false,
        get length() { return parts.reduce((n, part) => n + part.length, 0); },
        bytes: () => Buffer.concat(parts),
      };
      res.on('data', (chunk) => parts.push(chunk));
      res.on('end', () => { player.ended = true; });
      res.on('close', () => { player.closed = true; });
      res.on('error', () => {});
      resolve(player);
    });
    req.on('error', reject);
  });
}

let serveStreamId = null;
const server = http.createServer((req, res) => {
  const session = relay.getSession(serveStreamId);
  if (!session) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'video/mp2t' });
  relay.attachClient(session, req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
after(() => {
  server.closeAllConnections?.();
  server.close();
  relay.stopAll('test run finished');
});

const probe = {
  container: 'mpegts',
  video: { codec: 'h264', width: 1280, height: 720, fps: 25 },
  audio: [{ codec: 'aac', channels: 2 }],
  subtitles: [],
};

async function makeStream(title, { durationSec = null } = {}) {
  return store.createStream({
    title,
    profile: { mode: 'copy' },
    candidate: {
      url: 'https://cdn.example/live.m3u8',
      kind: 'hls',
      headers: {},
      probe: durationSec ? { ...probe, durationSec } : probe,
    },
  });
}

/** Every ffmpeg command line the stub has been started with, oldest first. */
function argvLines() {
  return fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').trim().split('\n') : [];
}

/** Start a session and wait until its ffmpeg has actually been launched. */
async function startSession(stream) {
  const before = argvLines().length;
  const session = await relay.ensureSession(stream, { container: 'mpegts' });
  await until(() => argvLines().length > before, 'the stub to be launched');
  return session;
}

function lastArgv() {
  return argvLines().pop();
}

function resetStub() {
  delete process.env.STUB_SECONDS;
}

/* ------------------------------------------------------------------ the hold */

test('no player attached: the movie waits in the pipe and ffmpeg stays alive', async () => {
  const stream = await makeStream('Nobody watching');
  const session = await relay.ensureSession(stream, { container: 'mpegts' });
  try {
    await until(() => session.held, 'the source to be held');
    const sent = session.bytesOut;
    await settle(300);
    assert.equal(session.bytesOut, sent, 'nothing more of the film is read while nobody is attached');
    assert.equal(session.child.exitCode, null, 'ffmpeg is alive, waiting for its player');
    assert.equal(relay.publicSession(session).held, true);
  } finally {
    relay.stopSession(stream.id, 'test done');
  }
});

test('a player that stops reading holds the film instead of being dropped, and continues from the same place', async () => {
  const stream = await makeStream('Paused player');
  serveStreamId = stream.id;
  const session = await relay.ensureSession(stream, { container: 'mpegts' });
  try {
    const player = await openPlayer(port);
    player.res.pause(); // a VLC that is paused: the connection stays open
    await until(() => session.held && session.clients.size === 1, 'the source to be held for the paused player');
    // The socket buffers take what they can. A drain can let a little more
    // through while the TCP window opens, so wait until the amount is steady.
    await untilStableFor(() => session.bytesOut, 400, 'the source to stop once the buffers are full');

    assert.equal(session.clients.size, 1, 'the paused player is still attached');
    const sent = session.bytesOut;
    assert.ok(sent > 1 * MB, `the socket buffers took a lot before the hold (${sent} bytes)`);
    await settle(400);
    assert.equal(session.bytesOut, sent, 'the source is not read while the player is paused');

    player.res.resume();
    await until(() => player.length >= 12 * MB, 'the player to receive 12 MB after the pause');
    player.req.destroy();
    await until(() => player.closed, 'the player to close');
    assert.ok(isTheFilmFromStart(player.bytes()), 'every byte is the next byte of the film: no gap, no repeat');
  } finally {
    relay.stopSession(stream.id, 'test done');
  }
});

test('a stuck player does not hold back another player on the same session', async () => {
  const stream = await makeStream('Two players');
  serveStreamId = stream.id;
  const session = await relay.ensureSession(stream, { container: 'mpegts' });
  try {
    const stuck = await openPlayer(port);
    stuck.res.pause();
    const reader = await openPlayer(port);
    await until(() => reader.length >= 12 * MB, 'the reading player to get 12 MB while the other is stuck');
    assert.equal(session.held, false, 'the source kept flowing for the reader');
    assert.equal(session.clients.size, 2, 'the stuck player was not dropped for being slow');

    reader.req.destroy();
    stuck.req.destroy();
    await until(() => session.clients.size === 0, 'both players to leave');
    assert.ok(isUnbrokenRunOfTheFilm(reader.bytes()), 'the reader got the film from where it joined, with no gap');
  } finally {
    relay.stopSession(stream.id, 'test done');
  }
});

test('a player that never reads again is dropped after the stall window, and its response ends after the data it has', async (t) => {
  config.saveConfig({ transcode: { clientStallSeconds: 5 } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  const stream = await makeStream('Stalled player');
  serveStreamId = stream.id;
  const session = await relay.ensureSession(stream, { container: 'mpegts' });
  try {
    const player = await openPlayer(port);
    player.res.pause();
    await until(() => session.held && session.clients.size === 1, 'the source to be held for the stalled player');

    t.mock.timers.tick(5000);
    assert.equal(session.clients.size, 0, 'the stalled player was dropped');
    assert.equal(player.ended, false, 'its response has not ended yet: the data it already has is still queued');

    player.res.resume();
    await until(() => player.ended, 'the dropped player to read its last data and see the end');
    assert.ok(isTheFilmFromStart(player.bytes()), 'the data it got before the drop is the film, with no gap');
    assert.ok(player.length > 1 * MB);
  } finally {
    config.saveConfig({ transcode: { clientStallSeconds: 1800 } });
    relay.stopSession(stream.id, 'test done');
  }
});

test('a player that leaves while the film is held does not end the session: it is kept for the pause window', async () => {
  const stream = await makeStream('Player left while paused');
  serveStreamId = stream.id;
  const session = await relay.ensureSession(stream, { container: 'mpegts' });
  try {
    const player = await openPlayer(port);
    player.res.pause();
    await until(() => session.held, 'the source to be held');
    player.req.destroy();
    await until(() => session.clients.size === 0, 'the player to leave');
    assert.equal(relay.getSession(stream.id), session, 'the session is kept for the pause window');
    assert.equal(session.held, true, 'and the film stays where it was');
  } finally {
    relay.stopSession(stream.id, 'test done');
  }
});

test('ffmpeg exits promptly when a held session is stopped, instead of waiting for SIGKILL', async () => {
  const stream = await makeStream('Stopped while held');
  const session = await relay.ensureSession(stream, { container: 'mpegts' });
  await until(() => session.held, 'the source to be held');
  const child = session.child;
  const started = Date.now();
  relay.stopSession(stream.id, 'test done');
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('close', resolve);
  });
  assert.ok(Date.now() - started < 3000, `ffmpeg exited in ${Date.now() - started} ms, before the 5 s SIGKILL`);
});

test('the source flows only while some attached player is reading', () => {
  assert.equal(relay.sourceFlowsFor({ clients: new Set() }), false, 'nobody attached');
  assert.equal(relay.sourceFlowsFor({ clients: new Set([{ blocked: false }]) }), true);
  assert.equal(relay.sourceFlowsFor({ clients: new Set([{ blocked: true }]) }), false, 'the only player is stuck');
  assert.equal(relay.sourceFlowsFor({ clients: new Set([{ blocked: true }, { blocked: false }]) }), true, 'another player is reading');
});

/* ------------------------------------------------------- the play head memory */

test('an idle stop keeps the play head, and the next play of the stream resumes two seconds before it', async (t) => {
  config.saveConfig({ transcode: { idleStopSeconds: 5, pauseKeepSeconds: 20, resumeHours: 12 } });
  process.env.STUB_SECONDS = '50';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  const stream = await makeStream('Resumes at its play head');
  serveStreamId = stream.id;
  const session = await relay.ensureSession(stream, { container: 'mpegts' });
  try {
    const player = await openPlayer(port);
    await until(() => relay.playheadSeconds(session) >= 50 && player.length >= 800, 'the stub to write 50 seconds');
    player.req.destroy();
    await until(() => session.clients.size === 0, 'the player to leave');

    t.mock.timers.tick(19999);
    assert.equal(relay.getSession(stream.id), session, 'kept while the pause window runs');
    t.mock.timers.tick(1);
    assert.equal(relay.getSession(stream.id), null, 'stopped when the window ends');

    const next = await startSession(stream);
    assert.equal(next.resumeSeconds, 48, 'the play head (50 s) minus the 2 s rewind');
    assert.match(lastArgv(), /-ss 48 /, 'ffmpeg was started with an input seek to 48 s');
    const again = await openPlayer(port);
    await until(() => again.length >= 32, 'the resumed film to arrive');
    again.req.destroy();
    assert.equal(again.bytes().subarray(0, 32).toString('latin1'), '000000000000049\n000000000000050\n',
      'the first bytes are the seconds after the play head');
  } finally {
    resetStub();
    relay.stopSession(stream.id, 'test done');
  }
});

test('a deliberate stop keeps no play head: the next play starts from the beginning', async () => {
  config.saveConfig({ transcode: { resumeHours: 12 } });
  process.env.STUB_SECONDS = '50';
  const stream = await makeStream('Deliberate stop');
  try {
    const session = await relay.ensureSession(stream, { container: 'mpegts' });
    await until(() => relay.playheadSeconds(session) >= 50, 'the stub to write 50 seconds');
    relay.stopSession(stream.id, 'user request');
    const next = await startSession(stream);
    assert.equal(next.resumeSeconds, 0);
    assert.doesNotMatch(lastArgv(), /-ss /, 'no input seek');
  } finally {
    resetStub();
    relay.stopSession(stream.id, 'test done');
  }
});

test('a movie played to its known end keeps no play head', async () => {
  process.env.STUB_SECONDS = '40';
  const stream = await makeStream('Short film', { durationSec: 40 });
  try {
    const session = await relay.ensureSession(stream, { container: 'mpegts' });
    await until(() => relay.playheadSeconds(session) >= 40, 'the stub to write the whole film');
    assert.equal(relay.rememberResumePoint(session), 0, 'a finished film is not remembered');
    assert.equal(relay.takeResumePoint(stream.id), 0);
  } finally {
    resetStub();
    relay.stopSession(stream.id, 'test done');
  }
});

test('the kept play head expires after resumeHours, is consumed by a play, and resumeHours 0 turns it off', async () => {
  config.saveConfig({ transcode: { resumeHours: 12 } });
  process.env.STUB_SECONDS = '50';
  const stream = await makeStream('Expiry');
  try {
    const session = await relay.ensureSession(stream, { container: 'mpegts' });
    await until(() => relay.playheadSeconds(session) >= 50, 'the stub to write 50 seconds');
    const now = Date.now();

    assert.equal(relay.rememberResumePoint(session, { now }), 48);
    assert.equal(relay.takeResumePoint(stream.id, { now: now + 13 * 3600e3 }), 0, 'older than resumeHours is ignored');

    assert.equal(relay.rememberResumePoint(session, { now }), 48);
    assert.equal(relay.takeResumePoint(stream.id, { now: now + 3600e3 }), 48, 'within the window it is used');
    assert.equal(relay.takeResumePoint(stream.id, { now }), 0, 'and a play consumes it');

    config.saveConfig({ transcode: { resumeHours: 0 } });
    assert.equal(relay.rememberResumePoint(session, { now }), 0, 'resumeHours 0 keeps nothing');
    assert.equal(relay.takeResumePoint(stream.id, { now }), 0);
  } finally {
    resetStub();
    config.saveConfig({ transcode: { resumeHours: 12 } });
    relay.stopSession(stream.id, 'test done');
  }
});

test('an HLS session keeps no play head (its playlist would restart at zero)', async () => {
  const stream = await makeStream('HLS has no memory');
  const session = await relay.ensureSession(stream, { container: 'hls' });
  try {
    assert.equal(session.kind, 'hls');
    assert.equal(relay.rememberResumePoint(session), 0);
    assert.equal(session.resumeSeconds, 0);
  } finally {
    relay.stopSession(stream.id, 'test done');
  }
});

test('a session pins its upstream proxy while it lives, so the proxy sweep cannot close a paused session', async () => {
  const stream = await store.createStream({
    title: 'Pinned proxy',
    profile: { mode: 'copy' },
    candidate: { url: 'https://cdn.example/movie.mkv', kind: 'file', headers: {}, probe },
  });
  const session = await relay.ensureSession(stream, { container: 'mpegts' });
  try {
    assert.ok(session.upProxy, 'a file source gets an upstream proxy');
    assert.equal(session.upProxy.pinned, true);
  } finally {
    relay.stopSession(stream.id, 'test done');
  }
});
