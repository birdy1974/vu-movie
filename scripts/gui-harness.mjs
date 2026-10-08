/**
 * jsdom integration harness for the GUI (dev-only, not shipped, not part of the
 * app bundle). Requires jsdom in node_modules:  npm install --no-save jsdom
 *
 *   node scripts/gui-harness.mjs
 *
 * Loads public/index.html with the four scripts inlined (so jsdom gives them
 * real <script> semantics: one global lexical environment, parse-time order),
 * mocks the HTTP API and drives the UI the way a user would.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(import.meta.dirname, '..', 'public');
const calls = [];
const errors = [];
const playerCalls = [];

/* ---------------- mocked API data ---------------- */

let playlistItems = [
  { streamId: 's1', enabled: true, templateId: 'tpl-a', title: 'Dune: Part Two', year: 2024, kind: 'movie', sourceId: 'overlook', quality: '1080p', hasTemplate: true, subtitlePath: '/downloads/subtitles/dune-part-two.nl.srt', subtitleLanguageStored: 'nld', subtitleMode: 'soft', profileTemplateName: 'VAAPI 1080p → MPEG-TS', urls: { ts: 'http://h/pl/tok/a.ts', mkv: 'http://h/pl/tok/a.mkv', hls: 'http://h/pl/tok/a.m3u8', playlist: 'http://h/pl/tok/a.m3u', forBox: 'http://h/pl/tok/bouquet.tv', direct: 'http://h/pl/tok/a?direct=1', download: 'http://h/pl/tok/a.dl', watch: 'http://h/pl/tok/watch/a', directNote: 'expires in 4 h' }, order: 0 },
  { streamId: 's2', enabled: true, templateId: '', title: 'Alien: Romulus', year: 2024, kind: 'movie', sourceId: 'cinevo', quality: '720p', hasTemplate: false, urls: { ts: 'http://h/pl/tok/b.ts', watch: 'http://h/pl/tok/watch/b' }, order: 1 },
  { streamId: 's3', enabled: false, templateId: '', title: 'Blade Runner 2049', year: 2017, kind: 'movie', sourceId: 'flixhub', quality: '1080p', session: { clients: 1 }, urls: { ts: 'http://h/pl/tok/c.ts' }, order: 2 },
];
const templates = [
  { id: 'tpl-a', name: 'VAAPI 1080p → MPEG-TS', container: 'mpegts', enabled: true, isDefault: true, command: 'ffmpeg -hide_banner -i <url> -c copy -f mpegts pipe:1', options: { output_format: 'mpegts', hw_accel: 'none', video_codec: 'copy', audio_codec: 'copy' } },
  { id: 'tpl-b', name: 'Passthrough remux', container: 'matroska', enabled: true, isDefault: false, command: 'ffmpeg -hide_banner -i <url> -c copy -f matroska pipe:1', options: { output_format: 'matroska', hw_accel: 'none', video_codec: 'copy', audio_codec: 'copy' } },
  { id: 'tpl-vaapi', name: 'VAAPI 720p → MPEG-TS', container: 'mpegts', enabled: true, isDefault: false, command: 'ffmpeg -hide_banner -init_hw_device vaapi=intel:/dev/dri/renderD128 -hwaccel vaapi -i <url> -c:v h264_vaapi -f mpegts pipe:1', options: { output_format: 'mpegts', hw_accel: 'vaapi', device: '/dev/dri/renderD128', resolution: '720p', aspect: '16:9', video_codec: 'h264_vaapi', video_bitrate: '4000k', audio_codec: 'copy', subs: 'drop', vf_preset: 'none', rc_mode: 'VBR', advanced: [] } },
];
let realSchema = null;
try {
  const res = await fetch('http://127.0.0.1:8080/api/ffmpeg/templates/schema');
  const data = await res.json();
  realSchema = data.schema || null;
  console.log(`(harness) loaded the real FFmpeg schema: ${realSchema?.fields?.length} fields, ${realSchema?.groups?.length} groups`);
} catch (error) {
  console.log(`(harness) could not reach the dev server for the real schema (${error.message}) — using the inline one`);
}
// Mirrors the real /api/ffmpeg/templates/schema for the fields the checks
// below look at — including `custom: false`, which the server sets on every
// field it validates against its choices.
const schemaFields = [
  { key: 'hw_accel', label: 'Hardware acceleration', kind: 'enum', options: ['none', 'vaapi', 'qsv'], custom: false, help: 'none keeps everything in software.' },
  { key: 'resolution', label: 'Resolution cap', kind: 'resolution', options: ['source', '720p', '1080p'], help: 'The longest edge of the output.' },
  { key: 'video_codec', label: 'Video codec', kind: 'enum', options: ['copy', 'libx264', 'h264_vaapi'], help: 'copy needs no CPU.' },
  { key: 'video_bitrate', label: 'Video bitrate', kind: 'rate', help: 'Target bitrate in kbps.' },
  { key: 'audio_codec', label: 'Audio codec', kind: 'enum', options: ['copy', 'aac'], help: 'aac re-encodes the audio.' },
  { key: 'subs', label: 'Subtitles', kind: 'enum', options: ['drop', 'dvb', 'keep'], custom: false, help: 'keep only works in Matroska.' },
  { key: 'output_format', label: 'Output format', kind: 'enum', options: ['mpegts', 'matroska', 'hls'], help: 'mpegts is the live path.' },
];
const inlineSchema = {
  fields: schemaFields.map((f, i) => ({ ...f, choices: f.options, custom: f.custom, group: i < 4 ? 'video' : i === 4 ? 'audio' : i === 5 ? 'subtitles' : 'output' })),
  groups: [{ id: 'video', label: 'Video' }, { id: 'audio', label: 'Audio' }, { id: 'subtitles', label: 'Subtitles' }, { id: 'output', label: 'Output' }],
  advanced: [],
  vfPresets: [],
  defaults: {},
};

