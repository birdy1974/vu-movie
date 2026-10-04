/**
 * The Transcode-templates tab: structured FFmpeg fields over HTTP.
 *
 * These tests cover the contract the browser relies on — the schema it draws
 * the form from, the build/parse round trip it uses for live sync, the fields
 * being authoritative when a template is saved, and a disabled template never
 * being picked for an output. A temporary config file and the database layer's
 * in-memory fallback keep them isolated from a developer's /config directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-template-fields-'));
process.env.CONFIG_FILE = path.join(tempDir, 'vumovie.json');
process.env.TMP_DIR = path.join(tempDir, 'tmp');

const config = await import('../src/core/config.js');
const { default: api } = await import('../src/http/api.js');
const { default: store } = await import('../src/streams/store.js');
const { validateFfmpegTemplate } = await import('../src/core/media.js');

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

test('template fields: schema, build/parse round trip, persistence and disabled templates', async (t) => {
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

  /* --- the schema the editor draws the parameter form from --------------- */
  const library = await requestJson(base, '/ffmpeg/templates');
  assert.equal(library.response.status, 200);
  const schema = library.json.schema;
  assert.ok(schema, 'the library response carries the parameter schema');
  const keys = schema.fields.map((field) => field.key);
  for (const parameter of ['hw_accel', 'device', 'resolution', 'aspect', 'video_codec', 'video_bitrate',
    'maxrate', 'bufsize', 'fps', 'gop', 'profile', 'level', 'vf_preset', 'low_power', 'rc_mode',
    'global_quality', 'async_depth', 'audio_codec', 'audio_bitrate', 'audio_channels', 'audio_rate',
    'subs', 'output_format', 'extra_input', 'extra_output']) {
    assert.ok(keys.includes(parameter), `the editor can change ${parameter}`);
  }
  assert.ok(schema.advanced.length >= 25, 'the advanced flag table is exposed');
  assert.ok(schema.vfPresets.some((preset) => preset.id === 'yadif-frame'));

  /* --- fields → command -------------------------------------------------- */
  const fields = {
    video_codec: 'h264_vaapi', hw_accel: 'vaapi', resolution: '720p', video_bitrate: '4000k',
    maxrate: '4400k', bufsize: '8000k', fps: '25', gop: '50', profile: 'high', level: '4.0',
    rc_mode: 'VBR', async_depth: '4', low_power: true, audio_codec: 'ac3', audio_bitrate: '384k',
    audio_channels: '2', subs: 'dvb',
  };
  const built = await requestJson(base, '/ffmpeg/templates/build', {
    method: 'POST', body: { options: fields, container: 'mpegts' },
  });
  assert.equal(built.response.status, 200);
  assert.deepEqual(built.json.errors, []);
  assert.match(built.json.command, /-init_hw_device vaapi=intel:\/dev\/dri\/renderD128/);
  assert.match(built.json.command, /scale_vaapi=w=1280:h=720:format=nv12,fps=25,setsar=1/);
  assert.match(built.json.command, /-low_power 1 -rc_mode VBR -async_depth 4/);
  assert.match(built.json.command, /-c:s dvbsub/);
  assert.match(built.json.command, /-f mpegts pipe:1$/);
  assert.ok(validateFfmpegTemplate(built.json.command, { container: 'mpegts' }).ok);

  /* --- command → fields (an old, hand-written template stays editable) --- */
  const parsed = await requestJson(base, '/ffmpeg/templates/parse', {
    method: 'POST',
    body: { command: 'ffmpeg -i <url> -map 0:v:0 -vf scale=640:360 -c:v libx264 -c:a aac -b:a 128k -f hls <output>', container: 'hls' },
  });
  assert.equal(parsed.response.status, 200);
  assert.equal(parsed.json.options.video_codec, 'libx264');
  assert.equal(parsed.json.options.resolution, '360p');
  assert.equal(parsed.json.options.audio_codec, 'aac');
  assert.equal(parsed.json.options.audio_bitrate, '128k');
  assert.equal(parsed.json.options.output_format, 'hls');

  const rebuilt = await requestJson(base, '/ffmpeg/templates/build', {
    method: 'POST', body: { options: parsed.json.options, container: 'hls' },
  });
  assert.equal(rebuilt.json.command, 'ffmpeg -hide_banner -nostdin -loglevel warning -i <url> -vf scale=w=640:h=360,format=yuv420p,setsar=1 -map 0:v:0 -map 0:a:0? -dn -sn -c:v libx264 -c:a aac -b:a 128k -hls_time 2 -hls_init_time 1 -hls_list_size 10 -hls_flags delete_segments+omit_endlist+independent_segments -max_muxing_queue_size 1024 -f hls <output>');

  /* --- saving: the fields are authoritative, the command is rendered ----- */
  const saved = await requestJson(base, '/ffmpeg/templates', {
    method: 'PUT',
    body: {
      templates: [
        {
          id: 'vaapi-720', name: 'VAAPI 720p', container: 'mpegts', description: 'for the Duo2',
          command: 'this text is ignored — the fields win', output: { enigma2: 'vaapi-720' },
          options: fields,
        },
        {
          // No options: an inline command saved from the Stream tab keeps its
          // exact text (nothing is rewritten behind the operator's back).
          id: 'legacy', name: 'Legacy', container: 'mpegts',
          command: 'ffmpeg -i <url> -map 0:v:0 -c:v copy -c:a copy -f mpegts pipe:1',
        },
      ],
      defaultFfmpegTemplateId: 'vaapi-720',
      ffmpegDefaults: { enigma2: 'vaapi-720' },
    },
  });
  assert.equal(saved.response.status, 200);
  const [vaapi, legacy] = saved.json.templates;
  assert.equal(vaapi.command, built.json.command);
  assert.equal(vaapi.enabled, true);
  assert.equal(vaapi.options.resolution, '720p');
  assert.equal(legacy.command, 'ffmpeg -i <url> -map 0:v:0 -c:v copy -c:a copy -f mpegts pipe:1');
  assert.equal(legacy.options, null);

  /* --- validation: a bad field is a 422 with a readable reason ----------- */
  const invalid = await requestJson(base, '/ffmpeg/templates', {
    method: 'PUT',
    body: {
      templates: [{ id: 'broken', name: 'Broken', container: 'mpegts', options: { ...fields, video_bitrate: 'fast' } }],
      defaultFfmpegTemplateId: '',
    },
  });
  assert.equal(invalid.response.status, 422);
  assert.match(invalid.json.error, /Video bitrate/);

  const mismatched = await requestJson(base, '/ffmpeg/templates/build', {
    method: 'POST', body: { options: { ...fields, output_format: 'matroska' }, container: 'mpegts' },
  });
  assert.ok(mismatched.json.errors.some((text) => text.includes('does not match')));

  /* --- stopping a stream needs a usable template ------------------------- */
  const stream = await store.createStream({
    title: 'Disabled template', kind: 'movie',
    candidate: { url: 'https://cdn.example.test/movie.mp4', kind: 'file', headers: {} },
    profile: {},
  });
  assert.equal(stream.profile.ffmpegTemplateId, 'vaapi-720');

  const disabled = await requestJson(base, '/ffmpeg/templates', {
    method: 'PUT',
    body: {
      templates: saved.json.templates.map((item) => (item.id === 'vaapi-720' ? { ...item, enabled: false } : item)),
      defaultFfmpegTemplateId: 'vaapi-720',
      ffmpegDefaults: { enigma2: 'vaapi-720' },
    },
  });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.json.templates[0].enabled, false);

  // A stream bound to the disabled template falls back to the guided builder
  // instead of running a template the operator switched off.
  const rebound = await requestJson(base, `/streams/${stream.id}/profile`, {
    method: 'POST', body: { profile: { ...stream.profile, ffmpegTemplateId: 'vaapi-720', ffmpegTemplate: '' } },
  });
  assert.equal(rebound.response.status, 200);
  assert.equal(rebound.json.profile.ffmpegTemplateId || '', '');
  assert.equal(rebound.json.profile.ffmpegTemplate || '', '');

  // …and a brand-new stream does not pick it up as the global default either.
  const fresh = await store.createStream({
    title: 'Fresh', kind: 'movie',
    candidate: { url: 'https://cdn.example.test/other.mp4', kind: 'file', headers: {} },
    profile: {},
  });
  assert.equal(fresh.profile.ffmpegTemplateId || '', '');

  // Saved templates are still listed for the editor (disabled, not deleted).
  const relisted = await requestJson(base, '/ffmpeg/templates');
  assert.equal(relisted.json.templates.length, 2);
  assert.equal(relisted.json.templates.find((item) => item.id === 'vaapi-720').enabled, false);
});
