/* vu-movie — UI logic (no framework, no build step, one file). */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const RESULT_VIEW_KEY = 'vu-movie.search-results-view';
const SEARCH_STATE_KEY = 'vu-movie.search-state.v1';
const ACTIVE_PAGE_KEY = 'vu-movie.active-page';
const SELECTED_STREAM_KEY = 'vu-movie.selected-stream';
const APP_PAGES = ['dash', 'find', 'stream', 'subs', 'e2', 'tpl', 'tpl-test', 'logs', 'set'];
const OUTPUT_LABELS = {
  vlcTs: 'VLC / any player (.ts)',
  vlcMkv: 'VLC / any player (.mkv)',
  m3u8: 'Playlist (.m3u8)',
  m3u: 'Playlist (.m3u)',
  enigma2: 'Enigma2 / Duo2',
  direct: 'Direct upstream link (302)',
  download: 'Download to NAS',
};
const OUTPUT_TYPES = ['vlcTs', 'vlcMkv', 'm3u8', 'm3u', 'enigma2', 'direct', 'download'];
const FIND_TABS = ['title', 'url', 'browse'];
const RESULT_VIEWS = ['list', 'poster', 'thumbnails'];

function readStoredJson(key) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch { return null; }
}

function readStoredText(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function getInitialResultsView() {
  try {
    const saved = localStorage.getItem(RESULT_VIEW_KEY);
    return RESULT_VIEWS.includes(saved) ? saved : 'poster';
  } catch {
    return 'poster';
  }
}

const state = {
  health: null,
  sources: [],
  selectedSources: [],
  results: [],
  providerErrors: [],
  resultsView: getInitialResultsView(),
  selected: null,
  selectedSeason: 0,
  selectedEpisode: 0,
  selectedSeasons: [],
  candidates: [],
  stream: null,
  streams: [],
  providers: [],
  subResults: [],
  findSubtitleResults: [],
  selectedSubtitle: null,
  config: null,
  logs: [],
  jobs: [],
  sessions: [],
  ffmpegTemplates: [],
  ffmpegTemplatesLoaded: false,
  defaultFfmpegTemplateId: '',
  pendingRestoreSelection: false,
  pendingRestoreUrlResolve: false,
  lastResolveMode: '',
};

let searchRequestId = 0;
let selectionRequestId = 0;
let detailRequestId = 0;
let resolveRequestId = 0;
let streamRequestId = 0;
let findSubtitleRequestId = 0;
let searchAbortController = null;
let detailAbortController = null;
let resolveAbortController = null;

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.name === 'CanceledError';
}

function invalidateSelectionRequests() {
  selectionRequestId += 1;
  detailRequestId += 1;
  resolveRequestId += 1;
  detailAbortController?.abort();
  resolveAbortController?.abort();
  detailAbortController = null;
  resolveAbortController = null;
  return selectionRequestId;
}

/* ---------------- tiny helpers ---------------- */

async function api(path, opts = {}) {
  const { silent = false, ...fetchOptions } = opts;
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(fetchOptions.headers || {}) },
    ...fetchOptions,
    body: fetchOptions.body ? (typeof fetchOptions.body === 'string' ? fetchOptions.body : JSON.stringify(fetchOptions.body)) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = { ok: false, error: `invalid JSON (HTTP ${res.status})` }; }
  if (!res.ok || data?.ok === false) {
    const message = data?.error || `HTTP ${res.status}`;
    if (!silent) toast(`${path}: ${message}`, 'err');
    throw new Error(message);
  }
  return data;
}

function toast(message, kind = 'info', ms = 6000) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('#toasts').appendChild(node);
  setTimeout(() => node.remove(), ms);
}

const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => (n > 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n > 1048576 ? `${(n / 1048576).toFixed(0)} MB` : `${Math.round((n || 0) / 1024)} KB`);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '—');
const tag = (text, kind = '') => `<span class="tag ${kind}">${escapeHtml(text)}</span>`;

/* ---------------- navigation ---------------- */