/* ---------------- mocked API ---------------- */

/** What GET /api/config answers — the shape publicConfig() really serves. */
const mockConfig = {
  app: { port: 8080, baseUrl: '', username: '', password: '••••••', logLevel: 'info', tokenTtlMinutes: 4320 },
  transcode: { mode: 'auto', resolution: 1080, aspect: 'source', videoBitrate: 8000, audioBitrate: 192, audioChannels: 6, fps: '25', container: 'mpegts', alwaysTranscode: false, hardware: true, maxConcurrent: 1, device: '/dev/dri/renderD128', idleStopSeconds: 45, encoderFallback: 'x264', realtime: true },
  subtitles: { languages: ['nl', 'en'], autoSearch: true, pushToReceiver: false, receiverDir: '/media/hdd', disabledProviders: [] },
  playlist: { autoCheckEnabled: true, autoCheckIntervalMinutes: 360, autoRepairEnabled: true, xtreamUsername: 'vumovie', xtreamPassword: '••••••••' },
  enigma2: { host: '', port: 80, username: 'root', password: '••••', bouquetName: 'vu-movie', rootDir: '/etc/enigma2', serviceType: 4097, ftpEnabled: true, ftpPort: 21, autoPush: false },
  scraper: { browserConcurrency: 1, browserIdleSeconds: 180, resolveTimeoutMs: 45000, probeCandidates: true, maxCandidates: 12, flaresolverrUrl: '', externalExtractorUrl: '', sessionDir: '/data/sessions', userAgent: 'Mozilla/5.0' },
  storage: { downloads: '/downloads', tmp: '/tmp', cacheBudgetMb: 2048 },
};
/** The body of the last PUT /api/config, so the checks can see the real patch. */
let lastConfigPatch = null;


