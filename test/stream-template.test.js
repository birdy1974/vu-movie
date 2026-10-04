/**
 * FFmpeg-template persistence and API behavior without external services.
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

test('template library, default selection, stream profile persistence, and preview use the live template', async (t) => {
  config.saveConfig({
    subtitles: { autoSearch: false },
    enigma2: { autoPush: false },
    transcode: { ffmpegTemplates: [], defaultFfmpegTemplateId: '' },
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

  const baseTemplate = 'ffmpeg -i <url> -map 0:v:0 -c:v copy -c:a copy -f mpegts pipe:1';
  const tailoredTemplate = 'ffmpeg -headers "X-Template: private-value" -i <url> -map 0:v:0 -vf "scale=640:360" -c:v libx264 -f mpegts pipe:1';
  const templates = [
    { id: 'default-ts', name: 'Default transport stream', container: 'mpegts', command: baseTemplate },
    { id: 'tailored-ts', name: 'Tailored output', container: 'mpegts', command: tailoredTemplate },
  ];

  const saved = await requestJson(base, '/ffmpeg/templates', {
    method: 'PUT', body: { templates, defaultFfmpegTemplateId: 'default-ts' },
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.json.defaultFfmpegTemplateId, 'default-ts');
  // Templates are normalised server-side: empty `output` map and `description`
  // are added to every saved record so the editor can render uniformly.
  assert.deepEqual(saved.json.templates, templates.map((t) => ({ ...t, output: {}, description: '' })));

  const invalidLibrary = await requestJson(base, '/ffmpeg/templates', {
    method: 'PUT', body: {
      templates: [{ id: 'unsafe', name: 'Unsafe', container: 'mpegts', command: 'sh -c "echo bad"' }],
      defaultFfmpegTemplateId: '',
    },
  });
  assert.equal(invalidLibrary.response.status, 422);

  const url = 'https://cdn.example.test/movie.mp4?sig=ab12&expires=1791117426';
  const created = await requestJson(base, '/streams', {
    method: 'POST',
    body: {
      title: 'Template Persistence',
      candidate: {
        url, kind: 'file', quality: '1080p',
        headers: { Referer: 'https://player.example/watch', Cookie: 'session=secret' },
      },
      profile: {},
    },
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.json.stream.profile.ffmpegTemplateId, 'default-ts');
  assert.equal(created.json.stream.profile.ffmpegTemplate, baseTemplate);
  const streamId = created.json.stream.id;
  const streamToken = created.json.stream.token;

  const selected = await requestJson(base, `/streams/${streamId}/profile`, {
    method: 'POST',
    body: { profile: { ffmpegTemplate: '', ffmpegTemplateId: 'tailored-ts', ffmpegTemplateName: '' } },
  });
  assert.equal(selected.response.status, 200);
  assert.equal(selected.json.profile.ffmpegTemplateId, 'tailored-ts');
  assert.equal(selected.json.profile.ffmpegTemplate, tailoredTemplate);
  assert.equal(selected.json.profile.ffmpegTemplateName, 'Tailored output');

  const persisted = await requestJson(base, `/streams/${streamToken}`);
  assert.equal(persisted.response.status, 200);
  assert.equal(persisted.json.stream.id, streamId);
  assert.equal(persisted.json.stream.token, streamToken);
  assert.equal(persisted.json.stream.profile.ffmpegTemplateId, 'tailored-ts');
  assert.equal(persisted.json.stream.profile.ffmpegTemplate, tailoredTemplate);

  const preview = await requestJson(base, `/streams/${streamId}/command`);
  assert.equal(preview.response.status, 200);
  assert.match(preview.json.command, /scale=640:360/);
  assert.match(preview.json.command, /X-Template: private-value/);
  assert.match(preview.json.command, /Referer: https:\/\/player\.example\/watch/);
  assert.match(preview.json.command, /Cookie: session=secret/);
  assert.ok(preview.json.command.includes("'https://cdn.example.test/movie.mp4?sig=ab12&expires=1791117426'"));

  const customPreviewTemplate = 'ffmpeg -i <url> -map 0:v:0 -c:v copy -f mpegts pipe:1';
  const customPreview = await requestJson(base, `/streams/${streamId}/command`, {
    method: 'POST', body: { profile: { ffmpegTemplate: customPreviewTemplate, ffmpegTemplateId: '', container: 'mpegts' } },
  });
  assert.equal(customPreview.response.status, 200);
  assert.match(customPreview.json.command, /-c:v copy/);
  assert.doesNotMatch(customPreview.json.command, /scale=640:360/);
  const afterPreview = await requestJson(base, `/streams/${streamId}`);
  assert.equal(afterPreview.json.stream.profile.ffmpegTemplateId, 'tailored-ts', 'preview overrides do not mutate the saved profile');

  const invalidProfile = await requestJson(base, `/streams/${streamId}/profile`, {
    method: 'POST', body: { profile: { ffmpegTemplate: 'sh -c "echo bad"', ffmpegTemplateId: '' } },
  });
  assert.equal(invalidProfile.response.status, 422);
  const afterInvalidSave = await requestJson(base, `/streams/${streamId}`);
  assert.equal(afterInvalidSave.json.stream.profile.ffmpegTemplateId, 'tailored-ts');

  const publicSettings = await requestJson(base, '/config');
  assert.equal(publicSettings.response.status, 200);
  assert.equal(publicSettings.json.config.transcode.ffmpegTemplates, undefined);
  assert.ok(!JSON.stringify(publicSettings.json).includes('private-value'));
  const editorLibrary = await requestJson(base, '/ffmpeg/templates');
  assert.ok(JSON.stringify(editorLibrary.json).includes('private-value'), 'the editor endpoint returns the saved command');
});