function go(page) {
  if (!APP_PAGES.includes(page)) return;
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.p === page));
  $$('main > section').forEach((s) => s.classList.toggle('hide', s.id !== `p-${page}`));
  try { localStorage.setItem(ACTIVE_PAGE_KEY, page); } catch { /* storage may be disabled */ }
  if (page === 'dash') { loadHealth(); loadJobs(); loadStreams(); }
  // If this is the first visit after upgrading (or browser storage was cleared),
  // the most recently saved stream is a useful fallback for an empty Stream tab.
  if (page === 'stream' && !state.stream && !readStoredText(SELECTED_STREAM_KEY) && state.streams[0]?.id) {
    openStream(state.streams[0].id, { navigate: false });
  }
  // openStream() normally navigates after fetching; the fallback above opts out
  // of navigation so it cannot re-enter go('stream') recursively.
  if (page === 'find' && state.pendingRestoreUrlResolve) {
    state.pendingRestoreUrlResolve = false;
    doResolveFromUrl();
  } else if (page === 'find' && state.pendingRestoreSelection) {
    state.pendingRestoreSelection = false;
    const selectedIndex = state.results.indexOf(state.selected);
    if (selectedIndex >= 0) selectResult(selectedIndex);
  }
  if (page === 'logs') loadLogs();
  if (page === 'set') loadSettings();
  if (page === 'e2') loadEnigmaForm();
  if (page === 'subs') loadProviders();
  if (page === 'tpl') { loadFfmpegTemplates().then(renderTemplatesPage); }
  if (page === 'tpl-test') { Promise.all([loadFfmpegTemplates(), loadStreams()]).then(loadTplTestStreams); }
}
$$('#nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.p)));

/* ================= DASHBOARD ================= */

function dot(state_) {
  return state_ === true ? 'ok' : state_ === false ? 'err' : 'warn';
}

async function loadHealth() {
  try {
    const { health } = { health: await api('/api/health') };
    state.health = health;
    const h = health;
    $('#h-ffmpeg').className = `dot ${dot(h.ffmpeg?.ok)}`;
    $('#h-hw').className = `dot ${dot(h.hwaccel?.available)}`;
    $('#h-db').className = `dot ${h.postgres ? 'ok' : 'warn'}`;
    $('#h-box').className = `dot ${h.enigma2?.configured ? dot(h.enigma2.ok) : 'warn'}`;
    $('#side-info').innerHTML = `v${h.version} · up ${h.uptimeSec}s<br>${escapeHtml(h.hwaccel?.available ? `${h.hwaccel.driver || 'vaapi'} (H.264 enc)` : (h.hwaccel?.reason || 'no hardware accel'))}<br>${h.postgres ? 'postgres connected' : 'in-memory store'}`;

    // While the first hardware self-test is still running, say so instead of
    // showing an alarming "unavailable" — a slow GPU is not a broken GPU.
    const hwPending = Boolean(h.hwaccelPending || h.hwaccel?.pending);
    const ffmpegRow = h.ffmpeg?.ok
      ? `${h.ffmpeg.version}${h.ffmpeg.elapsedMs >= 1000 ? ` (${h.ffmpeg.elapsedMs} ms)` : ''}`
      : h.ffmpeg?.pending ? 'checking…'
        : h.ffmpeg?.kind === 'timeout'
          ? `not answering (timeout — retrying automatically; ${h.ffmpeg.error || ''})`
          : `MISSING (${h.ffmpeg?.error || 'not found'})`;

    const cards = [
      {
        title: 'Hardware transcode',
        rows: [
          ['/dev/dri device', hwPending ? 'checking…' : (h.hwaccel?.devicePresent ? 'present' : 'missing'), hwPending ? null : h.hwaccel?.devicePresent],
          ['vaapi', hwPending ? 'self-test running…' : (h.hwaccel?.available ? `yes (variant ${h.hwaccel.fpsVariant})` : (h.hwaccel?.reason || 'unavailable')), hwPending ? null : h.hwaccel?.available],
          ['H.264 encode', h.hwaccel?.h264Encode ? 'yes' : 'unknown', h.hwaccel?.h264Encode],
          ['HEVC encode', h.hwaccel?.hevcEncode ? 'yes' : 'no (decode only)', h.hwaccel?.hevcEncode],
          ['libva driver', h.hwaccel?.libvaDriver || h.hwaccel?.driver || '—', null],
        ],
      },
      {
        title: 'Runtime',
        rows: [
          ['ffmpeg', ffmpegRow, h.ffmpeg?.pending ? null : h.ffmpeg?.ok],
          ['ffprobe', h.ffprobe?.ok ? 'ok' : (h.ffprobe?.pending ? 'checking…' : 'missing'), h.ffprobe?.pending ? null : h.ffprobe?.ok],
          ['chromium', h.browser?.available ? `running (${h.browser.activePages} page)` : (h.browser?.executable ? 'idle, ready' : 'not installed'), h.browser?.executable ? true : false],
          ['external extractor', h.externalExtractor ? 'configured' : 'not used', null],
          ['node', h.node, null],
        ],
      },
      {
        title: 'Storage & database',
        rows: [
          ['postgres', h.postgres ? 'connected (tables migrated)' : 'memory fallback', h.postgres],
          ['database url', h.db?.lastError ? `error: ${h.db.lastError}` : 'ok', h.db?.lastError ? false : null],
          ['streams', String(h.streamSessions?.length ?? 0), null],
        ],
      },
      {
        title: 'VU+ Duo2 (Enigma2)',
        rows: [
          ['configured', h.enigma2?.configured ? 'yes' : 'no (set host in Settings)', h.enigma2?.configured],
          // The health endpoint never polls the box, so say when the answer is
          // from and that it is a last-known value, not a fresh probe.
          ['reachable', h.enigma2?.message || '—', h.enigma2?.ok === null ? null : h.enigma2?.ok],
          ['model', h.enigma2?.model || '—', null],
          ['last checked', h.enigma2?.checked ? `${h.enigma2.ageMs != null ? Math.round(h.enigma2.ageMs / 1000) : '?'}s ago (on demand only)` : 'never', null],
        ],
      },
    ];
    $('#dash-cards').innerHTML = cards.map((c) => `
      <div class="card">
        <h3>${escapeHtml(c.title)}</h3>
        ${c.rows.map(([k, v, ok]) => `<div class="kv"><span>${escapeHtml(k)}</span>
          <span>${ok === null ? '' : `<i class="dot ${dot(ok)}" style="margin-right:6px"></i>`}${escapeHtml(String(v))}</span></div>`).join('')}
      </div>`).join('');

    renderSessions(h.streamSessions || []);
    const healthById = Object.fromEntries((h.sources || []).map((s) => [s.id, s.health]));
    state.sources.forEach((s) => { s.health = healthById[s.id] || s.health; });
    renderSourceHealth();
  } catch (err) {
    $('#dash-cards').innerHTML = `<div class="card"><h3>Backend unreachable</h3><div class="meta">${escapeHtml(err.message)}</div></div>`;
  }
}

function renderSessions(sessions) {
  state.sessions = sessions;
  $('#dash-sessions').innerHTML = sessions.length
    ? sessions.map((s) => `<div class="kv"><span>${escapeHtml(s.streamId)} <span class="mut">${s.mode}/${s.encoder}</span></span>
        <span>${s.clients} client(s) · ${s.bytesOut ? fmtBytes(s.bytesOut) : '0'} ${s.stats?.speed ? `· ${s.stats.speed}` : ''}</span></div>`).join('')
    : '<div class="meta">none</div>';
  if (state.stream?.id) {
    const mine = sessions.find((s) => s.streamId === state.stream.id);
    renderMonitor(mine);
  }
}

function renderSourceHealth() {
  $('#dash-sources').innerHTML = state.sources.map((s) => `
    <div class="srcrow">
      <div><b>${escapeHtml(s.name)}</b> <span class="mut" style="font-size:11px">${escapeHtml(s.kind)}</span></div>
      <div>${s.health?.ok === true ? tag(s.health.message || 'ok', 'ok') : s.health?.checks ? tag(s.health.message || 'failing', 'err') : tag('unused')}
        <a href="${escapeHtml(s.home)}" target="_blank" rel="noreferrer">open ↗</a></div>
    </div>`).join('') || '<div class="meta">no sources</div>';
}

async function loadJobs() {
  try {
    const { jobs } = await api('/api/jobs?limit=25');
    state.jobs = jobs;
    $('#dash-jobs').innerHTML = jobs.length ? `<table>
      <thead><tr><th>Job</th><th>Type</th><th>Progress</th><th>State</th><th></th></tr></thead><tbody>
      ${jobs.map((j) => `<tr>
        <td>${escapeHtml(j.title)}<div class="meta">${escapeHtml(j.message || '')}</div></td>
        <td>${tag(j.type, j.type === 'download' ? 'info' : 'alt')}</td>
        <td><div class="bars" style="height:10px">${Array.from({ length: 12 }, (_, i) => `<i style="height:${i < Math.round(j.progress / 8.4) ? 10 : 3}px"></i>`).join('')}</div>
          <div class="meta">${j.progress}%</div></td>
        <td>${tag(j.status, j.status === 'failed' ? 'err' : j.status === 'done' ? 'ok' : j.status === 'running' ? 'info' : '')}</td>
        <td>${j.status === 'running' || j.status === 'queued' ? `<button class="btn sm ghost" onclick="App.cancelJob('${j.id}')">cancel</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="meta" style="padding:14px">no jobs</div>';
  } catch { /* toast already shown */ }
}

async function loadStreams() {
  const { streams } = await api('/api/streams');
  state.streams = streams;
  if (!state.stream && !readStoredText(SELECTED_STREAM_KEY) && streams[0]?.id
      && !$('#p-stream').classList.contains('hide')) {
    openStream(streams[0].id, { navigate: false, silent: true });
  }
  $('#dash-stream-count').textContent = `${streams.length} saved`;
  $('#dash-streams').innerHTML = streams.length ? `<table>
    <thead><tr><th>Title</th><th>Source</th><th>Quality</th><th>Mode</th><th>Created</th><th></th></tr></thead><tbody>
    ${streams.map((s) => `<tr>
      <td>${escapeHtml(s.title)}${s.year ? ` <span class="mut">(${s.year})</span>` : ''}</td>
      <td>${tag(s.sourceId || '—')}</td><td>${tag(s.quality || '—', 'ok')}</td>
      <td>${tag(s.transcode ? 'transcode' : 'copy', s.transcode ? 'alt' : 'ok')}</td>
      <td class="mut">${fmtTime(s.createdAt)}</td>
      <td><button class="btn sm" onclick="App.openStream('${s.id}')">open</button></td>
    </tr>`).join('')}</tbody></table>` : '<div class="meta" style="padding:14px">no streams yet</div>';
}

/* ================= FIND / SCRAPE ================= */

function setFindTab(tab, persist = true) {
  if (!FIND_TABS.includes(tab)) return;
  $$('#find-tabs button').forEach((button) => button.classList.toggle('on', button.dataset.t === tab));
  FIND_TABS.forEach((name) => $(`#tab-${name}`).classList.toggle('hide', name !== tab));
  if (persist) saveSearchState();
}

$$('#find-tabs button').forEach((button) => button.addEventListener('click', () => setFindTab(button.dataset.t)));

async function loadSources() {
  const { sources } = await api('/api/sources');
  state.sources = sources;
  if (!state.selectedSources.length) state.selectedSources = sources.filter((s) => s.enabled).map((s) => s.id);
  $('#source-chips').innerHTML = sources.map((s) => `
    <span class="chip ${state.selectedSources.includes(s.id) ? 'on' : ''}" data-id="${s.id}">
      ${escapeHtml(s.name)}${s.health?.ok === false ? ' ⚠' : ''}</span>`).join('');
  $$('#source-chips .chip').forEach((chip) => chip.addEventListener('click', () => {
    const id = chip.dataset.id;
    state.selectedSources = state.selectedSources.includes(id)
      ? state.selectedSources.filter((x) => x !== id)
      : [...state.selectedSources, id];
    chip.classList.toggle('on');
    saveSearchState();
  }));
  $('#browse-links').innerHTML = sources.map((s) => `<a class="btn sm" href="${escapeHtml(s.home)}" target="_blank" rel="noreferrer">${escapeHtml(s.name)} ↗</a>`).join('');
  if (state.results.length) {
    updateResultProviderFilter();
    renderResults();
  }
  renderSourceHealth();
}

function renderProviderErrors(errors = []) {
  state.providerErrors = Array.isArray(errors) ? errors : [];
  const node = $('#find-errors');
  if (!state.providerErrors.length) {
    node.classList.add('hide');
    node.innerHTML = '';
    return;
  }
  node.innerHTML = `<b>${state.providerErrors.length} search provider${state.providerErrors.length === 1 ? '' : 's'} unavailable:</b><ul>${state.providerErrors
    .map((entry) => `<li><b>${escapeHtml(entry.sourceName || entry.sourceId || 'Provider')}:</b> ${escapeHtml(entry.error || 'request failed')}</li>`)
    .join('')}</ul>`;
  node.classList.remove('hide');
}

function currentSubtitleTarget() {
  const selected = state.selected || {};
  const findTab = $('#find-tabs button.on')?.dataset.t || 'title';
  const urlForm = findTab === 'url';
  const title = String(selected.title || (urlForm ? $('#u-title').value : '') || '').trim();
  if (!title) return null;
  const requestedKind = urlForm ? $('#u-kind').value : $('#q-type').value;
  const kind = ['movie', 'series'].includes(selected.kind)
    ? selected.kind
    : ['movie', 'series'].includes(requestedKind) ? requestedKind : 'movie';
  const year = Number(selected.year) || (urlForm ? Number($('#u-year').value) : 0) || null;
  const season = kind === 'series'
    ? Number(state.selectedSeason || selected.selectedSeason || (urlForm ? $('#u-season').value : 0)) || 1
    : null;
  const episode = kind === 'series'
    ? Number(state.selectedEpisode || selected.selectedEpisode || (urlForm ? $('#u-episode').value : 0)) || 1
    : null;
  return {
    title,
    year,
    kind,
    season,
    episode,
    imdb: selected.imdb || selected.imdbId || selected.ids?.imdb || null,
    tmdb: selected.tmdb || selected.tmdbId || selected.ids?.tmdb || null,
    release: selected.release || selected.releaseName || null,
  };
}

function clearFindSubtitleSearch() {
  findSubtitleRequestId += 1;
  state.findSubtitleResults = [];
  state.selectedSubtitle = null;
  const panel = $('#sel-subtitle-panel');
  if (panel) panel.classList.add('hide');
  if ($('#sel-subtitle-count')) $('#sel-subtitle-count').textContent = '';
  if ($('#sel-subtitle-target')) $('#sel-subtitle-target').textContent = '';
  if ($('#sel-subtitle-results')) $('#sel-subtitle-results').innerHTML = '<div class="meta" style="padding:14px">no subtitle search yet</div>';
  if ($('#sel-subtitle-selection')) {
    $('#sel-subtitle-selection').textContent = '';
    $('#sel-subtitle-selection').classList.add('hide');
  }
}

function setFindSubtitlesAction() {
  if (!currentSubtitleTarget()) {
    $('#sel-actions').innerHTML = '';
    return;
  }
  $('#sel-actions').innerHTML = '<button class="btn" data-find-subtitles>▭ find subtitles</button>';
  $('#sel-actions [data-find-subtitles]').addEventListener('click', searchSelectedSubtitles);
}

function resetSelectedTitle() {
  clearFindSubtitleSearch();
  state.selected = null;
  if ($('#results-title-select')) $('#results-title-select').value = '';
  state.selectedSeason = 0;
  state.selectedEpisode = 0;
  state.selectedSeasons = [];
  state.candidates = [];
  $('#sel-name').textContent = 'nothing selected';
  $('#sel-meta').textContent = 'search or paste a URL, then pick a candidate below';
  $('#sel-poster').innerHTML = '<b>—</b>';
  $('#sel-details').innerHTML = '';
  $('#sel-details').classList.add('hide');
  $('#sel-episode-controls').classList.add('hide');
  $('#sel-actions').innerHTML = '';
  $('#sel-note').textContent = 'Select a title to load details and resolve its streams.';
  $('#candidates').innerHTML = '<div class="meta">No candidates yet.</div>';
}

async function searchSelectedSubtitles() {
  const target = currentSubtitleTarget();
  if (!target) return toast('Enter a title or title metadata before searching subtitles', 'warn');
  const requestId = ++findSubtitleRequestId;
  state.findSubtitleResults = [];
  state.selectedSubtitle = null;
  $('#sel-subtitle-panel').classList.remove('hide');
  $('#sel-subtitle-count').textContent = 'searching…';
  $('#sel-subtitle-target').textContent = `Searching ${target.title}${target.year ? ` (${target.year})` : ''}${target.kind === 'series' ? ` · S${target.season || '?'}E${target.episode || '?'}` : ''}`;
  $('#sel-subtitle-results').innerHTML = '<div class="meta" style="padding:14px"><span class="spin"></span> searching subtitle providers…</div>';
  $('#sel-subtitle-selection').textContent = '';
  $('#sel-subtitle-selection').classList.add('hide');
  try {
    const res = await api('/api/subtitles/search', { method: 'POST', body: target });
    if (requestId !== findSubtitleRequestId) return;
    state.findSubtitleResults = res.results || [];
    $('#sel-subtitle-count').textContent = `${state.findSubtitleResults.length} candidate${state.findSubtitleResults.length === 1 ? '' : 's'}`;
    renderFindSubtitleResults();
  } catch (error) {
    if (requestId !== findSubtitleRequestId) return;
    $('#sel-subtitle-count').textContent = 'search failed';
    $('#sel-subtitle-results').innerHTML = `<div class="note err" style="margin:12px">${escapeHtml(error?.message || 'Subtitle search failed')}</div>`;
  }
}

function renderFindSubtitleResults() {
  const results = state.findSubtitleResults || [];
  if (!results.length) {
    $('#sel-subtitle-results').innerHTML = '<div class="meta" style="padding:14px">No applicable subtitles found. Check the configured providers and languages.</div>';
    return;
  }
  $('#sel-subtitle-results').innerHTML = `<table>
    <thead><tr><th>Language</th><th>Provider</th><th>Release / match</th><th>Score</th><th>Downloads</th><th></th></tr></thead><tbody>
    ${results.slice(0, 40).map((result, index) => {
      const selected = state.selectedSubtitle === result;
      const matches = [
        result.hashMatch ? tag('hash match', 'ok') : '',
        result.episodeMatch ? tag('episode match', 'ok') : '',
        result.year ? tag(String(result.year)) : '',
      ].filter(Boolean).join(' ');
      const release = result.release || result.title || 'Untitled release';
      return `<tr${selected ? ' class="subtitle-choice-selected"' : ''}>
        <td>${tag((result.language || '?').toUpperCase(), (result.language || '').startsWith('nl') ? 'ok' : 'info')}</td>
        <td>${escapeHtml(result.providerId || '—')}</td>
        <td class="mono" style="font-size:11.5px">${escapeHtml(String(release).slice(0, 90))}${matches ? `<div style="margin-top:4px">${matches}</div>` : ''}</td>
        <td>${Number.isFinite(Number(result.score)) ? Number(result.score) : '—'}${result.rating ? `<div class="meta">rating ${escapeHtml(result.rating)}</div>` : ''}</td>
        <td class="mono">${Number(result.downloads) || 0}</td>
        <td><button class="btn sm ${selected ? 'pri' : ''}" data-select-subtitle="${index}">${selected ? 'selected' : 'select'}</button></td>
      </tr>`;
    }).join('')}</tbody></table>`;
  $$('#sel-subtitle-results button[data-select-subtitle]').forEach((button) => {
    button.addEventListener('click', () => chooseFindSubtitle(Number(button.dataset.selectSubtitle)));
  });
}

function matchingExistingStream(target) {
  const normalize = (value) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\b(?:19|20)\d{2}\b/g, '').replace(/[^a-z0-9]+/g, '');
  const candidates = [state.stream, ...(state.streams || [])].filter(Boolean);
  const seen = new Set();
  return candidates.find((stream) => {
    if (stream.id && seen.has(String(stream.id))) return false;
    if (stream.id) seen.add(String(stream.id));
    if (normalize(stream.title) !== normalize(target.title)) return false;
    if (target.year && stream.year && Number(target.year) !== Number(stream.year)) return false;
    if (target.kind && stream.kind && target.kind !== stream.kind) return false;
    if (target.kind === 'series') {
      const season = stream.upstream?.season ?? stream.season;
      const episode = stream.upstream?.episode ?? stream.episode;
      if (target.season && Number(season) !== Number(target.season)) return false;
      if (target.episode && Number(episode) !== Number(target.episode)) return false;
    }
    return true;
  }) || null;
}

async function chooseFindSubtitle(index) {
  const result = state.findSubtitleResults[index];
  if (!result) return;
  state.selectedSubtitle = result;
  renderFindSubtitleResults();
  const target = currentSubtitleTarget();
  const existingStream = target && matchingExistingStream(target);
  if (!existingStream) {
    $('#sel-subtitle-selection').textContent = `Selected: ${result.release || result.title || result.providerId} · ${String(result.language || '?').toUpperCase()}. It will be attached when you create a stream for this title.`;
    $('#sel-subtitle-selection').classList.remove('hide');
    toast('Subtitle selected. It will be attached when you create this stream.', 'ok', 8000);
    return;
  }
  $('#sel-subtitle-selection').textContent = 'Selected subtitle is being downloaded and attached to the matching stream…';
  $('#sel-subtitle-selection').classList.remove('hide');
  const attached = await downloadSubtitle(result, existingStream.id);
  if (attached) {
    try { await loadStreams(); } catch { /* api() already shows the error */ }
  }
  $('#sel-subtitle-selection').textContent = attached
    ? `Attached: ${result.release || result.title || result.providerId} · ${String(result.language || '?').toUpperCase()}`
    : `Could not attach ${result.release || result.title || result.providerId}. See the error notification for details.`;
}

async function doSearch() {
  const query = $('#q').value.trim();
  if (!query) return toast('Enter a title first', 'warn');
  state.lastResolveMode = 'search';
  state.pendingRestoreUrlResolve = false;

  searchAbortController?.abort();
  const controller = new AbortController();
  searchAbortController = controller;
  const requestId = ++searchRequestId;
  invalidateSelectionRequests();
  resetSelectedTitle();
  state.results = [];
  resetResultFilters();
  renderProviderErrors([]);
  $('#results-count').textContent = '';
  $('#results').innerHTML = '<div class="meta"><span class="spin"></span> searching…</div>';
  $('#find-hint').innerHTML = '<span class="spin"></span> searching…';

  try {
    const params = new URLSearchParams({
      q: query,
      type: $('#q-type').value,
      sources: state.selectedSources.join(','),
      moviebox: String($('#q-moviebox').checked),
    });
    const res = await api(`/api/find/search?${params}`, { signal: controller.signal, silent: true });
    if (requestId !== searchRequestId || controller.signal.aborted) return;
    state.results = Array.isArray(res.results) ? res.results : [];
    resetResultFilters();
    renderProviderErrors(res.providerErrors || []);
    renderResults();
    const titleCount = groupSearchResults(state.results).length;
    const failures = state.providerErrors.length;
    $('#find-hint').textContent = `${titleCount} title${titleCount === 1 ? '' : 's'} · ${state.results.length} provider result${state.results.length === 1 ? '' : 's'}${failures ? ` · ${failures} provider failure${failures === 1 ? '' : 's'}` : ''}`;
  } catch (err) {
    if (requestId !== searchRequestId || controller.signal.aborted || isAbortError(err)) return;
    renderProviderErrors([{ sourceName: 'Search service', error: err.message }]);
    $('#results-count').textContent = 'Search failed';
    $('#results').innerHTML = `<div class="note err">Search failed: ${escapeHtml(err.message)}. Check the search service and provider connectivity, then retry.</div>`;
    $('#find-hint').textContent = 'Search failed';
  } finally {
    if (requestId === searchRequestId) {
      if (searchAbortController === controller) searchAbortController = null;
      if ($('#find-hint').textContent.includes('searching…')) $('#find-hint').textContent = 'Search cancelled';
      saveSearchState();
    }
  }
}

function safePosterUrl(value, resultUrl = '') {
  if (!value) return '';
  try {
    const text = String(value);
    const isRelative = /^(?:\/|\.\/|\.\.\/)/.test(text);
    const base = !isRelative && /^https?:/i.test(String(resultUrl)) ? resultUrl : window.location.href;
    const url = new URL(text, base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function attachPosterImageFallbacks(root = document) {
  root.querySelectorAll('.result-poster img, #sel-poster img').forEach((img) => {
    img.addEventListener('error', () => img.remove(), { once: true });
  });
}

function resultPosterMarkup(result, compact = false) {
  const words = String(result.title || '').trim().split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map((word) => word[0]).join('').toUpperCase() || '▶';
  const posterUrl = safePosterUrl(result.poster, result.url);
  return `<div class="poster result-poster${compact ? ' compact' : ''}">
    <span class="poster-fallback" aria-hidden="true">${escapeHtml(initials)}</span>
    ${posterUrl ? `<img src="${escapeHtml(posterUrl)}" alt="" loading="lazy" decoding="async">` : ''}
    <span class="tag ok badge">${escapeHtml(result.kind || 'title')}</span>
  </div>`;
}

function formatRuntime(minutes) {
  const total = Number(minutes);
  if (!Number.isInteger(total) || total <= 0) return '';
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const remainder = total % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function resultMetaMarkup(result, includeKind = true, includeLanguage = false) {
  const parts = [];
  if (result.year) parts.push(String(result.year));
  if (includeKind && result.kind) parts.push(result.kind);
  if (result.sourceName) parts.push(result.sourceName);
  if (result.rating != null && Number.isFinite(Number(result.rating))) {
    const rating = Number(result.rating);
    parts.push(`★ ${Number.isInteger(rating) ? rating : rating.toFixed(1)}`);
  }
  const genres = Array.isArray(result.genres) ? result.genres : result.genres ? [result.genres] : [];
  if (genres.length) parts.push(`Genres: ${genres.slice(0, 4).join(', ')}`);
  const runtime = formatRuntime(result.runtime);
  if (runtime) parts.push(`Runtime: ${runtime}`);
  if (includeLanguage && result.language) parts.push(`Language: ${String(result.language).toUpperCase()}`);
  return parts.map((part) => `<span class="result-meta-item">${escapeHtml(part)}</span>`).join('');
}

function normalizeResultText(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function resultYearKey(result) {
  const explicitYear = Number(result?.year);
  if (Number.isFinite(explicitYear) && explicitYear > 0) return String(Math.floor(explicitYear));
  const title = String(result?.title || '');
  // Accept both "Title (2022)" and "Title 2022" (after normalizeResultText the
  // parens are already stripped to spaces, but we run the regex against the
  // raw title too so we don't miss the parenthetical form).
  const parentheticalYear = /\s*\(((?:19|20)\d{2})\)\s*$/.exec(title);
  if (parentheticalYear) return parentheticalYear[1];
  const bareYear = /\s+((?:19|20)\d{2})\s*$/.exec(normalizeResultText(title));
  return bareYear?.[1] || '';
}

function resultGroupingTitle(result, index) {
  let title = normalizeResultText(result?.title);
  const year = resultYearKey(result);
  if (year) title = title.replace(new RegExp(`\\s+${year}$`), '').trim();
  // Also strip common quality tags sites append to titles.
  title = title.replace(/\s+(?:hd|4k|uhd|1080p|720p|480p|free|online|watch|movie|series)$/, '').trim();
  return title || `untitled ${index}`;
}

function resultProviderKey(result) {
  return String(result?.sourceId || result?.sourceName || 'unknown').trim();
}

function groupSearchResults(results = state.results) {
  const buckets = new Map();
  results.forEach((result, index) => {
    if (!result || typeof result !== 'object') return;
    const titleKey = resultGroupingTitle(result, index);
    const kind = String(result.kind || 'title').toLowerCase();
    const key = `${kind}|${titleKey}`;
    if (!buckets.has(key)) buckets.set(key, { key, titleKey, kind, entries: [] });
    buckets.get(key).entries.push({ result, index });
  });

  const groups = [];
  const addGroup = (bucket, entries, year) => {
    if (!entries.length) return;
    groups.push({
      key: `${bucket.key}|${year || 'unknown'}`,
      titleKey: bucket.titleKey,
      kind: bucket.kind,
      year: year ? Number(year) : null,
      allResults: entries,
      matches: entries,
    });
  };

  for (const bucket of buckets.values()) {
    const years = [...new Set(bucket.entries.map(({ result }) => resultYearKey(result)).filter(Boolean))];
    const yearless = bucket.entries.filter(({ result }) => !resultYearKey(result));
    if (years.length <= 1) {
      // A missing year can join the only known edition, but never bridges two
      // different remakes with the same title.
      addGroup(bucket, bucket.entries, years[0] || '');
      continue;
    }
    // Multiple distinct years → each year gets its own card (remakes / show vs
    // movie with same title). Merge entries without a year into the year that
    // has the most provider results — that's almost always the same title
    // (sites that omit the year are usually scrapers missing metadata on a
    // single source, not an undiscovered edition).
    const counts = new Map();
    for (const year of years) {
      counts.set(year, bucket.entries.filter(({ result }) => resultYearKey(result) === year).length);
    }
    const majorityYear = [...counts.entries()].sort((a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0]))[0]?.[0];
    years.sort((a, b) => Number(b) - Number(a));
    for (const year of years) {
      const entries = bucket.entries.filter(({ result }) => resultYearKey(result) === year);
      // Merge the yearless entries into the most-numerous year group rather
      // than leaving them as an "unknown year" orphan.
      if (year === majorityYear && yearless.length) entries.push(...yearless);
      addGroup(bucket, entries, year);
    }
  }
  return groups;
}

function preferredResultEntry(entries) {
  const sourceOrder = new Map(state.sources.map((source, index) => [String(source.id), index]));
  return [...entries].sort((a, b) => {
    const posterOrder = Number(Boolean(b.result.poster)) - Number(Boolean(a.result.poster));
    if (posterOrder) return posterOrder;
    const rankA = sourceOrder.get(resultProviderKey(a.result)) ?? state.sources.length + 1;
    const rankB = sourceOrder.get(resultProviderKey(b.result)) ?? state.sources.length + 1;
    return rankA - rankB || a.index - b.index;
  })[0];
}

function updateResultProviderFilter() {
  const select = $('#results-provider-filter');
  if (!select) return;
  const selected = select.value;
  const providers = new Map();
  for (const result of state.results) {
    const id = resultProviderKey(result);
    if (!providers.has(id)) providers.set(id, { id, name: result.sourceName || id, count: 0 });
    providers.get(id).count += 1;
  }
  const sourceOrder = new Map(state.sources.map((source, index) => [String(source.id), index]));
  const ordered = [...providers.values()].sort((a, b) =>
    (sourceOrder.get(a.id) ?? state.sources.length + 1) - (sourceOrder.get(b.id) ?? state.sources.length + 1)
      || a.name.localeCompare(b.name));
  select.innerHTML = `<option value="">All providers</option>${ordered.map((provider) =>
    `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)} (${provider.count})</option>`).join('')}`;
  select.value = providers.has(selected) ? selected : '';
}

function resetResultFilters() {
  const title = $('#results-title-filter');
  const provider = $('#results-provider-filter');
  if (title) title.value = '';
  if (provider) provider.value = '';
  updateResultProviderFilter();
  updateResultTitleSelect();
}

function visibleResultGroups() {
  const titleFilter = normalizeResultText($('#results-title-filter')?.value);
  const providerFilter = $('#results-provider-filter')?.value || '';
  return groupSearchResults().map((group) => {
    const matches = group.allResults.filter((entry) =>
      !providerFilter || resultProviderKey(entry.result) === providerFilter);
    if (!matches.length) return null;
    if (titleFilter && !group.allResults.some((entry) =>
      normalizeResultText(entry.result.title).includes(titleFilter))) return null;
    return { ...group, matches };
  }).filter(Boolean);
}

function updateResultTitleSelect(groups = visibleResultGroups()) {
  const select = $('#results-title-select');
  if (!select) return;
  const previous = select.value;
  const options = groups.map((group) => {
    const primary = preferredResultEntry(group.matches);
    const result = primary?.result || {};
    const title = String(result.title || 'Untitled');
    const year = group.year && resultYearKey(result) !== String(group.year) ? ` (${group.year})` : '';
    const kind = ['movie', 'series'].includes(group.kind) ? ` · ${group.kind}` : '';
    const providerCount = new Set(group.matches.map((entry) => resultProviderKey(entry.result))).size;
    const providers = providerCount ? ` · ${providerCount} source${providerCount === 1 ? '' : 's'}` : '';
    return `<option value="${escapeHtml(group.key)}">${escapeHtml(`${title}${year}${kind}${providers}`)}</option>`;
  }).join('');
  select.innerHTML = `<option value="">Select a found title…</option>${options}`;
  const selectedGroup = groups.find((group) => group.allResults.some((entry) => entry.result === state.selected));
  const value = selectedGroup?.key || (groups.some((group) => group.key === previous) ? previous : '');
  select.value = value;
}

function providerChoicesMarkup(group) {
  const providers = new Map();
  for (const entry of group.matches) {
    const id = resultProviderKey(entry.result);
    if (!providers.has(id)) providers.set(id, { id, name: entry.result.sourceName || id, entries: [] });
    providers.get(id).entries.push(entry);
  }
  const choices = [...providers.values()].sort((a, b) => {
    const sourceOrder = new Map(state.sources.map((source, index) => [String(source.id), index]));
    return (sourceOrder.get(a.id) ?? state.sources.length + 1) - (sourceOrder.get(b.id) ?? state.sources.length + 1)
      || a.name.localeCompare(b.name);
  });
  return `<div class="moviecard-providers"><span class="moviecard-providers-label">Providers</span>${choices.map((provider) => {
    const entry = preferredResultEntry(provider.entries);
    const selected = provider.entries.some((candidate) => candidate.result === state.selected);
    return `<button type="button" class="provider-choice${selected ? ' on' : ''}"
      data-result-index="${entry.index}" aria-pressed="${selected}"
      title="Select ${escapeHtml(provider.name)} for this title">${escapeHtml(provider.name)}</button>`;
  }).join('')}</div>`;
}

function resultCardMarkup(group, view) {
  const primary = preferredResultEntry(group.matches);
  const rawResult = primary.result;
  const result = group.year && !resultYearKey(rawResult) ? { ...rawResult, year: group.year } : rawResult;
  const selected = group.allResults.some((entry) => entry.result === state.selected);
  const title = escapeHtml(result.title || 'Untitled');
  const metadataResult = { ...result, sourceName: '' };
  const metadata = resultMetaMarkup(metadataResult, view === 'thumbnails');
  const description = result.description
    ? `<div class="result-description">${escapeHtml(result.description)}</div>`
    : '';
  const copy = `<div class="moviecard-copy">
    <div class="moviecard-title" title="${title}">${title}</div>
    ${metadata ? `<div class="meta result-meta">${metadata}</div>` : ''}
    ${description}
  </div>`;
  const content = view === 'list'
    ? `${resultPosterMarkup(result, true)}${copy}<span class="result-kind">${tag(result.kind || 'title')}</span>`
    : view === 'thumbnails'
      ? `${resultPosterMarkup(result, true)}${copy}`
      : `${resultPosterMarkup(result)}${copy}`;
  const titleLabel = `${result.title || 'Untitled'}${group.year ? ` (${group.year})` : ''}`;
  const providerName = rawResult.sourceName || rawResult.sourceId || 'provider';
  const indices = group.allResults.map((entry) => entry.index).join(',');
  return `<article class="moviecard moviecard-${view}${selected ? ' sel' : ''}" data-result-indices="${indices}">
    <div class="moviecard-main moviecard-main-${view}" role="button" tabindex="0"
      data-result-index="${primary.index}" aria-pressed="${state.selected === rawResult}"
      aria-label="Select ${escapeHtml(titleLabel)} from ${escapeHtml(providerName)}">${content}</div>
    ${providerChoicesMarkup(group)}
  </article>`;
}

function updateResultsViewButtons() {
  $$('#results-view [data-view]').forEach((button) => {
    const active = button.dataset.view === state.resultsView;
    button.classList.toggle('on', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function setResultsView(view) {
  if (!RESULT_VIEWS.includes(view)) return;
  state.resultsView = view;
  try { localStorage.setItem(RESULT_VIEW_KEY, view); } catch { /* storage may be disabled */ }
  updateResultsViewButtons();
  renderResults();
}

function renderResults() {
  const results = $('#results');
  results.className = `results results-${state.resultsView}`;
  if (!state.results.length) {
    updateResultTitleSelect([]);
    $('#results-count').textContent = '0 titles';
    results.innerHTML = state.providerErrors.length
      ? '<div class="note err">Search returned no titles because one or more providers failed. See the provider errors above; this is not a confirmed no-results response.</div>'
      : '<div class="meta">No results. Try fewer sources, or use “Paste URL” with the movie page you have open.</div>';
    return;
  }
  const groups = visibleResultGroups();
  updateResultTitleSelect(groups);
  const matchCount = groups.reduce((sum, group) => sum + group.matches.length, 0);
  $('#results-count').textContent = `${groups.length} title${groups.length === 1 ? '' : 's'} · ${matchCount} provider result${matchCount === 1 ? '' : 's'}`;
  if (!groups.length) {
    results.innerHTML = '<div class="meta">No titles match these filters. Clear the title and provider filters to see all results.</div>';
    return;
  }
  results.innerHTML = `<div class="results-cards">${groups.map((group) => resultCardMarkup(group, state.resultsView)).join('')}</div>`;
  $$('#results .moviecard-main').forEach((main) => {
    const index = Number(main.dataset.resultIndex);
    main.addEventListener('click', () => selectResult(index));
    main.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectResult(index);
      }
    });
  });
  $$('#results .provider-choice').forEach((button) => {
    button.addEventListener('click', () => selectResult(Number(button.dataset.resultIndex)));
  });
  attachPosterImageFallbacks($('#results'));
}

function movieBoxTargetForResult(result) {
  const url = String(result?.url || '');
  const match = /^moviebox:\/\/subject\/([^/?#]+)/i.exec(url);
  const params = new URLSearchParams(url.split('?')[1]?.split('#')[0] || '');
  let subjectId = result?.movieboxSubjectId || match?.[1] || '';
  try { subjectId = decodeURIComponent(String(subjectId)); } catch { /* use the supplied id */ }
  return subjectId ? {
    subjectId: String(subjectId),
    season: Number(params.get('se')) || 0,
    episode: Number(params.get('ep')) || 0,
  } : null;
}

function renderSelectedInfo(result) {
  $('#sel-name').textContent = `${result.title}${result.year ? ` (${result.year})` : ''}`;
  const meta = resultMetaMarkup(result, true, true);
  $('#sel-meta').innerHTML = `${meta ? `<div class="result-meta">${meta}</div>` : ''}${result.url ? `<div class="selected-url mono" title="${escapeHtml(result.url)}">${escapeHtml(result.url)}</div>` : ''}`;
  const detailParts = [];
  if (result.releaseDate && String(result.releaseDate) !== String(result.year || '')) {
    detailParts.push(`<div class="selected-release">Release date: ${escapeHtml(result.releaseDate)}</div>`);
  }
  if (result.description) detailParts.push(`<p>${escapeHtml(result.description)}</p>`);
  $('#sel-details').innerHTML = detailParts.join('');
  $('#sel-details').classList.toggle('hide', detailParts.length === 0);
  const posterUrl = safePosterUrl(result.poster, result.url);
  $('#sel-poster').innerHTML = posterUrl
    ? `<img src="${escapeHtml(posterUrl)}" alt="" style="width:100%;border-radius:8px">`
    : `<b>${escapeHtml(result.title)}</b>`;
  attachPosterImageFallbacks($('#sel-poster'));
}

function saveSearchState() {
  const selectedIndex = state.selected ? state.results.indexOf(state.selected) : -1;
  const urlForm = {
    url: $('#u-url')?.value || '',
    title: $('#u-title')?.value || '',
    year: $('#u-year')?.value || '',
    kind: $('#u-kind')?.value || 'movie',
    season: $('#u-season')?.value || '',
    episode: $('#u-episode')?.value || '',
    browser: $('#u-browser')?.checked ?? true,
    probe: $('#u-probe')?.checked ?? true,
  };
  try {
    localStorage.setItem(SEARCH_STATE_KEY, JSON.stringify({
      query: $('#q')?.value || '',
      type: $('#q-type')?.value || '',
      selectedSources: state.selectedSources,
      moviebox: $('#q-moviebox')?.checked ?? true,
      results: state.results,
      providerErrors: state.providerErrors,
      selectedResultIndex: selectedIndex >= 0 ? selectedIndex : null,
      resolveMode: state.lastResolveMode,
      selectedSeason: state.selectedSeason,
      selectedEpisode: state.selectedEpisode,
      titleFilter: $('#results-title-filter')?.value || '',
      providerFilter: $('#results-provider-filter')?.value || '',
      findTab: $('#find-tabs button.on')?.dataset.t || 'title',
      urlForm,
    }));
  } catch { /* storage may be disabled or full */ }
}

function restoreSearchState(saved = readStoredJson(SEARCH_STATE_KEY)) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
  state.pendingRestoreSelection = false;
  state.pendingRestoreUrlResolve = false;
  state.lastResolveMode = saved.resolveMode === 'url' ? 'url' : '';

  $('#q').value = typeof saved.query === 'string' ? saved.query : '';
  if (['', 'movie', 'series'].includes(saved.type)) $('#q-type').value = saved.type;
  $('#q-moviebox').checked = saved.moviebox !== false;
  state.selectedSources = Array.isArray(saved.selectedSources)
    ? saved.selectedSources.filter((id) => typeof id === 'string')
    : [];
  state.results = Array.isArray(saved.results)
    ? saved.results.filter((result) => result && typeof result === 'object' && !Array.isArray(result))
    : [];
  state.providerErrors = Array.isArray(saved.providerErrors) ? saved.providerErrors : [];

  const selectedIndex = Number.isInteger(saved.selectedResultIndex)
    && saved.selectedResultIndex >= 0 && saved.selectedResultIndex < state.results.length
    ? saved.selectedResultIndex
    : -1;
  state.selected = selectedIndex >= 0 ? state.results[selectedIndex] : null;
  state.selectedSeason = Number(saved.selectedSeason) || 0;
  state.selectedEpisode = Number(saved.selectedEpisode) || 0;

  const urlForm = saved.urlForm && typeof saved.urlForm === 'object' ? saved.urlForm : {};
  $('#u-url').value = String(urlForm.url || '');
  $('#u-title').value = String(urlForm.title || '');
  $('#u-year').value = String(urlForm.year || '');
  $('#u-kind').value = urlForm.kind === 'series' ? 'series' : 'movie';
  $('#u-season').value = String(urlForm.season || '');
  $('#u-episode').value = String(urlForm.episode || '');
  $('#u-browser').checked = urlForm.browser !== false;
  $('#u-probe').checked = urlForm.probe !== false;
  setFindTab(FIND_TABS.includes(saved.findTab) ? saved.findTab : 'title', false);

  renderProviderErrors(state.providerErrors);
  updateResultProviderFilter();
  $('#results-title-filter').value = String(saved.titleFilter || '');
  $('#results-provider-filter').value = String(saved.providerFilter || '');
  renderResults();

  if (state.results.length || state.providerErrors.length) {
    const titleCount = groupSearchResults(state.results).length;
    $('#find-hint').textContent = `Restored ${titleCount} saved title${titleCount === 1 ? '' : 's'} and ${state.results.length} provider result${state.results.length === 1 ? '' : 's'}`;
  } else if (saved.query) {
    $('#find-hint').textContent = 'No saved results. Run the search again to reload them.';
  }

  if (state.selected) {
    renderSelectedInfo(state.selected);
    $('#sel-note').textContent = 'Saved title restored. Select it to refresh its stream candidates.';
    $('#sel-episode-controls').classList.add('hide');
    $('#sel-actions').innerHTML = '';
    $('#candidates').innerHTML = '<div class="meta">Select the saved title to resolve fresh stream candidates.</div>';
    state.pendingRestoreSelection = true;
  } else if (state.lastResolveMode === 'url' && saved.findTab === 'url' && $('#u-url').value.trim()) {
    state.pendingRestoreUrlResolve = true;
  }
}

function restoreAppState() {
  restoreSearchState();
  const storedPage = readStoredText(ACTIVE_PAGE_KEY);
  const activePage = APP_PAGES.includes(storedPage) ? storedPage : 'dash';
  if (activePage !== 'dash') go(activePage);

  const streamId = readStoredText(SELECTED_STREAM_KEY);
  if (streamId) openStream(streamId, { navigate: false, silent: true });
}

function positiveNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 500 ? number : fallback;
}

function findMovieBoxArray(value, keys, depth = 0, seen = new Set()) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return null;
  seen.add(value);
  for (const key of keys) if (Array.isArray(value[key])) return value[key];
  for (const key of keys) {
    if (value[key] && typeof value[key] === 'object') {
      const found = findMovieBoxArray(value[key], keys, depth + 1, seen);
      if (found) return found;
    }
  }
  for (const key of ['data', 'subject', 'subjectInfo', 'seasonInfo', 'result']) {
    if (value[key] && typeof value[key] === 'object') {
      const found = findMovieBoxArray(value[key], keys, depth + 1, seen);
      if (found) return found;
    }
  }
  return null;
}

function normalizeMovieBoxSeasons(payload, details = {}, result = {}) {
  const seasonKeys = ['seasons', 'seasonList', 'season_list', 'seasonInfos', 'seasonInfoList', 'items', 'list', 'results'];
  const episodeKeys = ['episodes', 'episodeList', 'episode_list', 'episodeInfoList', 'epList', 'episodesList', 'list', 'items'];
  const rows = findMovieBoxArray(payload, seasonKeys) || findMovieBoxArray(details, seasonKeys) || [];
  const normalized = rows.map((season, index) => {
    const entry = season && typeof season === 'object' ? season : { se: season };
    const number = positiveNumber(entry.se ?? entry.seasonNumber ?? entry.seasonNo ?? entry.season ?? entry.number, index + 1);
    const episodeRows = findMovieBoxArray(entry, episodeKeys) || [];
    const episodes = episodeRows.map((episode, episodeIndex) => {
      const item = episode && typeof episode === 'object' ? episode : { ep: episode };
      const episodeNumber = positiveNumber(item.ep ?? item.episodeNumber ?? item.episodeNo ?? item.episode ?? item.number, episodeIndex + 1);
      return { number: episodeNumber, title: item.title || item.name || item.episodeTitle || `Episode ${episodeNumber}` };
    });
    const count = positiveNumber(entry.episodeCount ?? entry.totalEpisodes ?? entry.totalEpisode
      ?? entry.episodeNum ?? entry.epCount ?? entry.epNum ?? entry.episodesCount ?? entry.episodeTotal ?? entry.count, null);
    const finalEpisodes = episodes.length ? episodes : Array.from({ length: count || 30 }, (_, i) => ({ number: i + 1, title: `Episode ${i + 1}` }));
    return {
      number,
      title: entry.name || entry.title || entry.seasonName || `Season ${number}`,
      episodes: finalEpisodes,
      episodesFromApi: episodes.length > 0 || count != null,
    };
  }).filter((season) => season.number);
  if (normalized.length) return normalized.sort((a, b) => a.number - b.number);

  const rawCount = details.seasonCount ?? details.season_count ?? details.totalSeasons
    ?? details.season ?? result.seasonCount;
  const count = positiveNumber(rawCount, 1);
  return Array.from({ length: Math.min(count, 100) }, (_, index) => ({
    number: index + 1,
    title: `Season ${index + 1}`,
    episodes: Array.from({ length: 30 }, (_episode, episodeIndex) => ({
      number: episodeIndex + 1,
      title: `Episode ${episodeIndex + 1}`,
    })),
    episodesFromApi: false,
  }));
}

function unwrapMovieBoxDetails(value) {
  let current = value;
  const visited = new Set();
  for (let i = 0; i < 5 && current && typeof current === 'object' && !Array.isArray(current) && !visited.has(current); i += 1) {
    visited.add(current);
    const nested = current.subject || current.subjectInfo || current.detail || current.details || current.data;
    if (!nested || typeof nested !== 'object') break;
    current = nested;
  }
  return current || {};
}

function movieBoxGenreNames(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.map((genre) => genre && typeof genre === 'object'
    ? genre.name || genre.title || genre.label
    : genre).filter((genre) => genre != null && String(genre).trim());
}

function updateSelectedFromMovieBox(result, payload) {
  const details = unwrapMovieBoxDetails(payload);
  const cover = details.cover?.url || details.coverUrl || details.poster || details.pic || null;
  result.title = details.title || details.name || result.title;
  result.year = result.year || Number(details.year || details.releaseDate?.slice?.(0, 4) || 0) || null;
  result.description = details.description || details.overview || details.plot || details.introduction || result.description;
  result.releaseDate = details.releaseDate || details.release_date || details.firstAirDate || details.first_air_date || result.releaseDate;
  result.rating = details.imdbRatingValue || details.rating || result.rating;
  const genres = details.genres || details.genreList || details.genreNames;
  if (genres) result.genres = movieBoxGenreNames(genres);
  result.runtime = details.duration || details.runtime || result.runtime;
  if (!result.poster && cover && /^https?:\/\//i.test(String(cover))) result.poster = cover;
  renderSelectedInfo(result);
  saveSearchState();
  return details;
}

function renderEpisodeOptions(season) {
  const select = $('#sel-episode');
  const episodes = season?.episodes?.length ? season.episodes : [{ number: 1, title: 'Episode 1' }];
  select.innerHTML = episodes.map((episode) => `<option value="${episode.number}">${escapeHtml(episode.title || `Episode ${episode.number}`)}</option>`).join('');
  if (episodes.some((episode) => episode.number === state.selectedEpisode)) select.value = String(state.selectedEpisode);
  else {
    state.selectedEpisode = episodes[0].number;
    select.value = String(state.selectedEpisode);
  }
}

function renderSeriesControls(seasons, selectionId, statusMessage = '') {
  const controls = $('#sel-episode-controls');
  state.selectedSeasons = seasons;
  controls.classList.remove('hide');
  const seasonSelect = $('#sel-season');
  seasonSelect.innerHTML = seasons.map((season) => `<option value="${season.number}">${escapeHtml(season.title)}</option>`).join('');
  const available = seasons.some((season) => season.number === state.selectedSeason);
  if (!available) state.selectedSeason = seasons[0]?.number || 1;
  seasonSelect.value = String(state.selectedSeason);
  renderEpisodeOptions(seasons.find((season) => season.number === state.selectedSeason));
  $('#sel-episode-status').textContent = statusMessage;

  seasonSelect.onchange = () => {
    if (selectionId !== selectionRequestId) return;
    clearFindSubtitleSearch();
    state.selectedSeason = Number(seasonSelect.value) || 1;
    state.selectedEpisode = 0;
    renderEpisodeOptions(seasons.find((season) => season.number === state.selectedSeason));
    resolveSelectedMovieBox(selectionId);
  };
  $('#sel-episode').onchange = () => {
    if (selectionId !== selectionRequestId) return;
    clearFindSubtitleSearch();
    state.selectedEpisode = Number($('#sel-episode').value) || 1;
    resolveSelectedMovieBox(selectionId);
  };
}

function isCurrentSelection(selectionId) {
  return selectionId === selectionRequestId;
}

async function resolveSelectedMovieBox(selectionId) {
  if (!isCurrentSelection(selectionId) || !state.selected) return;
  const result = state.selected;
  result.selectedSeason = state.selectedSeason;
  result.selectedEpisode = state.selectedEpisode;
  saveSearchState();
  await resolve({
    url: result.url,
    title: result.title,
    year: result.year,
    kind: result.kind,
    sourceId: result.sourceId,
    season: state.selectedSeason,
    episode: state.selectedEpisode,
  }, selectionId);
}

async function loadMovieBoxDetails(result, selectionId) {
  const target = movieBoxTargetForResult(result);
  if (!target) {
    $('#sel-note').textContent = 'MovieBox subject ID is missing; cannot load title details.';
    return;
  }
  const controller = new AbortController();
  detailAbortController?.abort();
  detailAbortController = controller;
  const requestId = ++detailRequestId;
  $('#sel-note').textContent = 'Loading MovieBox title details and episode information…';
  try {
    const params = new URLSearchParams({ subjectId: target.subjectId, kind: result.kind || 'movie' });
    const response = await api(`/api/find/details?${params}`, { signal: controller.signal, silent: true });
    if (!isCurrentSelection(selectionId) || requestId !== detailRequestId || controller.signal.aborted) return;
    const details = updateSelectedFromMovieBox(result, response.details);
    if (result.kind === 'series') {
      const seasons = normalizeMovieBoxSeasons(response.seasons, details, result);
      state.selectedSeason = target.season || seasons[0]?.number || 1;
      state.selectedEpisode = target.episode || 0;
      const hasEpisodeData = seasons.some((season) => season.episodesFromApi);
      const status = response.seasonError
        ? `Episode list unavailable (${response.seasonError}); showing selectable fallback episode numbers.`
        : hasEpisodeData
          ? 'Choose a season and episode; streams reload for the selected episode.'
          : 'MovieBox returned no episode list; showing fallback episode numbers. Streams still resolve for the selection.';
      renderSeriesControls(seasons, selectionId, status);
    }
    $('#sel-note').textContent = result.kind === 'series'
      ? 'Resolving the selected season and episode…'
      : 'Details loaded. Resolving MovieBox streams…';
    await resolveSelectedMovieBox(selectionId);
  } catch (err) {
    if (!isCurrentSelection(selectionId) || requestId !== detailRequestId || controller.signal.aborted || isAbortError(err)) return;
    $('#sel-note').textContent = `MovieBox details failed (${err.message}); trying the selected title with default episode values.`;
    if (result.kind === 'series') {
      const seasons = normalizeMovieBoxSeasons(null, {}, result);
      state.selectedSeason = target.season || 1;
      state.selectedEpisode = target.episode || 1;
      renderSeriesControls(seasons, selectionId, 'Episode details are unavailable; choose a fallback season and episode number.');
    }
    await resolveSelectedMovieBox(selectionId);
  } finally {
    if (requestId === detailRequestId && detailAbortController === controller) detailAbortController = null;
  }
}

async function selectResult(index) {
  const r = state.results[index];
  if (!r) return;
  const selectionId = invalidateSelectionRequests();
  state.lastResolveMode = 'result';
  state.pendingRestoreUrlResolve = false;
  state.selected = r;
  state.selectedSeason = 0;
  state.selectedEpisode = 0;
  state.selectedSeasons = [];
  state.candidates = [];
  updateResultTitleSelect(visibleResultGroups());
  saveSearchState();
  $$('#results .moviecard').forEach((card) => {
    const active = (card.dataset.resultIndices || '').split(',').includes(String(index));
    card.classList.toggle('sel', active);
  });
  $$('#results .moviecard-main').forEach((main) => {
    main.setAttribute('aria-pressed', String(Number(main.dataset.resultIndex) === index));
  });
  $$('#results .provider-choice').forEach((button) => {
    const active = Number(button.dataset.resultIndex) === index;
    button.classList.toggle('on', active);
    button.setAttribute('aria-pressed', String(active));
  });
  clearFindSubtitleSearch();
  renderSelectedInfo(r);
  $('#sel-episode-controls').classList.add('hide');
  $('#sel-note').textContent = 'Resolving candidates — every URL is probed with ffprobe before it is offered.';
  $('#sel-actions').innerHTML = '';
  $('#candidates').innerHTML = '<div class="meta"><span class="spin"></span> resolving…</div>';
  if (r.sourceId === 'moviebox' || String(r.url || '').startsWith('moviebox://')) {
    await loadMovieBoxDetails(r, selectionId);
  } else {
    await resolve({ url: r.url, title: r.title, year: r.year, kind: r.kind, sourceId: r.sourceId }, selectionId);
  }
}

async function doResolveFromUrl() {
  const url = $('#u-url').value.trim();
  if (!url) return toast('Paste a URL first', 'warn');
  state.lastResolveMode = 'url';
  state.pendingRestoreSelection = false;
  const selectionId = invalidateSelectionRequests();
  resetSelectedTitle();
  $('#sel-name').textContent = $('#u-title').value.trim() || url;
  $('#sel-meta').textContent = 'Pasted URL resolve';
  $('#sel-note').textContent = 'Scraping the supplied URL…';
  saveSearchState();
  await resolve({
    url,
    title: $('#u-title').value.trim() || null,
    year: Number($('#u-year').value) || null,
    kind: $('#u-kind').value,
    season: Number($('#u-season').value) || 0,
    episode: Number($('#u-episode').value) || 0,
    useBrowser: $('#u-browser').checked,
    probe: $('#u-probe').checked,
  }, selectionId);
}

async function resolve(payload, selectionId = null) {
  resolveAbortController?.abort();
  const controller = new AbortController();
  resolveAbortController = controller;
  const requestId = ++resolveRequestId;
  state.candidates = [];
  $('#sel-actions').innerHTML = '';
  $('#candidates').innerHTML = '<div class="meta"><span class="spin"></span> resolving…</div>';
  const isCurrent = () => requestId === resolveRequestId
    && !controller.signal.aborted
    && (selectionId == null || isCurrentSelection(selectionId));
  try {
    const res = await api('/api/find/resolve', {
      method: 'POST',
      body: { ...payload, probe: payload.probe !== false },
      signal: controller.signal,
      silent: true,
    });
    if (!isCurrent()) return;
    state.candidates = res.candidates || [];
    renderCandidates(res);
  } catch (err) {
    if (!isCurrent() || isAbortError(err)) return;
    $('#candidates').innerHTML = `<div class="note err">Resolve failed: ${escapeHtml(err.message)}</div>`;
    setFindSubtitlesAction();
  } finally {
    if (requestId === resolveRequestId && resolveAbortController === controller) resolveAbortController = null;
  }
}

function renderCandidates(res) {
  const list = res.candidates || [];
  $('#sel-note').innerHTML = `Resolve timings: ${Object.entries(res.timeline || {}).map(([k, v]) => `${k} ${v}ms`).join(' · ') || '—'}`;
  setFindSubtitlesAction();
  if (!list.length) {
    $('#candidates').innerHTML = `<div class="note err">No playable stream found.<br>${escapeHtml(res.error || '')}</div>`;
    return;
  }
  $('#candidates').innerHTML = `<table>
    <thead><tr><th>#</th><th>Quality</th><th>Source</th><th>Probe</th><th>State</th><th></th></tr></thead><tbody>
    ${list.map((c) => `<tr>
      <td>${c.index + 1}</td>
      <td>${tag(c.quality || c.label || '—', c.ok ? 'ok' : 'warn')}</td>
      <td>${tag(c.sourceId || '—')}<div class="meta">${escapeHtml((c.url || '').slice(0, 48))}…</div></td>
      <td class="mono" style="font-size:11.5px">${c.probe?.video ? `${c.probe.video.codec} ${c.probe.video.width}x${c.probe.video.height} @${c.probe.video.fps || '?'}<br>${c.probe.audio?.map((a) => a.codec).join(',') || 'no audio'}${c.probe.subtitles?.length ? ` · ${c.probe.subtitles.length} sub track(s)` : ''}` : '—'}</td>
      <td>${c.ok ? tag('playable', 'ok') : tag(c.error || 'unverified', 'err')}</td>
      <td><button class="btn sm ${c.ok ? 'pri' : ''}" data-c="${c.index}">use</button></td>
    </tr>`).join('')}</tbody></table>`;
  $$('#candidates button[data-c]').forEach((b) => b.addEventListener('click', () => createStream(state.candidates[Number(b.dataset.c)])));
}

async function createStream(candidate) {
  const sel = state.selected || {};
  const streamKind = sel.kind || $('#u-kind').value;
  const selectedSubtitleTarget = state.selectedSubtitle ? currentSubtitleTarget() : null;
  const seasonForStream = state.selected
    ? (state.selectedSeason || sel.selectedSeason || selectedSubtitleTarget?.season)
    : (Number($('#u-season').value) || selectedSubtitleTarget?.season);
  const episodeForStream = state.selected
    ? (state.selectedEpisode || sel.selectedEpisode || selectedSubtitleTarget?.episode)
    : (Number($('#u-episode').value) || selectedSubtitleTarget?.episode);
  try {
    const res = await api('/api/streams', {
      method: 'POST',
      body: {
        title: sel.title || $('#u-title').value || 'Untitled',
        year: sel.year || Number($('#u-year').value) || null,
        kind: streamKind,
        poster: sel.poster || null,
        description: sel.description || null,
        sourceId: candidate.sourceId,
        season: streamKind === 'series' ? (Number(seasonForStream) || null) : null,
        episode: streamKind === 'series' ? (Number(episodeForStream) || null) : null,
        candidate: {
          url: candidate.url,
          quality: candidate.quality,
          label: candidate.label,
          kind: candidate.kind,
          headers: candidate.headers || {},
          probe: candidate.probe,
          variants: candidate.variants,
          sourceId: candidate.sourceId,
          via: candidate.via,
        },
        profile: {},
        ...(state.selectedSubtitle ? { subtitleResult: state.selectedSubtitle } : {}),
      },
    });
    streamRequestId += 1;
    state.stream = res.stream;
    await loadFfmpegTemplates();
    try { localStorage.setItem(SELECTED_STREAM_KEY, String(res.stream.id)); } catch { /* storage may be disabled */ }
    toast(`Stream created: ${res.stream.title}`, 'ok');
    if (state.selectedSubtitle) {
      toast(res.subtitleError
        ? `Subtitle selected, but could not attach: ${res.subtitleError}`
        : `Selected subtitle attached: ${state.selectedSubtitle.release || state.selectedSubtitle.title || state.selectedSubtitle.providerId}`,
      res.subtitleError ? 'warn' : 'ok', 9000);
    }
    renderStream(res);
    go('stream');
    loadStreams();
  } catch { /* toast shown */ }
}

/* ================= STREAM ================= */

const TEMPLATE_CUSTOM_VALUE = '__custom__';

function newFfmpegTemplateId() {
  return globalThis.crypto?.randomUUID?.()
    || `template-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function starterFfmpegTemplate(container = 'mpegts') {
  const muxer = ['mpegts', 'matroska', 'hls'].includes(container) ? container : 'mpegts';
  const base = `ffmpeg -hide_banner -nostdin -loglevel warning -i <url> -map 0:v:0 -map 0:a:0? -c:v copy -c:a copy`;
  if (muxer === 'hls') return `${base} -f hls -hls_time 2 -hls_list_size 10 -hls_flags delete_segments+omit_endlist <output>`;
  return `${base} -f ${muxer}${muxer === 'matroska' ? ' -live 1' : ''} pipe:1`;
}

async function loadFfmpegTemplates(force = false) {
  if (state.ffmpegTemplatesLoaded && !force) return true;
  try {
    const result = await api('/api/ffmpeg/templates', { silent: true });
    state.ffmpegTemplates = Array.isArray(result.templates) ? result.templates : [];
    state.defaultFfmpegTemplateId = result.defaultFfmpegTemplateId || '';
    state.ffmpegDefaults = result.ffmpegDefaults && typeof result.ffmpegDefaults === 'object' ? result.ffmpegDefaults : {};
    state.ffmpegTemplatesLoaded = true;
    if (state.stream) {
      renderFfmpegTemplateControls(state.stream.profile || {});
      renderOutputTemplates(state.stream.profile?.outputTemplates || {});
    }
    return true;
  } catch {
    return false;
  }
}

function updateFfmpegTemplateButtons() {
  const select = $('#pf-template-select');
  const value = select.value;
  const saved = state.ffmpegTemplates.find((item) => item.id === value);
  const active = value !== '';
  $('#pf-template-editor').classList.toggle('hide', !active);
  $('#btn-template-save-new').disabled = !active || !$('#pf-template-command').value.trim();
  $('#btn-template-save').disabled = !saved;
  $('#btn-template-delete').disabled = !saved;
  $('#btn-template-default').disabled = !saved || state.defaultFfmpegTemplateId === saved.id;
  $('#btn-template-default').textContent = saved && state.defaultFfmpegTemplateId === saved.id
    ? 'default for new streams' : 'set as default for new streams';
}

function renderFfmpegTemplateControls(profile = {}) {
  const select = $('#pf-template-select');
  const options = [
    new Option('Guided profile builder', ''),
    new Option('Custom command…', TEMPLATE_CUSTOM_VALUE),
    ...state.ffmpegTemplates.map((item) => new Option(`${item.name} · ${item.container}`, item.id)),
  ];
  select.replaceChildren(...options);
  const saved = state.ffmpegTemplates.find((item) => item.id === profile.ffmpegTemplateId);
  select.value = saved ? saved.id : profile.ffmpegTemplate ? TEMPLATE_CUSTOM_VALUE : '';
  $('#pf-template-command').value = profile.ffmpegTemplate || (saved?.command || '');
  $('#pf-template-name').value = profile.ffmpegTemplateName || saved?.name || (profile.ffmpegTemplate ? 'Custom template' : '');
  updateFfmpegTemplateButtons();
}

function selectFfmpegTemplate() {
  const value = $('#pf-template-select').value;
  const saved = state.ffmpegTemplates.find((item) => item.id === value);
  if (saved) {
    $('#pf-template-command').value = saved.command;
    $('#pf-template-name').value = saved.name;
    $('#pf-container').value = saved.container;
  } else if (value === TEMPLATE_CUSTOM_VALUE) {
    if (!$('#pf-template-command').value.trim()) {
      $('#pf-template-command').value = starterFfmpegTemplate($('#pf-container').value);
    }
    if (!$('#pf-template-name').value.trim()) $('#pf-template-name').value = 'Custom template';
  } else {
    $('#pf-template-command').value = '';
    $('#pf-template-name').value = '';
  }
  updateFfmpegTemplateButtons();
  updateCommandPreview();
}

function currentTemplateProfileFields() {
  const value = $('#pf-template-select').value;
  const active = value !== '';
  return {
    ffmpegTemplate: active ? $('#pf-template-command').value.trim() : '',
    ffmpegTemplateId: active && value !== TEMPLATE_CUSTOM_VALUE ? value : '',
    ffmpegTemplateName: active ? $('#pf-template-name').value.trim() : '',
  };
}

async function saveFfmpegTemplate({ update = false, makeDefault = false } = {}) {
  const selectedId = $('#pf-template-select').value;
  const existing = state.ffmpegTemplates.find((item) => item.id === selectedId);
  if (update && !existing) return toast('Select a saved template before updating it', 'warn');
  const name = $('#pf-template-name').value.trim();
  const command = $('#pf-template-command').value.trim();
  const container = $('#pf-container').value;
  if (!name) return toast('Give the FFmpeg template a name first', 'warn');
  if (!command) return toast('The FFmpeg template command is empty', 'warn');
  const item = { id: existing?.id || newFfmpegTemplateId(), name, command, container };
  const templates = existing
    ? state.ffmpegTemplates.map((template) => template.id === existing.id ? item : template)
    : [...state.ffmpegTemplates, item];
  const defaultFfmpegTemplateId = makeDefault ? item.id : state.defaultFfmpegTemplateId;
  const result = await api('/api/ffmpeg/templates', {
    method: 'PUT', body: { templates, defaultFfmpegTemplateId },
  });
  state.ffmpegTemplates = result.templates;
  state.defaultFfmpegTemplateId = result.defaultFfmpegTemplateId || '';
  state.ffmpegTemplatesLoaded = true;
  renderFfmpegTemplateControls({
    ffmpegTemplate: command, ffmpegTemplateId: item.id, ffmpegTemplateName: item.name,
  });
  $('#pf-container').value = container;
  toast(makeDefault ? 'Template saved and set as the default for new streams' : 'FFmpeg template saved', 'ok');
  updateCommandPreview();
}

async function deleteFfmpegTemplate() {
  const id = $('#pf-template-select').value;
  const existing = state.ffmpegTemplates.find((item) => item.id === id);
  if (!existing) return;
  if (!window.confirm(`Delete FFmpeg template “${existing.name}”?`)) return;
  const templates = state.ffmpegTemplates.filter((item) => item.id !== id);
  const defaultFfmpegTemplateId = state.defaultFfmpegTemplateId === id ? '' : state.defaultFfmpegTemplateId;
  const ffmpegDefaults = { ...(state.ffmpegDefaults || {}) };
  for (const [output, tplId] of Object.entries(ffmpegDefaults)) if (tplId === id) ffmpegDefaults[output] = '';
  const result = await api('/api/ffmpeg/templates', {
    method: 'PUT', body: { templates, defaultFfmpegTemplateId, ffmpegDefaults },
  });
  state.ffmpegTemplates = result.templates;
  state.defaultFfmpegTemplateId = result.defaultFfmpegTemplateId || '';
  state.ffmpegDefaults = result.ffmpegDefaults || {};
  $('#pf-template-select').value = TEMPLATE_CUSTOM_VALUE;
  $('#pf-template-name').value = 'Custom template';
  updateFfmpegTemplateButtons();
  toast('FFmpeg template deleted', 'ok');
  updateCommandPreview();
}

/* ================= TRANSCODE TEMPLATES (dedicated page) ================= */

/** All templates know which output types they want to drive. */
state.tplEditor = null;
state.ffmpegDefaults = state.ffmpegDefaults || {};

function tplEditorSelect(template) {
  state.tplEditor = template ? { ...template, output: { ...(template.output || {}) } } : null;
  renderTplEditor();
}

function tplOutputLabel(key) { return OUTPUT_LABELS[key] || key; }

function tplShortCommand(command = '') {
  const trimmed = String(command || '').replace(/\s+/g, ' ').trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

function renderTemplatesPage() {
  const list = $('#tpl-list');
  if (!list) return;
  if (!state.ffmpegTemplates.length) {
    list.innerHTML = '<div class="meta" style="padding:14px">No templates saved yet — click “New template” or save one from the Stream tab.</div>';
  } else {
    list.innerHTML = state.ffmpegTemplates.map((item) => {
      const outputs = OUTPUT_TYPES.filter((output) => item.output && item.output[output]).map((output) => tplOutputLabel(output));
      const isDefault = state.defaultFfmpegTemplateId === item.id;
      const isEditor = state.tplEditor && state.tplEditor.id === item.id;
      return `
        <div class="template-list-row${isEditor ? ' selected' : ''}" data-tpl-row="${escapeHtml(item.id)}">
          <div style="min-width:0;flex:1">
            <div class="tname">${escapeHtml(item.name || 'unnamed')}${isDefault ? ' <span class="tag alt">default</span>' : ''}</div>
            <div class="tmeta">${escapeHtml(item.container || '—')} · ${outputs.length ? outputs.map((o) => `<span class="tag">${escapeHtml(o)}</span>`).join('') : '<span class="mut">no outputs assigned</span>'}</div>
            <div class="tmeta mono" style="margin-top:3px">${escapeHtml(tplShortCommand(item.command))}</div>
          </div>
          <div class="tactions">
            <button class="btn sm" data-tpl-edit="${escapeHtml(item.id)}">edit</button>
            <button class="btn sm ghost" data-tpl-default="${escapeHtml(item.id)}">${isDefault ? 'default' : 'set default'}</button>
            <button class="btn sm ghost" data-tpl-test-row="${escapeHtml(item.id)}">▷ test</button>
            <button class="btn sm ghost" data-tpl-delete="${escapeHtml(item.id)}">delete</button>
          </div>
        </div>`;
    }).join('');
  }

  // Default template selector in the page header.
  const defSel = $('#tpl-default');
  defSel.replaceChildren(
    new Option('(no default — guided profile builder)', ''),
    ...state.ffmpegTemplates.map((item) => new Option(`${item.name} · ${item.container}`, item.id)),
  );
  defSel.value = state.defaultFfmpegTemplateId || '';
  $('#btn-tpl-set-default').disabled = !state.tplEditor?.id
    || state.defaultFfmpegTemplateId === state.tplEditor.id;

  renderTplEditor();
}

function renderTplEditor() {
  const editor = state.tplEditor || null;
  const titleEl = $('#tpl-editor-title');
  const nameEl = $('#tpl-editor-name');
  const descEl = $('#tpl-editor-description');
  const cmdEl = $('#tpl-editor-command');
  const containerEl = $('#tpl-editor-container');
  const outputsEl = $('#tpl-editor-outputs');
  if (!editor) {
    titleEl.textContent = 'Template editor';
    nameEl.value = '';
    descEl.value = '';
    cmdEl.value = '';
    containerEl.value = 'mpegts';
    outputsEl.innerHTML = OUTPUT_TYPES.map((output) => `
      <label class="row" data-output="${output}">
        <input type="checkbox" disabled>
        <span>
          <span class="output-name">${escapeHtml(tplOutputLabel(output))}</span>
          <span class="output-meta">${escapeHtml(tplOutputHint(output))}</span>
        </span>
      </label>`).join('');
    $('#btn-tpl-save').disabled = true;
    $('#btn-tpl-save-top').disabled = true;
    $('#btn-tpl-delete').disabled = true;
    $('#tpl-editor-status').textContent = 'Click “+ New template” or pick one from the list.';
    return;
  }
  titleEl.textContent = `Editing “${editor.name || 'untitled'}”`;
  nameEl.value = editor.name || '';
  descEl.value = editor.description || '';
  cmdEl.value = editor.command || '';
  containerEl.value = editor.container || 'mpegts';
  outputsEl.innerHTML = OUTPUT_TYPES.map((output) => {
    const on = Boolean(editor.output && editor.output[output]);
    return `
      <label class="row${on ? ' on' : ''}" data-output="${output}">
        <input type="checkbox" data-output-check="${output}" ${on ? 'checked' : ''}>
        <span>
          <span class="output-name">${escapeHtml(tplOutputLabel(output))}</span>
          <span class="output-meta">${escapeHtml(tplOutputHint(output))}</span>
        </span>
      </label>`;
  }).join('');
  $('#btn-tpl-save').disabled = false;
  $('#btn-tpl-save-top').disabled = false;
  $('#btn-tpl-delete').disabled = !editor.id || state.defaultFfmpegTemplateId === editor.id;
  $('#tpl-editor-status').textContent = editor.id
    ? (state.defaultFfmpegTemplateId === editor.id ? 'This template is the global default.' : 'Save to apply changes.')
    : 'New template — save to add it to the library.';
}

function tplOutputHint(output) {
  switch (output) {
    case 'vlcTs': return '.ts URL · desktop player';
    case 'vlcMkv': return '.mkv URL · desktop player';
    case 'm3u8': return 'HLS playlist URL';
    case 'm3u': return 'M3U playlist file';
    case 'enigma2': return 'Bouquet entry for VU+ / Duo2';
    case 'direct': return 'Direct 302 redirect';
    case 'download': return 'Saved-to-disk copy';
    default: return '';
  }
}

function tplCollectFromEditor() {
  const editor = state.tplEditor || {};
  const outputs = {};
  for (const output of OUTPUT_TYPES) {
    const checkbox = $(`#tpl-editor-outputs input[data-output-check="${output}"]`);
    if (checkbox && checkbox.checked) outputs[output] = editor.id || '__self__';
  }
  return {
    id: editor.id || newFfmpegTemplateId(),
    name: $('#tpl-editor-name').value.trim(),
    description: $('#tpl-editor-description').value.trim(),
    container: $('#tpl-editor-container').value,
    command: $('#tpl-editor-command').value.trim(),
    output: outputs,
  };
}

async function tplSave({ makeDefault = false } = {}) {
  const item = tplCollectFromEditor();
  if (!item.name) return toast('Give the template a name first', 'warn');
  if (!item.command) return toast('The template command is empty', 'warn');
  if (!['mpegts', 'matroska', 'hls'].includes(item.container)) return toast('Pick a container', 'warn');
  const existing = state.ffmpegTemplates.find((t) => t.id === item.id);
  const next = existing
    ? state.ffmpegTemplates.map((t) => (t.id === item.id ? item : t))
    : [...state.ffmpegTemplates, item];
  const defaultFfmpegTemplateId = makeDefault
    ? item.id
    : (state.defaultFfmpegTemplateId || '');
  const ffmpegDefaults = { ...(state.ffmpegDefaults || {}) };
  // If this template is no longer the editor's owner of an output, drop the assignment.
  for (const [output, owner] of Object.entries(ffmpegDefaults)) {
    if (owner !== item.id) continue;
    if (!item.output[output]) ffmpegDefaults[output] = '';
  }
  // Promote any freshly ticked outputs to "this template is the default" so
  // operators don't have to flip them in two places after editing.
  for (const [output, owner] of Object.entries(item.output)) {
    if (owner === '__self__') ffmpegDefaults[output] = item.id;
    if (owner === item.id) ffmpegDefaults[output] = item.id;
  }
  const result = await api('/api/ffmpeg/templates', {
    method: 'PUT', body: { templates: next, defaultFfmpegTemplateId, ffmpegDefaults },
  });
  state.ffmpegTemplates = result.templates;
  state.defaultFfmpegTemplateId = result.defaultFfmpegTemplateId || '';
  state.ffmpegDefaults = result.ffmpegDefaults || {};
  state.ffmpegTemplatesLoaded = true;
  tplEditorSelect(result.templates.find((t) => t.id === item.id) || null);
  if (state.stream) renderFfmpegTemplateControls(state.stream.profile || {});
  renderOutputTemplates(state.stream?.profile?.outputTemplates || {});
  toast(makeDefault ? 'Template saved and set as default' : 'Template saved', 'ok');
  updateCommandPreview();
}

async function tplDelete() {
  const editor = state.tplEditor;
  if (!editor?.id) { tplEditorSelect(null); return; }
  if (!window.confirm(`Delete template “${editor.name || editor.id}”?`)) return;
  const templates = state.ffmpegTemplates.filter((t) => t.id !== editor.id);
  const defaultFfmpegTemplateId = state.defaultFfmpegTemplateId === editor.id ? '' : state.defaultFfmpegTemplateId;
  const ffmpegDefaults = { ...(state.ffmpegDefaults || {}) };
  for (const [output, tplId] of Object.entries(ffmpegDefaults)) if (tplId === editor.id) ffmpegDefaults[output] = '';
  const result = await api('/api/ffmpeg/templates', {
    method: 'PUT', body: { templates, defaultFfmpegTemplateId, ffmpegDefaults },
  });
  state.ffmpegTemplates = result.templates;
  state.defaultFfmpegTemplateId = result.defaultFfmpegTemplateId || '';
  state.ffmpegDefaults = result.ffmpegDefaults || {};
  tplEditorSelect(null);
  if (state.stream) renderFfmpegTemplateControls(state.stream.profile || {});
  renderOutputTemplates(state.stream?.profile?.outputTemplates || {});
  toast('Template deleted', 'ok');
}

async function tplSetDefaultFromList(id) {
  const existing = state.ffmpegTemplates.find((t) => t.id === id);
  if (!existing) return;
  const result = await api('/api/ffmpeg/templates', {
    method: 'PUT',
    body: {
      templates: state.ffmpegTemplates,
      defaultFfmpegTemplateId: state.defaultFfmpegTemplateId === id ? '' : id,
      ffmpegDefaults: state.ffmpegDefaults,
    },
  });
  state.ffmpegTemplates = result.templates;
  state.defaultFfmpegTemplateId = result.defaultFfmpegTemplateId || '';
  state.ffmpegDefaults = result.ffmpegDefaults || {};
  renderTemplatesPage();
  toast(state.defaultFfmpegTemplateId === id ? 'Set as default' : 'Default cleared', 'ok');
}

/* ---------------- TEMPLATE TEST PANEL ---------------- */

const TPL_TEST_INLINE_VALUE = '__inline__';
state.tplTest = { inFlight: false, lastResult: null };

function tplTestVerdictClass(result) {
  if (!result) return '';
  if (result.ok) return 'ok';
  if (result.error) return 'err';
  return 'warn';
}

function tplTestSummary(result) {
  if (!result) return 'Press “Run test” to spawn ffmpeg against the chosen stream.';
  if (result.error) {
    return `ffmpeg could not be spawned: ${escapeHtml(result.error)}`;
  }
  const parts = [
    result.bytesOut ? `${fmtBytes(result.bytesOut)} produced` : 'no bytes produced',
    `ran for ${(result.durationMs / 1000).toFixed(1)} s`,
    result.exitCode != null ? `exit ${result.exitCode}` : '',
    result.signal ? `signal ${result.signal}` : '',
    result.timedOut ? 'timed out (test window reached)' : '',
  ].filter(Boolean);
  const verdict = result.ok ? 'Looks healthy.' : (parts[0] === 'no bytes produced' ? 'No data reached the output — the template is not transcoding this stream.' : 'ffmpeg exited with an error.');
  return `${verdict} ${parts.join(' · ')}.`;
}

function fmtProgressValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
    return String(value);
  }
  return String(value);
}

function tplTestProgressMeta(result) {
  if (!result || !result.progress || !Object.keys(result.progress).length) return '';
  const p = result.progress;
  const items = [
    p.bitrate ? `bitrate: ${p.bitrate}` : null,
    p.fps ? `fps: ${p.fps}` : null,
    p.speed ? `speed: ${p.speed}` : null,
    p.frame != null ? `frame: ${p.frame}` : null,
    p.outTimeMs != null ? `time: ${(Number(p.outTimeMs) / 1000).toFixed(1)}s` : null,
    p.dropFrames != null ? `dropped: ${p.dropFrames}` : null,
  ].filter(Boolean);
  return items.join(' · ');
}

function renderTplTestPanel() {
  const tmplSel = $('#tpl-test-template');
  const streamSel = $('#tpl-test-stream');
  const verdict = $('#tpl-test-verdict');
  const summary = $('#tpl-test-summary');
  const cmdEl = $('#tpl-test-cmd');
  const stderrEl = $('#tpl-test-stderr');
  const cmdMeta = $('#tpl-test-cmd-meta');
  const progMeta = $('#tpl-test-progress-meta');
  const statusEl = $('#tpl-test-status');
  const inlineCommandEl = $('#tpl-test-command');
  const runBtn = $('#btn-tpl-test-run');
  const resetBtn = $('#btn-tpl-test-reset');

  if (!tmplSel) return;

  // Template picker: every saved template + an "inline command…" option.
  const selected = tmplSel.value || '';
  tmplSel.replaceChildren(
    ...state.ffmpegTemplates.map((item) => new Option(`${item.name} · ${item.container}`, item.id)),
    new Option('(inline command…)', TPL_TEST_INLINE_VALUE),
  );
  if (![...tmplSel.options].some((opt) => opt.value === selected)) tmplSel.value = '';
  else tmplSel.value = selected;
  if (!tmplSel.value) tmplSel.value = state.tplTest.lastResult?.templateId || (state.ffmpegTemplates[0]?.id || TPL_TEST_INLINE_VALUE);

  // Stream picker: every saved stream (the test runs against the stream's
  // actual upstream URL + headers, including signed cookies).
  const streamPicked = streamSel.value || '';
  streamSel.replaceChildren(
    new Option('(pick a stream)', ''),
    ...state.streams.map((s) => new Option(`${s.title}${s.year ? ` (${s.year})` : ''} · ${s.upstream?.quality || s.quality || 'source'}`, s.id)),
  );
  if (streamPicked && [...streamSel.options].some((opt) => opt.value === streamPicked)) {
    streamSel.value = streamPicked;
  } else if (state.stream?.id) {
    streamSel.value = state.stream.id;
  }

  // Inline command visibility follows the picker.
  if (inlineCommandEl) {
    const inline = tmplSel.value === TPL_TEST_INLINE_VALUE;
    inlineCommandEl.disabled = !inline;
    inlineCommandEl.parentElement?.classList.toggle('hide', !inline);
    if (inline && !inlineCommandEl.value.trim() && state.tplEditor) {
      inlineCommandEl.value = state.tplEditor.command || '';
    }
  }

  const result = state.tplTest.lastResult;
  if (result) {
    verdict.className = `tpl-test-verdict ${tplTestVerdictClass(result)}`;
    verdict.textContent = result.ok
      ? `✓ ${result.templateName || 'Template'} ran cleanly`
      : `✗ ${result.templateName || 'Template'} failed`;
    summary.textContent = tplTestSummary(result);
    cmdEl.textContent = result.command || '—';
    cmdMeta.textContent = `${result.outputType ? `${OUTPUT_LABELS[result.outputType] || result.outputType} · ` : ''}${result.templateId ? `template ${result.templateId}` : 'inline'}`;
    stderrEl.textContent = (result.stderr && result.stderr.trim()) || '(no stderr captured — ffmpeg probably had nothing to say, which is a good sign)';
    progMeta.textContent = tplTestProgressMeta(result);
  } else {
    verdict.className = 'tpl-test-verdict';
    verdict.textContent = '(not run yet)';
    summary.textContent = 'Press “Run test” to spawn ffmpeg against the chosen stream.';
    cmdEl.textContent = '—';
    cmdMeta.textContent = '';
    stderrEl.textContent = '—';
    progMeta.textContent = '';
  }

  statusEl.textContent = state.tplTest.inFlight ? 'running ffmpeg…' : '';
  runBtn.disabled = state.tplTest.inFlight;
  runBtn.textContent = state.tplTest.inFlight ? '⧗ running…' : '▷ run test';
  resetBtn.disabled = state.tplTest.inFlight;
}

async function loadTplTestStreams() {
  try {
    const result = await api('/api/streams', { silent: true });
    state.streams = Array.isArray(result.streams) ? result.streams : state.streams;
  } catch { /* toast handled */ }
  renderTplTestPanel();
}

async function runTplTest() {
  if (state.tplTest.inFlight) return;
  const tmplSel = $('#tpl-test-template');
  const streamSel = $('#tpl-test-stream');
  const durationEl = $('#tpl-test-duration');
  const inlineCommandEl = $('#tpl-test-command');
  const templateId = tmplSel.value;
  const streamId = streamSel.value;
  if (!streamId) return toast('Pick a stream to test the template against', 'warn');
  const durationMs = Math.max(500, Math.min(30000, Number(durationEl.value) * 1000 || 5000));
  let body;
  if (templateId === TPL_TEST_INLINE_VALUE) {
    const command = (inlineCommandEl.value || '').trim();
    if (!command) return toast('Inline command is empty', 'warn');
    body = { streamId, durationMs, command, name: 'inline test' };
  } else {
    if (!templateId) return toast('Pick a template to render', 'warn');
    body = { streamId, durationMs };
  }

  state.tplTest.inFlight = true;
  renderTplTestPanel();
  try {
    const route = templateId === TPL_TEST_INLINE_VALUE
      ? '/api/ffmpeg/test'
      : `/api/ffmpeg/templates/${encodeURIComponent(templateId)}/test`;
    const response = await api(route, { method: 'POST', body });
    const result = response.result || {};
    const templateMeta = response.template || {};
    state.tplTest.lastResult = {
      ...result,
      templateId: templateMeta.id || templateId || '',
      templateName: templateMeta.name || 'inline test',
      outputType: '',
    };
    if (result.ok) toast('Template test succeeded', 'ok');
    else if (result.error) toast(`Template test failed: ${result.error}`, 'err');
    else toast('Template test produced no output', 'warn');
  } catch (err) {
    state.tplTest.lastResult = {
      ok: false, error: err.message, command: '', stderr: '',
      durationMs: 0, bytesOut: 0, exitCode: null, signal: null,
      templateId, templateName: '', outputType: '',
    };
  } finally {
    state.tplTest.inFlight = false;
    renderTplTestPanel();
  }
}

function resetTplTest() {
  state.tplTest.lastResult = null;
  renderTplTestPanel();
}

/** Helper for the per-stream profile test button on the Stream tab. */
async function testCurrentStreamTemplate() {
  if (!state.stream) return;
  await loadFfmpegTemplates(true);
  await loadTplTestStreams();
  // Pick the saved template the stream uses; otherwise fall back to inline.
  const profile = state.stream.profile || {};
  const tmplSel = $('#tpl-test-template');
  const streamSel = $('#tpl-test-stream');
  if (profile.ffmpegTemplateId && state.ffmpegTemplates.find((t) => t.id === profile.ffmpegTemplateId)) {
    tmplSel.value = profile.ffmpegTemplateId;
  } else if (profile.ffmpegTemplate && profile.ffmpegTemplate.trim()) {
    tmplSel.value = TPL_TEST_INLINE_VALUE;
    $('#tpl-test-command').value = profile.ffmpegTemplate;
  }
  streamSel.value = state.stream.id;
  go('tpl-test');
}

/* ---- per-output template pickers on the Stream tab ---- */

function renderOutputTemplates(current = {}) {
  const grid = $('#pf-output-templates');
  if (!grid) return;
  const cur = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const opts = [
    new Option('(inherit)', ''),
    ...state.ffmpegTemplates.map((item) => new Option(`${item.name} · ${item.container}`, item.id)),
  ];
  grid.innerHTML = OUTPUT_TYPES.map((output) => {
    const sel = document.createElement('select');
    sel.dataset.output = output;
    sel.replaceChildren(...opts);
    sel.value = cur[output] || '';
    return `<div class="field">
      <label>${escapeHtml(tplOutputLabel(output))}</label>
      ${sel.outerHTML}
      <div class="meta">${escapeHtml(tplOutputHint(output))}</div>
    </div>`;
  }).join('');
}

function readOutputTemplatesFromForm() {
  const result = {};
  for (const select of $$('#pf-output-templates select[data-output]')) {
    const value = select.value;
    if (value) result[select.dataset.output] = value;
  }
  return result;
}

function readProfileForm() {
  return {
    mode: $('#pf-mode').value,
    resolution: Number($('#pf-res').value),
    aspect: $('#pf-aspect').value,
    container: $('#pf-container').value,
    videoBitrate: Number($('#pf-vbr').value),
    audioBitrate: Number($('#pf-abr').value),
    audioChannels: Number($('#pf-ac').value),
    fps: $('#pf-fps').value,
    subtitles: $('#pf-subs').value,
    alwaysTranscode: $('#pf-always').checked,
    deinterlace: $('#pf-deint').checked,
    ...currentTemplateProfileFields(),
    outputTemplates: readOutputTemplatesFromForm(),
  };
}

async function openStream(id, { navigate = true, silent = false } = {}) {
  const requestId = ++streamRequestId;
  try {
    const res = await api(`/api/streams/${encodeURIComponent(String(id))}`, { silent });
    if (requestId !== streamRequestId) return;
    state.stream = res.stream;
    await loadFfmpegTemplates();
    try { localStorage.setItem(SELECTED_STREAM_KEY, String(res.stream.id)); } catch { /* storage may be disabled */ }
    renderStream(res);
    if (navigate) go('stream');
  } catch (err) {
    if (requestId !== streamRequestId) return;
    if (err.message === 'stream not found') {
      if (readStoredText(SELECTED_STREAM_KEY) === String(id)) {
        try { localStorage.removeItem(SELECTED_STREAM_KEY); } catch { /* storage may be disabled */ }
      }
      if (!state.stream || String(state.stream.id) === String(id)) {
        state.stream = null;
        $('#stream-body').classList.add('hide');
        $('#stream-empty').classList.remove('hide');
      }
    }
    // api() already shows errors unless this is a quiet startup restore.
  }
}

function renderStream(res) {
  const s = res.stream || state.stream;
  const urls = res.urls || {};
  $('#stream-empty').classList.add('hide');
  $('#stream-body').classList.remove('hide');
  $('#st-title').textContent = `${s.title}${s.year ? ` (${s.year})` : ''}`;
  $('#st-meta').innerHTML = `${tag(s.upstream?.quality || 'unknown', 'ok')} ${tag(s.upstream?.kind || 'file')} ${tag(s.source_id || s.sourceId || '—')}
    ${s.expires_at ? `<span class="mut">token until ${new Date(s.expires_at).toLocaleString()}</span>` : '<span class="mut">token never expires</span>'}`;
  $('#st-tags').innerHTML = `${tag(s.profile?.ffmpegTemplate ? 'custom FFmpeg template' : s.profile?.transcode ? 'transcode' : 'stream copy', s.profile?.ffmpegTemplate || s.profile?.transcode ? 'alt' : 'ok')}
    ${tag(s.profile?.ffmpegTemplateName || s.profile?.encoder || 'copy')} ${tag(s.profile?.container || 'mpegts', 'info')}
    ${(s.profile?.reasons || []).slice(0, 2).map((r) => tag(r)).join('')}`;

  // Populate the per-output command preview dropdown with the labels from the
  // backend. The user picks which output to render the ffmpeg command for.
  const cmdOut = $('#pf-cmd-output');
  if (cmdOut && !cmdOut.options.length) {
    cmdOut.replaceChildren(...OUTPUT_TYPES.map((output) => new Option(OUTPUT_LABELS[output] || output, output)));
  }

  const rows = [
    ['VLC / any player (.ts)', urls.ts],
    ['VLC / any player (.mkv)', urls.mkv],
    ['Playlist (.m3u8)', urls.hls],
    ['Playlist (.m3u)', urls.playlist],
    ['Enigma2 / Duo2', urls.forBox],
    ...(urls.direct ? [['Direct upstream link (302)', urls.direct]] : []),
    ['Watch in browser', urls.watch],
  ];
  $('#st-client-urls').innerHTML = rows.map(([label, url]) => `
    <div class="field" style="flex:1;min-width:260px;margin-bottom:0">
      <label>${escapeHtml(label)}</label>
      <div class="row"><input type="text" class="mono" data-client-url readonly value="${escapeHtml(url || '')}" aria-label="${escapeHtml(label)} URL" style="flex:1">
      <button type="button" class="btn sm" data-copy-client-url>copy</button></div>
    </div>`).join('')
    + (urls.directNote
      ? `<div class="note mut" style="flex-basis:100%;margin-top:4px">Direct upstream link ${escapeHtml(urls.directNote)}.</div>`
      : '');
  $$('#st-client-urls input[data-client-url]').forEach((input) => {
    input.addEventListener('click', () => input.select());
  });
  $$('#st-client-urls button[data-copy-client-url]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = button.parentElement.querySelector('input[data-client-url]');
      if (input) App.copy(input.value);
    });
  });

  const p = s.profile || {};
  renderFfmpegTemplateControls(p);
  renderOutputTemplates(p.outputTemplates || {});
  if (p.resolution) $('#pf-res').value = String(p.resolution);
  if (p.aspect) $('#pf-aspect').value = p.aspect === 'source' ? 'source' : p.aspect;
  if (p.container) { try { $('#pf-container').value = p.container; } catch { /* hls etc. */ } }
  if (p.fps) $('#pf-fps').value = p.fps === 'source' ? 'source' : String(p.fps);
  if (p.videoBitrate) { $('#pf-vbr').value = p.videoBitrate; $('#pf-vbr-l').textContent = `${p.videoBitrate} kbps`; }
  if (p.audioBitrate) { $('#pf-abr').value = p.audioBitrate; $('#pf-abr-l').textContent = `${p.audioBitrate} kbps`; }
  // Without this the selector silently fell back to "2 (stereo)" after a reload,
  // and the next Apply saved stereo over the 5.1 the user had chosen.
  if (p.audioChannels) { try { $('#pf-ac').value = String(p.audioChannels); } catch { /* keep default */ } }
  $('#pf-always').checked = Boolean(p.alwaysTranscode);
  $('#pf-mode').value = p.mode || 'auto';
  $('#pf-subs').value = p.subtitles || 'soft';
  $('#pf-note').innerHTML = p.ffmpegTemplate
    ? `Using <b>${escapeHtml(p.ffmpegTemplateName || 'custom FFmpeg template')}</b>; its command controls the outgoing stream. Guided profile fields are ignored while a template is selected.`
    : (p.reasons || []).length
      ? `Decision: <b>${p.transcode ? 'encode' : 'stream copy'}</b> — ${escapeHtml((p.reasons || []).join('; '))}`
      : 'Profile will be decided when the stream starts.';

  renderProbe(s.upstream?.probe);
  if (state.health?.hwaccel) {
    $('#st-hw').innerHTML = `
      <div class="kv"><span>device</span><span class="mono">${escapeHtml(state.health.hwaccel.device || '')}</span></div>
      <div class="kv"><span>vaapi</span><span>${state.health.hwaccel.available ? 'available' : 'unavailable'}</span></div>
      <div class="kv"><span>H.264 encode</span><span>${state.health.hwaccel.h264Encode ? 'yes' : 'no'}</span></div>
      <div class="kv"><span>HEVC encode</span><span>${state.health.hwaccel.hevcEncode ? 'yes' : 'no (decode only)'}</span></div>
      <div class="kv"><span>fps filter variant</span><span>${state.health.hwaccel.fpsVariant || '—'}</span></div>`;
  }
  updateCommandPreview();
  const session = res.session;
  renderMonitor(session);
}

