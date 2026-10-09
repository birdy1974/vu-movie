/**
 * "Stop all sessions" (the Mobile tab's button): POST /api/sessions/stop-all stops
 * every running relay session, web previews included, and says how many it
 * stopped. It is a deliberate stop, so no play head is kept, and every player
 * on those sessions is disconnected.
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
import express from 'express';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-stop-all-'));
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
config.saveConfig({ transcode: { hardware: false } });
const { default: api } = await import('../src/http/api.js');
const store = await import('../src/streams/store.js');
const relay = await import('../src/streams/relay.js');

/* ------------------------------------------------------------------ helpers */

/** Poll with setImmediate so it also works while timers are real. */
async function until(check, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
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

/** Start a session and wait until its ffmpeg has actually been launched. */
async function startSession(stream, extra = {}) {
  const before = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').trim().split('\n').length : 0;
  const session = await relay.ensureSession(stream, { container: 'mpegts', ...extra });
  await until(() => fs.existsSync(argvLog) && fs.readFileSync(argvLog, 'utf8').trim().split('\n').length > before, 'the stub to be launched');
  return session;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api', api);
// A player for the test: it watches the running session of a stream.
app.get('/play/:id', (req, res) => {
  const session = relay.getSession(req.params.id);
  if (!session) {
    res.status(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'video/mp2t' });
  relay.attachClient(session, req, res);
});
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.closeAllConnections?.();
  server.close();
  relay.stopAll('stop-all tests finished');
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function postStopAll() {
  const response = await fetch(`${base}/api/sessions/stop-all`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  return { status: response.status, json: await response.json() };
}

/** A player: an HTTP GET whose body is collected as it arrives. */
function openPlayer(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${urlPath}`, { agent: false }, (res) => {
      const parts = [];
      const player = {
        req,
        ended: false,
        get length() { return parts.reduce((n, part) => n + part.length, 0); },
      };
      res.on('data', (chunk) => parts.push(chunk));
      res.on('end', () => { player.ended = true; });
      res.on('error', () => {});
      resolve(player);
    });
    req.on('error', reject);
  });
}

/* -------------------------------------------------------------------- tests */

test('stop all stops every running session and says how many', async () => {
  const first = await makeStream('First film');
  const second = await makeStream('Second film');
  await startSession(first);
  await startSession(second);
  assert.equal(relay.listSessions().length, 2);

  const { status, json } = await postStopAll();
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, stopped: 2 });
  assert.equal(relay.listSessions().length, 0);
});

test('a web preview is a running session too: stop all stops it with the rest', async () => {
  const vlc = await makeStream('Watched in VLC');
  const preview = await makeStream('Previewed in the browser');
  await startSession(vlc);
  await relay.ensureSession(preview, {
    container: 'mpegts',
    outputType: 'web',
    web: { reported: true, videoCodecs: ['avc1'], audioCodecs: ['mp4a'] },
  });
  assert.equal(relay.listSessions().length, 2);

  const { json } = await postStopAll();
  assert.deepEqual(json, { ok: true, stopped: 2 });
  assert.equal(relay.listSessions().length, 0);
});

test('with nothing running, stop all stops 0 and still answers ok', async () => {
  assert.equal(relay.listSessions().length, 0);
  const { status, json } = await postStopAll();
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, stopped: 0 });
});

test('a session stopped this way disconnects its player and keeps no play head: the next play starts at the beginning', async () => {
  const stream = await makeStream('Watched film');
  await startSession(stream);
  const player = await openPlayer(`/play/${stream.id}`);
  // Enough film has run that a kept play head would be well past zero.
  await until(() => player.length >= 16 * 50, 'the film to reach the player');

  const { json } = await postStopAll();
  assert.deepEqual(json, { ok: true, stopped: 1 });
  await until(() => player.ended, 'the player to be disconnected');

  const next = await startSession(stream);
  assert.equal(next.resumeSeconds, 0, 'nothing was kept for the next play');
  relay.stopSession(stream.id, 'test done');
});
