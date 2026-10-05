#!/usr/bin/env node
/**
 * dev-seed.mjs — development helper (never used by the app itself).
 *
 * Fills a running vu-movie instance with three FFmpeg templates and three
 * playlist items so the GUI can be exercised without a real scraper run. The
 * streams point at `https://example.invalid/…`, so playback and probing fail on
 * purpose — that is fine, the point is the UI.
 *
 *   node src/index.js &            # or npm start
 *   node scripts/dev-seed.mjs      # BASE=http://localhost:8080 by default
 *
 * It is idempotent: existing templates/streams are replaced.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8080';

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json?.error || text.slice(0, 200)}`);
  return json;
}

/** Ask the server to render the command for a set of parameters. */
async function build(options) {
  const res = await call('/api/ffmpeg/templates/build', {
    method: 'POST',
    body: { options, container: options.output_format },
  });
  if (res.errors?.length) throw new Error(`build failed: ${res.errors.join('; ')}`);
  return { command: res.command, options: res.options };
}

const wants = [
  {
    id: 'tpl-seed-1080p-ts',
    name: 'VAAPI 1080p → MPEG-TS',
    description: 'Hardware H.264, 1080p cap, 8 Mbit/s — the live VLC/Enigma2 path.',
    output: { vlcTs: '__self__', enigma2: '__self__' },
    options: {
      hw_accel: 'vaapi', device: '/dev/dri/renderD128', resolution: '1080p',
      video_codec: 'h264_vaapi', video_bitrate: 8000, gop: 50,
      rc_mode: 'CQP', global_quality: 22, low_power: true,
      audio_codec: 'aac', audio_bitrate: 192, audio_channels: 6, audio_rate: 48000,
      subs: 'drop', output_format: 'mpegts',
    },
  },
  {
    id: 'tpl-seed-720p-mkv',
    name: 'VAAPI 720p → Matroska',
    description: 'Smaller hardware encode for downloads and the web player.',
    output: {},
    options: {
      hw_accel: 'vaapi', device: '/dev/dri/renderD128', resolution: '720p',
      video_codec: 'h264_vaapi', video_bitrate: 3000,
      audio_codec: 'aac', audio_bitrate: 128, audio_channels: 2, audio_rate: 48000,
      subs: 'keep', output_format: 'matroska',
    },
  },
  {
    id: 'tpl-seed-remux',
    name: 'Passthrough remux',
    description: 'No re-encode at all — copy the video and the audio.',
    output: {},
    options: {
      hw_accel: 'none', video_codec: 'copy', audio_codec: 'copy',
      subs: 'keep', output_format: 'matroska',
    },
  },
];

const streams = [
  {
    title: 'Dune: Part Two', year: 2024, sourceId: 'overlook', quality: '1080p',
    url: 'https://example.invalid/dune-part-two.mkv', template: 'tpl-seed-1080p-ts', enabled: true,
  },
  {
    title: 'Alien: Romulus', year: 2024, sourceId: 'cinevo', quality: '720p',
    url: 'https://example.invalid/alien-romulus.mkv', template: 'tpl-seed-720p-mkv', enabled: true,
  },
  {
    title: 'Blade Runner 2049', year: 2017, sourceId: 'flixhub', quality: '1080p',
    url: 'https://example.invalid/blade-runner-2049.mkv', template: '', enabled: false,
  },
];

const templates = [];
for (const want of wants) {
  const { command, options } = await build(want.options);
  templates.push({
    id: want.id, name: want.name, description: want.description,
    container: want.options.output_format, command, options,
    output: want.output, enabled: true,
  });
}

await call('/api/ffmpeg/templates', {
  method: 'PUT',
  body: { templates, defaultFfmpegTemplateId: 'tpl-seed-1080p-ts', ffmpegDefaults: {} },
});
console.log(`✓ ${templates.length} templates saved (default: VAAPI 1080p → MPEG-TS)`);

// Start from a clean playlist so repeated runs stay predictable.
const current = await call('/api/playlist');
for (const item of current.items || []) {
  await call(`/api/playlist/items/${encodeURIComponent(item.streamId)}`, { method: 'DELETE' });
}
const existing = await call('/api/streams');
for (const stream of existing.streams || []) {
  await call(`/api/streams/${encodeURIComponent(stream.id)}`, { method: 'DELETE' });
}

for (const want of streams) {
  const created = await call('/api/streams', {
    method: 'POST',
    body: {
      title: want.title, year: want.year, kind: 'movie', sourceId: want.sourceId,
      candidate: { url: want.url, kind: 'file', sourceId: want.sourceId, probe: { quality: want.quality } },
      profile: { container: 'mpegts', quality: want.quality, transcode: false },
    },
  });
  const id = created.stream.id;
  await call('/api/playlist/items', { method: 'POST', body: { streamIds: [id] } });
  // A freshly created stream is auto-appended *enabled* by the playlist sync,
  // so the switch is set explicitly afterwards.
  await call(`/api/playlist/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: { enabled: want.enabled } });
  if (want.template) {
    await call(`/api/playlist/items/${encodeURIComponent(id)}/template`, { method: 'POST', body: { templateId: want.template } });
  }
  console.log(`✓ ${want.title} (${want.quality}, ${want.enabled ? 'enabled' : 'disabled'})`);
}

const playlist = await call('/api/playlist');
console.log(`\nplaylist: ${playlist.summary?.enabled || 0}/${playlist.summary?.total || 0} enabled`
  + `, ${playlist.summary?.withTemplate || 0} with template`);
if (playlist.urls?.page) console.log(`outputs:  ${playlist.urls.page}`);