function renderProbe(probe) {
  if (!probe) { $('#st-probe').innerHTML = '<div class="meta">no probe data (candidate was not probed)</div>'; return; }
  const v = probe.video || {};
  $('#st-probe').innerHTML = `
    <div class="kv"><span>container</span><span class="mono">${escapeHtml(probe.container || '—')}</span></div>
    <div class="kv"><span>video</span><span class="mono">${escapeHtml(v.codec || '—')} ${v.width || '?'}x${v.height || '?'} @${v.fps || '?'} </span></div>
    <div class="kv"><span>bitrate</span><span class="mono">${probe.bitrate ? `${Math.round(probe.bitrate / 1000)} kbps` : '—'}</span></div>
    <div class="kv"><span>duration</span><span class="mono">${probe.durationSec ? `${Math.floor(probe.durationSec / 60)} min` : '—'}</span></div>
    <div class="kv"><span>audio</span><span class="mono">${(probe.audio || []).map((a) => `${a.codec}${a.channels ? ` ${a.channels}ch` : ''}`).join(', ') || '—'}</span></div>
    <div class="kv"><span>subtitle tracks</span><span class="mono">${(probe.subtitles || []).length}</span></div>`;
}

function renderMonitor(session) {
  if (!session) { $('#st-monitor').innerHTML = '<div class="meta">no session running</div>'; return; }
  const st = session.stats || {};
  $('#st-monitor').innerHTML = `
    <div class="kv"><span>state</span><b>${session.alive ? 'streaming' : 'stopped'}</b></div>
    <div class="kv"><span>mode</span><span>${escapeHtml(session.mode)} · ${escapeHtml(session.encoder)}</span></div>
    <div class="kv"><span>clients</span><span>${session.clients}</span></div>
    <div class="kv"><span>speed</span><span class="mono">${st.speed || '—'}</span></div>
    <div class="kv"><span>encoded fps</span><span class="mono">${st.fps ?? '—'}</span></div>
    <div class="kv"><span>bitrate</span><span class="mono">${st.bitrate || '—'}</span></div>
    <div class="kv"><span>dropped frames</span><span class="mono">${st.dropFrames ?? 0}</span></div>
    <div class="kv"><span>out</span><span class="mono">${fmtBytes(session.bytesOut)}</span></div>
    <div class="kv"><span>uptime</span><span class="mono">${session.uptimeSec}s</span></div>
    ${session.hls ? `<div class="row" style="margin-top:8px"><a class="btn sm" href="${session.progressUrl}" target="_blank">open HLS playlist ↗</a></div>` : ''}
    <h3 style="margin-top:12px">ffmpeg command</h3>
    <pre style="max-height:160px">${escapeHtml(session.command || '')}</pre>`;
}