async function fetchMock(url, options = {}) {
  const u = String(url);
  const method = (options.method || 'GET').toUpperCase();
  calls.push(`${method} ${u}`);
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.startsWith('/api/health')) return json({ ok: true, version: '1.0.0', uptimeSec: 12, ffmpeg: { ok: true, version: '6.1' }, hwaccel: { available: false, reason: 'no /dev/dri' }, postgres: false, enigma2: { configured: false } });
  if (u.startsWith('/api/jobs')) return json({ ok: true, jobs: [] });
  if (/^\/api\/streams\/[^/?]+$/.test(u) && method === 'GET') {
    const id = u.split('/').pop();
    const item = playlistItems.find((entry) => entry.streamId === id) || playlistItems[0];
    const profile = item.subtitlePath
      ? { container: 'matroska', subtitlePath: item.subtitlePath, subtitleLanguage: 'nld', subtitles: item.subtitleMode || 'soft' }
      : { container: 'mpegts' };
    return json({ ok: true, stream: { id, title: item.title, year: item.year, profile, upstream: { quality: item.quality } }, urls: item.urls || {} });
  }
  if (u.startsWith('/api/streams') && method === 'GET') return json({ ok: true, streams: playlistItems.map((i) => ({ id: i.streamId, title: i.title, year: i.year, upstream: { quality: i.quality } })) });
  if (u.startsWith('/api/streams') && method === 'POST') {
    const body = JSON.parse(options.body || '{}');
    return json({ ok: true, stream: { id: 'new1', title: body.title || 'New', upstream: { quality: body.candidate?.quality } }, urls: {} });
  }
  if (u.startsWith('/api/find/search')) return json({ ok: true, results: [{
    title: 'Quality Movie', year: 2026, kind: 'movie', sourceId: 'overlook', sourceName: 'Overlook',
    url: 'https://catalog.example/movie', poster: '/api/poster?url=https%3A%2F%2Fimages.example%2Fposter.jpg&ref=&sig=test',
    description: 'A result with selectable HLS renditions.',
  }], providerErrors: [] });
  if (u.startsWith('/api/find/resolve')) return json({ ok: true, candidates: [{
    url: 'https://cdn.example/master.m3u8', sourceId: 'overlook', quality: '1080p', ok: true,
    probe: { video: { codec: 'h264', width: 1920, height: 1080 }, audio: [{ codec: 'aac', channels: 2 }], bitrate: 5000000, subtitles: [] },
    variants: [
      { url: 'https://cdn.example/1080.m3u8', quality: '1080p', width: 1920, height: 1080, bandwidth: 5000000 },
      { url: 'https://cdn.example/720.m3u8', quality: '720p', width: 1280, height: 720, bandwidth: 2500000 },
    ],
  }] });
  if (u.startsWith('/api/sources')) return json({ ok: true, sources: [{ id: 'overlook', name: 'Overlook', enabled: true, home: 'https://overlook.example' }] });
  if (u.startsWith('/api/config/hwaccel')) return json({ ok: true, hwaccel: { available: false, reason: 'no /dev/dri' } });
  if (u.startsWith('/api/config') && method === 'PUT') {
    // What the Settings form actually posted — checked below for the Xtream card.
    lastConfigPatch = JSON.parse(options.body || '{}');
    return json({ ok: true, config: mockConfig, changed: Object.keys(lastConfigPatch) });
  }
  if (u.startsWith('/api/config')) return json({ ok: true, config: mockConfig });
  if (u.startsWith('/api/subtitles/search')) return json({ ok: true, results: [{ providerId: 'podnapisi', language: 'en', title: 'Quality Movie', release: 'Quality.Movie.2026.1080p', url: 'https://subs.example/file.srt' }] });
  if (u.startsWith('/api/subtitles/download')) return json({ ok: true, language: 'en', srt: '1\n00:00:01,000 --> 00:00:02,000\nHello\n' });
  if (u.startsWith('/api/subtitles/providers')) return json({ ok: true, providers: [] });
  if (u.startsWith('/api/ffmpeg/templates/schema')) return json({ ok: true, schema: realSchema || inlineSchema });
  if (u.startsWith('/api/ffmpeg/templates/build')) {
    const options2 = JSON.parse(options.body || '{}').options || {};
    return json({ ok: true, command: `ffmpeg -hide_banner -i <url> -c:v ${options2.video_codec || 'copy'} -f ${options2.output_format || 'mpegts'} pipe:1`, errors: [], warnings: [], options: options2 });
  }
  if (u.startsWith('/api/ffmpeg/templates') && method === 'PUT') {
    const body = JSON.parse(options.body || '{}');
    templates.length = 0;
    templates.push(...(body.templates || []));
    return json({ ok: true, templates, defaultFfmpegTemplateId: body.defaultFfmpegTemplateId || '', ffmpegDefaults: {} });
  }
  if (u.startsWith('/api/ffmpeg/templates')) return json({ ok: true, templates, defaultFfmpegTemplateId: 'tpl-a', ffmpegDefaults: {}, outputTypes: ['vlcTs', 'vlcMkv', 'm3u8', 'm3u', 'enigma2', 'direct', 'download'], outputLabels: {}, schema: realSchema || inlineSchema });
  if (u.startsWith('/api/playlist') && method === 'PUT') {
    const body = JSON.parse(options.body || '{}');
    if (Array.isArray(body.streamIds)) {
      const byId = new Map(playlistItems.map((i) => [i.streamId, i]));
      const next = [];
      for (const id of body.streamIds) { const item = byId.get(id); if (item) { next.push(item); byId.delete(id); } }
      for (const item of playlistItems) if (byId.has(item.streamId)) next.push(item);
      playlistItems = next.map((item, index) => ({ ...item, order: index }));
    }
    return json({ ok: true, items: playlistItems });
  }
  if (u.startsWith('/api/playlist/items')) return json({ ok: true, items: playlistItems });
  if (u.startsWith('/api/playlist')) return json({ ok: true, name: 'vu-movie', summary: { total: 3, enabled: 2, withTemplate: 1, withSubtitle: 0 }, items: playlistItems, available: [], templates: templates.map((t) => ({ id: t.id, name: t.name, enabled: true, isDefault: t.id === 'tpl-a' })), defaultTemplateId: 'tpl-a', outputTypes: ['vlcTs'], outputLabels: {}, urls: { page: 'http://h/pl/tok/', m3u: 'http://h/pl/tok/playlist.m3u', vlc: 'http://h/pl/tok/playlist.m3u', bouquet: 'http://h/pl/tok/userbouquet.tv', json: 'http://h/pl/tok/playlist.json', kodi: 'http://h/pl/tok/kodi', xtream: { base: 'http://h/xtream/tok/', playerApi: 'http://h/xtream/tok/player_api.php', get: 'http://h/xtream/tok/get.php', xmltv: 'http://h/xtream/tok/xmltv.php', username: 'u', password: 'p' } } });
  if (u.startsWith('/api/enigma2')) return json({ ok: true, status: { configured: false } });
  return json({ ok: true });
}

/* ---------------- load the page ---------------- */

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
for (const file of ['core.js', 'web-codecs.js', 'playlist.js', 'ffmpeg-editor.js', 'app.js']) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/<\/script/gi, '<\\/script');
  const tag = `<script src="/${file}"></script>`;
  if (!html.includes(tag)) throw new Error(`script tag not found: ${tag}`);
  // NB: function replacer — a string replacement would eat "$$" in the code.
  html = html.replace(tag, () => `<script>${code}</script>`);
}

