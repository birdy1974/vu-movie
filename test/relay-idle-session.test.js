import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-relay-idle-'));
const ffmpegStub = path.join(directory, 'ffmpeg-stub.sh');
process.env.CONFIG_FILE = path.join(directory, 'vumovie.json');
process.env.TMP_DIR = path.join(directory, 'tmp');
process.env.FFMPEG_PATH = ffmpegStub;
process.env.FFPROBE_PATH = ffmpegStub;
process.env.LOG_LEVEL = 'error';
fs.writeFileSync(ffmpegStub, `#!/bin/sh
if [ "$1" = "-version" ]; then
  echo "ffmpeg version 7.0-test"
  exit 0
fi
exec sleep 60
`, { mode: 0o755 });

const config = await import('../src/core/config.js');
config.loadConfig();
config.saveConfig({ transcode: { hardware: false, idleStopSeconds: 5 } });
const store = await import('../src/streams/store.js');
const relay = await import('../src/streams/relay.js');

const probe = {
  container: 'mpegts',
  durationSec: 3600,
  video: { codec: 'h264', width: 1280, height: 720, fps: 25 },
  audio: [{ codec: 'aac', channels: 2 }],
  subtitles: [],
};

async function makeStream(title) {
  return store.createStream({
    title,
    profile: { mode: 'copy' },
    candidate: {
      url: 'https://cdn.example/live.m3u8',
      kind: 'hls',
      headers: {},
      probe,
    },
  });
}

function enableFakeTimers(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
}

async function waitForChildClose(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise((resolve) => child.once('close', resolve));
}

test('a session started without a streaming client is stopped after the idle window', async (t) => {
  enableFakeTimers(t);
  const stream = await makeStream('Unattached pipe session');
  const session = await relay.ensureSession(stream, { container: 'mpegts' });
  assert.equal(session.clients.size, 0);
  assert.equal(relay.getSession(stream.id), session);

  // The session API (and a HEAD/preflight request) can start FFmpeg without
  // attaching a long-lived /s response. It still needs the normal idle lease.
  t.mock.timers.tick(5000);
  assert.equal(relay.getSession(stream.id), null, 'orphan session was evicted');
  await waitForChildClose(session.child);
});

test('HLS playlist/segment polls renew the idle lease for a live HLS session', async (t) => {
  enableFakeTimers(t);
  const stream = await makeStream('Polled HLS session');
  const session = await relay.ensureSession(stream, { container: 'hls' });
  assert.equal(session.kind, 'hls');

  t.mock.timers.tick(4000);
  assert.equal(relay.touchSessionByToken(stream.token), true, 'the HLS request found and touched its session');
  t.mock.timers.tick(4000);
  assert.equal(relay.getSession(stream.id), session, 'the original timer was renewed by the HLS poll');

  t.mock.timers.tick(1000);
  assert.equal(relay.getSession(stream.id), null, 'the session is still stopped after a full idle interval');
  await waitForChildClose(session.child);
});