let commandTimer = null;
let commandPreviewRevision = 0;
function updateCommandPreview() {
  clearTimeout(commandTimer);
  const revision = ++commandPreviewRevision;
  commandTimer = setTimeout(async () => {
    if (!state.stream) return;
    try {
      const outputType = $('#pf-cmd-output')?.value || '';
      const res = await api(`/api/streams/${state.stream.id}/command`, {
        method: 'POST', body: { profile: { ...readProfileForm(), outputType } }, silent: true,
      });
      if (revision !== commandPreviewRevision) return;
      $('#cmd-preview').textContent = res.command;
      if (res.profile.ffmpegTemplate) {
        $('#pf-note').innerHTML = `Using <b>${escapeHtml(res.profile.ffmpegTemplateName || 'custom FFmpeg template')}</b>; the template controls this outgoing command. The guided fields above are ignored.`;
      } else {
        $('#pf-note').innerHTML = `${res.profile.transcode ? '<b>encode</b>' : '<b>stream copy</b>'} — ${escapeHtml((res.profile.reasons || []).join('; '))}
          ${res.profile.transcode && res.profile.encoder === 'vaapi' && !res.hw.available ? '<br><span class="tag warn">vaapi unavailable here — this command will use software encoding</span>' : ''}`;
      }
      const tplLabel = res.template && res.template.templateId
        ? `${escapeHtml(res.template.name || res.template.templateId)} (${escapeHtml(res.template.source || 'guided')})`
        : (res.template && res.template.source === 'stream-custom' ? 'custom inline command' : 'guided profile builder');
      $('#pf-cmd-template').textContent = tplLabel;
    } catch (error) {
      if (revision !== commandPreviewRevision) return;
      if ($('#pf-template-select').value) {
        $('#cmd-preview').textContent = `Template error: ${error.message}`;
        $('#pf-note').innerHTML = `<b>Template not valid for this outgoing stream:</b> ${escapeHtml(error.message)}`;
      }
    }
  }, 250);
}

