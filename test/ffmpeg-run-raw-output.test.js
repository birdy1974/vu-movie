/**
 * The live test panel must show the *raw* ffmpeg output.
 *
 * Two properties of `POST /api/ffmpeg/live-test` are load-bearing for that pane
 * (the one under “Test the final command” on the Transcode tab):
 *
 *   1. every stderr line reaches the browser verbatim — no clipping, no
 *      summarising. Long lines are normal here: an error naming the source
 *      carries a signed CDN URL, and the old UI replaced anything over 500
 *      characters with a note about "binary output on pipe:1";
 *   2. the `-progress pipe:2` lines are normal log output, not noise to hide.
 *      With `-loglevel warning` (the default) they are the *only* thing a
 *      healthy run prints, so they are forwarded as `progress` events that
 *      carry the exact line in `raw` plus the stats accumulated across the
 *      key=value stream.
 *
 * A stub "ffmpeg" drives both, so the test does not need a real build.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-raw-output-'));
process.env.CONFIG_FILE = path.join(tempDir, 'vumovie.json');
process.env.TMP_DIR = path.join(tempDir, 'tmp');

/** A warning line whose length matches a signed CDN URL in an ffmpeg error. */
const LONG_WARNING = `[https @ 0x55] HTTP error 403 Forbidden — url=https://cdn.example/movie.mp4?expires=1893456000&token=${'a'.repeat(900)}`;

const stub = path.join(tempDir, 'bin', 'ffmpeg');
fs.mkdirSync(path.dirname(stub), { recursive: true });
fs.writeFileSync(stub, `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    -version) echo "ffmpeg version 6.1.1-stub"; exit 0 ;;
  esac
done
# Two -progress blocks, exactly how ffmpeg writes them (one key per line) …
printf 'frame=1\\nfps=25.0\\nbitrate=1200.0kbits/s\\nspeed=1.01x\\nprogress=continue\\n' >&2
# … a long real-looking warning (must reach the browser untouched) …
cat >&2 <<'WARN'
${LONG_WARNING}
WARN
printf 'frame=2\\nfps=25.0\\nbitrate=1300.0kbits/s\\nspeed=1.02x\\nprogress=end\\n' >&2
# … and bytes on the output path, so the run counts as produced output.
for last in "$@"; do :; done
printf 'stub-media' > "$last" 2>/dev/null || true
exit 0
`, { mode: 0o755 });
process.env.FFMPEG_PATH = stub;

const { default: api } = await import('../src/http/api.js');
const { default: ffmpegRun } = await import('../src/playlist/ffmpeg-run.js');
const express = (await import('express')).default;
const http = (await import('node:http')).default;

test('the live test streams every raw ffmpeg line, with the progress stats accumulated', async (t) => {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/ffmpeg', ffmpegRun);
  app.use('/api', api);
  const server = http.createServer(app);
  const base = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const created = await fetch(`${base}/api/streams`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Raw output', kind: 'movie',
      candidate: { url: path.join(tempDir, 'source.mp4'), kind: 'file', headers: {} },
      profile: { container: 'mpegts' },
    }),
  }).then((r) => r.json());

  const response = await fetch(`${base}/api/ffmpeg/live-test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      streamId: created.stream.id,
      container: 'mpegts',
      durationMs: 2000,
      command: 'ffmpeg -hide_banner -nostdin -loglevel warning -i <url> -c copy -f mpegts <output>',
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const events = body.split('\n\n').filter(Boolean).map((raw) => ({
    name: /^event: (\S+)/m.exec(raw)?.[1] || '?',
    data: JSON.parse(/^data: (.*)$/m.exec(raw)?.[1] || '{}'),
  }));

  const stderr = events.filter((event) => event.name === 'stderr').map((event) => event.data.line);
  const progress = events.filter((event) => event.name === 'progress');
  const done = events.find((event) => event.name === 'done')?.data || {};

  assert.ok(done, 'the run answered with a verdict');
  assert.deepEqual(
    progress.map((event) => event.data.raw),
    ['frame=1', 'fps=25.0', 'bitrate=1200.0kbits/s', 'speed=1.01x', 'progress=continue',
      'frame=2', 'fps=25.0', 'bitrate=1300.0kbits/s', 'speed=1.02x', 'progress=end'],
    'every -progress line is forwarded exactly as ffmpeg wrote it',
  );
  // The panel's readout needs the whole picture, not just the last key.
  assert.deepEqual(
    { frame: progress.at(-1).data.frame, fps: progress.at(-1).data.fps, speed: progress.at(-1).data.speed, progress: progress.at(-1).data.progress },
    { frame: 2, fps: 25, speed: '1.02x', progress: 'end' },
    'progress events accumulate across the key=value stream',
  );
  assert.ok(progress.filter((event) => event.data.frame !== undefined).length >= 2, 'each block updates frame');

  assert.equal(stderr.length, 1, 'the warning is forwarded on its own');
  assert.equal(stderr[0], LONG_WARNING, `the ${LONG_WARNING.length}-character stderr line arrives verbatim`);
  assert.ok(!body.includes('suppressed'), 'nothing on stderr is summarised on the way to the browser');
  assert.equal(done.ok, true);
  assert.ok(done.fileBytes > 0, 'the verdict measures the output file');
});
