/**
 * Template test endpoint: run a saved or inline FFmpeg template against a
 * real stream for a short window. The test exercises the validation and
 * argv-rendering paths even on machines without ffmpeg, and only the actual
 * ffmpeg spawn is skipped (the relay then returns an `error` rather than a
 * result, which we still treat as a successful round-trip).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-template-test-'));
process.env.CONFIG_FILE = path.join(tempDir, 'vumovie.json');
process.env.TMP_DIR = path.join(tempDir, 'tmp');

const config = await import('../src/core/config.js');
const { default: api } = await import('../src/http/api.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

async function requestJson(base, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, json: await response.json() };
}

test('template test endpoint: validates, renders, and runs a short FFmpeg window', async (t) => {
  config.saveConfig({
    subtitles: { autoSearch: false },
    enigma2: { autoPush: false },
    transcode: { ffmpegTemplates: [], defaultFfmpegTemplateId: '', ffmpegDefaults: {} },
  });

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', api);
  const server = http.createServer(app);
  const base = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const savedCmd = 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -c:v copy -f mpegts pipe:1';
  const templates = [
    { id: 'ts-template', name: 'Passthrough', container: 'mpegts', command: savedCmd, output: { vlcTs: 'ts-template' } },
  ];
  const library = await requestJson(base, '/ffmpeg/templates', {
    method: 'PUT', body: { templates, defaultFfmpegTemplateId: '', ffmpegDefaults: {} },
  });
  assert.equal(library.response.status, 200);

  // Create a stream so the test has an upstream URL to play with.
  const url = 'https://cdn.example.test/movie.mp4';
  const created = await requestJson(base, '/streams', {
    method: 'POST',
    body: {
      title: 'Test Stream',
      candidate: { url, kind: 'file', quality: '1080p', headers: { Referer: 'https://player.example/' } },
      profile: {},
    },
  });
  assert.equal(created.response.status, 200);
  const streamId = created.json.stream.id;

  // (1) The saved-template endpoint runs the saved template against the
  //     stream. Without ffmpeg in the test container this returns either
  //     ok:true with bytesOut > 0 (an FFmpeg run happened — fine in CI boxes
  //     with ffmpeg) or ok:false + an error string ("spawn ffmpeg ENOENT").
  //     Either way the HTTP round-trip, validation, and headers-injection
  //     paths are exercised.
  const savedRun = await requestJson(base, '/ffmpeg/templates/ts-template/test', {
    method: 'POST', body: { streamId, durationMs: 1500 },
  });
  assert.equal(savedRun.response.status, 200);
  assert.equal(savedRun.json.ok, true);
  assert.ok(savedRun.json.result);
  assert.equal(savedRun.json.result.templateId, 'ts-template');
  assert.equal(savedRun.json.result.outputType, '');
  // The command preview is rendered even when ffmpeg is missing.
  assert.match(savedRun.json.result.command, /-i\s+https:\/\/cdn\.example\.test\/movie\.mp4/);
  assert.match(savedRun.json.result.command, /Referer: https:\/\/player\.example\//);
  assert.match(savedRun.json.result.command, /-f\s+mpegts/);

  // (2) An invalid template id is rejected with 404 (no upstream round-trip).
  const missing = await requestJson(base, '/ffmpeg/templates/does-not-exist/test', {
    method: 'POST', body: { streamId },
  });
  assert.equal(missing.response.status, 404);

  // (3) Missing streamId and url is a 422 validation error.
  const noStream = await requestJson(base, '/ffmpeg/templates/ts-template/test', {
    method: 'POST', body: {},
  });
  assert.equal(noStream.response.status, 422);

  // (4) Inline templates: POST /api/ffmpeg/test with a raw command. The
  //     command must validate (use one <url> placeholder + -f mpegts).
  const inline = await requestJson(base, '/ffmpeg/test', {
    method: 'POST',
    body: {
      streamId, durationMs: 1500,
      command: 'ffmpeg -i <url> -map 0:v:0 -vf "scale=1280:720" -c:v libx264 -preset veryfast -b:v 2500k -f mpegts pipe:1',
      name: 'VU+ 720p smoke',
    },
  });
  assert.equal(inline.response.status, 200);
  assert.equal(inline.json.ok, true);
  assert.equal(inline.json.template.name, 'VU+ 720p smoke');
  assert.match(inline.json.result.command, /scale=1280:720/);
  assert.match(inline.json.result.command, /-b:v 2500k/);

  // (5) Inline templates with an invalid command are rejected BEFORE the run.
  const invalidInline = await requestJson(base, '/ffmpeg/test', {
    method: 'POST',
    body: { streamId, command: 'sh -c "echo oops"' },
  });
  assert.equal(invalidInline.response.status, 422);

  // (6) Ephemeral streams: pass `url` instead of `streamId`. We use a path
  //     that resolves to nothing so ffmpeg fails fast — the goal here is to
  //     confirm the relay renders the right command and never crashes when
  //     the stream record does not exist in storage.
  const ephemeral = await requestJson(base, '/ffmpeg/test', {
    method: 'POST',
    body: {
      url: 'http://127.0.0.1:1/does-not-exist.m3u8',
      durationMs: 1500,
      command: 'ffmpeg -i <url> -map 0:v:0 -c:v copy -f mpegts pipe:1',
    },
  });
  assert.equal(ephemeral.response.status, 200);
  // The URL passes the shell-arg allowlist `[A-Za-z0-9_@%+=:,./-]+`, so it is
  // rendered bare. The test still confirms the relay renders the right URL
  // (it could have been lost to the `<url>` substitution step).
  assert.ok(ephemeral.json.result.command.includes('http://127.0.0.1:1/does-not-exist.m3u8'));

  // (7) The result payload always carries the template + bytesOut fields the
  //     UI needs to render the verdict.
  assert.ok(typeof savedRun.json.result.bytesOut === 'number');
  assert.ok(typeof savedRun.json.result.durationMs === 'number');
  assert.ok(typeof savedRun.json.result.stderr === 'string');
  assert.ok(savedRun.json.result.progress && typeof savedRun.json.result.progress === 'object');
});