async function applyProfile() {
  if (!state.stream) return;
  const profile = readProfileForm();
  const res = await api(`/api/streams/${state.stream.id}/profile`, { method: 'POST', body: { profile } });
  toast(profile.ffmpegTemplate
    ? `Profile saved (FFmpeg template: ${profile.ffmpegTemplateName || 'custom'})`
    : `Profile saved (${res.profile.transcode ? 'transcode' : 'copy'})`, 'ok');
  await openStream(state.stream.id, { navigate: false });
}

/* ================= SUBTITLES ================= */

async function loadProviders() {
  try {
    const { providers } = await api('/api/subtitles/providers');
    state.providers = providers;
    $('#sub-providers').innerHTML = `<table>
      <thead><tr><th>Provider</th><th>Kind</th><th>Needs</th><th>Languages</th><th>State</th><th></th></tr></thead><tbody>
      ${providers.map((p) => `<tr>
        <td>${escapeHtml(p.name)}<div class="meta">${escapeHtml(p.note || '')}</div></td>
        <td>${tag(p.kind, p.kind === 'custom' ? 'alt' : '')}</td>
        <td>${p.needs.length ? p.needs.map((n) => tag(n, 'warn')).join('') : tag('—', 'ok')}</td>
        <td>${p.languages.map((l) => tag(l.toUpperCase())).join('')}</td>
        <td>${p.enabled
          ? (p.state?.ok === false ? tag(p.state.message, 'err') : p.state?.ok ? tag(p.state.message, 'ok') : tag('enabled'))
          : tag('disabled — needs key/credentials', 'warn')}</td>
        <td class="row">
          ${p.enabled ? `<button class="btn sm ghost" data-test="${p.id}">test</button>` : ''}
          ${p.kind === 'custom' ? `<button class="btn sm ghost" data-del="${p.id}">delete</button>` : ''}
        </td>
      </tr>`).join('')}</tbody></table>`;
    $$('#sub-providers button[data-test]').forEach((b) => b.addEventListener('click', async () => {
      b.textContent = 'testing…';
      try {
        const { result } = await api('/api/subtitles/providers/test', { method: 'POST', body: { id: b.dataset.test } });
        toast(`${result.id}: ${result.message}`, result.ok ? 'ok' : 'warn', 9000);
      } finally { loadProviders(); }
    }));
    $$('#sub-providers button[data-del]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/subtitles/providers/${b.dataset.del}`, { method: 'DELETE' });
      loadProviders();
    }));
  } catch { /* toast */ }
}