const dom = new JSDOM(html, {
  url: 'http://127.0.0.1:8080/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = fetchMock;
    window.Response = Response;
    window.EventSource = class { constructor() { this.readyState = 0; } addEventListener() {} close() {} };
    window.mpegts = {
      Events: { ERROR: 'error' },
      isSupported: () => true,
      createPlayer: ({ url }) => {
        playerCalls.push(`create:${url}`);
        return {
          attachMediaElement: () => playerCalls.push('attach'),
          on: () => {},
          load: () => playerCalls.push('load'),
          play: () => { playerCalls.push('play'); return Promise.resolve(); },
          pause: () => playerCalls.push('pause'),
          unload: () => playerCalls.push('unload'),
          detachMediaElement: () => playerCalls.push('detach'),
          destroy: () => playerCalls.push('destroy'),
        };
      },
    };
    window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
    window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled rejection: ${e.reason}`));
  },
});
const { window } = dom;
const { document } = window;

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
let failures = 0;
const check = (label, condition, extra = '') => {
  console.log(`${condition ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!condition) failures += 1;
};

await tick(150);

/* ---------------- 0. the site opens on the Mobile tab ---------------- */

check('startup lands on the Mobile tab', !$('#p-mobile')?.classList.contains('hide') && $('#p-dash')?.classList.contains('hide'),
  `mobile=${$('#p-mobile')?.className} dash=${$('#p-dash')?.className}`);
check('the nav highlights Mobile', $('[data-p="mobile"]')?.classList.contains('on') === true && !$('[data-p="dash"]')?.classList.contains('on'));
check('body[data-page] is mobile (phone-sized CSS applies)', document.body.dataset.page === 'mobile', document.body.dataset.page);
const foldBodies = $$('#p-mobile [data-fold-body]');
check('all five Mobile panes start collapsed', foldBodies.length === 5 && foldBodies.every((b) => b.classList.contains('hide')),
  foldBodies.map((b) => `${b.dataset.foldBody}:${b.classList.contains('hide') ? 'folded' : 'open'}`).join(' '));
const foldAll = $('#btn-mob-fold');
check('the Mobile title has a fold-all button that offers “expand all”', /expand all/.test(foldAll?.textContent || ''), foldAll?.textContent?.trim());
foldAll?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(30);
check('it opens every pane in one tap', foldBodies.every((b) => !b.classList.contains('hide')) && /collapse all/.test(foldAll.textContent));
foldAll.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(30);
check('and closes them again', foldBodies.every((b) => b.classList.contains('hide')) && /expand all/.test(foldAll.textContent));

/* ---------------- 1. sidebar rail + pin ---------------- */

const app = $('.app');
check('sidebar starts as an icon rail (.nav-mini)', app.classList.contains('nav-mini'), app.className);
check('rail button exists', Boolean($('#btn-nav-pin')));
check('every nav button has an icon and a label',
  $$('.nav button[data-p]').length === 10 && $$('.nav button .ico').length === 10 && $$('.nav button .lbl').length === 10,
  `${$$('.nav button[data-p]').length} buttons, ${$$('.nav button .ico').length} icons`);
$('#btn-nav-pin').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('pin toggles the large menu', app.classList.contains('nav-pinned') && !app.classList.contains('nav-mini'));
check('pin is remembered', window.localStorage.getItem('vu-movie.nav-pinned') === '1', String(window.localStorage.getItem('vu-movie.nav-pinned')));
$('#btn-nav-pin').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('unpin returns to the rail', app.classList.contains('nav-mini'));

/* ---------------- 2. mobile fold buttons ---------------- */

const folds = $$('.foldbtn[data-fold]');
check('5 mobile fold buttons', folds.length === 5, folds.map((f) => f.dataset.fold).join(','));
const mobSearchBody = $('[data-fold-body="mob-search"]');
// The panes start folded, so the first tap opens and the second closes.
folds[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('opening a pane shows its body', !mobSearchBody.classList.contains('hide'));
check('a folded pane is remembered under the current key',
  JSON.parse(window.localStorage.getItem('vu-movie.folded.v2') || '{}')['mob-search'] === false,
  String(window.localStorage.getItem('vu-movie.folded.v2')));
folds[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('closing it hides the pane again', mobSearchBody.classList.contains('hide'));

/* ---------------- 3. mobile playlist template beside the title ---------------- */

await window.App.go('mobile');
await tick(80);
const mobRows = $$('#mob-list .mob-item');
check('mobile playlist rows rendered', mobRows.length === 3, `${mobRows.length} rows`);
check('template select sits beside the title block, not under it',
  Boolean(mobRows[0]?.querySelector('.mob-title') && mobRows[0]?.querySelector('.mob-tpl')) &&
  mobRows[0].querySelector('.mob-tpl').parentElement.classList.contains('mob-item') &&
  Boolean(mobRows[0].querySelector('.mob-item-main + .mob-tpl')),
  mobRows[0]?.outerHTML.replace(/\s+/g, ' ').slice(0, 150));

/* ---------------- Search: selectable HLS qualities + subtitles ---------------- */

await window.App.go('find');
await tick(80);
$('#q').value = 'Quality Movie';
$('#btn-search').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(120);
check('search result poster is rendered as an image', Boolean($('#results .poster img')));
$('#results [data-open-formats]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(160);
const qualityButtons = $$('#candidates [data-add-candidate]');
check('HLS master expands into each available quality', qualityButtons.length === 2, qualityButtons.map((button) => button.textContent.trim()).join(' | '));
check('required quality can be added directly', qualityButtons.some((button) => button.textContent.includes('720p')));
const quality720 = qualityButtons.find((button) => button.textContent.includes('720p'));
quality720?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(100);
check('selected quality is posted to the stream API', calls.includes('POST /api/streams'));
$('#btn-sel-subs').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(120);
check('selected-title subtitle result has a direct .srt download', Boolean($('#sel-subtitle-results [data-download-sub]')));

/* ---------------- 8. stream tab: VLC / playlist URLs ---------------- */

await window.App.go('stream');
await tick(100);
check('stream picker lists the playlist items', $$('#st-pick option').length === 3, String($$('#st-pick option').length));
const urlInputs = $$('#st-urls input[readonly]').map((i) => i.value).filter(Boolean);
check('stream tab shows the per-stream URLs', urlInputs.length >= 5, `${urlInputs.length} urls`);
check('VLC .ts URL present', urlInputs.some((v) => v.endsWith('.ts')));
check('m3u playlist URL present', urlInputs.some((v) => v.endsWith('.m3u')));
check('direct 302 URL present', urlInputs.some((v) => v.includes('direct=1')));
check('old-tab actions exist', ['btn-st-vlc', 'btn-st-session-start', 'btn-st-session-stop', 'btn-st-download', 'btn-st-m3u', 'btn-st-test-template', 'btn-st-copy-all'].every((id) => $(`#${id}`)));
$('#st-pick').value = 's2';
$('#st-pick').dispatchEvent(new window.Event('change', { bubbles: true }));
check('switching the stream re-renders its URLs', $$('#st-urls input[readonly]').some((i) => i.value.endsWith('b.ts')));
// The credentials are printed here, but the account is set in Settings.
const xtreamAccountButton = $('#st-outputs [data-xtream-settings]');
check('the Stream tab offers to change the Xtream account', Boolean(xtreamAccountButton), xtreamAccountButton?.textContent?.trim());
xtreamAccountButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(150);
check('“change account” opens the Settings tab', window.location.hash === '#set' && !$('#p-set').classList.contains('hide'), window.location.hash);

/* ---------------- 7. playlist drag & drop ---------------- */

await window.App.go('list');
await tick(150);
const rows = $$('#playlist-items .pl-row');
check('playlist rendered with 3 rows', rows.length === 3, `${rows.length}`);
rows[0].querySelector('[data-pl-play]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(120);
check('web preview uses the local MPEG-TS transmuxer', playerCalls.some((entry) => entry.startsWith('create:')) && playerCalls.includes('load'), playerCalls.join(','));
window.App.closeModal();
check('closing preview destroys the player', playerCalls.includes('destroy'), playerCalls.join(','));
rows.forEach((row, index) => {
  row.getBoundingClientRect = () => ({ top: index * 40, bottom: index * 40 + 36, height: 36, left: 0, right: 600, width: 600, x: 0, y: index * 40 });
});
const elementFromPoint = (x, y) => rows[Math.min(rows.length - 1, Math.max(0, Math.floor(y / 40)))];
document.elementFromPoint = elementFromPoint;

const pointerEvent = (type, target, { y = 0, id = 7 } = {}) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  event.clientX = 10; event.clientY = y; event.pointerId = id; event.button = 0; event.pointerType = 'mouse';
  target.dispatchEvent(event);
  return event;
};
rows[0].setPointerCapture = () => {};
rows[0].releasePointerCapture = () => {};
pointerEvent('pointerdown', rows[0].querySelector('.pl-handle'), { y: 10 });
check('dragging the first row marks it', rows[0].classList.contains('dragging'));
pointerEvent('pointermove', rows[0], { y: 110 }); // over the third row, lower half
check('drop target is marked', rows[2].classList.contains('drop-after'), rows.map((r) => `${r.dataset.plRow}:${r.className.replace('pl-row', '').trim()}`).join(' '));
pointerEvent('pointerup', rows[0], { y: 110 });
await tick(150);
const orderAfter = $$('#playlist-items .pl-row').map((r) => r.dataset.plRow);
check('drag & drop reorders the playlist', orderAfter.join(',') === 's2,s3,s1', orderAfter.join(','));
check('the reorder was sent to the API', calls.some((c) => c === 'PUT /api/playlist'), calls.filter((c) => c.includes('playlist')).slice(-3).join(' | '));
check('the row is no longer marked as dragging', !rows.some((r) => r.classList.contains('dragging')));

/* ---------------- 7b. per-item subtitle mode (soft / burn / off) ---------------- */

await window.App.go('list');
await tick(150);
const subRow = $$('#playlist-items .pl-row').find((row) => row.dataset.plRow === 's1') || $$('#playlist-items .pl-row')[0];
subRow.querySelector('[data-pl-sub]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(200);
const modeSelect = $('#sub-mode');
const modeValues = modeSelect ? [...modeSelect.options].map((o) => o.value) : [];
check('the subtitle modal offers push, soft, burn and off', ['push', 'soft', 'burn', 'none'].every((v) => modeValues.includes(v)), modeValues.join(',') || 'no #sub-mode');
check('the no-CPU option is offered first', modeValues[0] === 'push', modeValues.join(','));
check('the current mode comes from the stream profile', modeSelect?.value === 'soft', modeSelect?.value);
modeSelect.value = 'burn';
modeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
await tick(200);
check('switching to burn-in PATCHes the playlist item', calls.some((c) => c.startsWith('PATCH /api/playlist/items/')), calls.filter((c) => c.startsWith('PATCH')).slice(-2).join(' | '));
window.App.closeModal();

/* ---------------- 4. settings: sections + custom subtitle source ---------------- */

await window.App.go('set');
await tick(150);
const sectionCards = $$('#settings-grid [data-set-section]').map((c) => c.dataset.setSection);
if (!sectionCards.length) console.log('DEBUG settings-grid:', $('#settings-grid')?.innerHTML.slice(0, 400));
check('settings sections include playlist recovery controls', ['transcode', 'subtitles', 'playlist', 'enigma2', 'scraper', 'storage', 'app'].every((k) => sectionCards.includes(k)), sectionCards.join(','));
check('playlist schedule and auto-repair settings are available', ['autoCheckEnabled', 'autoCheckIntervalMinutes', 'autoRepairEnabled'].every((key) => $(`#set-playlist-${key}`)), 'schedule · interval · auto-refresh');
// The Xtream account has its own card but its two options live under
// `playlist` in the config, which is what the save has to reproduce.
const xtreamCard = $('#settings-grid [data-set-section="xtream"]');
const xtreamUser = $('#set-xtream-xtreamUsername');
const xtreamPass = $('#set-xtream-xtreamPassword');
check('the Xtream account is editable in Settings', Boolean(xtreamCard && xtreamUser && xtreamPass), sectionCards.join(','));
check('the Xtream card is prefilled and masks the password like every other secret',
  xtreamUser?.value === 'vumovie' && xtreamPass?.type === 'password' && xtreamPass?.value === '••••••••',
  `${xtreamUser?.value} / ${xtreamPass?.type}:${xtreamPass?.value}`);
check('the Xtream card says which account is in use', /Account in use: vumovie/.test(xtreamCard?.textContent || ''), xtreamCard?.textContent?.replace(/\s+/g, ' ').slice(-90));

xtreamUser.value = 'tivimate';
$('#btn-save-settings').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(150);
check('saving writes the Xtream account into the playlist config section',
  lastConfigPatch?.playlist?.xtreamUsername === 'tivimate' && lastConfigPatch?.playlist?.autoCheckIntervalMinutes === 360,
  JSON.stringify(lastConfigPatch?.playlist));
check('an untouched masked password is not posted back', !('xtreamPassword' in (lastConfigPatch?.playlist || {})),
  JSON.stringify(lastConfigPatch?.playlist));

xtreamPass.value = 'hunter2';
$('#btn-save-settings').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(150);
check('a typed Xtream password is posted', lastConfigPatch?.playlist?.xtreamPassword === 'hunter2', JSON.stringify(lastConfigPatch?.playlist));

const checkInterval = $('#set-playlist-autoCheckIntervalMinutes');
check('check interval is constrained to 15–10080 minutes', checkInterval?.min === '15' && checkInterval?.max === '10080', `${checkInterval?.min}–${checkInterval?.max}`);
const setInputs = $$('#settings-grid input,#settings-grid select');
check('settings fields rendered', setInputs.length >= 40, `${setInputs.length} controls`);
const rawKeys = /^(mode|resolution|aspect|videoBitrate|audioBitrate|audioChannels|fps|container|alwaysTranscode|hardware|maxConcurrent|device|idleStopSeconds|encoderFallback|realtime|languages|autoSearch|pushToReceiver|receiverDir|disabledProviders|host|port|username|password|bouquetName|rootDir|serviceType|ftpEnabled|ftpPort|autoPush|autoCheckEnabled|autoCheckIntervalMinutes|autoRepairEnabled|browserConcurrency|browserIdleSeconds|resolveTimeoutMs|probeCandidates|maxCandidates|flaresolverrUrl|externalExtractorUrl|sessionDir|userAgent|downloads|tmp|cacheBudgetMb|baseUrl|logLevel|tokenTtlMinutes)$/;
check('field labels are human, not raw keys',
  [...$$('#settings-grid label')].every((l) => !rawKeys.test(l.textContent.replace(/i\s*$/, '').trim())),
  [...$$('#settings-grid label')].map((l) => l.textContent.trim().replace(/\s*i$/, '')).slice(0, 4).join(' | '));
check('each field has a hover tip', $$('#settings-grid .tip').length >= 40, `${$$('#settings-grid .tip').length} tips`);
check('custom subtitle source lives in Settings', Boolean($('#cp-id') && $('#btn-cp-save') && $('#cp-search')));
check('settings buttons intact', ['btn-save-settings', 'btn-reload-settings', 'btn-hw-test', 'btn-diag', 'btn-cs-save'].every((id) => $(`#${id}`)));
check('no subtitle-source form left on the Subtitles tab', !$('#p-subs #cp-id') && !$('#p-subs #btn-cp-save'));

/* ---------------- 5 + 6. transcode editor: tips + 3 columns ---------------- */

await window.App.go('tpl');
await tick(200);
const paramGrid = $('#ff-params') || $$('.param-grid')[0];
check('parameter grid is 3-column ready', Boolean(paramGrid?.classList.contains('param-grid')), paramGrid?.className || '(none)');
check('parameters rendered', paramGrid ? paramGrid.children.length >= 5 : false, paramGrid ? `${paramGrid.children.length} fields, id=${paramGrid.id}, parent=${paramGrid.parentElement?.className}` : '');
if (!paramGrid || paramGrid.children.length === 0) console.log('DEBUG param grids:', $$('.param-grid').map((g) => `#${g.id || '(no id)'} in ${g.parentElement?.className} children=${g.children.length}`).join(' | '));
check('no inline help paragraphs in the editor', $$('.ff-editor .param-hint').length === 0, `${$$('.ff-editor .param-hint').length}`);
const tips = $$('.ff-editor .tip[data-tip]');
check('help text moved into "i" tooltips', tips.length >= 5, `${tips.length} tips`);
check('tips carry real text', tips.every((t) => (t.dataset.tip || '').length > 8), tips[0]?.dataset.tip);
const transcodeTestSource = $('#ff-editor-1-test-source');
check('Transcode final-command input lists playlist items',
  Boolean(transcodeTestSource) && [...transcodeTestSource.options].filter((option) => option.value.startsWith('stream:')).length === 3,
  transcodeTestSource ? [...transcodeTestSource.options].map((option) => option.textContent).join(' | ') : '(missing select)');

/* ---------------- 5b. the advice pane on a VAAPI template ---------------- */

// Regression: the VAAPI/CPU-encoder hint compared against the *accessor* instead
// of the list, so selecting any VAAPI template threw while painting the pane.
// The pane then kept the previous verdicts on screen — which is how a template
// that really is set to "Video decoding: vaapi" kept showing the Quick Sync
// warning. The harness's global error listener catches the throw.
const vaapiRow = $('#tpl-list [data-tpl="tpl-vaapi"]');
check('VAAPI template row is listed', Boolean(vaapiRow));
vaapiRow?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(300);
const adviceText = () => $$('#ff-editor-1-advice .param-msg').map((el) => el.textContent.trim()).join('\n');
check('a VAAPI template paints its advice', adviceText().includes('VAAPI'), adviceText().slice(0, 100) || '(pane empty)');
check('the pane never says “could not render”', !($('#ff-editor-1-sync-status')?.textContent || '').includes('could not render'),
  $('#ff-editor-1-sync-status')?.textContent || '(no status)');

const setParam = async (id, value) => {
  const el = $(id);
  el.value = value;
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(450); // the editor debounces the rebuild by 220 ms
};
await setParam('#ff-editor-1-ff-video_codec', 'libx264');
check('the copy-back hint appears for a CPU encoder behind VAAPI decoding',
  adviceText().includes('VAAPI decoding feeds a CPU encoder'), adviceText().slice(0, 160) || '(pane empty)');
await setParam('#ff-editor-1-ff-video_codec', 'h264_vaapi');
check('switching back to h264_vaapi drops the copy-back hint',
  !adviceText().includes('VAAPI decoding feeds a CPU encoder'), adviceText().slice(0, 160) || '(pane empty)');
await setParam('#ff-editor-1-ff-hw_accel', 'none');
check('the pane follows the setting instead of leaving the old verdicts',
  adviceText().includes('is a GPU encoder but hardware decoding is off') && !adviceText().includes('Keep everything on the GPU.'),
  adviceText().slice(0, 200) || '(pane empty)');

/* ---------------- 9. test tab: start button ---------------- */

try { await window.VMFfmpegEditor.initTestTab(); } catch (error) { console.log('DEBUG initTestTab threw:', error.stack); }
await window.App.go('tpl-test');
await tick(200);
check('start-test button exists', Boolean($('#btn-test-run')));
check('stop button starts disabled', $('#btn-test-stop')?.disabled === true);
let ranTest = 0;
window.VMFfmpegEditor.runTestTab = () => { ranTest += 1; return Promise.resolve(); };
$('#btn-test-run').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(40);
check('start test triggers the editor run', ranTest === 1, `${ranTest}; status=${$('#test-status')?.textContent}; editor=${Boolean(window.VMFfmpegEditor.testEditor)}`);
if (ranTest !== 1) console.log('DEBUG test tab:', ($('#toasts')?.textContent || '').slice(0, 200), '|', $('#test-editor-host')?.innerHTML.slice(0, 200));
$('#btn-test-stop').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(40);

/* ---------------- 10. dashboard still works ---------------- */

await window.App.go('dash');
await tick(80);
check('dashboard still renders', Boolean($('#p-dash') && !$('#p-dash').classList.contains('hide')));

if (process.env.DUMP) {
  const pretty = (html) => html.replace(/>\s*</g, '>\n<').split('\n').filter((l) => l.trim()).map((l) => l.trim()).join('\n');
  console.log('\n--- mobile pane ---\n' + pretty($('#p-mobile').innerHTML).slice(0, 2600));
  console.log('\n--- stream url card ---\n' + pretty($('#st-urls')?.closest('.card')?.outerHTML || '(none)').slice(0, 1800));
}
/* ---------------- 11. help tooltips on every tab ---------------- */

const bubble = () => document.querySelector('.tipbubble');
const hover = (element) => element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, cancelable: true }));
const unhover = (element) => element.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, cancelable: true, relatedTarget: document.body }));

