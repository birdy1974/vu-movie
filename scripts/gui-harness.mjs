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

/* ---------------- mocked API data ---------------- */

let playlistItems = [
  { streamId: 's1', enabled: true, templateId: 'tpl-a', title: 'Dune: Part Two', year: 2024, kind: 'movie', sourceId: 'overlook', quality: '1080p', hasTemplate: true, profileTemplateName: 'VAAPI 1080p → MPEG-TS', urls: { ts: 'http://h/pl/tok/a.ts', mkv: 'http://h/pl/tok/a.mkv', hls: 'http://h/pl/tok/a.m3u8', playlist: 'http://h/pl/tok/a.m3u', forBox: 'http://h/pl/tok/bouquet.tv', direct: 'http://h/pl/tok/a?direct=1', download: 'http://h/pl/tok/a.dl', watch: 'http://h/pl/tok/watch/a', directNote: 'expires in 4 h' }, order: 0 },
  { streamId: 's2', enabled: true, templateId: '', title: 'Alien: Romulus', year: 2024, kind: 'movie', sourceId: 'cinevo', quality: '720p', hasTemplate: false, urls: { ts: 'http://h/pl/tok/b.ts', watch: 'http://h/pl/tok/watch/b' }, order: 1 },
  { streamId: 's3', enabled: false, templateId: '', title: 'Blade Runner 2049', year: 2017, kind: 'movie', sourceId: 'flixhub', quality: '1080p', session: { clients: 1 }, urls: { ts: 'http://h/pl/tok/c.ts' }, order: 2 },
];
const templates = [
  { id: 'tpl-a', name: 'VAAPI 1080p → MPEG-TS', container: 'mpegts', enabled: true, isDefault: true, command: 'ffmpeg -hide_banner -i <url> -c copy -f mpegts pipe:1', options: { output_format: 'mpegts', hw_accel: 'none', video_codec: 'copy', audio_codec: 'copy' } },
  { id: 'tpl-b', name: 'Passthrough remux', container: 'matroska', enabled: true, isDefault: false, command: 'ffmpeg -hide_banner -i <url> -c copy -f matroska pipe:1', options: { output_format: 'matroska', hw_accel: 'none', video_codec: 'copy', audio_codec: 'copy' } },
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
const schemaFields = [
  { key: 'hw_accel', label: 'Hardware acceleration', kind: 'enum', options: ['none', 'vaapi', 'qsv'], help: 'none keeps everything in software.' },
  { key: 'resolution', label: 'Resolution cap', kind: 'resolution', options: ['source', '720p', '1080p'], help: 'The longest edge of the output.' },
  { key: 'video_codec', label: 'Video codec', kind: 'enum', options: ['copy', 'libx264', 'h264_vaapi'], help: 'copy needs no CPU.' },
  { key: 'video_bitrate', label: 'Video bitrate', kind: 'rate', help: 'Target bitrate in kbps.' },
  { key: 'audio_codec', label: 'Audio codec', kind: 'enum', options: ['copy', 'aac'], help: 'aac re-encodes the audio.' },
  { key: 'subs', label: 'Subtitles', kind: 'enum', options: ['drop', 'dvb', 'keep'], help: 'keep only works in Matroska.' },
  { key: 'output_format', label: 'Output format', kind: 'enum', options: ['mpegts', 'matroska', 'hls'], help: 'mpegts is the live path.' },
];
const inlineSchema = {
  fields: schemaFields.map((f, i) => ({ ...f, choices: f.options, group: i < 4 ? 'video' : i === 4 ? 'audio' : i === 5 ? 'subtitles' : 'output' })),
  groups: [{ id: 'video', label: 'Video' }, { id: 'audio', label: 'Audio' }, { id: 'subtitles', label: 'Subtitles' }, { id: 'output', label: 'Output' }],
  advanced: [],
  vfPresets: [],
  defaults: {},
};

/* ---------------- mocked API ---------------- */

async function fetchMock(url, options = {}) {
  const u = String(url);
  const method = (options.method || 'GET').toUpperCase();
  calls.push(`${method} ${u}`);
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.startsWith('/api/health')) return json({ ok: true, version: '1.0.0', uptimeSec: 12, ffmpeg: { ok: true, version: '6.1' }, hwaccel: { available: false, reason: 'no /dev/dri' }, postgres: false, enigma2: { configured: false } });
  if (u.startsWith('/api/jobs')) return json({ ok: true, jobs: [] });
  if (u.startsWith('/api/streams') && method === 'GET') return json({ ok: true, streams: playlistItems.map((i) => ({ id: i.streamId, title: i.title, year: i.year, upstream: { quality: i.quality } })) });
  if (u.startsWith('/api/streams') && method === 'POST') return json({ ok: true, stream: { id: 'new1', title: 'New' }, urls: {} });
  if (u.startsWith('/api/sources')) return json({ ok: true, sources: [] });
  if (u.startsWith('/api/config/hwaccel')) return json({ ok: true, hwaccel: { available: false, reason: 'no /dev/dri' } });
  if (u.startsWith('/api/config')) return json({ ok: true, config: {
    app: { port: 8080, baseUrl: '', username: '', password: '••••••', logLevel: 'info', tokenTtlMinutes: 4320 },
    transcode: { mode: 'auto', resolution: 1080, aspect: 'source', videoBitrate: 8000, audioBitrate: 192, audioChannels: 6, fps: '25', container: 'mpegts', alwaysTranscode: false, hardware: true, maxConcurrent: 1, device: '/dev/dri/renderD128', idleStopSeconds: 45, encoderFallback: 'x264', realtime: true },
    subtitles: { languages: ['nl', 'en'], autoSearch: true, pushToReceiver: false, receiverDir: '/media/hdd', disabledProviders: [] },
    enigma2: { host: '', port: 80, username: 'root', password: '••••', bouquetName: 'vu-movie', rootDir: '/etc/enigma2', serviceType: 4097, ftpEnabled: true, ftpPort: 21, autoPush: false },
    scraper: { browserConcurrency: 1, browserIdleSeconds: 180, resolveTimeoutMs: 45000, probeCandidates: true, maxCandidates: 12, flaresolverrUrl: '', externalExtractorUrl: '', sessionDir: '/data/sessions', userAgent: 'Mozilla/5.0' },
    storage: { downloads: '/downloads', tmp: '/tmp', cacheBudgetMb: 2048 },
  } });
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
for (const file of ['core.js', 'playlist.js', 'ffmpeg-editor.js', 'app.js']) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/<\/script/gi, '<\\/script');
  const tag = `<script src="/${file}"></script>`;
  if (!html.includes(tag)) throw new Error(`script tag not found: ${tag}`);
  // NB: function replacer — a string replacement would eat "$$" in the code.
  html = html.replace(tag, () => `<script>${code}</script>`);
}