async function searchSubtitles() {
  const title = $('#sub-title').value.trim() || state.stream?.title;
  if (!title) return toast('Enter a title (or select a stream)', 'warn');
  $('#sub-results').innerHTML = '<div class="meta"><span class="spin"></span> searching providers…</div>';
  const res = await api('/api/subtitles/search', {
    method: 'POST',
    body: {
      title,
      year: Number($('#sub-year').value) || state.stream?.year || null,
      kind: state.stream?.kind || 'movie',
      season: state.stream?.upstream?.season || null,
      episode: state.stream?.upstream?.episode || null,
      imdb: $('#sub-imdb').value.trim() || null,
      languages: $('#sub-langs').value.split(',').map((s) => s.trim()).filter(Boolean),
      streamId: $('#sub-autostream').checked && state.stream ? state.stream.id : null,
    },
  });
  state.subResults = res.results;
  $('#sub-count').textContent = `${res.results.length} candidates`;
  $('#sub-results').innerHTML = res.results.length ? `<table>
    <thead><tr><th>Lang</th><th>Provider</th><th>Release</th><th>Score</th><th>DLs</th><th></th></tr></thead><tbody>
    ${res.results.slice(0, 40).map((r, i) => `<tr>
      <td>${tag((r.language || '?').toUpperCase(), (r.language || '').startsWith('nl') ? 'ok' : 'info')}</td>
      <td>${escapeHtml(r.providerId)}</td>
      <td class="mono" style="font-size:11.5px">${escapeHtml((r.release || r.title || '').slice(0, 70))}${r.hashMatch ? ' ' + tag('hash match', 'ok') : ''}</td>
      <td>${r.score}</td><td class="mono">${r.downloads || 0}</td>
      <td><button class="btn sm pri" data-sub="${i}">download</button></td>
    </tr>`).join('')}</tbody></table>` : '<div class="meta" style="padding:14px">No subtitles found. Check the provider states above — a "needs key" provider is skipped, not broken.</div>';
  $$('#sub-results button[data-sub]').forEach((b) => b.addEventListener('click', () => downloadSubtitle(state.subResults[Number(b.dataset.sub)])));
}