check('one shared tooltip bubble lives on <body>', Boolean(bubble()) && bubble().parentElement === document.body);

const TABS = [
  ['mobile', 'Mobile'], ['dash', 'Dashboard'], ['find', 'Search'], ['subs', 'Subtitles'],
  ['tpl', 'Transcode'], ['list', 'Playlist'], ['stream', 'Stream'], ['tpl-test', 'Test'],
  ['logs', 'Logs'], ['set', 'Settings'],
];
for (const [page, label] of TABS) {
  await window.App.go(page);
  await tick(120);
  const tips = $$(`#p-${page} .tip[data-tip]`);
  const anchor = tips[0];
  let shown = false;
  if (anchor) {
    hover(anchor);
    shown = !bubble().hidden && bubble().textContent.trim().length > 10;
    unhover(anchor);
  }
  check(`${label}: help tip opens on hover`,
    tips.length >= 1 && shown,
    `${tips.length} tip(s)${anchor ? ` · “${(anchor.dataset.tip || '').slice(0, 60)}…”` : ''}`);
}
check('the bubble closes again', bubble().hidden === true);

/* keyboard + touch: the tip must be reachable without a mouse */
await window.App.go('tpl');
await tick(200);
const focusTip = $$('#p-tpl h1 .tip[data-tip]')[0] || $$('#p-tpl .tip[data-tip]')[0];
focusTip.focus();
focusTip.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
check('a focused tip opens too (keyboard / screen reader)', bubble().hidden === false && bubble().textContent.trim().length > 10, bubble().textContent.slice(0, 60));
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
check('Escape dismisses the tip', bubble().hidden === true);
const tapTip = $$('#p-tpl .tip[data-tip]')[0];
tapTip.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const afterTap = bubble().hidden === false;
tapTip.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
check('tap toggles the tip (no hover on a phone)', afterTap && bubble().hidden === true);
/* a tip must not activate the control it sits in (button, <summary>, label) */
const host = document.createElement('div');
host.innerHTML = `<button type="button" id="host-btn">do it ${'<span class="tip" tabindex="0" role="note" aria-label="x" data-tip="why not">i</span>'}</button>`;
document.body.appendChild(host);
let activated = 0;
$('#host-btn').addEventListener('click', () => { activated += 1; });
const hostTip = $('#host-btn .tip');
if (hostTip) hostTip.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
check('clicking a tip inside a button does not press the button', activated === 0 && bubble().hidden === false, `activated=${activated}`);
const outside = document.createElement('div');
document.body.appendChild(outside);
const backInTpl = $$('#p-tpl .tip[data-tip]')[0];
backInTpl.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
outside.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
check('tapping outside closes the tip', bubble().hidden === true);
outside.remove();

