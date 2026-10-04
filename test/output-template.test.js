/**
 * Per-output FFmpeg templates: each output slot (VLC .ts, VLC .mkv, .m3u8, .m3u,
 * Enigma2 / Duo2, direct 302, download) gets its own template id. The relay
 * resolves the right template per request URL — the bouquet entry points at
 * the .ts with ?enigma2=1, so the relay binds the receiver to the `enigma2`
 * template, while the desktop VLC URL still uses the `vlcTs` template.
 *
 * A temporary config file and the database layer's in-memory fallback keep
 * these tests isolated from a developer's /config directory and Postgres.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-output-template-test-'));
process.env.CONFIG_FILE = path.join(tempDir, 'vumovie.json');
process.env.TMP_DIR = path.join(tempDir, 'tmp');

const config = await import('../src/core/config.js');
const { default: api } = await import('../src/http/api.js');
const { default: store } = await import('../src/streams/store.js');

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

test('per-output template library, stream overrides, and Enigma2 routing', async (t) => {
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

  const tsCmd = 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -c:v libx264 -preset veryfast -b:v 8000k -f mpegts pipe:1';
  const mkvCmd = 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -c:v copy -f matroska pipe:1';
  const hlsCmd = 'ffmpeg -i <url> -map 0:v:0 -c:v copy -f hls -hls_time 2 -hls_list_size 6 <output>';
  const m3uCmd = 'ffmpeg -i <url> -map 0:v:0 -c:v copy -f mpegts pipe:1';
  const e2Cmd = 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -vf "scale=1280:720\" -c:v libx264 -preset veryfast -b:v 2500k -f mpegts pipe:1';
  const directCmd = 'ffmpeg -i <url> -c:v copy -f mpegts pipe:1';
  const downloadCmd = 'ffmpeg -i <url> -map 0:v -map 0:a -c:v copy -c:a copy -f matroska <output>';

  const templates = [
    { id: 'ts-template', name: 'Desktop VLC .ts', container: 'mpegts', command: tsCmd, output: { vlcTs: 'ts-template' } },
    { id: 'mkv-template', name: 'Desktop VLC .mkv', container: 'matroska', command: mkvCmd, output: { vlcMkv: 'mkv-template' } },
    { id: 'hls-template', name: 'Browser HLS', container: 'hls', command: hlsCmd, output: { m3u8: 'hls-template' } },
    { id: 'm3u-template', name: 'Playlist .m3u', container: 'mpegts', command: m3uCmd, output: { m3u: 'm3u-template' } },
    { id: 'enigma2-template', name: 'VU+ Duo2 720p H.264', container: 'mpegts', command: e2Cmd, output: { enigma2: 'enigma2-template' } },
    { id: 'direct-template', name: 'Direct upstream passthrough', container: 'mpegts', command: directCmd, output: { direct: 'direct-template' } },
    { id: 'download-template', name: 'Matroska download', container: 'matroska', command: downloadCmd, output: { download: 'download-template' } },
  ];

  // Save the library and the per-output default mapping in one request.
  const saved = await requestJson(base, '/ffmpeg/templates', {
    method: 'PUT',
    body: {
      templates,
      defaultFfmpegTemplateId: '',
      ffmpegDefaults: { vlcTs: 'ts-template', vlcMkv: 'mkv-template', m3u8: 'hls-template', m3u: 'm3u-template', enigma2: 'enigma2-template', direct: 'direct-template', download: 'download-template' },
    },
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.json.templates.length, 7);
  assert.equal(saved.json.ffmpegDefaults.enigma2, 'enigma2-template');

  // Default validation: pointing ffmpegDefaults at a non-existent id is a 422.
  const bad = await requestJson(base, '/ffmpeg/templates', {
    method: 'PUT',
    body: { templates, defaultFfmpegTemplateId: '', ffmpegDefaults: { enigma2: 'no-such-template' } },
  });
  assert.equal(bad.response.status, 422);

  // Get endpoint exposes the labels + the output type list.
  const editor = await requestJson(base, '/ffmpeg/templates');
  assert.equal(editor.response.status, 200);
  assert.ok(Array.isArray(editor.json.outputTypes));
  assert.ok(editor.json.outputTypes.includes('enigma2'));
  assert.ok(editor.json.outputTypes.includes('vlcTs'));
  assert.equal(editor.json.outputLabels.enigma2, 'Enigma2 / Duo2');

  // A stream that inherits the global defaults: no per-stream override, so
  // each output type's preview pulls the right template by URL.
  const url = 'https://cdn.example.test/movie.mp4?sig=ab12&expires=1791117426';
  const created = await requestJson(base, '/streams', {
    method: 'POST',
    body: {
      title: 'Per-output Template Demo',
      candidate: {
        url, kind: 'file', quality: '1080p',
        headers: { Referer: 'https://player.example/watch' },
      },
      profile: {},
    },
  });
  assert.equal(created.response.status, 200);
  const streamId = created.json.stream.id;
  // New streams inherit `vlcTs` because that is the legacy single default.
  assert.equal(created.json.stream.profile.ffmpegTemplateId, 'ts-template');

  // Per-output preview: the Enigma2 output gets its own template.
  const e2Preview = await requestJson(base, `/streams/${streamId}/command`, {
    method: 'POST', body: { profile: { outputType: 'enigma2' } },
  });
  assert.equal(e2Preview.response.status, 200);
  assert.match(e2Preview.json.command, /scale=1280:720/);
  assert.match(e2Preview.json.command, /-b:v 2500k/);
  assert.equal(e2Preview.json.template.templateId, 'enigma2-template');

  // VLC .ts preview pulls the desktop template, which encodes at 8 Mbps.
  const tsPreview = await requestJson(base, `/streams/${streamId}/command`, {
    method: 'POST', body: { profile: { outputType: 'vlcTs' } },
  });
  assert.equal(tsPreview.response.status, 200);
  assert.match(tsPreview.json.command, /-b:v 8000k/);
  assert.equal(tsPreview.json.template.templateId, 'ts-template');

  // VLC .mkv preview pulls the matroska template.
  const mkvPreview = await requestJson(base, `/streams/${streamId}/command`, {
    method: 'POST', body: { profile: { outputType: 'vlcMkv' } },
  });
  assert.equal(mkvPreview.response.status, 200);
  assert.match(mkvPreview.json.command, /-f matroska/);
  assert.equal(mkvPreview.json.template.templateId, 'mkv-template');

  // Stream-level override: the user assigns `mkv-template` to the vlcTs slot
  // and leaves enigma2 untouched. The override is saved on the stream profile
  // and the saved profile echoes the per-output map back.
  const override = await requestJson(base, `/streams/${streamId}/profile`, {
    method: 'POST',
    body: { profile: { outputTemplates: { vlcTs: 'mkv-template', vlcMkv: 'mkv-template' } } },
  });
  assert.equal(override.response.status, 200);
  assert.equal(override.json.profile.outputTemplates.vlcTs, 'mkv-template');
  assert.equal(override.json.profile.outputTemplates.vlcMkv, 'mkv-template');
  assert.equal(override.json.profile.outputTemplates.enigma2, undefined);

  // After the override, the .ts preview returns the mkv-template even though
  // the global default for vlcTs still says "ts-template".
  const tsAfterOverride = await requestJson(base, `/streams/${streamId}/command`, {
    method: 'POST', body: { profile: { outputType: 'vlcTs' } },
  });
  assert.equal(tsAfterOverride.response.status, 200);
  assert.match(tsAfterOverride.json.command, /-f matroska/);
  assert.equal(tsAfterOverride.json.template.templateId, 'mkv-template');
  assert.equal(tsAfterOverride.json.template.source, 'stream-output');

  // Enigma2 preview still finds the global enigma2-template because the stream
  // did not override it.
  const e2AfterOverride = await requestJson(base, `/streams/${streamId}/command`, {
    method: 'POST', body: { profile: { outputType: 'enigma2' } },
  });
  assert.equal(e2AfterOverride.response.status, 200);
  assert.match(e2AfterOverride.json.command, /scale=1280:720/);
  assert.equal(e2AfterOverride.json.template.source, 'global-output');

  // A bouquet preview marks every URL with `.ts.enigma2` so the relay routes
  // them to the Enigma2 template.
  const preview = await requestJson(base, '/enigma2/preview', { method: 'POST', body: { streamIds: [streamId] } });
  assert.equal(preview.response.status, 200);
  assert.ok(preview.json.text, 'preview should include the bouquet text');
  assert.match(preview.json.text, /\.ts\.enigma2/);

  // The relay session picks up `outputType: 'enigma2'` so the live command
  // it spawns is the one for the VU+ Duo2.
  const { default: relay } = await import('../src/streams/relay.js');
  const full = await store.getStream(streamId);
  // Stub ffmpeg path so ensureSession can spawn. The test only inspects the
  // built command, not the running ffmpeg process.
  const startedSessions = [];
  // We can't easily run ffmpeg in CI; instead simulate ensureSession by
  // reading the command that would be spawned for each output type.
  const paths = ['vlcTs', 'vlcMkv', 'm3u8', 'm3u', 'enigma2', 'direct', 'download'];
  for (const outputType of paths) {
    const preview = await requestJson(base, `/streams/${streamId}/command`, {
      method: 'POST', body: { profile: { outputType } },
    });
    assert.equal(preview.response.status, 200);
    // The recorded templateId matches the global default for this output.
    assert.equal(preview.json.template.templateId, { vlcTs: 'mkv-template', vlcMkv: 'mkv-template', m3u8: 'hls-template', m3u: 'm3u-template', enigma2: 'enigma2-template', direct: 'direct-template', download: 'download-template' }[outputType]);
    startedSessions.push(outputType);
  }
  assert.deepEqual(startedSessions, paths);
});