async function downloadSubtitle(result, streamId = ($('#sub-autostream').checked ? state.stream?.id : null)) {
  try {
    const res = await api('/api/subtitles/download', {
      method: 'POST',
      body: { result, offsetMs: Number($('#sub-offset').value) || 0, streamId: streamId || null, push: streamId ? null : false },
    });
    if (streamId) {
      $('#sub-attached').textContent = `${res.language} · ${res.cues} cues · ${res.provider}`;
      if (state.stream?.id === streamId) {
        const fresh = await api(`/api/streams/${encodeURIComponent(String(streamId))}`);
        state.stream = fresh.stream;
        renderStream(fresh);
      }
      toast('Subtitle attached to the stream profile (soft mux). Restart the session to apply.', 'info', 9000);
    } else {
      toast(`Subtitle downloaded: ${res.language} ${res.cues} cues (${res.provider})`, 'ok');
    }
    return true;
  } catch {
    return false; // api() already shows the failure
  }
}

/* ================= ENIGMA2 ================= */

async function loadEnigmaForm() {
  try {
    const { config } = await api('/api/config');
    const e = config.enigma2 || {};
    $('#e2-host').value = e.host || '';
    $('#e2-port').value = e.port || 80;
    $('#e2-user').value = e.username || 'root';
    $('#e2-name').value = e.bouquetName || 'vu-movie';
    $('#e2-service').value = String(e.serviceType || 4097);
    $('#e2-ftp').checked = Boolean(e.ftpEnabled);
    $('#e2-pass').value = '';
    $('#e2-pass').placeholder = e.password ? '(blank keeps saved password)' : '(empty if none)';
  } catch { /* api() shows the error */ }
}

async function loadEnigmaStatus() {
  const button = $('#btn-e2-test');
  const originalText = button.textContent;
  if (!$('#e2-host').value.trim()) await loadEnigmaForm();
  const host = $('#e2-host').value.trim();
  const port = Number($('#e2-port').value) || 80;
  const username = $('#e2-user').value.trim();
  const password = $('#e2-pass').value;

  button.disabled = true;
  button.textContent = 'testing…';
  $('#e2-status').textContent = 'testing connection…';
  $('#e2-status').className = 'tag info';
  $('#e2-log').textContent = `Testing OpenWebif and FTP file access at ${host || '(no host configured)'}…`;
  try {
    const { status } = await api('/api/enigma2/test', {
      method: 'POST', body: { host, port, username, ftpEnabled: $('#e2-ftp').checked, ...(password ? { password } : {}) },
    });
    const message = status.message || (status.ok ? 'WebIF reachable' : 'receiver unreachable');
    $('#e2-status').textContent = message;
    $('#e2-status').className = `tag ${status.ok ? 'ok' : status.configured ? 'err' : 'warn'}`;
    $('#e2-log').textContent = message;
    toast(status.ok ? `Connection successful: ${message}` : `Connection test failed: ${message}`, status.ok ? 'ok' : 'warn', 9000);
  } catch (error) {
    const message = error?.message || 'connection test failed';
    $('#e2-status').textContent = 'test failed';
    $('#e2-status').className = 'tag err';
    $('#e2-log').textContent = message;
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function previewBouquet() {
  const scope = document.querySelector('input[name=e2scope]:checked')?.value;
  const streamIds = scope === 'selected' && state.stream ? [state.stream.id] : [];
  const res = await api('/api/enigma2/preview', { method: 'POST', body: { streamIds, name: $('#e2-name').value || 'vu-movie' } });
  $('#e2-file').textContent = res.fileName;
  $('#e2-count').textContent = `${res.entries} entries`;
  $('#e2-preview').textContent = res.text;
  state.e2Preview = res;
}

async function saveEnigmaSettings() {
  const enigma2 = {
    host: $('#e2-host').value.trim(),
    port: Number($('#e2-port').value) || 80,
    username: $('#e2-user').value.trim(),
    bouquetName: $('#e2-name').value.trim() || 'vu-movie',
    serviceType: Number($('#e2-service').value) || 4097,
    ftpEnabled: $('#e2-ftp').checked,
  };
  // Password is write-only in the API response. An empty input means "leave the
  // saved credential alone"; users can still replace it by entering a new one.
  if ($('#e2-pass').value) enigma2.password = $('#e2-pass').value;
  await api('/api/config', { method: 'PUT', body: { enigma2 } });
  toast('Enigma2 settings saved', 'ok');
  loadEnigmaStatus();
}

async function pushBouquet(dryRun = false) {
  const scope = document.querySelector('input[name=e2scope]:checked')?.value;
  const streamIds = scope === 'selected' && state.stream ? [state.stream.id] : [];
  $('#e2-log').innerHTML = `<div><span class="info">INFO </span> pushing${dryRun ? ' (dry run)' : ''}…</div>`;
  try {
    const res = await api('/api/enigma2/push', { method: 'POST', body: { streamIds, name: $('#e2-name').value || 'vu-movie', dryRun } });
    $('#e2-log').innerHTML = [
      `<div><span class="info">INFO </span> bouquet "${escapeHtml(res.bouquet?.name || '')}" → ${res.bouquet?.entries || 0} entries</div>`,
      res.transport ? `<div><span class="info">INFO </span> transport: ${escapeHtml(res.transport)}</div>` : '',
      res.verified !== null && res.verified !== undefined ? `<div><span class="info">INFO </span> verified on the receiver: ${res.verified} entries</div>` : '',
      `<div><span class="${res.ok ? 'info' : 'error'}">${res.ok ? 'INFO ' : 'ERROR'}</span> ${res.ok ? 'push complete' : escapeHtml(res.error || 'failed')}</div>`,
      res.bouquet?.bouquetsLine ? `<div><span class="debug">DEBUG</span> ${escapeHtml(res.bouquet.bouquetsLine)}</div>` : '',
    ].join('');
    toast(res.ok ? 'Bouquet pushed to the receiver' : `Push failed: ${res.error}`, res.ok ? 'ok' : 'err', 10000);
    if (!dryRun) previewBouquet();
  } catch (err) {
    $('#e2-log').innerHTML += `<div><span class="error">ERROR</span> ${escapeHtml(err.message)}</div>`;
  }
}

/* ================= LOGS ================= */

function logLine(entry) {
  return `<div><span class="t">${escapeHtml(entry.time?.slice(11) || '')}</span> <span class="${entry.level}">${entry.level.toUpperCase().padEnd(5)}</span> <span class="component">${escapeHtml(entry.component)}</span> ${escapeHtml(entry.message)}${entry.fields ? ` <span class="mut">${escapeHtml(JSON.stringify(entry.fields))}</span>` : ''}</div>`;
}

async function loadLogs() {
  const params = new URLSearchParams({
    level: $('#log-level').value,
    component: $('#log-component').value,
    search: $('#log-search').value,
    limit: '400',
  });
  const res = await api(`/api/logs?${params}`);
  state.logs = res.entries;
  const select = $('#log-component');
  const current = select.value;
  select.innerHTML = `<option value="">all components</option>${res.components.map((c) => `<option value="${escapeHtml(c)}" ${c === current ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}`;
  $('#log-view').innerHTML = res.entries.map(logLine).join('') || '<div class="mut">no entries</div>';
  $('#log-view').scrollTop = $('#log-view').scrollHeight;
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('log', (event) => {
    const entry = JSON.parse(event.data);
    state.logs.push(entry);
    if (state.logs.length > 800) state.logs.shift();
    const min = { debug: 0, info: 1, warn: 2, error: 3 }[$('#log-level').value] ?? 1;
    const rank = { debug: 0, info: 1, warn: 2, error: 3 }[entry.level] ?? 1;
    const component = $('#log-component').value;
    const search = $('#log-search').value.toLowerCase();
    if (rank < min) return;
    if (component && entry.component !== component) return;
    if (search && !JSON.stringify(entry).toLowerCase().includes(search)) return;
    if (!$('#log-live').checked || $('#p-logs').classList.contains('hide')) return;
    const view = $('#log-view');
    view.insertAdjacentHTML('beforeend', logLine(entry));
    while (view.childElementCount > 500) view.firstElementChild.remove();
    view.scrollTop = view.scrollHeight;
  });
  source.addEventListener('job', () => { if (!$('#p-dash').classList.contains('hide')) loadJobs(); });
  source.addEventListener('sessions', (event) => renderSessions(JSON.parse(event.data)));
  source.onerror = () => { /* EventSource reconnects on its own */ };
}

/* ================= SETTINGS ================= */

const SETTINGS_SECTIONS = [
  {
    key: 'transcode', title: 'Transcode',
    fields: [
      ['mode', 'select', ['auto', 'copy', 'vaapi', 'x264', 'h265']],
      ['resolution', 'number'], ['aspect', 'select', ['source', '169', '43']],
      ['videoBitrate', 'number'], ['audioBitrate', 'number'], ['audioChannels', 'number'],
      ['fps', 'select', ['source', '25', '30']],
      ['container', 'select', ['mpegts', 'matroska', 'hls']],
      ['alwaysTranscode', 'bool'], ['hardware', 'bool'], ['maxConcurrent', 'number'],
      ['device', 'text'], ['idleStopSeconds', 'number'], ['encoderFallback', 'text'],
    ],
  },
  {
    key: 'subtitles', title: 'Subtitles',
    fields: [
      ['languages', 'list'], ['autoSearch', 'bool'], ['pushToReceiver', 'bool'],
      ['receiverDir', 'text'], ['disabledProviders', 'list'],
    ],
  },
  {
    key: 'enigma2', title: 'Enigma2',
    fields: [
      ['host', 'text'], ['port', 'number'], ['username', 'text'], ['password', 'password'],
      ['bouquetName', 'text'], ['rootDir', 'text'], ['serviceType', 'number'],
      ['ftpEnabled', 'bool'], ['ftpPort', 'number'], ['autoPush', 'bool'],
    ],
  },
  {
    key: 'scraper', title: 'Scraper',
    fields: [
      ['browserConcurrency', 'number'], ['browserIdleSeconds', 'number'], ['resolveTimeoutMs', 'number'],
      ['probeCandidates', 'bool'], ['maxCandidates', 'number'], ['flaresolverrUrl', 'text'],
      ['externalExtractorUrl', 'text'], ['sessionDir', 'text'], ['userAgent', 'text'],
    ],
  },
  {
    key: 'storage', title: 'Storage',
    fields: [['downloads', 'text'], ['tmp', 'text'], ['cacheBudgetMb', 'number']],
  },
  {
    key: 'app', title: 'Application',
    fields: [['port', 'number'], ['baseUrl', 'text'], ['username', 'text'], ['password', 'password'], ['logLevel', 'select', ['debug', 'info', 'warn', 'error']], ['tokenTtlMinutes', 'number']],
  },
];

let settingsDraft = null;

async function loadSettings() {
  const res = await api('/api/config');
  state.config = res.config;
  settingsDraft = JSON.parse(JSON.stringify(res.config));
  $('#settings-grid').innerHTML = SETTINGS_SECTIONS.map((section) => `
    <div class="card">
      <h2>${escapeHtml(section.title)}</h2>
      ${section.fields.map(([key, type, options]) => {
        const value = settingsDraft[section.key]?.[key];
        const id = `set-${section.key}-${key}`;
        if (type === 'bool') {
          return `<div class="field"><label class="row" style="gap:6px;color:var(--fg);margin:0"><input type="checkbox" id="${id}" ${value ? 'checked' : ''}> ${escapeHtml(key)}</label></div>`;
        }
        if (type === 'select') {
          return `<div class="field"><label>${escapeHtml(key)}</label><select id="${id}">${options.map((o) => `<option value="${o}" ${String(value) === String(o) ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
        }
        if (type === 'list') {
          return `<div class="field"><label>${escapeHtml(key)} (comma separated)</label><input id="${id}" value="${escapeHtml((value || []).join(', '))}"></div>`;
        }
        return `<div class="field"><label>${escapeHtml(key)}</label><input id="${id}" type="${type}" value="${escapeHtml(value ?? '')}"></div>`;
      }).join('')}
    </div>`).join('');
}

async function saveSettings() {
  const patch = {};
  for (const section of SETTINGS_SECTIONS) {
    patch[section.key] = {};
    for (const [key, type] of section.fields) {
      const el = $(`#set-${section.key}-${key}`);
      if (!el) continue;
      let value;
      if (type === 'bool') value = el.checked;
      else if (type === 'number') value = Number(el.value);
      else if (type === 'list') value = el.value.split(',').map((s) => s.trim()).filter(Boolean);
      else value = el.value;
      if (type === 'password' && /^•+$/.test(String(value))) continue; // unchanged masked secret
      patch[section.key][key] = value;
    }
  }
  await api('/api/config', { method: 'PUT', body: patch });
  toast('Settings saved to /config/vumovie.json', 'ok');
  loadHealth();
}

/* ================= wiring ================= */

async function copyText(text) {
  const value = String(text ?? '');
  if (!value) {
    toast('Nothing to copy', 'warn');
    return false;
  }

  // The Clipboard API is restricted to secure contexts. vu-movie is commonly
  // opened over plain HTTP on a home LAN, so keep a synchronous fallback for
  // those browsers (and for browsers that deny clipboard-write permissions).
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      toast('Copied to the clipboard', 'ok', 2500);
      return true;
    } catch { /* fall through to execCommand while the click is still active */ }
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  Object.assign(textarea.style, {
    position: 'fixed', top: '0', left: '-9999px', opacity: '0', pointerEvents: 'none',
  });
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { /* unsupported browser */ }
  textarea.remove();

  if (copied) {
    toast('Copied to the clipboard', 'ok', 2500);
    return true;
  }
  toast('Copy failed — select the text manually', 'warn');
  return false;
}