const dom = new JSDOM(html, {
  url: 'http://127.0.0.1:8080/#dash',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = fetchMock;
    window.Response = Response;
    window.EventSource = class { constructor() { this.readyState = 0; } addEventListener() {} close() {} };
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
folds[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('folding hides the pane body', mobSearchBody.classList.contains('hide'));
check('fold state persists', JSON.parse(window.localStorage.getItem('vu-movie.folded') || '{}')['mob-search'] === true,
  String(window.localStorage.getItem('vu-movie.folded')));
folds[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('unfolding shows it again', !mobSearchBody.classList.contains('hide'));

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

/* ---------------- 7. playlist drag & drop ---------------- */

await window.App.go('list');
await tick(150);
const rows = $$('#playlist-items .pl-row');
check('playlist rendered with 3 rows', rows.length === 3, `${rows.length}`);
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

/* ---------------- 4. settings: sections + custom subtitle source ---------------- */

await window.App.go('set');
await tick(150);
const sectionCards = $$('#settings-grid [data-set-section]').map((c) => c.dataset.setSection);
if (!sectionCards.length) console.log('DEBUG settings-grid:', $('#settings-grid')?.innerHTML.slice(0, 400));
check('old settings sections are back', ['transcode', 'subtitles', 'enigma2', 'scraper', 'storage', 'app'].every((k) => sectionCards.includes(k)), sectionCards.join(','));
const setInputs = $$('#settings-grid input,#settings-grid select');
check('settings fields rendered', setInputs.length >= 40, `${setInputs.length} controls`);
const rawKeys = /^(mode|resolution|aspect|videoBitrate|audioBitrate|audioChannels|fps|container|alwaysTranscode|hardware|maxConcurrent|device|idleStopSeconds|encoderFallback|realtime|languages|autoSearch|pushToReceiver|receiverDir|disabledProviders|host|port|username|password|bouquetName|rootDir|serviceType|ftpEnabled|ftpPort|autoPush|browserConcurrency|browserIdleSeconds|resolveTimeoutMs|probeCandidates|maxCandidates|flaresolverrUrl|externalExtractorUrl|sessionDir|userAgent|downloads|tmp|cacheBudgetMb|baseUrl|logLevel|tokenTtlMinutes)$/;
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
check('no runtime errors collected', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`\n${failures ? `✗ ${failures} check(s) failed` : '✓ all checks passed'} — ${calls.length} API calls`);
process.exit(failures ? 1 : 0);
