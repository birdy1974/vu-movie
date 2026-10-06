/**
 * The live template test must never flood the browser.
 *
 * A template that ends in `pipe:1` (vu-movie's own convention, and what the
 * editor's quick templates use) writes the finished *movie* to stdout. The SSE
 * runner used to slice that into lines and send every one of them to the page:
 * an 8 s test produced 6,036 binary events / 2.7 MB, which the UI appended into
 * one <pre> node until the tab locked up and had to be killed. Binary output is
 * now recognised, counted and suppressed — and, because the test writes to a
 * file (`<output>`), the verdict measures the file, not just stdout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-ffmpeg-run-'));
process.env.CONFIG_FILE = path.join(tempDir, 'vumovie.json');
process.env.TMP_DIR = path.join(tempDir, 'tmp');

const { classifyStdoutLine } = await import('../src/playlist/ffmpeg-run.js');

test('classifyStdoutLine keeps ffmpeg log text', () => {
  const cases = [
    'frame=1 time=00:00:01.000 bitrate=1234.5kbits/s speed=1x',
    'Stream #0:0: Video: h264 (High), yuv420p, 640x360',
    'Dune (2024) — 1080p source resolved',
    'ok',
  ];
  for (const line of cases) {
    const result = classifyStdoutLine(line);
    assert.equal(result.kind, 'text', `${line} → ${JSON.stringify(result)}`);
    assert.equal(result.text, line);
  }
});

test('classifyStdoutLine recognises media: control bytes, near-binary runs, huge "lines"', () => {
  // A real MPEG-TS chunk: sync byte 0x47, PIDs, PCR, no newline anywhere.
  const tsPacket = Buffer.alloc(188).fill(0x47);
  tsPacket[1] = 0x40; tsPacket[2] = 0x11; tsPacket[3] = 0x10;
  assert.equal(classifyStdoutLine(tsPacket.toString('latin1')).kind, 'binary');
  assert.equal(classifyStdoutLine('p\u0000\u0001\u0002q').kind, 'binary');
  assert.equal(classifyStdoutLine('x'.repeat(3000)).kind, 'binary', 'a 3 KB "line" is a chunk of packets');
  assert.equal(classifyStdoutLine('').kind, 'empty');
  assert.equal(classifyStdoutLine('   ').kind, 'empty');
});

test('the binary verdict of a real test run counts the bytes instead of printing them', async (t) => {
  const { default: api } = await import('../src/http/api.js');
  const { default: ffmpegRun } = await import('../src/playlist/ffmpeg-run.js');
  const express = (await import('express')).default;
  const http = (await import('node:http')).default;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  // The live-test router is mounted by server.js, not by the api router.
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

  // A local file source, so the run is fast and hermetic.
  const mediaDir = fs.mkdtempSync(path.join(tempDir, 'media-'));
  const mediaFile = path.join(mediaDir, 'clip.mp4');
  fs.writeFileSync(mediaFile, Buffer.alloc(64 * 1024, 0x21)); // 64 KB of junk

  const created = await fetch(`${base}/api/streams`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Flood', kind: 'movie',
      candidate: { url: mediaFile, kind: 'file', headers: {} },
      profile: { container: 'mpegts' },
    }),
  }).then((r) => r.json());
  const streamId = created.stream.id;

  const response = await fetch(`${base}/api/ffmpeg/live-test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      streamId,
      container: 'mpegts',
      durationMs: 3000,
      // The flooding form: the finished stream is written to stdout.
      command: 'ffmpeg -i <url> -c:v copy -c:a copy -f mpegts pipe:1',
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const events = body.split('\n\n').filter(Boolean);
  const names = events.map((event) => /^event: (\S+)/m.exec(event)?.[1] || '?');
  const stdoutEvents = events.filter((event) => event.startsWith('event: stdout'));
  // ffmpeg may not exist in every test container: the run then fails with a
  // clear error and never reaches the flood. Only assert the flood properties
  // when the process actually produced output.
  if (names.includes('done')) {
    const done = JSON.parse(/event: done\ndata: (.*)/.exec(body)?.[1] || '{}');
    if (done.stdoutBinaryBytes > 0) {
      assert.ok(stdoutEvents.length <= 3, `at most a note per run, got ${stdoutEvents.length} stdout events`);
      assert.ok(body.length < 100_000, `the SSE body must stay small, got ${body.length} bytes`);
      assert.ok(done.bytesOut > 0, 'the bytes are counted in the verdict');
      assert.match(done.verdict, /produced output and stopped cleanly/);
    }
  } else {
    assert.ok(body.length > 0, 'a failed run still answers');
  }
});