const App = {
  go, openStream, cancelJob: async (id) => { await api(`/api/jobs/${id}/cancel`, { method: 'POST' }); loadJobs(); },
  copy: copyText,
  loadJobs, loadStreams, loadHealth,
};
window.App = App;

function wire() {
  $('#btn-search').addEventListener('click', doSearch);
  $('#results-title-filter').addEventListener('input', () => { renderResults(); saveSearchState(); });
  $('#results-title-select').addEventListener('change', () => {
    const group = visibleResultGroups().find((candidate) => candidate.key === $('#results-title-select').value);
    const preferred = group && preferredResultEntry(group.matches);
    if (preferred) selectResult(preferred.index);
  });
  $('#results-provider-filter').addEventListener('change', () => { renderResults(); saveSearchState(); });
  const saveUrlForm = () => {
    clearFindSubtitleSearch();
    state.lastResolveMode = '';
    state.pendingRestoreUrlResolve = false;
    saveSearchState();
    setFindSubtitlesAction();
  };
  ['u-url', 'u-title', 'u-year', 'u-season', 'u-episode'].forEach((id) =>
    $(`#${id}`).addEventListener('input', saveUrlForm));
  ['u-kind', 'u-browser', 'u-probe'].forEach((id) =>
    $(`#${id}`).addEventListener('change', saveUrlForm));
  $('#results-view').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (button) setResultsView(button.dataset.view);
  });
  updateResultsViewButtons();
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  $('#btn-resolve').addEventListener('click', doResolveFromUrl);
  $('#btn-sel-subs-close').addEventListener('click', () => $('#sel-subtitle-panel').classList.add('hide'));

  ['pf-vbr', 'pf-abr'].forEach((id) => $(`#${id}`).addEventListener('input', () => {
    $(`#${id}-l`).textContent = `${$(`#${id}`).value} kbps`;
    updateCommandPreview();
  }));
  ['pf-mode', 'pf-res', 'pf-aspect', 'pf-container', 'pf-fps', 'pf-subs', 'pf-always', 'pf-deint', 'pf-ac']
    .forEach((id) => $(`#${id}`).addEventListener('change', updateCommandPreview));
  $('#pf-template-select').addEventListener('change', selectFfmpegTemplate);
  $('#pf-template-command').addEventListener('input', () => {
    updateFfmpegTemplateButtons();
    updateCommandPreview();
  });
  $('#btn-template-save-new').addEventListener('click', () => saveFfmpegTemplate());
  $('#btn-template-save').addEventListener('click', () => saveFfmpegTemplate({ update: true }));
  $('#btn-template-default').addEventListener('click', () => saveFfmpegTemplate({ update: true, makeDefault: true }));
  $('#btn-template-delete').addEventListener('click', deleteFfmpegTemplate);
  $('#pf-cmd-output')?.addEventListener('change', updateCommandPreview);
  $('#pf-output-templates')?.addEventListener('change', updateCommandPreview);
  $('#btn-test-template')?.addEventListener('click', testCurrentStreamTemplate);

  // Dedicated Transcode templates page
  $('#btn-tpl-new')?.addEventListener('click', () => {
    tplEditorSelect({ id: '', name: '', description: '', container: 'mpegts', command: starterFfmpegTemplate('mpegts'), output: {} });
  });
  $('#btn-tpl-save')?.addEventListener('click', () => tplSave());
  $('#btn-tpl-save-top')?.addEventListener('click', () => tplSave());
  $('#btn-tpl-delete')?.addEventListener('click', tplDelete);
  $('#btn-tpl-test')?.addEventListener('click', () => {
    if (!state.tplEditor) return;
    const editor = state.tplEditor;
    const tmplSel = $('#tpl-test-template');
    if (editor.id && state.ffmpegTemplates.find((t) => t.id === editor.id)) {
      tmplSel.value = editor.id;
    } else {
      tmplSel.value = TPL_TEST_INLINE_VALUE;
      $('#tpl-test-command').value = editor.command || '';
    }
    go('tpl-test');
  });
  $('#btn-tpl-set-default')?.addEventListener('click', () => {
    if (!state.tplEditor?.id) return;
    tplSetDefaultFromList(state.tplEditor.id);
  });
  $('#tpl-list')?.addEventListener('click', (event) => {
    const editId = event.target.closest('[data-tpl-edit]')?.dataset.tplEdit;
    const delId = event.target.closest('[data-tpl-delete]')?.dataset.tplDelete;
    const defId = event.target.closest('[data-tpl-default]')?.dataset.tplDefault;
    const testRowId = event.target.closest('[data-tpl-test-row]')?.dataset.tplTestRow;
    if (editId) {
      const item = state.ffmpegTemplates.find((t) => t.id === editId);
      if (item) tplEditorSelect(item);
    } else if (testRowId) {
      $('#tpl-test-template').value = testRowId;
      go('tpl-test');
    } else if (delId) {
      const item = state.ffmpegTemplates.find((t) => t.id === delId);
      if (!item) return;
      if (!window.confirm(`Delete template “${item.name}”?`)) return;
      const templates = state.ffmpegTemplates.filter((t) => t.id !== delId);
      const defaultFfmpegTemplateId = state.defaultFfmpegTemplateId === delId ? '' : state.defaultFfmpegTemplateId;
      const ffmpegDefaults = { ...(state.ffmpegDefaults || {}) };
      for (const [output, tplId] of Object.entries(ffmpegDefaults)) if (tplId === delId) ffmpegDefaults[output] = '';
      api('/api/ffmpeg/templates', { method: 'PUT', body: { templates, defaultFfmpegTemplateId, ffmpegDefaults } }).then((res) => {
        state.ffmpegTemplates = res.templates;
        state.defaultFfmpegTemplateId = res.defaultFfmpegTemplateId || '';
        state.ffmpegDefaults = res.ffmpegDefaults || {};
        if (state.tplEditor?.id === delId) tplEditorSelect(null);
        renderTemplatesPage();
        toast('Template deleted', 'ok');
      });
    } else if (defId) {
      tplSetDefaultFromList(defId);
    }
  });
  $('#tpl-editor-outputs')?.addEventListener('change', (event) => {
    const target = event.target;
    if (!target.matches('input[data-output-check]')) return;
    const output = target.dataset.outputCheck;
    if (!state.tplEditor) return;
    state.tplEditor.output = { ...(state.tplEditor.output || {}) };
    if (target.checked) state.tplEditor.output[output] = state.tplEditor.id || '__self__';
    else delete state.tplEditor.output[output];
    renderTplEditor();
  });
  $('#tpl-editor-command')?.addEventListener('input', () => {
    if (!state.tplEditor) return;
    state.tplEditor.command = $('#tpl-editor-command').value;
    $('#tpl-editor-status').textContent = 'Save to apply changes.';
  });
  $('#tpl-editor-name')?.addEventListener('input', () => {
    if (!state.tplEditor) return;
    state.tplEditor.name = $('#tpl-editor-name').value;
  });
  $('#tpl-editor-description')?.addEventListener('input', () => {
    if (!state.tplEditor) return;
    state.tplEditor.description = $('#tpl-editor-description').value;
  });
  $('#tpl-editor-container')?.addEventListener('change', () => {
    if (!state.tplEditor) return;
    state.tplEditor.container = $('#tpl-editor-container').value;
  });
  $('#tpl-default')?.addEventListener('change', async () => {
    const value = $('#tpl-default').value;
    const result = await api('/api/ffmpeg/templates', {
      method: 'PUT',
      body: { templates: state.ffmpegTemplates, defaultFfmpegTemplateId: value, ffmpegDefaults: state.ffmpegDefaults },
    });
    state.ffmpegTemplates = result.templates;
    state.defaultFfmpegTemplateId = result.defaultFfmpegTemplateId || '';
    state.ffmpegDefaults = result.ffmpegDefaults || {};
    renderTemplatesPage();
    toast(value ? 'Default template set' : 'Default template cleared', 'ok');
  });

  // Template test page
  $('#tpl-test-template')?.addEventListener('change', () => {
    state.tplTest.lastResult = null;
    renderTplTestPanel();
  });
  $('#tpl-test-stream')?.addEventListener('change', () => {
    state.tplTest.lastResult = null;
    renderTplTestPanel();
  });
  $('#tpl-test-duration')?.addEventListener('input', () => {
    if (state.tplTest.lastResult) state.tplTest.lastResult = null;
    renderTplTestPanel();
  });
  $('#tpl-test-command')?.addEventListener('input', () => {
    if (state.tplTest.lastResult) state.tplTest.lastResult = null;
    renderTplTestPanel();
  });
  $('#btn-tpl-test-run')?.addEventListener('click', runTplTest);
  $('#btn-tpl-test-reset')?.addEventListener('click', resetTplTest);
  $('#btn-profile-apply').addEventListener('click', applyProfile);
  $('#btn-profile-reset').addEventListener('click', async () => {
    if (!state.stream) return;
    await api(`/api/streams/${state.stream.id}/profile`, { method: 'POST', body: { profile: { mode: 'auto', container: 'mpegts', alwaysTranscode: false, resolution: 1080, videoBitrate: 8000, audioBitrate: 192, audioChannels: 6, fps: '25', aspect: 'source', subtitles: 'soft', ffmpegTemplate: '', ffmpegTemplateId: '', ffmpegTemplateName: '' } } });
    openStream(state.stream.id);
  });
  $('#btn-vlc').addEventListener('click', async () => {
    const res = await api(`/api/streams/${state.stream.id}`);
    window.location.href = res.urls.ts.replace(/^https?:/, 'vlc:');
  });
  $('#btn-session-start').addEventListener('click', async () => {
    await api(`/api/streams/${state.stream.id}/session`, { method: 'POST', body: {} });
    toast('Session started — ffmpeg is warming up', 'ok');
    setTimeout(() => openStream(state.stream.id), 1200);
  });
  $('#btn-session-stop').addEventListener('click', async () => {
    await api(`/api/streams/${state.stream.id}/session`, { method: 'DELETE' });
    toast('Session stopped', 'info');
    openStream(state.stream.id);
  });
  $('#btn-download').addEventListener('click', async () => {
    const res = await api(`/api/streams/${state.stream.id}/download`, { method: 'POST', body: {} });
    toast(`Download job ${res.job.id} queued — watch it on the dashboard`, 'ok', 9000);
  });
  $('#btn-playlist').addEventListener('click', () => {
    window.location.href = `/s/${state.stream.token}/${state.stream.title ? state.stream.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() : 'stream'}.m3u`;
  });
  $('#btn-direct').addEventListener('click', () => {
    window.open(`/s/${state.stream.token}/direct`, '_blank');
  });
  $('#btn-refresh-stream').addEventListener('click', () => openStream(state.stream.id));

  $('#btn-sub-search').addEventListener('click', searchSubtitles);
  $('#btn-providers-refresh').addEventListener('click', loadProviders);
  $('#btn-sub-push').addEventListener('click', async () => {
    if (!state.stream) return toast('Select a stream first', 'warn');
    const res = await api('/api/subtitles/push', { method: 'POST', body: { streamId: state.stream.id } });
    toast(res.ok ? `Subtitle pushed (${res.path || res.via})` : `Push failed: ${res.error}`, res.ok ? 'ok' : 'err', 9000);
  });
  $('#btn-cp-save').addEventListener('click', async () => {
    const id = $('#cp-id').value.trim();
    const searchUrl = $('#cp-search').value.trim();
    if (!id || !searchUrl) return toast('id and search URL are required', 'warn');
    const kind = $('#cp-kind').value;
    await api('/api/subtitles/providers', {
      method: 'POST',
      body: {
        id, name: $('#cp-name').value.trim() || id, searchUrl, enabled: true,
        downloadUrl: $('#cp-download').value.trim() || undefined,
        parse: kind === 'json' ? { kind: 'json', items: $('#cp-parse').value.trim() } : { kind: 'html', regex: $('#cp-parse').value.trim() },
      },
    });
    toast(`Provider ${id} saved`, 'ok');
    loadProviders();
  });

  $('#btn-e2-preview').addEventListener('click', previewBouquet);
  $('#btn-e2-save').addEventListener('click', saveEnigmaSettings);
  $('#btn-e2-test').addEventListener('click', loadEnigmaStatus);
  $('#btn-e2-push').addEventListener('click', () => pushBouquet(false));
  $('#btn-e2-dry').addEventListener('click', () => pushBouquet(true));
  $('#btn-e2-copy').addEventListener('click', () => App.copy(state.e2Preview?.text || ''));
  $('#btn-e2-download').addEventListener('click', () => {
    const blob = new Blob([state.e2Preview?.text || ''], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.e2Preview?.fileName || 'userbouquet.vu-movie.tv';
    a.click();
  });

  $('#btn-log-refresh').addEventListener('click', loadLogs);
  $('#btn-log-clear').addEventListener('click', () => { $('#log-view').innerHTML = ''; });
  ['log-level', 'log-component', 'log-search'].forEach((id) => $(`#${id}`).addEventListener('change', loadLogs));
  $('#log-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadLogs(); });

  $('#btn-save-settings').addEventListener('click', saveSettings);
  $('#btn-reload-settings').addEventListener('click', loadSettings);
  $('#btn-hw-test').addEventListener('click', async () => {
    toast('Re-testing the VAAPI pipelines (this runs a 2 s encode)…', 'info');
    const res = await api('/api/config/hwaccel/test', { method: 'POST' });
    const hw = res.hwaccel;
    toast(hw.available
      ? `VAAPI ok: ${hw.driver || 'driver'} via ${hw.libvaDriver || 'libva default'} (variant ${hw.fpsVariant})`
      : `VAAPI unavailable: ${hw.reason}`, hw.available ? 'ok' : 'warn', 12000);
    loadHealth();
  });

  // "ffmpeg is not working" button: timed probes, driver by driver, no guessing.
  $('#btn-diag').addEventListener('click', async () => {
    const out = $('#diag-out');
    out.textContent = 'Running diagnostics: ffmpeg -version, /dev/dri, vainfo and a 2 s VAAPI encode per driver…';
    try {
      const res = await api('/api/diagnostics/ffmpeg');
      const r = res.report;
      const lines = [
        `ffmpeg: ${r.ffmpeg.ok ? `${r.ffmpeg.version} — answered in ${r.ffmpeg.elapsedMs} ms (${r.ffmpeg.path})` : `${r.ffmpeg.kind}: ${r.ffmpeg.error}`}`,
        `ffprobe: ${r.ffprobe.ok ? `ok (${r.ffprobe.version})` : `${r.ffprobe.kind}: ${r.ffprobe.error}`}`,
        `/dev/dri: ${r.devicePresent ? `${r.config.device} present` : `${r.config.device} MISSING${r.driEntries.length ? ` (container sees: ${r.driEntries.join(', ')})` : ' (container sees no /dev/dri at all — pass it through in docker-compose.yml)'}`}`,
        ...r.drivers.map((d) => `driver ${d.driver}: vainfo ${d.vainfo.ok ? `ok (${d.vainfo.version})` : `failed (${d.vainfo.error})`} · encode ${d.encode.ok ? 'WORKS' : `failed (${d.encode.error})`}`),
      ];
      out.innerHTML = `<b>${r.ok ? (r.hardwareOk ? 'Result: hardware transcoding is usable' : 'Result: ffmpeg works, software transcoding only') : 'Result: ffmpeg is not usable'}</b>`
        + `<br>${lines.map((l) => escapeHtml(String(l))).join('<br>')}`
        + `<br><span class="mut">finished in ${r.elapsedMs} ms · ${escapeHtml(r.hint || '')}</span>`;
      toast(r.hardwareOk ? 'VAAPI works — details under the buttons' : 'No VAAPI — details under the buttons', r.hardwareOk ? 'ok' : 'warn', 10000);
      loadHealth();
    } catch (err) {
      out.textContent = `Diagnostics failed: ${err.message}`;
    }
  });
  $('#btn-cs-save').addEventListener('click', async () => {
    const id = $('#cs-id').value.trim();
    const home = $('#cs-home').value.trim();
    if (!id || !home) return toast('id and home URL are required', 'warn');
    await api('/api/sources', {
      method: 'POST',
      body: {
        id, name: $('#cs-name').value.trim() || id, home, enabled: true,
        match: [home.replace(/^https?:\/\//, '').replace(/\/.*$/, '')],
        search: { kind: 'browser', url: $('#cs-search').value.trim() || `${home}/search/{query}`, linkPattern: '/(movie|tv|watch|serie)/' },
        resolve: { kind: 'browser' },
      },
    });
    toast(`Source ${id} saved`, 'ok');
    loadSources();
  });
}

wire();
restoreAppState();
loadHealth();
loadSources();
loadStreams();
loadJobs();
connectEvents();
setInterval(() => { if (!$('#p-dash').classList.contains('hide')) loadHealth(); }, 15000);