/* ---------------- 12. the prefilled parameter values come from the schema ---------------- */

await window.App.go('tpl');
await tick(200);
const optionsOf = (key) => [...($(`#ff-editor-1-ff-${key}`)?.options || [])].map((o) => o.value);
const videoCodecs = optionsOf('video_codec');
const audioCodecs = optionsOf('audio_codec');
const levels = optionsOf('level');
const fpsList = optionsOf('fps');
check('every video encoder from the schema is offered', ['libx264', 'libx265', 'libvpx-vp9', 'libsvtav1', 'mpeg2video', 'h264_vaapi', 'hevc_vaapi', 'vp8_vaapi', 'vp9_vaapi', 'av1_vaapi', 'h264_qsv', 'hevc_qsv', 'h264_nvenc', 'hevc_nvenc', 'copy'].every((c) => videoCodecs.includes(c)), videoCodecs.join(','));
check('every audio encoder from the schema is offered', ['aac', 'ac3', 'eac3', 'mp2', 'mp3', 'libmp3lame', 'libopus', 'libvorbis', 'flac', 'pcm_s16le', 'copy', 'none'].every((c) => audioCodecs.includes(c)), audioCodecs.join(','));
check('H.264 levels cover the whole range (1 … 6.2, incl. 1b)', ['1', '1b', '2.2', '3.1', '4.1', '5.2', '6.2'].every((v) => levels.includes(v)), levels.join(' '));
check('frame rates include the fractional and high rates', ['23.976', '29.97', '59.94', '120'].every((v) => fpsList.includes(v)), fpsList.join(' '));
check('profiles include the x264 set', ['baseline', 'main', 'high', 'high10', 'high422', 'high444'].every((v) => optionsOf('profile').includes(v)), optionsOf('profile').join(' '));
check('audio sample rates cover 32 … 192 kHz', ['32000', '44100', '48000', '96000', '192000'].every((v) => optionsOf('audio_rate').includes(v)), optionsOf('audio_rate').join(' '));
const advFlagOptions = $$('#ff-editor-1-adv-flag option').map((o) => o.value).filter((v) => v.startsWith('-'));
check('advanced flag picker is filled from the schema', advFlagOptions.length >= 25, `${advFlagOptions.length} flags`);
check('advanced flags include the streaming-relevant ones',
  ['-probesize', '-analyzeduration', '-reconnect', '-mpegts_flags', '-hls_flags', '-max_muxing_queue_size', '-flush_packets', '-live', '-tune', '-preset'].every((f) => advFlagOptions.includes(f)),
  advFlagOptions.slice(0, 8).join(' '));

// The advice pane and the validator talk about “copy all”, so the Subtitles box
// must offer exactly that wording — the stored token (`keep`) is not a label an
// operator can map to a behaviour.
const subsOptions = [...($(`#ff-editor-1-ff-subs`)?.options || [])].map((o) => ({ value: o.value, label: o.textContent }));
check('the Subtitles box names the subtitle modes instead of the stored tokens',
  ['drop', 'dvb', 'keep'].every((v) => subsOptions.some((o) => o.value === v))
  && subsOptions.some((o) => o.value === 'keep' && /copy all/i.test(o.label))
  && subsOptions.some((o) => o.value === 'dvb' && /DVB/i.test(o.label))
  && subsOptions.some((o) => o.value === 'drop' && /drop/i.test(o.label)),
  subsOptions.map((o) => `${o.value}=${o.label}`).join(' | '));
check('a field whose choices are validated offers no “custom value…” box',
  !subsOptions.some((o) => o.value === '__custom__') && !$('#ff-editor-1-ff-subs-custom'),
  subsOptions.map((o) => o.value).join(','));

/* ---------------- 13. the test pane shows the raw ffmpeg output ---------------- */

// The rules the output pane applies to each line it receives. They are pure
// functions on the editor object, so they can be checked without running ffmpeg.
const forDisplay = (line, source) => window.VMFfmpegEditor.testLineForDisplay(line, source);
const longLine = `[https @ 0x55] HTTP error 403 — url=https://cdn.example/movie.mp4?token=${'a'.repeat(1200)}`;
check('a long real ffmpeg line reaches the pane untouched', forDisplay(longLine) === longLine,
  `${longLine.length} chars in, ${String(forDisplay(longLine)).length} out`);
check('a plain stderr line is printed as-is', forDisplay('Stream #0:0: Video: h264 (High), 1920x1080') === 'Stream #0:0: Video: h264 (High), 1920x1080');
check('a -progress line is part of the raw output', forDisplay('frame=120') === 'frame=120' && forDisplay('speed=1.02x') === 'speed=1.02x');
check('only non-text bytes are summarised, and the note names the right pipe',
  /non-text output suppressed/.test(forDisplay(`x\u0000${'y'.repeat(10)}`))
  && /pipe:1/.test(forDisplay(`x\u0000${'y'.repeat(10)}`, 'stdout'))
  && !/pipe:1/.test(forDisplay(`x\u0000${'y'.repeat(10)}`, 'stderr')),
  forDisplay(`x\u0000${'y'.repeat(10)}`, 'stderr'));
check('the placeholder promises the raw output', /raw ffmpeg output/.test($('#ff-editor-1-test-output')?.textContent || ''),
  $('#ff-editor-1-test-output')?.textContent?.slice(0, 60));

check('no runtime errors collected', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`\n${failures ? `✗ ${failures} check(s) failed` : '✓ all checks passed'} — ${calls.length} API calls`);
process.exit(failures ? 1 : 0);
