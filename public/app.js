/* vu-movie — the app shell: tab controllers, routing and bootstrap.
 *
 * This file is the last script on the page, so core.js, playlist.js and
 * ffmpeg-editor.js are already loaded. It owns every tab except the three that
 * have their own module:
 *
 *   core.js          helpers, shared `state`, `api()`, `toast()`, modal, copy
 *   playlist.js      the Playlist tab (and the client copy of the playlist)
 *   ffmpeg-editor.js the Transcode + Test tabs (one parameter editor)
 *   app.js           Mobile, Dashboard, Search, Subtitles, Stream, Logs,
 *                    Settings, navigation, health polling and bootstrap
 *
 * Source recipes and their home/mirror links arrive through the existing
 * /api/sources endpoint; GUI state and rendering stay in this plain script.
 */
'use strict';

const SEARCH_STATE_KEY = 'vu-movie.search-state.v2';
const RESULT_VIEW_KEY = 'vu-movie.search-results-view';
const RESULT_SORT_KEY = 'vu-movie.search-results-sort';
const SELECTED_STREAM_KEY = 'vu-movie.selected-stream';
// Set by Stream → “test template” so the Test tab opens on the same stream.
const TEST_SOURCE_KEY = 'vu-movie.test-source';
const FIND_TABS = ['title', 'url', 'browse'];
const RESULT_VIEWS = ['list', 'poster', 'thumbnails'];

const ui = {
  search: { q: '', type: '', tabs: 'title', moviebox: true, url: '', urlTitle: '', urlYear: '', urlKind: 'movie', urlSeason: '', urlEpisode: '' },
  resultsView: 'poster',
  resultsSort: 'year-desc',
  titleFilter: '',
  /* Exact-title filter: the key of one group, set by the “Filter found title”
     box. Independent of `titleFilter` (the free-text one) — picking a title
     narrows the list, it never selects or resolves it. */
  titlePick: '',
  providerFilter: '',
  /* “All / movie / series” — filters the cards by their kind. */
  kindFilter: '',
  providers: [],
  selection: null,
  groups: [],
  candidates: [],
  resolving: false,
  seasons: null,
  /* Series picker state (series selections only; movies ignore it). */
  series: null,
};
// The Mobile tab's state lives on the shared `state` object (core.js), because
// every mobile helper — search, formats, add, subtitles — reads it from there.

let searchSeq = 0;
let resolveSeq = 0;
let searchAbort = null;
let resolveAbort = null;
const initialized = new Set();
let currentPage = 'dash';
let healthTimer = null;
let logStream = null;

/* ====================================================================== *
 * routing
 * ====================================================================== */

function pageFromHash() {
  const raw = String(window.location.hash || '').replace(/^#\/?/, '').split('?')[0];
  return APP_PAGES.includes(raw) ? raw : '';
}

async function go(page, { hash = true, force = false } = {}) {
  if (!APP_PAGES.includes(page)) page = 'dash';
  currentPage = page;
  $$('.nav button').forEach((button) => button.classList.toggle('on', button.dataset.p === page));
  APP_PAGES.forEach((name) => $(`#p-${name}`)?.classList.toggle('hide', name !== page));
  document.body.dataset.page = page;
  if (hash && pageFromHash() !== page) {
    // `hash = page` keeps the back button working without a scroll jump.
    window.location.hash = `#${page}`;
  }
  try {
    await openPage(page, { force });
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function openPage(page, { force = false } = {}) {
  const once = async (name, fn) => {
    if (!initialized.has(name) || force) {
      initialized.add(name);
      try {
        await fn();
      } catch (error) {
        // A failed first load must not lock the tab: forget it so opening the
        // page again retries instead of showing an empty pane for ever.
        initialized.delete(name);
        throw error;
      }
    }
  };
  switch (page) {
    case 'mobile':
      await once('mobile', initMobile);
      refreshMobile();
      break;
    case 'dash':
      loadHealth();
      loadJobs();
      loadStreams();
      await once('dash-sources', loadSources);
      break;
    case 'find':
      await once('find', initFind);
      break;
    case 'subs':
      await once('subs', initSubtitles);
      refreshSubTargets();
      break;
    case 'tpl':
      // Refresh on every visit. A title can be added in Search after this editor
      // was first opened, and its test-source picker must reflect the playlist
      // immediately instead of staying empty until a full page reload.
      await Promise.all([VMPlaylist.load({ silent: false }), loadStreams()]);
      await once('tpl', async () => {
        await VMFfmpegEditor.initLibrary();
        VMFfmpegEditor.wireLibraryTab();
      });
      VMFfmpegEditor.renderLibrary();
      // the editor's own test pane offers the playlist + saved streams as input
      VMFfmpegEditor.renderTestSources(VMFfmpegEditor.libraryEditor);
      break;
    case 'list':
      await VMPlaylist.refresh();
      break;
    case 'stream':
      await once('stream', initStream);
      await refreshStream();
      break;
    case 'tpl-test':
      await Promise.all([VMPlaylist.load({ silent: false }), loadStreams()]);
      await once('tpl-test', async () => {
        await VMFfmpegEditor.initTestTab();
        wireTestSourcePicker();
        wireTestControls();
      });
      renderTestSourcePicker();
      break;
    case 'logs':
      await once('logs', initLogs);
      loadLogs();
      break;
    case 'set':
      await once('set', initSettings);
      break;
    default:
      break;
  }
}

/* ====================================================================== *
 * dashboard (kept as it was — same cards, same data, new markup)
 * ====================================================================== */

const dot = (value) => (value === true ? 'ok' : value === false ? 'err' : 'warn');

async function loadHealth() {
  try {
    const h = await api('/api/health', { silent: true });
    state.health = h;
    const hwPending = Boolean(h.hwaccelPending || h.hwaccel?.pending);
    $('#h-ffmpeg').className = `dot ${dot(h.ffmpeg?.ok)}`;
    $('#h-hw').className = `dot ${dot(hwPending ? null : h.hwaccel?.available)}`;
    $('#h-db').className = `dot ${h.postgres ? 'ok' : 'warn'}`;
    $('#h-box').className = `dot ${h.enigma2?.configured ? dot(h.enigma2.ok) : 'warn'}`;
    $('#side-info').innerHTML = `v${escapeHtml(h.version)} · up ${escapeHtml(String(h.uptimeSec))}s<br>`
      + `${escapeHtml(hwPending ? 'hardware self-test running…' : h.hwaccel?.available ? `${h.hwaccel.driver || 'vaapi'} (H.264 enc)` : (h.hwaccel?.reason || 'no hardware accel'))}<br>`
      + `${h.postgres ? 'postgres connected' : 'in-memory store'}`;

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
          ['chromium', h.browser?.available ? `running (${h.browser.activePages} page)` : (h.browser?.executable ? 'idle, ready' : 'not installed'), Boolean(h.browser?.executable)],
          ['external extractor', h.externalExtractor ? 'configured' : 'not used', null],
          ['node', h.node, null],
        ],
      },
      {
        title: 'Storage & database',
        rows: [
          ['postgres', h.postgres ? 'connected (tables migrated)' : 'memory fallback', h.postgres],
          ['database url', h.db?.lastError ? `error: ${h.db.lastError}` : 'ok', h.db?.lastError ? false : null],
          ['live sessions', String(h.streamSessions?.length ?? 0), null],
        ],
      },
      {
        title: 'VU+ Duo2 (Enigma2)',
        rows: [
          ['configured', h.enigma2?.configured ? 'yes' : 'no (set host in Settings)', h.enigma2?.configured],
          ['reachable', h.enigma2?.message || '—', h.enigma2?.ok === null ? null : h.enigma2?.ok],
          ['model', h.enigma2?.model || '—', null],
          ['last checked', h.enigma2?.checked ? `${h.enigma2.ageMs != null ? Math.round(h.enigma2.ageMs / 1000) : '?'}s ago (on demand only)` : 'never', null],
        ],
      },
    ];
    $('#dash-cards').innerHTML = cards.map((card) => `
      <div class="card">
        <h3>${escapeHtml(card.title)}</h3>
        ${card.rows.map(([key, value, ok]) => `<div class="kv"><span>${escapeHtml(key)}</span>
          <span>${ok === null ? '' : `<i class="dot ${dot(ok)}" style="margin-right:6px"></i>`}${escapeHtml(String(value))}</span></div>`).join('')}
      </div>`).join('');

    renderSessions(h.streamSessions || []);
    const healthById = Object.fromEntries((h.sources || []).map((source) => [source.id, source.health]));
    state.sources.forEach((source) => { source.health = healthById[source.id] || source.health; });
    if (currentPage === 'dash' && state.sources.length) renderSourceHealth();
  } catch (error) {
    const cards = $('#dash-cards');
    if (cards) cards.innerHTML = `<div class="card"><h3>Backend unreachable</h3><div class="meta">${escapeHtml(error.message)}</div></div>`;
  }
}

function renderSessions(sessions) {
  state.sessions = sessions;
  const host = $('#dash-sessions');
  if (host) {
    // A preview runs as its own session next to a VLC one (a running pipe
    // cannot change its output), so the row has to say which is which.
    host.innerHTML = sessions.length
      ? sessions.map((s) => `<div class="kv"><span>${escapeHtml(s.streamId)} <span class="mut">${escapeHtml(s.mode || '')}/${escapeHtml(s.encoder || '')}</span>${s.web ? ` ${tag(OUTPUT_LABELS.web || 'web preview', 'alt')}` : ''}</span>
          <span>${s.clients} client(s) · ${s.bytesOut ? fmtBytes(s.bytesOut) : '0'} ${s.stats?.speed ? `· ${escapeHtml(s.stats.speed)}` : ''}</span></div>`).join('')
      : '<div class="meta">none</div>';
  }
  if ($('#st-monitor') && !$('#p-stream')?.classList.contains('hide')) renderStreamMonitor();
}

function sourceHomeEntries(source) {
  const mirrors = Array.isArray(source?.mirrors) ? source.mirrors : [];
  const candidates = [{ name: source?.name || '', url: source?.home || '' }, ...mirrors.map((mirror) => (
    typeof mirror === 'string' ? { name: '', url: mirror } : mirror || {}
  ))];
  const seen = new Set();
  return candidates.flatMap((candidate) => {
    try {
      const url = new URL(String(candidate.url || candidate.home || ''));
      if (!['http:', 'https:'].includes(url.protocol)) return [];
      const href = url.href;
      const key = href.replace(/\/$/, '').toLowerCase();
      if (!url.hostname || seen.has(key)) return [];
      seen.add(key);
      return [{ href, label: url.hostname.replace(/^www\./i, ''), name: candidate.name || url.hostname }];
    } catch { return []; }
  });
}

/**
 * The ↗ beside a source chip always opens the source's own website (primary
 * homepage) — never a title search for whatever is in the search box.
 * Unsafe/non-http homepages render no link at all.
 */
function sourceHomeOpenLink(source) {
  const entry = sourceHomeEntries(source)[0];
  if (!entry) return '';
  const title = `Open ${source?.name || 'source'} homepage`;
  return `<a class="source-home-open" href="${escapeHtml(entry.href)}" target="_blank" rel="noopener noreferrer"
    aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}">↗</a>`;
}

function sourceLinkButtons(source, className = 'source-open-link') {
  return sourceHomeEntries(source).map((entry) => `<a class="btn sm ghost ${className}" href="${escapeHtml(entry.href)}" target="_blank" rel="noopener noreferrer"
    aria-label="Open ${escapeHtml(source.name)} at ${escapeHtml(entry.label)}" title="${escapeHtml(entry.href)}">${escapeHtml(entry.label)} ↗</a>`).join('');
}

function sourceDirectoryMarkup(source) {
  const entries = sourceHomeEntries(source);
  return `<div class="source-directory-group" data-source-group="${escapeHtml(source.id)}">
    <div class="source-directory-heading"${source.notes ? ` title="${escapeHtml(source.notes)}"` : ''}>
      <span>${escapeHtml(source.name)}</span>${entries.length > 1 ? `<span class="source-directory-count">${entries.length} domains</span>` : ''}
    </div>
    <div class="source-directory-links">${sourceLinkButtons(source, 'source-directory-link') || '<span class="meta">no homepage URL</span>'}</div>
  </div>`;
}

function renderSourceHealth() {
  const host = $('#dash-sources');
  if (host) {
    host.innerHTML = state.sources.map((source) => `
      <div class="srcrow">
        <div class="srcrow-info"><b>${escapeHtml(source.name)}</b> <span class="mut" style="font-size:11px">${escapeHtml(source.kind || '')}</span></div>
        <div class="srcrow-actions">
          <span>${source.health?.ok === true ? tag(source.health.message || 'ok', 'ok') : source.health?.checks ? tag(source.health.message || 'failing', 'err') : tag('unused')}</span>
          <div class="source-health-links">${sourceLinkButtons(source, 'source-health-link')}</div>
        </div>
      </div>`).join('') || '<div class="meta">no sources</div>';
  }
  if (host) host.dataset.loaded = '1';
  const chips = $('#source-chips');
  if (chips && state.sources.length) renderSourceChips();
}

async function loadJobs() {
  try {
    const { jobs } = await api('/api/jobs?limit=25', { silent: true });
    state.jobs = jobs;
    const host = $('#dash-jobs');
    if (!host) return;
    host.innerHTML = jobs.length ? `<table>
      <thead><tr><th>Job</th><th>Type</th><th>Progress</th><th>State</th><th></th></tr></thead><tbody>
      ${jobs.map((job) => `<tr>
        <td>${escapeHtml(job.title)}<div class="meta">${escapeHtml(job.message || '')}</div></td>
        <td>${tag(job.type, job.type === 'download' ? 'info' : 'alt')}</td>
        <td><div class="bars" style="height:10px">${Array.from({ length: 12 }, (_, i) => `<i style="height:${i < Math.round(job.progress / 8.4) ? 10 : 3}px"></i>`).join('')}</div>
          <div class="meta">${job.progress}%</div></td>
        <td>${tag(job.status, job.status === 'failed' ? 'err' : job.status === 'done' ? 'ok' : job.status === 'running' ? 'info' : '')}</td>
        <td>${job.status === 'running' || job.status === 'queued' ? `<button class="btn sm ghost" data-cancel="${escapeHtml(job.id)}">cancel</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="meta" style="padding:14px">no jobs</div>';
  } catch { /* the toast from api() is enough */ }
}

async function loadStreams() {
  const { streams } = await api('/api/streams', { silent: true });
  state.streams = streams;
  const count = $('#dash-stream-count');
  if (count) count.textContent = `${streams.length} saved`;
  const host = $('#dash-streams');
  if (host) {
    host.innerHTML = streams.length ? `<table>
      <thead><tr><th>Title</th><th>Source</th><th>Quality</th><th>Mode</th><th>Created</th><th></th></tr></thead><tbody>
      ${streams.map((stream) => `<tr>
        <td>${escapeHtml(stream.title)}${stream.year ? ` <span class="mut">(${stream.year})</span>` : ''}</td>
        <td>${tag(stream.sourceId || '—')}</td><td>${tag(stream.quality || '—', 'ok')}</td>
        <td>${tag(stream.transcode ? 'transcode' : 'copy', stream.transcode ? 'alt' : 'ok')}</td>
        <td class="mut">${fmtTime(stream.createdAt)}</td>
        <td><button class="btn sm" data-open-stream="${escapeHtml(stream.id)}">open</button></td>
      </tr>`).join('')}</tbody></table>` : '<div class="meta" style="padding:14px">no streams yet</div>';
  }
}

/* ====================================================================== *
 * search — sources, grouped results, metadata + formats
 * ====================================================================== */

const LEGACY_BUILTIN_SOURCE_IDS = ['overlook', 'cinevo', 'cinejoy', 'flixhub', 'redflix', 'flex1', 'cinezo'];

async function loadSources() {
  const { sources = [] } = await api('/api/sources');
  state.sources = sources;
  const currentIds = sources.map((source) => source.id);
  const enabledIds = sources.filter((source) => source.enabled).map((source) => source.id);
  if (!state.selectedSources.length) {
    state.selectedSources = enabledIds;
  } else {
    const savedCatalog = Array.isArray(ui.search.sourceIds) ? ui.search.sourceIds : null;
    const wasSelectAll = savedCatalog?.length
      ? savedCatalog.every((id) => state.selectedSources.includes(id))
        && state.selectedSources.every((id) => savedCatalog.includes(id))
      : LEGACY_BUILTIN_SOURCE_IDS.every((id) => state.selectedSources.includes(id));
    const selected = state.selectedSources.filter((id) => currentIds.includes(id));
    // An old v2 preference with every original built-in selected means “all”;
    // include newly installed sources without overriding a saved custom subset.
    state.selectedSources = wasSelectAll
      ? [...new Set([...selected, ...enabledIds])]
      : [...new Set(selected)];
  }
  ui.search.sourceIds = currentIds;
  renderSourceChips();
  renderSourceHealth();
  renderBrowseLinks();
  renderMobileSourceLinks();
}

function renderSourceChips() {
  const host = $('#source-chips');
  if (!host) return;
  host.innerHTML = state.sources.map((source) => {
    const domains = sourceHomeEntries(source).map((entry) => entry.label).join(', ');
    const details = [source.notes, domains ? `Domains: ${domains}` : ''].filter(Boolean).join(' — ');
    return `<span class="source-chip-option">
      <span class="chip ${state.selectedSources.includes(source.id) ? 'on' : ''}" data-id="${escapeHtml(source.id)}" role="button" tabindex="0"
        title="${escapeHtml(details || source.name)}${source.health?.ok === false ? ' — failing' : ''}">
        ${escapeHtml(source.name)}${source.mirrors?.length ? ` <small class="chip-count">+${source.mirrors.length}</small>` : ''}${source.health?.ok === false ? ' ⚠' : ''}</span>
      ${sourceHomeOpenLink(source)}
    </span>`;
  }).join('') || '<span class="meta">no sources configured</span>';
  const count = $('#sources-count');
  if (count) count.textContent = `${state.selectedSources.length}/${state.sources.length} selected`;
}

function safeImageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function discoveryCardMarkup(item, list) {
  const title = String(item.title || '').trim();
  if (!title) return '';
  const posterUrl = safeImageUrl(item.poster);
  const kind = item.type === 'series' ? 'series' : 'movie';
  const year = Number(item.year) || '';
  const details = [kind === 'series' ? 'Series' : 'Movie', year || ''].filter(Boolean).join(' · ');
  const rating = Number(item.rating) > 0 ? `★ ${Number(item.rating).toFixed(1)}` : '';
  const reason = list === 'for-you' && Number(item.matches) > 0
    ? `Matches ${item.matches} added title${item.matches === 1 ? '' : 's'}`
    : '';
  const overview = String(item.overview || '').trim();
  return `<button type="button" class="discovery-card" data-discovery-pick data-title="${escapeHtml(title)}"
      data-kind="${kind}" data-year="${year}" aria-label="Search for ${escapeHtml(title)}">
    ${posterUrl ? `<img class="discovery-poster" src="${escapeHtml(posterUrl)}" alt="" loading="lazy">` : '<span class="discovery-poster placeholder" aria-hidden="true">🎬</span>'}
    <span class="discovery-copy">
      <b>${escapeHtml(title)}</b>
      <span class="meta">${escapeHtml(details)}${rating ? ` · ${escapeHtml(rating)}` : ''}</span>
      ${reason ? `<span class="discovery-reason">${escapeHtml(reason)}</span>` : ''}
      ${overview ? `<span class="discovery-overview">${escapeHtml(overview)}</span>` : ''}
    </span>
    <span class="discovery-select" aria-hidden="true">Search ↗</span>
  </button>`;
}

function openDiscoveryModal(target = 'find') {
  const bodyMarkup = `<p class="meta discovery-intro">Choose a title to run it through the existing source search. “For you” uses the complete playlist-addition history, including removed or deleted items — never playback history.</p>
    <div class="tabs discovery-tabs" role="tablist" aria-label="Title lists">
      <button type="button" class="on" data-discovery-list="trending" aria-pressed="true">Trending now</button>
      <button type="button" data-discovery-list="top10" aria-pressed="false">Top 10</button>
      <button type="button" data-discovery-list="for-you" aria-pressed="false">For you</button>
    </div>
    <div class="discovery-controls">
      <label class="discovery-filter">Titles<select id="discovery-type"><option value="all">Movies + series</option><option value="movie">Movies</option><option value="series">Series</option></select></label>
      <label class="discovery-filter" id="discovery-window-filter">Trending<select id="discovery-window"><option value="week">This week</option><option value="day">Today</option></select></label>
      <button type="button" class="btn sm ghost" id="discovery-refresh">↻ Refresh</button>
    </div>
    <div id="discovery-summary" class="meta" role="status" aria-live="polite">Loading titles…</div>
    <div id="discovery-results" class="discovery-grid"><div class="meta">Loading…</div></div>`;
  openModal({
    title: 'Discover titles',
    body: bodyMarkup,
    className: 'wide discovery-modal',
    onMount: (body) => mountDiscoveryModal(body, target),
  });
}

function mountDiscoveryModal(body, target) {
  if (!body) return null;
  let list = 'trending';
  let type = 'all';
  let window = 'week';
  let sequence = 0;
  let controller = null;
  const summary = $('#discovery-summary', body);
  const results = $('#discovery-results', body);
  const typeSelect = $('#discovery-type', body);
  const windowSelect = $('#discovery-window', body);
  const windowFilter = $('#discovery-window-filter', body);

  const renderState = () => {
    $$('[data-discovery-list]', body).forEach((button) => {
      const active = button.dataset.discoveryList === list;
      button.classList.toggle('on', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (windowFilter) windowFilter.classList.toggle('hide', list !== 'trending');
  };

  const showError = (error) => {
    const message = String(error?.message || 'Could not load this list');
    if (/TMDB API key is not configured/i.test(message)) {
      if (summary) summary.innerHTML = 'Add a TMDB API key in Settings → Metadata to load this list. <button type="button" class="btn sm ghost" data-discovery-settings>Open Settings</button>';
    } else if (summary) summary.textContent = message;
    if (results) results.innerHTML = '<div class="meta">No titles loaded.</div>';
  };

  const load = async () => {
    controller?.abort();
    controller = new AbortController();
    const current = ++sequence;
    if (summary) summary.textContent = 'Loading titles…';
    if (results) results.innerHTML = '<div class="meta"><span class="spin"></span> Loading…</div>';
    const params = new URLSearchParams({ type });
    if (list === 'trending') params.set('window', window);
    params.set('limit', list === 'top10' ? '10' : '20');
    try {
      const data = await api(`/api/discovery/${list}?${params}`, { silent: true, signal: controller.signal });
      if (current !== sequence) return;
      const items = Array.isArray(data.items) ? data.items : [];
      if (list === 'for-you') {
        if (summary) {
          const additions = Number(data.historyCount) || 0;
          const unique = Number(data.uniqueHistoryTitles) || 0;
          summary.textContent = additions
            ? `Based on ${type === 'all' ? 'all ' : ''}${additions} playlist additions${type === 'all' ? '' : ` matching the ${type === 'movie' ? 'movies' : 'series'} filter`} (${unique} distinct titles; removed/deleted titles are retained). No watch history is used.${data.partialFailures ? ` ${data.partialFailures} TMDB lookup(s) unavailable.` : ''}`
            : type === 'all'
              ? 'No playlist additions yet. Add a title to the playlist to build recommendations; later removals and deletions will stay in the history.'
              : `No ${type === 'movie' ? 'movie' : 'series'} additions match this filter. Switch to Movies + series to see all playlist additions.`;
        }
      } else if (summary) {
        summary.textContent = list === 'trending'
          ? `TMDB trending ${window === 'day' ? 'today' : 'this week'} · ${items.length} titles`
          : `TMDB top-rated titles · ${items.length} titles`;
      }
      if (results) {
        results.innerHTML = items.length
          ? items.map((item) => discoveryCardMarkup(item, list)).filter(Boolean).join('')
          : `<div class="meta">${list === 'for-you' && Number(data.historyCount) === 0 ? 'Your playlist-addition history is empty for this filter.' : 'No titles in this list right now.'}</div>`;
      }
    } catch (error) {
      if (error?.name === 'AbortError' || current !== sequence) return;
      showError(error);
    }
  };

  $$('[data-discovery-list]', body).forEach((button) => button.addEventListener('click', () => {
    list = button.dataset.discoveryList;
    renderState();
    load();
  }));
  typeSelect?.addEventListener('change', () => { type = typeSelect.value; load(); });
  windowSelect?.addEventListener('change', () => { window = windowSelect.value; load(); });
  $('#discovery-refresh', body)?.addEventListener('click', load);
  body.addEventListener('click', (event) => {
    const settings = event.target.closest('[data-discovery-settings]');
    if (settings) { closeModal(); go('set'); return; }
    const choice = event.target.closest('[data-discovery-pick]');
    if (!choice) return;
    const title = choice.dataset.title || '';
    if (target === 'mobile') {
      if ($('#mob-q')) $('#mob-q').value = title;
      if ($('#mob-type')) $('#mob-type').value = choice.dataset.kind === 'series' ? 'series' : 'movie';
      renderMobSourceChips();
      closeModal();
      mobileSearch();
    } else {
      if ($('#q')) $('#q').value = title;
      if ($('#q-type')) $('#q-type').value = choice.dataset.kind === 'series' ? 'series' : 'movie';
      renderSourceChips();
      closeModal();
      doSearch();
    }
  });
  renderState();
  load();
  return () => { sequence += 1; controller?.abort(); };
}

function initFind() {
  setFindTab(readStoredJson(SEARCH_STATE_KEY)?.tabs || 'title', false);
  const stored = readStoredJson(SEARCH_STATE_KEY) || {};
  ui.search = { ...ui.search, ...stored };
  if (Array.isArray(stored.sources) && stored.sources.length) state.selectedSources = stored.sources;
  ui.resultsView = RESULT_VIEWS.includes(readStoredText(RESULT_VIEW_KEY)) ? readStoredText(RESULT_VIEW_KEY) : 'poster';
  ui.resultsSort = readStoredText(RESULT_SORT_KEY) || 'year-desc';
  if ($('#q')) $('#q').value = ui.search.q || '';
  if ($('#q-type')) $('#q-type').value = ui.search.type || '';
  if ($('#q-moviebox')) $('#q-moviebox').checked = ui.search.moviebox !== false;
  for (const [id, key] of [['u-url', 'url'], ['u-title', 'urlTitle'], ['u-year', 'urlYear'], ['u-season', 'urlSeason'], ['u-episode', 'urlEpisode']]) {
    if ($(`#${id}`)) $(`#${id}`).value = ui.search[key] || '';
  }
  if ($('#u-kind')) $('#u-kind').value = ui.search.urlKind || 'movie';
  $('#results-sort').value = ui.resultsSort;
  updateResultsViewButtons();
  renderBrowseLinks();
  loadSources().catch((error) => toast(error.message, 'err'));
  wireFind();
}

function saveSearchState() {
  ui.search.sources = state.selectedSources;
  ui.search.sourceIds = state.sources.map((source) => source.id);
  writeStoredText(SEARCH_STATE_KEY, JSON.stringify(ui.search));
}

function setFindTab(tab, persist = true) {
  if (!FIND_TABS.includes(tab)) return;
  ui.search.tabs = tab;
  $$('#find-tabs button').forEach((button) => button.classList.toggle('on', button.dataset.t === tab));
  FIND_TABS.forEach((name) => $(`#tab-${name}`)?.classList.toggle('hide', name !== tab));
  if (persist) saveSearchState();
}

function renderBrowseLinks() {
  const host = $('#browse-links');
  if (host) {
    host.innerHTML = state.sources.map(sourceDirectoryMarkup).join('')
      || '<div class="meta">no sources configured</div>';
  }
  renderMobileSourceLinks();
}

function renderMobileSourceLinks() {
  const host = $('#mob-source-links');
  if (!host) return;
  host.innerHTML = state.sources.map(sourceDirectoryMarkup).join('')
    || '<div class="meta">no sources configured</div>';
}

/**
 * Reset the panel *before* the request goes out.
 *
 * A fan-out search takes seconds per provider, and the previous answer used to
 * stay on screen the whole time — so right after pressing Search the list still
 * showed the old query's titles, and its selection and formats stayed below it.
 * Everything the previous search produced is dropped here (cards, counts,
 * filters, the selected title and its formats) and the panel says what is
 * running instead.
 */
function beginSearch(query) {
  state.searching = { query, sources: state.selectedSources.length || state.sources.length || 0 };
  state.searchError = null;
  state.searched = false;
  state.results = [];
  state.groups = [];
  state.providerErrors = [];
  ui.titleFilter = '';
  ui.titlePick = '';
  ui.providerFilter = '';
  ui.kindFilter = '';
  if ($('#results-title-filter')) $('#results-title-filter').value = '';
  clearSelection();
  renderFindErrors([]);
  renderResults();
}

async function doSearch() {
  const q = ($('#q')?.value || '').trim();
  if (!q) {
    toast('Type a title first', 'warn');
    return;
  }
  ui.search.q = q;
  ui.search.type = $('#q-type')?.value || '';
  ui.search.moviebox = $('#q-moviebox')?.checked !== false;
  saveSearchState();
  searchAbort?.abort();
  searchAbort = new AbortController();
  const seq = ++searchSeq;
  const hint = $('#find-hint');
  if (hint) hint.textContent = `searching ${state.selectedSources.length || state.sources.length || 0} source(s)…`;
  beginSearch(q);
  $('#btn-search').disabled = true;
  try {
    const params = new URLSearchParams({ q });
    if (ui.search.type) params.set('type', ui.search.type);
    if (state.selectedSources.length && state.selectedSources.length !== state.sources.length) params.set('sources', state.selectedSources.join(','));
    params.set('moviebox', ui.search.moviebox ? 'true' : 'false');
    const data = await api(`/api/find/search?${params}`, { silent: true, signal: searchAbort.signal });
    if (seq !== searchSeq) return;
    state.searching = null;
    state.searchError = null;
    state.searched = true;
    state.results = data.results || [];
    state.providerErrors = data.providerErrors || [];
    renderFindErrors(state.providerErrors);
    renderResults();
    if (hint) hint.textContent = `${state.results.length} result(s) on ${new Set(state.results.map((r) => r.sourceId)).size} provider(s)`;
    renderBrowseLinks();
  } catch (error) {
    // An aborted search was replaced by a newer one: it owns the panel now.
    if (error.name !== 'AbortError' && seq === searchSeq) {
      state.searching = null;
      state.searchError = error.message;
      renderFindErrors([{ sourceId: '', error: error.message }]);
      if (hint) hint.textContent = '';
      renderResults();
    }
  } finally {
    if (seq === searchSeq) $('#btn-search').disabled = false;
  }
}

function renderFindErrors(providerErrors) {
  const host = $('#find-errors');
  if (!host) return;
  const rows = (providerErrors || []).filter((entry) => entry?.error);
  host.classList.toggle('hide', !rows.length);
  host.innerHTML = rows.map((entry) => `<div class="errline">${tag(entry.sourceId || 'source', 'err')} ${escapeHtml(entry.error)}</div>`).join('');
}

/* ---------------- grouping ---------------- */

const titleKey = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\(\s*(19|20)\d{2}\s*\)/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/** The same movie found on several providers becomes one group (title + year + kind). */
function buildGroups(results) {
  const groups = new Map();
  for (const result of results) {
    if (!result || !result.url) continue;
    const key = `${titleKey(result.title)}|${result.year || ''}|${result.kind || 'movie'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: result.title,
        year: result.year || null,
        kind: result.kind || 'movie',
        poster: result.poster || '',
        entries: [],
      });
    }
    const group = groups.get(key);
    group.poster = group.poster || result.poster || '';
    group.entries.push(result);
  }
  return [...groups.values()];
}

/**
 * Narrow the list of title cards.
 *
 * Three independent filters: the exact title picked in “Filter found title”
 * (`ui.titlePick`, a group key), the free-text `ui.titleFilter`, the provider
 * filter and the “All / movie / series” kind filter. Filtering only decides what
 * is *listed* — nothing is selected or resolved by filtering.
 */
function visibleGroups() {
  const pick = ui.titlePick;
  const filter = titleKey(ui.titleFilter);
  const provider = ui.providerFilter;
  const kind = ui.kindFilter;
  let groups = state.groups || [];
  if (pick) groups = groups.filter((group) => group.key === pick);
  if (filter) groups = groups.filter((group) => titleKey(group.title).includes(filter));
  if (kind) groups = groups.filter((group) => (group.kind || 'movie') === kind);
  if (provider) groups = groups.map((group) => ({ ...group, entries: group.entries.filter((entry) => entry.sourceId === provider) })).filter((group) => group.entries.length);
  const sort = ui.resultsSort;
  const year = (group) => Number(group.year) || 0;
  return [...groups].sort((a, b) => {
    if (sort === 'year-asc') return year(a) - year(b) || a.title.localeCompare(b.title);
    if (sort === 'title') return a.title.localeCompare(b.title);
    if (sort === 'providers') return b.entries.length - a.entries.length || year(b) - year(a);
    return year(b) - year(a) || a.title.localeCompare(b.title);
  });
}

function isSelectedGroup(group) {
  return Boolean(state.selection?.key && state.selection.key === group.key);
}

/** “Dune: Part Two (2024)” — the label every list, chip and select uses. */
function titleText(group) {
  return `${group.title}${group.year ? ` (${group.year})` : ''}`;
}

/** The free-text title filter. Typing here drops an exact title pick. */
function applyTitleFilter(value) {
  ui.titleFilter = String(value ?? '');
  ui.titlePick = '';
  if ($('#results-title-select')) $('#results-title-select').value = '';
  renderResults();
}

/**
 * The “Filter found title” box narrows the list to one title.
 *
 * It used to call selectGroup(), i.e. pick a title and resolve its formats at
 * once — which is what the cards are for. Choosing here now only filters, and
 * it clears the other two filters so the title that was just chosen cannot be
 * filtered away again.
 */
function applyTitlePick(key) {
  ui.titlePick = String(key || '');
  ui.titleFilter = '';
  ui.providerFilter = '';
  ui.kindFilter = '';
  if ($('#results-title-filter')) $('#results-title-filter').value = '';
  if ($('#results-provider-filter')) $('#results-provider-filter').value = '';
  if ($('#results-kind-filter')) $('#results-kind-filter').value = '';
  renderResults();
}

/** What the empty result area says — never the previous answer. */
function emptyResultsMessage() {
  if (state.searching) return `searching “${escapeHtml(state.searching.query)}” on ${state.searching.sources} source(s)…`;
  if (state.searchError) return `search failed — ${escapeHtml(state.searchError)}`;
  if ((state.results || []).length) return 'Nothing matches these filters.';
  if (state.searched) return 'No results. Open a site in the Browse tab, or paste the player URL in the Paste URL tab.';
  return 'No search yet.';
}

/**
 * One chip per provider, plus “all providers” where the panel needs the way
 * back. The chip is the click target that resolves a single provider; the card
 * or the panel around it resolves every provider.
 */
function providerChipsMarkup(group, { activeSource = '', attr = 'data-provider', all = false, allLabel = 'all providers' } = {}) {
  const ids = [...new Set(group.entries.map((entry) => entry.sourceId))];
  if (!ids.length) return '';
  const chip = (value, label, count, active) => `<button type="button" class="chip sm provider-chip${active ? ' on' : ''}" ${attr}="${escapeHtml(value)}" aria-pressed="${active ? 'true' : 'false'}" title="${escapeHtml(value ? `Resolve only the formats ${label} has for this title` : 'Resolve the formats of every provider on this title')}">${escapeHtml(label)}<span class="mut">${count}</span></button>`;
  const chips = ids.map((id) => chip(id, sourceName(id), group.entries.filter((entry) => entry.sourceId === id).length, activeSource === id));
  if (all) chips.unshift(chip('', allLabel, group.entries.length, !activeSource));
  return chips.join('');
}

function renderResults() {
  const host = $('#results');
  if (!host) return;
  state.groups = buildGroups(state.results || []);
  // Re-sync the two filter controls *before* the list is computed: a provider
  // filter left over from the previous search (or a picked title that is no
  // longer in the results) must not be applied one render late.
  const providerSelect = $('#results-provider-filter');
  if (providerSelect) {
    const ids = [...new Set((state.results || []).map((result) => result.sourceId))];
    const previous = providerSelect.value;
    providerSelect.innerHTML = `<option value="">All providers</option>${ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(sourceName(id))}</option>`).join('')}`;
    providerSelect.value = ids.includes(previous) ? previous : '';
    ui.providerFilter = providerSelect.value;
  }
  const titleSelect = $('#results-title-select');
  if (titleSelect) {
    // Every found title stays selectable, also while the list is filtered: the
    // box is the way out of — and between — single-title views.
    titleSelect.innerHTML = `<option value="">All titles</option>${(state.groups || []).map((group) => `<option value="${escapeHtml(group.key)}">${escapeHtml(titleText(group))} — ${group.entries.length} provider(s)</option>`).join('')}`;
    const known = (state.groups || []).some((group) => group.key === ui.titlePick);
    ui.titlePick = known ? ui.titlePick : '';
    titleSelect.value = ui.titlePick;
  }
  // The kind filter's options are static (all/movie/series); just keep the
  // control on the value the panel is filtering by.
  if ($('#results-kind-filter')) $('#results-kind-filter').value = ui.kindFilter;
  const groups = visibleGroups();
  const total = (state.groups || []).length;
  const filtered = Boolean(ui.titlePick || ui.titleFilter || ui.providerFilter || ui.kindFilter);
  host.className = `results results-${ui.resultsView}`;
  // While a search runs the panel is empty on purpose; tell assistive tech the
  // area is busy instead of letting it read out the previous answer.
  host.setAttribute('aria-busy', state.searching ? 'true' : 'false');
  const count = $('#results-count');
  if (count) {
    const providers = new Set((state.results || []).map((result) => result.sourceId));
    if (state.searching) count.textContent = 'searching…';
    else if (!state.results?.length) count.textContent = '';
    else count.textContent = `${filtered ? `${groups.length} of ${total}` : total} title(s) · ${state.results.length} hit(s) · ${providers.size} provider(s)`;
  }
  if (!groups.length) {
    host.innerHTML = `<div class="meta">${emptyResultsMessage()}</div>`;
    return;
  }
  host.innerHTML = groups.map((group) => resultGroupMarkup(group)).join('');
  $$('[data-group]', host).forEach((card) => {
    const group = groups.find((candidate) => candidate.key === card.dataset.group);
    const open = () => selectGroup(group);
    card.addEventListener('click', (event) => {
      if (event.target.closest('a,button')) return;
      open();
    });
    card.addEventListener('keydown', (event) => {
      // Enter/Space on a provider chip belongs to the chip, not to the card.
      if (event.target.closest('a,button')) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    });
    card.querySelector('[data-open-meta]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openSearchMetadata(group);
    });
    card.querySelector('[data-open-formats]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selectGroup(group);
    });
    card.querySelector('[data-preview-group]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      previewGroup(group, e.currentTarget);
    });
  });
}

function sourceName(id) {
  if (id === 'moviebox') return 'MovieBox';
  return state.sources.find((source) => source.id === id)?.name || id || '—';
}

function resultGroupMarkup(group) {
  const activeSource = isSelectedGroup(group) ? (state.selection?.activeSource || '') : '';
  const meta = group.entries.map((entry) => entry.releaseDate || '').filter(Boolean)[0];
  const rating = group.entries.map((entry) => Number(entry.rating)).filter((value) => value > 0).sort((a, b) => b - a)[0];
  const genres = group.entries.flatMap((entry) => (Array.isArray(entry.genres) ? entry.genres : [])).slice(0, 3);
  const description = group.entries.map((entry) => entry.description).find(Boolean);
  const poster = group.poster || group.entries.map((entry) => entry.poster).find(Boolean) || '';
  return `<article class="result-card${isSelectedGroup(group) ? ' selected' : ''}" data-group="${escapeHtml(group.key)}" tabindex="0" role="button">
    <div class="poster small">${poster ? `<img src="${escapeHtml(poster)}" alt="" loading="lazy" onerror="this.remove()">` : '<b>—</b>'}</div>
    <div class="result-body">
      <div class="result-title">${escapeHtml(group.title)}${group.year ? ` <span class="mut">(${group.year})</span>` : ''}</div>
      <div class="result-meta">
        ${tag(group.kind || 'movie', group.kind === 'series' ? 'alt' : '')}
        ${rating ? tag(`★ ${rating.toFixed(1)}`, 'ok') : ''}
        ${meta ? tag(String(meta).slice(0, 10)) : ''}
        ${genres.map((genre) => tag(genre)).join('')}
      </div>
      ${description ? `<p class="result-desc">${escapeHtml(String(description).slice(0, 260))}${String(description).length > 260 ? '…' : ''}</p>` : ''}
      <div class="result-providers">${providerChipsMarkup(group, { activeSource })}</div>
    </div>
    <div class="result-actions">
      <span class="tag info">${group.entries.length} format(s)</span>
      <button class="btn sm ghost" data-open-meta title="show TMDB/IMDb metadata">ⓘ meta</button>
      <button class="btn sm pri" data-open-formats>formats &amp; metadata</button>
    </div>
  </article>`;
}

/* ---------------- search-result preview (ephemeral stream + web player) ----------------
 *
 * The ▶ preview button on a result card resolves the title's providers in a
 * race, takes the best playable format of the first provider that answers
 * with one, and plays it in the preview web player — without touching the
 * playlist. The backing stream is ephemeral (never listed, no subtitle or
 * bouquet chores) and is deleted when the player modal closes.
 */

/** First episode of the first listed season — what a series preview plays. */
async function previewSeriesEpisode(group) {
  try {
    const params = new URLSearchParams({ title: group.title || '' });
    if (group.year) params.set('year', String(group.year));
    const data = await api(`/api/find/series?${params}`, { silent: true });
    const seasons = Array.isArray(data.seasons) ? data.seasons : [];
    const first = seasons.map((entry) => ({
      season: Number(entry.season),
      episode: (entry.episodes || []).map((ep) => Number(ep.episode)).filter((n) => n > 0).sort((a, b) => a - b)[0],
    })).filter((entry) => entry.season > 0 && entry.episode).sort((a, b) => a.season - b.season)[0];
    if (first) return { season: first.season, episode: first.episode };
  } catch { /* fall through to S1E1 */ }
  return { season: 1, episode: 1 };
}

async function previewGroup(group, button = null) {
  if (!group?.entries?.length) return;
  const label = button?.innerHTML;
  if (button) { button.disabled = true; button.innerHTML = '<span class="spin"></span> resolving…'; }
  try {
    const isSeries = (group.kind || 'movie') === 'series';
    const picked = isSeries ? await previewSeriesEpisode(group) : { season: 0, episode: 0 };
    const { season, episode } = picked;
    // Providers race: the first playable format wins and the rest are
    // aborted, so one slow/dead site never holds the preview hostage.
    const controller = new AbortController();
    let winner = null;
    const errors = [];
    const heightOf = (candidate) => seriesQualityHeight(seriesQualityKey(candidate));
    await Promise.all(group.entries.map(async (entry) => {
      if (controller.signal.aborted || winner) return;
      try {
        const data = await api('/api/find/resolve', {
          method: 'POST', silent: true, signal: controller.signal,
          body: {
            url: entry.url,
            sourceId: entry.sourceId,
            title: entry.title || group.title,
            year: entry.year || group.year || null,
            kind: entry.kind || group.kind || 'movie',
            season, episode,
            probe: true,
            useBrowser: entry.sourceId !== 'moviebox',
          },
        });
        if (controller.signal.aborted || winner) return;
        const playable = expandCandidateQualities(data.candidates || [])
          .filter((candidate) => candidate.ok !== false)
          .sort((a, b) => heightOf(b) - heightOf(a));
        if (playable.length && !winner) {
          winner = { ...playable[0], sourceId: playable[0].sourceId || entry.sourceId, _entry: entry };
          controller.abort();
        } else if (data.error) {
          errors.push(`${sourceName(entry.sourceId)}: ${data.error}`);
        }
      } catch (error) {
        if (error?.name !== 'AbortError') errors.push(`${sourceName(entry.sourceId)}: ${error.message}`);
      }
    }));
    if (!winner) {
      toast(errors.length ? `Nothing playable to preview — ${errors[0]}` : 'Nothing playable to preview', 'warn');
      return;
    }
    const entry = winner._entry || {};
    const data = await api('/api/streams', {
      method: 'POST',
      silent: true,
      body: {
        title: isSeries && season && episode ? `${group.title} ${seriesLabel(season, episode)}` : group.title,
        year: entry.year || group.year || null,
        kind: entry.kind || group.kind || 'movie',
        poster: group.poster || entry.poster || '',
        description: entry.description || '',
        sourceId: winner.sourceId || entry.sourceId || '',
        candidate: {
          url: winner.url,
          quality: winner.quality,
          label: winner.label,
          sourceId: winner.sourceId || entry.sourceId,
          kind: winner.kind,
          headers: winner.headers,
          variants: winner.variants,
          probe: winner.probe,
        },
        season: isSeries ? season : null,
        episode: isSeries ? episode : null,
        ephemeral: true,
      },
    });
    const streamId = data.stream?.id;
    if (!streamId) throw new Error('preview stream was not created');
    await VMPlaylist.openPlayer(streamId, {
      onClose: () => {
        api(`/api/streams/${encodeURIComponent(streamId)}`, { method: 'DELETE', silent: true }).catch(() => {});
      },
    });
  } catch (error) {
    if (error?.name !== 'AbortError') toast(`Preview failed: ${error.message}`, 'err');
  } finally {
    if (button) { button.disabled = false; button.innerHTML = label; }
  }
}

function updateResultsViewButtons() {
  $$('#results-view button').forEach((button) => {
    const on = button.dataset.view === ui.resultsView;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const host = $('#results');
  if (host) host.className = `results results-${ui.resultsView}`;
}

/* ---------------- selection: metadata + formats ---------------- */

function clearSelection() {
  state.selection = null;
  state.candidates = [];
  state.seasons = null;
  // A resolve that was in flight belongs to the selection that is going away;
  // without this the “resolving formats…” note could outlive it.
  state.resolving = false;
  resolveAbort?.abort();
  abortSeriesLoads();
  state.series = null;
  $('#sel-name').textContent = 'nothing selected';
  $('#sel-meta').textContent = 'search or paste a URL, then pick a title to see its metadata and formats';
  $('#sel-poster').innerHTML = '<b>—</b>';
  if ($('#sel-note')) $('#sel-note').textContent = 'Pick a title to resolve its available qualities.';
  if ($('#sel-providers')) $('#sel-providers').innerHTML = '';
  // The subtitle hits belong to the title that is going away.
  $('#sel-subtitle-panel')?.classList.add('hide');
  $('#sel-details')?.classList.add('hide');
  $('#sel-meta-table')?.classList.add('hide');
  $('#sel-episode-controls')?.classList.add('hide');
  $('#candidates').innerHTML = '<div class="meta">No formats yet.</div>';
  $('#sel-actions').innerHTML = '';
  markSelectedCard();
}

/**
 * Repaint “this card is open / this provider is the scope” in place.
 *
 * Re-rendering the whole list would work too, but it drops focus and the
 * scroll position — and the list is the only place the active provider is
 * visible while the formats below are being resolved.
 */
function markSelectedCard() {
  const host = $('#results');
  if (!host) return;
  const key = state.selection?.key || '';
  const active = state.selection?.activeSource || '';
  $$('[data-group]', host).forEach((card) => {
    const selected = Boolean(key) && card.dataset.group === key;
    card.classList.toggle('selected', selected);
    card.querySelectorAll('[data-provider]').forEach((chip) => {
      const on = selected && chip.dataset.provider === active;
      chip.classList.toggle('on', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  });
}

/** “all providers” plus one chip per provider: the panel's format scope. */
function renderSelectionProviders(group, activeSource = '') {
  const host = $('#sel-providers');
  if (!host) return;
  const ids = [...new Set(group.entries.map((entry) => entry.sourceId))];
  // A single provider needs no switch — the card click already means it.
  host.innerHTML = ids.length > 1 ? providerChipsMarkup(group, { activeSource, attr: 'data-sel-provider', all: true }) : '';
}

function metadataRows(group) {
  const first = group.entries[0] || {};
  const rows = [
    ['Title', group.title],
    ['Year', group.year || '—'],
    ['Kind', group.kind],
    ['Rating', group.entries.map((entry) => Number(entry.rating)).filter((value) => value > 0).sort((a, b) => b - a)[0]?.toFixed(1) || '—'],
    ['Genres', group.entries.flatMap((entry) => (Array.isArray(entry.genres) ? entry.genres : [])).join(', ') || '—'],
    ['Runtime', group.entries.map((entry) => entry.runtime).find(Boolean) || first.duration || '—'],
    ['Language', group.entries.map((entry) => entry.language).find(Boolean) || '—'],
    ['Released', group.entries.map((entry) => entry.releaseDate).find(Boolean)?.slice(0, 10) || '—'],
    ['Providers', group.entries.map((entry) => sourceName(entry.sourceId)).join(', ')],
    ['Sources', String(group.entries.length)],
  ];
  const description = group.entries.map((entry) => entry.description).find(Boolean);
  return { rows, description };
}

async function fetchEnrichedSearch(group) {
  try {
    const params = new URLSearchParams({
      title: group.title || '',
      year: group.year ? String(group.year) : '',
      type: group.kind || 'movie',
    });
    // Try to use imdb/tmdb id if present in entries
    const meta = group.entries.find(e=>e.imdbId||e.tmdbId) || {};
    if (meta.imdbId) params.set('imdbId', meta.imdbId);
    if (meta.tmdbId) params.set('tmdbId', meta.tmdbId);
    const data = await api(`/api/metadata/tmdb?${params}`, { silent: true });
    return data;
  } catch (e) {
    return null;
  }
}

function enrichedToRows(enriched) {
  if (!enriched) return [];
  const rows = [];
  const tmdb = enriched.tmdb;
  const omdb = enriched.omdb;
  if (tmdb) {
    if (tmdb.overview) rows.push(['Plot (TMDB)', tmdb.overview]);
    if (tmdb.tagline) rows.push(['Tagline', tmdb.tagline]);
    if (tmdb.genres?.length) rows.push(['Genres (TMDB)', tmdb.genres.join(', ')]);
    if (tmdb.rating) rows.push(['TMDB rating', `★ ${tmdb.rating} (${tmdb.votes||0} votes)`]);
    if (tmdb.runtime) rows.push(['Runtime (TMDB)', `${tmdb.runtime} min`]);
    if (tmdb.director?.length) rows.push(['Director (TMDB)', tmdb.director.join(', ')]);
    if (tmdb.cast?.length) rows.push(['Cast (TMDB)', tmdb.cast.slice(0,8).map(c=>c.name).join(', ')]);
    if (tmdb.releaseDate) rows.push(['Released (TMDB)', tmdb.releaseDate]);
    if (tmdb.status) rows.push(['Status (TMDB)', tmdb.status]);
  }
  if (omdb) {
    if (omdb.imdbRating) rows.push(['IMDb rating', `★ ${omdb.imdbRating} (${omdb.imdbVotes||''})`]);
    if (omdb.metascore && omdb.metascore !== 'N/A') rows.push(['Metascore', omdb.metascore]);
    if (omdb.rated) rows.push(['Rated', omdb.rated]);
    if (omdb.awards && omdb.awards !== 'N/A') rows.push(['Awards', omdb.awards]);
    if (omdb.director?.length) rows.push(['Director (OMDB)', omdb.director.join(', ')]);
    if (omdb.actors?.length) rows.push(['Actors (OMDB)', omdb.actors.join(', ')]);
  }
  if (tmdb?.tmdbUrl || omdb?.imdbUrl || enriched.imdbId) {
    const links = [];
    if (tmdb?.tmdbUrl) links.push(`TMDB: ${tmdb.tmdbUrl}`);
    if (tmdb?.imdbUrl || omdb?.imdbUrl) links.push(`IMDb: ${tmdb?.imdbUrl||omdb?.imdbUrl}`);
    if (enriched.imdbId) links.push(`IMDb ID: ${enriched.imdbId}`);
    rows.push(['Links', links.join(' · ')]);
  }
  return rows;
}

function tmdbLinksMarkup(enriched) {
  if (!enriched) return '';
  const tmdb = enriched.tmdb;
  const omdb = enriched.omdb;
  const links = [];
  if (tmdb?.tmdbUrl) links.push(`<a href="${escapeHtml(tmdb.tmdbUrl)}" target="_blank" rel="noreferrer">TMDB ↗</a>`);
  if (tmdb?.imdbUrl || omdb?.imdbUrl) links.push(`<a href="${escapeHtml(tmdb?.imdbUrl||omdb?.imdbUrl)}" target="_blank" rel="noreferrer">IMDb ↗</a>`);
  if (enriched.imdbId) links.push(`<a href="https://www.imdb.com/title/${escapeHtml(enriched.imdbId)}/" target="_blank" rel="noreferrer">IMDb (${escapeHtml(enriched.imdbId)}) ↗</a>`);
  if (tmdb?.backdrop) links.push(`<a href="${escapeHtml(tmdb.backdrop)}" target="_blank" rel="noreferrer">backdrop ↗</a>`);
  return links.length ? `<div class="row" style="margin-top:8px">${links.join(' · ')}</div>` : '';
}

async function openSearchMetadata(group) {
  const title = group.title || 'Metadata';
  openModal({
    title: `${title}${group.year ? ` (${group.year})` : ''} — metadata`,
    className: 'wide',
    body: `<div class="meta"><span class="spin"></span> loading TMDB/IMDb…</div>`,
  });
  try {
    const enriched = await fetchEnrichedSearch(group);
    if (!enriched || (!enriched.tmdb && !enriched.omdb)) {
      const errMsg = (enriched?.errors||[]).map(e=>`${e.source}: ${e.error}`).join('; ') || 'No TMDB/OMDB results — configure API keys in Settings → Metadata.';
      openModal({
        title: `${title} — metadata`,
        className: 'wide',
        body: `<div class="meta">${escapeHtml(errMsg)}</div>
          <div class="meta-table">${metadataRows(group).rows.map(([k,v])=>`<div class="kv"><span>${escapeHtml(k)}</span><span>${escapeHtml(String(v))}</span></div>`).join('')}</div>
          ${group.entries[0]?.description ? `<p>${escapeHtml(group.entries[0].description)}</p>` : ''}`,
      });
      return;
    }
    const baseRows = metadataRows(group).rows;
    const extraRows = enrichedToRows(enriched);
    const allRows = [...baseRows, ...extraRows];
    const desc = enriched.tmdb?.overview || enriched.omdb?.plot || group.entries.map(e=>e.description).find(Boolean) || '';
    const poster = enriched.tmdb?.poster || group.poster || '';
    openModal({
      title: `${enriched.tmdb?.title || group.title}${enriched.tmdb?.year || group.year ? ` (${enriched.tmdb?.year||group.year})` : ''}`,
      className: 'wide',
      body: `
        <div class="meta-flex">
          ${poster ? `<img src="${escapeHtml(poster)}" alt="" style="width:120px;max-height:180px;object-fit:cover;border-radius:8px" onerror="this.remove()">` : ''}
          <div style="flex:1;min-width:240px">
            ${desc ? `<p>${escapeHtml(desc)}</p>` : '<p class="mut">No description.</p>'}
            ${tmdbLinksMarkup(enriched)}
            <div class="row" style="margin-top:8px">
              <span class="tag ok">${escapeHtml((enriched.sources||[]).join(', ')||'metadata')}</span>
              ${enriched.tmdb?.rating ? `<span class="tag info">★ ${enriched.tmdb.rating}</span>` : ''}
              ${enriched.omdb?.imdbRating ? `<span class="tag info">IMDb ${enriched.omdb.imdbRating}</span>` : ''}
            </div>
          </div>
        </div>
        <h3 style="margin-top:14px">Combined metadata</h3>
        <div class="meta-table">${allRows.map(([k,v])=>`<div class="kv"><span>${escapeHtml(k)}</span><span>${escapeHtml(String(v))}</span></div>`).join('')}</div>
        ${enriched.tmdb?.cast?.length ? `<h3 style="margin-top:14px">Cast (TMDB)</h3><div class="meta-table">${enriched.tmdb.cast.slice(0,10).map(c=>`<div class="kv"><span>${escapeHtml(c.name)}</span><span>${escapeHtml(c.character||'')}</span></div>`).join('')}</div>` : ''}
        <details style="margin-top:14px"><summary class="sub" style="cursor:pointer">Raw enriched JSON</summary><pre style="max-height:320px">${escapeHtml(JSON.stringify(enriched, null, 2))}</pre></details>
      `,
    });
  } catch (error) {
    openModal({ title: 'Metadata', body: `<div class="note err">${escapeHtml(error.message)}</div>` });
  }
}


/**
 * HLS resolvers return one master candidate with its renditions in `variants`.
 * A master URL leaves the bitrate choice to FFmpeg (normally the largest one),
 * which made the Search panel look as if only one quality existed. Turn every
 * rendition into a real selectable candidate so the URL stored in the playlist
 * is the exact quality the user picked.
 */
function expandCandidateQualities(candidates = []) {
  const expanded = [];
  for (const candidate of candidates) {
    const variants = Array.isArray(candidate?.variants)
      ? candidate.variants.filter((variant) => variant?.url)
      : [];
    if (!variants.length) {
      expanded.push(candidate);
      continue;
    }
    for (const variant of variants) {
      const height = Number(variant.height) || Number(String(variant.quality || '').match(/(\d{3,4})/)?.[1]) || null;
      const sourceVideo = candidate.probe?.video || null;
      const width = Number(variant.width)
        || (height && sourceVideo?.width && sourceVideo?.height ? Math.round((sourceVideo.width / sourceVideo.height) * height) : null);
      expanded.push({
        ...candidate,
        ...variant,
        url: variant.url,
        quality: variant.quality || (height ? `${height}p` : candidate.quality),
        label: variant.label || variant.name || (height ? `${height}p` : candidate.label),
        headers: variant.headers || candidate.headers || {},
        variants: null,
        _entry: candidate._entry,
        _fromMaster: true,
        probe: candidate.probe ? {
          ...candidate.probe,
          bitrate: Number(variant.bandwidth) || candidate.probe.bitrate,
          video: sourceVideo ? {
            ...sourceVideo,
            ...(height ? { height } : {}),
            ...(width ? { width } : {}),
            ...(variant.bandwidth ? { bitrate: Number(variant.bandwidth) } : {}),
          } : null,
        } : null,
      });
    }
  }
  const seen = new Set();
  return expanded.filter((candidate) => {
    const key = String(candidate?.url || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => {
    if ((a.ok !== false) !== (b.ok !== false)) return a.ok === false ? 1 : -1;
    const height = (candidate) => Number(candidate.height)
      || Number(String(candidate.quality || '').match(/(\d{3,4})/)?.[1]) || 0;
    return height(b) - height(a) || (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0);
  });
}

/** One card per provider/file inside a title — the "formats" list. */
function candidateMarkup(candidate, index, meta = {}) {
  const probe = candidate.probe || null;
  const video = probe?.video ? `${probe.video.codec || '?'}${probe.video.width ? ` ${probe.video.width}×${probe.video.height}` : ''}` : '';
  const firstAudio = Array.isArray(probe?.audio) ? probe.audio[0] : probe?.audio;
  const audio = firstAudio ? `${firstAudio.codec || '?'}${firstAudio.channels ? ` ${firstAudio.channels}ch` : ''}` : '';
  const bitrate = Number(candidate.bandwidth) || Number(probe?.bitrate) || 0;
  const ok = candidate.ok !== false;
  const error = candidate.error || null;
  const quality = candidate.quality || candidate.label || 'format';
  return `<div class="cand ${ok ? '' : 'bad'}" data-candidate="${index}">
    <div class="cand-main">
      <div class="cand-title">${escapeHtml(quality)}
        ${tag(meta.sourceName || sourceName(candidate.sourceId), 'alt')}
        ${candidate._fromMaster ? tag('HLS quality', 'info') : ''}
        ${ok ? tag('playable', 'ok') : tag('unplayable', 'err')}</div>
      <div class="cand-meta">${video ? tag(video) : ''}${audio ? tag(audio) : ''}${probe?.durationSec ? tag(fmtDuration(probe.durationSec)) : ''}${bitrate ? tag(`${Math.round(bitrate / 1000)} kbps`) : ''}
        ${(probe?.subtitles || []).length ? tag(`${probe.subtitles.length} subtitle track(s)`) : ''}</div>
      ${meta.seasonEpisode ? `<div class="meta">${escapeHtml(meta.seasonEpisode)}</div>` : ''}
      <div class="mono cand-url">${escapeHtml(String(candidate.url || '').slice(0, 160))}</div>
      ${error ? `<div class="err-text">${escapeHtml(error)}</div>` : ''}
    </div>
    <div class="cand-side">
      <button class="btn sm pri" data-add-candidate="${index}" ${ok ? '' : 'disabled'}>+ add ${escapeHtml(quality)}</button>
      <button class="btn sm ghost" data-probe-url="${escapeHtml(candidate.url || '')}">probe</button>
    </div>
  </div>`;
}

function renderCandidates(candidates, meta = {}) {
  const host = $('#candidates');
  if (!host) return;
  if (!candidates.length) {
    host.innerHTML = `<div class="meta">${state.resolving ? 'resolving formats…' : 'No playable formats found for this title.'}</div>`;
    return;
  }
  host.innerHTML = candidates.map((candidate, index) => candidateMarkup(candidate, index, meta)).join('');
}

/**
 * Open a title: fill the Selected-title panel and resolve its formats.
 *
 * `sourceId` is the provider scope. Called from a result card (or its
 * “formats & metadata” button) it is empty and *every* provider on the card is
 * resolved; called from a provider chip it is that one provider, and only its
 * formats are fetched.
 */
async function selectGroup(group, { sourceId = '' } = {}) {
  if (!group) return;
  // The group handed in may come from a filtered list (title pick, provider
  // filter), whose `entries` are a subset. Re-read the full card from the
  // unfiltered groups so a card click really does resolve all providers.
  const full = (state.groups || []).find((candidate) => candidate.key === group.key) || group;
  const entries = sourceId ? full.entries.filter((entry) => entry.sourceId === sourceId) : full.entries;
  if (!entries.length) {
    toast(`No ${sourceName(sourceId)} format for this title`, 'warn');
    return;
  }
  clearSelection();
  state.selection = {
    key: full.key,
    title: full.title,
    year: full.year,
    kind: full.kind,
    poster: full.poster,
    sourceId: sourceId || full.entries[0]?.sourceId || '',
    activeSource: sourceId || '',
    movieboxSubjectId: full.entries.find((entry) => entry.movieboxSubjectId)?.movieboxSubjectId || null,
    entries,
  };
  const providerCount = new Set(full.entries.map((entry) => entry.sourceId)).size;
  const { rows, description } = metadataRows({ ...full, entries });
  $('#sel-name').innerHTML = `${escapeHtml(full.title)}${full.year ? ` <span class="mut">(${full.year})</span>` : ''}`;
  $('#sel-meta').textContent = sourceId
    ? `${full.kind} · ${entries.length} format(s) from ${sourceName(sourceId)} only`
    : `${full.kind} · ${entries.length} format(s) from ${providerCount} provider(s)`;
  if (full.poster) $('#sel-poster').innerHTML = `<img src="${escapeHtml(full.poster)}" alt="" onerror="this.remove()">`;
  const details = $('#sel-details');
  if (details) {
    details.classList.toggle('hide', !description);
    details.textContent = description || '';
  }
  const table = $('#sel-meta-table');
  if (table) {
    table.classList.remove('hide');
    table.innerHTML = rows.map(([key, value]) => `<div class="meta-row"><span>${escapeHtml(key)}</span><span>${escapeHtml(String(value))}</span></div>`).join('');
    // Async enrich with TMDB/IMDb — does not block format resolving
    fetchEnrichedSearch(full).then((enriched) => {
      if (!enriched || (!enriched.tmdb && !enriched.omdb)) return;
      const extra = enrichedToRows(enriched);
      if (!extra.length) return;
      const current = table.innerHTML;
      const extraHtml = extra.map(([k,v])=>`<div class="meta-row"><span>${escapeHtml(k)}</span><span>${escapeHtml(String(v))}</span></div>`).join('');
      table.innerHTML = current + extraHtml;
      if (enriched.tmdb?.overview && details) {
        details.textContent = enriched.tmdb.overview;
        details.classList.remove('hide');
      }
      // Add links row
      const linksEl = document.createElement('div');
      linksEl.innerHTML = tmdbLinksMarkup(enriched);
      if (linksEl.firstChild) table.appendChild(linksEl.firstChild);
    }).catch(()=>{});
  }
  renderSelectionProviders(full, sourceId);
  const selectionNote = $('#sel-note');
  if (selectionNote) {
    selectionNote.textContent = sourceId
      ? `Formats come from ${sourceName(sourceId)} only — press “all providers” to resolve the other ${Math.max(0, providerCount - 1)}. Nothing is put on the playlist until you press “add to playlist” on one quality.`
      : `Formats come from every provider on this card (${providerCount}). Press a provider chip to resolve only that source. Nothing is put on the playlist until you press “add to playlist” on one quality.`;
  }
  renderSelectionActions();
  markSelectedCard();
  if (full.kind === 'series') {
    // Series resolve per episode, on demand — the picker below owns the
    // Formats area (quality matrix + episode groups), not the flat list.
    loadSeriesSeasons();
  } else {
    await loadFormats();
  }
}

function renderSelectionActions() {
  const host = $('#sel-actions');
  if (!host) return;
  host.innerHTML = `
    <button class="btn sm" id="btn-sel-formats">↻ resolve formats</button>
    <button class="btn sm ghost" id="btn-sel-meta">ⓘ metadata (TMDB/IMDb)</button>
    <button class="btn sm ghost" id="btn-sel-subs">▭ matching subtitles</button>
    <button class="btn sm ghost" id="btn-sel-playlist">☰ open playlist</button>
    <span class="mut" id="sel-format-note"></span>`;
  $('#btn-sel-formats').addEventListener('click', () => {
    // Series re-resolve the selected episodes (cached ones are reused unless
    // they failed); movies — and pasted-URL series, which never built a picker
    // — re-resolve the single flat list.
    if (state.selection?.kind === 'series' && state.series) loadSelectedEpisodes({ announce: true });
    else loadFormats({ announce: true });
  });
  $('#btn-sel-meta').addEventListener('click', () => {
    const sel = state.selection;
    if (sel) openSearchMetadata({ title: sel.title, year: sel.year, kind: sel.kind, entries: sel.entries, poster: sel.poster });
  });
  $('#btn-sel-subs').addEventListener('click', () => openSelectionSubtitles());
  $('#btn-sel-playlist').addEventListener('click', () => go('list'));
}

/** Resolve every provider entry of the selection into playable formats. */
async function loadFormats({ announce = false } = {}) {
  const selection = state.selection;
  if (!selection) return;
  const seq = ++resolveSeq;
  resolveAbort?.abort();
  resolveAbort = new AbortController();
  state.resolving = true;
  const note = $('#sel-format-note');
  const entries = selection.entries || [];
  // A provider chip narrowed the scope: say so, so a shorter format list is
  // never mistaken for “the source has nothing else”.
  const scope = selection.activeSource ? ` from ${sourceName(selection.activeSource)}` : '';
  if (note) note.textContent = `resolving and probing 0/${entries.length} provider(s)${scope}…`;
  renderCandidates([], {});
  const collected = [];
  const errors = [];
  let finished = 0;

  const updateVisibleCandidates = () => {
    if (seq !== resolveSeq) return;
    state.candidates = expandCandidateQualities(collected);
    renderCandidates(state.candidates, {});
    const playable = state.candidates.filter((candidate) => candidate.ok !== false).length;
    if (note) note.textContent = finished < entries.length
      ? `resolving and probing ${finished}/${entries.length} provider(s)${scope} · ${playable} quality option(s) ready`
      : `${playable}/${state.candidates.length} playable quality option(s)${scope} · ${errors.length ? `${errors.length} provider(s) failed` : 'all providers answered'}`;
  };

  // Providers are independent. Resolve them together and render each answer as
  // soon as it arrives: one slow/dead site must not hide the qualities already
  // returned by another site for up to several minutes.
  await Promise.all(entries.map(async (entry) => {
    if (seq !== resolveSeq) return;
    try {
      const body = {
        url: entry.url,
        sourceId: entry.sourceId,
        title: entry.title || selection.title,
        year: entry.year || selection.year || null,
        kind: entry.kind || selection.kind || 'movie',
        season: selection.season || 0,
        episode: selection.episode || 0,
        probe: true,
        useBrowser: entry.sourceId !== 'moviebox',
      };
      const data = await api('/api/find/resolve', { method: 'POST', body, silent: true, signal: resolveAbort.signal });
      if (seq !== resolveSeq) return;
      for (const candidate of data.candidates || []) {
        collected.push({ ...candidate, sourceId: candidate.sourceId || entry.sourceId, _entry: entry });
      }
      if (data.error) errors.push({ sourceId: entry.sourceId, error: data.error });
    } catch (error) {
      if (error.name !== 'AbortError') errors.push({ sourceId: entry.sourceId, error: error.message });
    } finally {
      finished += 1;
      updateVisibleCandidates();
    }
  }));
  if (seq !== resolveSeq) return;
  state.resolving = false;
  updateVisibleCandidates();
  if (errors.length) renderFindErrors(errors.map((entry) => ({ sourceId: entry.sourceId, error: entry.error })));
  if (announce) toast(state.candidates.length ? `${state.candidates.length} quality option(s) resolved` : 'No formats resolved', state.candidates.length ? 'ok' : 'warn');
}

async function addCandidateToPlaylist(index, { candidate: override = null, season = null, episode = null, button = null } = {}) {
  const candidate = override || state.candidates[index];
  const selection = state.selection;
  if (!candidate || !selection) return null;
  const entry = candidate._entry || {};
  const btn = button || (override ? null : $(`[data-add-candidate="${index}"]`));
  if (btn) btn.disabled = true;
  try {
    const se = Number(season ?? candidate.season ?? selection.season) || null;
    const ep = Number(episode ?? candidate.episode ?? selection.episode) || null;
    const isSeries = (entry.kind || selection.kind || 'movie') === 'series';
    const body = {
      title: isSeries && se && ep
        ? `${selection.title} ${seriesLabel(se, ep)}`
        : selection.title,
      year: entry.year || selection.year || null,
      kind: entry.kind || selection.kind || 'movie',
      poster: selection.poster || entry.poster || '',
      description: entry.description || '',
      sourceId: candidate.sourceId || entry.sourceId || '',
      candidate: {
        url: candidate.url,
        quality: candidate.quality,
        label: candidate.label,
        sourceId: candidate.sourceId || entry.sourceId,
        kind: candidate.kind,
        headers: candidate.headers,
        variants: candidate.variants,
        probe: candidate.probe,
      },
      season: isSeries ? se : (selection.season || null),
      episode: isSeries ? ep : (selection.episode || null),
    };
    const data = await api('/api/streams', { method: 'POST', body });
    await VMPlaylist.refresh();
    toast(`Added “${data.stream.title}” to the playlist`, 'ok');
    if (btn) btn.textContent = '✓ added';
    const note = $('#sel-format-note');
    if (note) note.innerHTML = `added · <a href="#list" data-go-list>open the playlist</a>`;
    return data.stream;
  } catch (error) {
    toast(error.message, 'err');
    if (btn) btn.disabled = false;
    return null;
  }
}

/**
 * Bulk add: one playlist item per episode for the given quality row.
 * Picks the first playable candidate of that quality in each loaded episode.
 */
async function addQualityToPlaylist(quality) {
  const series = state.series;
  if (!series) return;
  const rows = seriesMatrixRows();
  const row = rows.find((candidate) => candidate.quality === quality);
  if (!row) return;
  let added = 0;
  let failed = 0;
  toast(`Adding ${row.episodes.length} episode(s) in ${quality}…`, 'info', 4000);
  for (const { season, episode } of row.episodes) {
    const group = series.episodes.get(seriesKey(season, episode));
    const candidate = (group?.candidates || []).find((c) => seriesQualityKey(c) === quality && c.ok !== false)
      || (group?.candidates || []).find((c) => seriesQualityKey(c) === quality);
    if (!candidate) { failed += 1; continue; }
    const stream = await addCandidateToPlaylist(-1, { candidate, season, episode });
    if (stream) added += 1; else failed += 1;
  }
  toast(added ? `Added ${added} episode(s) in ${quality}${failed ? ` (${failed} failed)` : ''}` : `Nothing added in ${quality}`, added ? 'ok' : 'warn');
  renderSeriesCandidates();
}

/** Add the single best playable candidate of one episode. */
async function addEpisodeBestToPlaylist(season, episode, button = null) {
  const series = state.series;
  const group = series?.episodes.get(seriesKey(season, episode));
  if (!group?.candidates?.length) return;
  const best = [...group.candidates]
    .filter((c) => c.ok !== false)
    .sort((a, b) => seriesQualityHeight(seriesQualityKey(b)) - seriesQualityHeight(seriesQualityKey(a)))[0]
    || group.candidates[0];
  if (button) button.disabled = true;
  try {
    await addCandidateToPlaylist(-1, { candidate: best, season, episode, button });
  } finally {
    renderSeriesCandidates();
  }
}

/* ---------------- series picker: seasons → episodes → formats ----------------
 *
 * Movies keep the flat format list. A series instead gets, just above the
 * Formats area, one card per season with episode checkboxes (plus "all"
 * toggles), and the Formats area becomes:
 *
 *   1. a quality-first matrix — one row per quality with episode coverage
 *      (the seasons × episodes × formats combination that keeps the list
 *      small), with a bulk "add all in this quality" action;
 *   2. one collapsible group per selected episode, resolved on demand when it
 *      is expanded (a browser-source episode costs a full page sniff, so "all
 *      seasons" must never resolve eagerly).
 *
 * Season data comes from GET /api/find/series (MovieBox → TMDB → none, in
 * which case the manual season/episode inputs are shown).
 */

const SERIES_LOAD_CONCURRENCY = 2;

const seriesKey = (season, episode) => `${Number(season)}:${Number(episode)}`;

function seriesLabel(season, episode) {
  return `S${String(Number(season) || 0).padStart(2, '0')}E${String(Number(episode) || 0).padStart(2, '0')}`;
}

/** Abort every in-flight per-episode resolve (selection changed or cleared). */
function abortSeriesLoads() {
  const series = state.series;
  if (!series) return;
  for (const group of series.episodes.values()) {
    try { group.controller?.abort(); } catch { /* already settled */ }
    if (group.status === 'loading') group.status = 'idle';
  }
  series.loadingAll = false;
}

/** Fresh picker state for the selected series title. */
function newSeriesState(selection) {
  return {
    key: selection.key,
    source: 'loading',
    seasons: [],
    subjectId: selection.movieboxSubjectId || null,
    tmdbId: null,
    errors: [],
    collapsed: new Set(),
    episodes: new Map(),
    loadingAll: false,
    seq: 0,
  };
}

function seriesSelectedEpisodes() {
  const series = state.series;
  if (!series) return [];
  return [...series.episodes.values()]
    .filter((group) => group.selected)
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
}

function seriesLoadedEpisodes() {
  return seriesSelectedEpisodes().filter((group) => group.status === 'done' && (group.candidates || []).length);
}

/* Quality helpers (mirror of src/scrapers/series.js for the browser). */

function seriesQualityHeight(quality) {
  const text = String(quality || '').toLowerCase();
  if (/\b4k\b|2160/.test(text)) return 2160;
  const match = /(\d{3,4})\s*p?/.exec(text);
  const height = match ? Number(match[1]) : 0;
  return height > 200 && height < 5000 ? height : 0;
}

function seriesQualityKey(candidate) {
  const raw = String(candidate?.quality || candidate?.label || '').trim();
  const height = Number(candidate?.height) || seriesQualityHeight(raw);
  if (height) return `${height}p`;
  if (raw) return raw.slice(0, 24);
  return 'source';
}

/**
 * Aggregate loaded episodes into quality-first rows (coverage matrix).
 * Defaults to the Search tab's loaded episodes; the Mobile tab passes its own.
 */
function seriesMatrixRows(loaded = seriesLoadedEpisodes()) {
  const rows = new Map();
  for (const entry of loaded) {
    const seen = new Set();
    for (const candidate of entry.candidates || []) {
      const quality = seriesQualityKey(candidate);
      if (!rows.has(quality)) {
        rows.set(quality, {
          quality,
          height: Number(candidate?.height) || seriesQualityHeight(quality),
          episodes: [],
          providers: new Set(),
          playable: 0,
          total: 0,
        });
      }
      const row = rows.get(quality);
      row.providers.add(String(candidate?.sourceId || candidate?._entry?.sourceId || 'unknown'));
      row.total += 1;
      if (candidate?.ok !== false) row.playable += 1;
      const key = seriesKey(entry.season, entry.episode);
      if (!seen.has(key)) {
        seen.add(key);
        row.episodes.push({ season: entry.season, episode: entry.episode, name: entry.name });
      }
    }
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      providers: [...row.providers].sort(),
      episodes: row.episodes.sort((a, b) => a.season - b.season || a.episode - b.episode),
    }))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || a.quality.localeCompare(b.quality));
}

/** Fetch the season list for the selected series and render the picker. */
async function loadSeriesSeasons() {
  const selection = state.selection;
  if (!selection || selection.kind !== 'series') return;
  const controls = $('#sel-episode-controls');
  const series = newSeriesState(selection);
  state.series = series;
  const seq = ++series.seq;
  controls?.classList.remove('hide');
  $('#sel-series-manual')?.classList.add('hide');
  $('#sel-seasons').innerHTML = '<div class="meta"><span class="spin"></span> loading seasons…</div>';
  $('#sel-series-source').textContent = '';
  $('#sel-series-summary').textContent = '';
  $('#sel-episode-status').textContent = '';
  renderSeriesCandidates();
  try {
    const params = new URLSearchParams({ title: selection.title || '' });
    if (selection.year) params.set('year', String(selection.year));
    if (selection.movieboxSubjectId) params.set('subjectId', selection.movieboxSubjectId);
    const meta = (selection.entries || []).find((entry) => entry.imdbId || entry.tmdbId) || {};
    if (meta.tmdbId) params.set('tmdbId', meta.tmdbId);
    if (meta.imdbId) params.set('imdbId', meta.imdbId);
    const data = await api(`/api/find/series?${params}`, { silent: true });
    if (state.series !== series || seq !== series.seq) return;
    series.source = data.source || 'none';
    series.seasons = Array.isArray(data.seasons) ? data.seasons : [];
    series.subjectId = data.subjectId || series.subjectId;
    series.tmdbId = data.tmdbId || null;
    series.errors = Array.isArray(data.errors) ? data.errors : [];
    if (!series.seasons.length) {
      renderSeriesManual();
      return;
    }
    // Default: first season, all episodes selected — the first episode group
    // auto-loads so the Formats area is not empty.
    const firstSeason = series.seasons[0];
    for (const entry of series.seasons) {
      for (const ep of entry.episodes || []) {
        series.episodes.set(seriesKey(entry.season, ep.episode), {
          season: entry.season,
          episode: ep.episode,
          name: ep.name || '',
          airDate: ep.airDate || null,
          selected: entry.season === firstSeason.season,
          status: 'idle',
          candidates: [],
          error: null,
          controller: null,
          open: entry.season === firstSeason.season && ep.episode === (entry.episodes[0]?.episode ?? 1),
        });
      }
    }
    renderSeriesPicker();
    renderSeriesCandidates();
    // Auto-load the first selected episode; the rest load on expand or via
    // "load selected".
    const first = seriesSelectedEpisodes()[0];
    if (first) loadSeriesEpisode(first.season, first.episode);
  } catch (error) {
    if (state.series !== series) return;
    series.source = 'none';
    series.errors = [{ source: 'series', error: error.message }];
    renderSeriesManual();
  }
}

/** No season source answered: manual season/episode number inputs. */
function renderSeriesManual() {
  const series = state.series;
  $('#sel-series-source').textContent = 'manual entry';
  const host = $('#sel-seasons');
  if (host) {
    const reasons = (series?.errors || []).map((entry) => `${entry.source}: ${entry.error}`).join(' · ');
    host.innerHTML = `<div class="meta">No season list available${reasons ? ` — ${escapeHtml(reasons)}` : ''}. Add episodes by hand:</div>`;
  }
  $('#sel-series-manual')?.classList.remove('hide');
  updateSeriesSummary();
  renderSeriesCandidates();
}

function parseEpisodeList(text) {
  const out = new Set();
  for (const part of String(text || '').split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
    if (range) {
      const from = Math.min(Number(range[1]), Number(range[2]));
      const to = Math.max(Number(range[1]), Number(range[2]));
      for (let episode = from; episode <= Math.min(to, from + 200); episode++) {
        if (episode > 0) out.add(episode);
      }
    } else if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) {
      out.add(Number(trimmed));
    }
  }
  return [...out].sort((a, b) => a - b);
}

function addManualEpisodes() {
  const series = state.series;
  if (!series) return;
  const season = Number($('#sel-manual-season')?.value) || 0;
  const episodes = parseEpisodeList($('#sel-manual-episodes')?.value);
  if (!season || !episodes.length) {
    toast('Enter a season and at least one episode (e.g. 1-8)', 'warn');
    return;
  }
  if (!series.seasons.some((entry) => entry.season === season)) {
    series.seasons.push({ season, name: `Season ${season}`, episodeCount: 0, episodes: [] });
    series.seasons.sort((a, b) => a.season - b.season);
  }
  const seasonEntry = series.seasons.find((entry) => entry.season === season);
  for (const episode of episodes) {
    const key = seriesKey(season, episode);
    if (!series.episodes.has(key)) {
      series.episodes.set(key, {
        season, episode, name: '', airDate: null,
        selected: true, status: 'idle', candidates: [], error: null, controller: null, open: false,
      });
    } else {
      series.episodes.get(key).selected = true;
    }
    if (!seasonEntry.episodes.some((item) => item.episode === episode)) {
      seasonEntry.episodes.push({ episode, name: `Episode ${episode}` });
      seasonEntry.episodes.sort((a, b) => a.episode - b.episode);
    }
  }
  if (series.source === 'none') series.source = 'manual';
  $('#sel-manual-episodes').value = '';
  renderSeriesPicker();
  renderSeriesCandidates();
  updateSeriesSummary();
}

function renderSeriesPicker() {
  const series = state.series;
  const host = $('#sel-seasons');
  if (!series || !host) return;
  const sourceLabel = {
    moviebox: 'MovieBox', tmdb: 'TMDB', manual: 'manual', loading: '…', none: 'manual entry',
  }[series.source] || series.source;
  $('#sel-series-source').textContent = series.seasons.length
    ? `${sourceLabel} · ${series.seasons.length} season(s)`
    : sourceLabel;
  $('#sel-series-manual')?.classList.toggle('hide', series.source !== 'none' && series.source !== 'manual');
  host.innerHTML = series.seasons.map((entry) => seasonCardMarkup(series, entry)).join('') || '<div class="meta">No seasons listed.</div>';
  updateSeriesSummary();
}

/**
 * One season card with its episode pills — shared by the Search tab and the
 * Mobile tab so both pickers are literally the same cards. The data attributes
 * are identical on both tabs on purpose: the listeners live on different
 * containers (#sel-seasons vs #mob-formats), so there is no cross-talk.
 */
function seasonCardMarkup(series, entry) {
  const groups = (entry.episodes || []).map((ep) => series.episodes.get(seriesKey(entry.season, ep.episode))).filter(Boolean);
  const selected = groups.filter((group) => group.selected).length;
  const collapsed = series.collapsed.has(entry.season);
  return `<div class="season-card" data-season-card="${entry.season}">
    <div class="season-card-head">
      <label class="season-check"><input type="checkbox" data-season-check="${entry.season}"${selected && selected === groups.length ? ' checked' : ''} aria-label="select all of season ${entry.season}"> <b>${escapeHtml(entry.name || `Season ${entry.season}`)}</b></label>
      <span class="mut">${selected}/${groups.length}</span>
      <button type="button" class="btn sm ghost" data-season-all="${entry.season}">all</button>
      <button type="button" class="btn sm ghost" data-season-none="${entry.season}">none</button>
      <button type="button" class="foldbtn" data-season-toggle="${entry.season}" aria-expanded="${collapsed ? 'false' : 'true'}" title="${collapsed ? 'show' : 'hide'} episodes">${collapsed ? '▸' : '▾'}</button>
    </div>
    <div class="episode-pills${collapsed ? ' hide' : ''}">
      ${groups.map((group) => `<label class="ep-pill${group.selected ? ' on' : ''}${group.status === 'done' ? ' loaded' : ''}${group.status === 'loading' ? ' busy' : ''}" title="${escapeHtml(group.name || `Episode ${group.episode}`)}${group.status === 'done' ? ` — ${(group.candidates || []).length} format(s) loaded` : ''}">
        <input type="checkbox" data-ep-check="${group.season}:${group.episode}"${group.selected ? ' checked' : ''}>
        <span>E${String(group.episode).padStart(2, '0')}</span>
      </label>`).join('') || '<span class="meta">no episodes listed</span>'}
    </div>
  </div>`;
}

function updateSeriesSummary() {
  const series = state.series;
  const host = $('#sel-series-summary');
  if (!host) return;
  if (!series) { host.textContent = ''; return; }
  const selected = seriesSelectedEpisodes();
  const loaded = selected.filter((group) => group.status === 'done').length;
  const loading = selected.filter((group) => group.status === 'loading').length;
  host.textContent = selected.length
    ? `${selected.length} episode(s) selected · ${loaded} loaded${loading ? ` · ${loading} loading` : ''}`
    : 'nothing selected';
}

function setSeasonSelection(season, selected) {
  const series = state.series;
  if (!series) return;
  for (const group of series.episodes.values()) {
    if (group.season === Number(season)) group.selected = selected;
  }
  renderSeriesPicker();
  renderSeriesCandidates();
}

function setAllSeasons(selected) {
  const series = state.series;
  if (!series) return;
  for (const group of series.episodes.values()) group.selected = selected;
  renderSeriesPicker();
  renderSeriesCandidates();
}

/* ---------------- per-episode on-demand resolve ---------------- */

function seriesEpisodeKey() {
  const selection = state.selection;
  return `${selection?.key || ''}|${selection?.activeSource || ''}`;
}

/**
 * Resolve one S/E across the selection's provider entries (cached: a loaded
 * episode is not re-resolved unless `force`). Renders progressively like the
 * movie path — each provider's answer appears as soon as it arrives.
 */
async function loadSeriesEpisode(season, episode, { force = false } = {}) {
  const selection = state.selection;
  const series = state.series;
  if (!selection || !series) return;
  const key = seriesKey(season, episode);
  const group = series.episodes.get(key);
  if (!group || !group.selected) return;
  if (group.status === 'loading') return;
  if (group.status === 'done' && !force && group.scopeKey === seriesEpisodeKey()) {
    renderSeriesCandidates();
    return;
  }
  group.controller?.abort();
  const controller = new AbortController();
  group.controller = controller;
  group.status = 'loading';
  group.error = null;
  group.candidates = [];
  group.scopeKey = seriesEpisodeKey();
  renderSeriesCandidates();
  updateSeriesSummary();
  const entries = selection.entries || [];
  const collected = [];
  const errors = [];
  let finished = 0;
  const render = () => {
    if (state.series !== series || group.controller !== controller) return;
    group.candidates = expandCandidateQualities(collected);
    renderSeriesCandidates();
    const playable = group.candidates.filter((candidate) => candidate.ok !== false).length;
    $('#sel-episode-status').textContent = finished < entries.length
      ? `${seriesLabel(season, episode)}: resolving ${finished}/${entries.length} provider(s) · ${playable} format(s) ready…`
      : `${seriesLabel(season, episode)}: ${playable}/${group.candidates.length} playable`;
  };
  await Promise.all(entries.map(async (entry) => {
    if (controller.signal.aborted) return;
    try {
      const data = await api('/api/find/resolve', {
        method: 'POST',
        silent: true,
        signal: controller.signal,
        body: {
          url: entry.url,
          sourceId: entry.sourceId,
          title: entry.title || selection.title,
          year: entry.year || selection.year || null,
          kind: entry.kind || selection.kind || 'series',
          season, episode,
          probe: true,
          useBrowser: entry.sourceId !== 'moviebox',
        },
      });
      if (controller.signal.aborted) return;
      for (const candidate of data.candidates || []) {
        collected.push({
          ...candidate,
          season, episode,
          sourceId: candidate.sourceId || entry.sourceId,
          _entry: entry,
        });
      }
      if (data.error) errors.push(data.error);
    } catch (error) {
      if (error?.name !== 'AbortError') errors.push(`${sourceName(entry.sourceId)}: ${error.message}`);
    } finally {
      finished += 1;
      render();
    }
  }));
  if (state.series !== series || group.controller !== controller) return;
  group.status = errors.length && !collected.length ? 'error' : 'done';
  group.error = group.status === 'error' ? errors[0] : (errors.length ? `${errors.length} provider(s) failed` : null);
  group.candidates = expandCandidateQualities(collected);
  group.controller = null;
  renderSeriesCandidates();
  updateSeriesSummary();
  const note = $('#sel-format-note');
  if (note) {
    const loaded = seriesLoadedEpisodes().length;
    const total = seriesSelectedEpisodes().length;
    note.textContent = `${loaded}/${total} episode(s) loaded — expand an episode to resolve it, or load everything selected.`;
  }
}

/** Resolve every selected episode with a small concurrency (browser sniffs are slow). */
async function loadSelectedEpisodes({ announce = false, force = false } = {}) {
  const series = state.series;
  if (!series) return;
  const queue = seriesSelectedEpisodes().filter((group) =>
    force || (group.status !== 'done' && group.status !== 'loading'));
  if (!queue.length) {
    if (announce) toast('Every selected episode is already loaded', 'info', 3000);
    return;
  }
  if (queue.length > 25) {
    toast(`Loading ${queue.length} episodes — each browser-source episode costs a full page sniff`, 'warn', 8000);
  }
  series.loadingAll = true;
  updateSeriesSummary();
  let index = 0;
  const workers = Array.from({ length: Math.min(SERIES_LOAD_CONCURRENCY, queue.length) }, async () => {
    while (index < queue.length && state.series === series && series.loadingAll) {
      const next = queue[index++];
      await loadSeriesEpisode(next.season, next.episode, { force });
    }
  });
  await Promise.all(workers);
  if (state.series !== series) return;
  series.loadingAll = false;
  updateSeriesSummary();
  if (announce) {
    const loaded = seriesLoadedEpisodes().length;
    toast(loaded ? `${loaded} episode(s) loaded` : 'No episode formats resolved', loaded ? 'ok' : 'warn');
  }
}

/* ---------------- series Formats area: matrix + episode groups ---------------- */

function renderSeriesCandidates() {
  const series = state.series;
  const selection = state.selection;
  const host = $('#candidates');
  if (!host) return;
  if (!selection || selection.kind !== 'series' || !series) return;
  const selected = seriesSelectedEpisodes();
  if (series.source === 'loading') {
    host.innerHTML = '<div class="meta"><span class="spin"></span> loading seasons…</div>';
    return;
  }
  if (!selected.length) {
    host.innerHTML = '<div class="meta">Tick episodes above — each one resolves on demand when expanded.</div>';
    return;
  }
  const rows = seriesMatrixRows();
  const loadedCount = seriesLoadedEpisodes().length;
  host.innerHTML = `
    ${rows.length ? seriesMatrixMarkup(rows, selected.length, loadedCount) : `<div class="meta">No episode loaded yet — expand one below or press “load selected”. ${selected.length} episode(s) selected.</div>`}
    <div class="episode-groups">
      ${selected.map((group) => seriesEpisodeGroupMarkup(group)).join('')}
    </div>`;
}

function seriesMatrixMarkup(rows, totalSelected, loadedCount) {
  return `<div class="quality-matrix" role="region" aria-label="Quality coverage across loaded episodes">
    <div class="cardhead">
      <h3 style="margin:0">Quality coverage</h3>
      <span class="mut">${loadedCount}/${totalSelected} episode(s) loaded</span>
    </div>
    <table>
      <thead><tr><th>Quality</th><th>Episodes</th><th>Providers</th><th></th></tr></thead>
      <tbody>
        ${rows.map((row) => {
          const sample = row.episodes.slice(0, 6).map((entry) => seriesLabel(entry.season, entry.episode)).join(', ');
          const more = row.episodes.length > 6 ? ` +${row.episodes.length - 6} more` : '';
          return `<tr>
            <td><b>${escapeHtml(row.quality)}</b> ${row.playable === row.total && row.total ? tag('all playable', 'ok') : tag(`${row.playable}/${row.total} playable`, row.playable ? '' : 'err')}</td>
            <td><span class="mut">${row.episodes.length} episode(s)</span> ${escapeHtml(sample)}${escapeHtml(more)}</td>
            <td>${row.providers.map((id) => tag(sourceName(id) === id ? id : sourceName(id))).join('')}</td>
            <td><button type="button" class="btn sm pri" data-series-add-quality="${escapeHtml(row.quality)}" title="add one playlist item per episode in ${escapeHtml(row.quality)}">+ add all ${escapeHtml(row.quality)}</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>`;
}

function seriesEpisodeGroupMarkup(group, providerCount = null) {
  const key = seriesKey(group.season, group.episode);
  const label = seriesLabel(group.season, group.episode);
  const status = group.status === 'loading'
    ? tag('loading…', 'info')
    : group.status === 'done'
      ? tag(`${(group.candidates || []).filter((c) => c.ok !== false).length}/${(group.candidates || []).length} playable`, (group.candidates || []).some((c) => c.ok !== false) ? 'ok' : 'err')
      : group.status === 'error'
        ? tag('failed', 'err')
        : tag('not loaded');
  const title = group.name && group.name !== `Episode ${group.episode}` ? ` — ${escapeHtml(group.name)}` : '';
  let body = '';
  if (group.status === 'loading') {
    // Desktop passes nothing (the Search selection owns the count); the Mobile
    // tab passes its own scoped entry count explicitly.
    const count = providerCount ?? (state.selection?.entries || []).length;
    body = `<div class="meta"><span class="spin"></span> resolving ${count} provider(s)…</div>`;
  } else if (group.status === 'done' && (group.candidates || []).length) {
    body = `<div class="ep-group-actions">
        <button type="button" class="btn sm pri" data-series-add-best="${key}">+ add best (${escapeHtml(seriesQualityKey((group.candidates || []).find((c) => c.ok !== false) || group.candidates[0]))})</button>
        <button type="button" class="btn sm ghost" data-series-reload="${key}">↻ reload</button>
        ${group.error ? `<span class="mut">${escapeHtml(group.error)}</span>` : ''}
      </div>
      <div class="ep-candidates">
        ${(group.candidates || []).map((candidate, index) => seriesCandidateMarkup(candidate, key, index)).join('')}
      </div>`;
  } else if (group.status === 'done') {
    body = `<div class="meta">No formats for this episode. ${group.error ? escapeHtml(group.error) : ''}</div>
      <div class="ep-group-actions"><button type="button" class="btn sm ghost" data-series-reload="${key}">↻ retry</button></div>`;
  } else if (group.status === 'error') {
    body = `<div class="err-text">${escapeHtml(group.error || 'resolve failed')}</div>
      <div class="ep-group-actions"><button type="button" class="btn sm ghost" data-series-reload="${key}">↻ retry</button></div>`;
  } else {
    body = `<div class="ep-group-actions"><button type="button" class="btn sm" data-series-load="${key}">⤓ load ${escapeHtml(label)}</button></div>`;
  }
  return `<details class="ep-group" data-ep-group="${key}"${group.open ? ' open' : ''}>
    <summary><b>${escapeHtml(label)}</b>${title} ${status}
      <span class="mut">${(group.candidates || []).length ? `${(group.candidates || []).length} format(s)` : ''}</span></summary>
    <div class="ep-group-body">${body}</div>
  </details>`;
}

function seriesCandidateMarkup(candidate, key, index) {
  const probe = candidate.probe || null;
  const video = probe?.video ? `${probe.video.codec || '?'}${probe.video.width ? ` ${probe.video.width}×${probe.video.height}` : ''}` : '';
  const firstAudio = Array.isArray(probe?.audio) ? probe.audio[0] : probe?.audio;
  const audio = firstAudio ? `${firstAudio.codec || '?'}${firstAudio.channels ? ` ${firstAudio.channels}ch` : ''}` : '';
  const bitrate = Number(candidate.bandwidth) || Number(probe?.bitrate) || 0;
  const ok = candidate.ok !== false;
  const quality = candidate.quality || candidate.label || 'format';
  const [season, episode] = key.split(':').map(Number);
  return `<div class="cand ${ok ? '' : 'bad'}">
    <div class="cand-main">
      <div class="cand-title">${escapeHtml(quality)}
        ${tag(sourceName(candidate.sourceId), 'alt')}
        ${tag(seriesLabel(season, episode))}
        ${ok ? tag('playable', 'ok') : tag('unplayable', 'err')}</div>
      <div class="cand-meta">${video ? tag(video) : ''}${audio ? tag(audio) : ''}${probe?.durationSec ? tag(fmtDuration(probe.durationSec)) : ''}${bitrate ? tag(`${Math.round(bitrate / 1000)} kbps`) : ''}</div>
      <div class="mono cand-url">${escapeHtml(String(candidate.url || '').slice(0, 160))}</div>
      ${candidate.error ? `<div class="err-text">${escapeHtml(candidate.error)}</div>` : ''}
    </div>
    <div class="cand-side">
      <button class="btn sm pri" data-series-add="${key}:${index}" ${ok ? '' : 'disabled'}>+ add ${escapeHtml(quality)}</button>
      <button class="btn sm ghost" data-probe-url="${escapeHtml(candidate.url || '')}">probe</button>
    </div>
  </div>`;
}

async function addSeriesCandidate(key, index, button) {
  const series = state.series;
  if (!series) return;
  const [season, episode] = String(key).split(':').map(Number);
  const group = series.episodes.get(seriesKey(season, episode));
  const candidate = group?.candidates?.[index];
  if (!candidate) return;
  if (button) button.disabled = true;
  try {
    await addCandidateToPlaylist(-1, { candidate, season, episode, button });
  } finally {
    renderSeriesCandidates();
  }
}

/* ---------------- selection subtitles (same panel the old UI had) ---------------- */

async function openSelectionSubtitles() {
  const selection = state.selection;
  if (!selection) return;
  const panel = $('#sel-subtitle-panel');
  panel.classList.remove('hide');
  const items = VMPlaylist.items();
  const suggested = items.find((item) => titleKey(item.title) === titleKey(selection.title)) || null;
  $('#sel-subtitle-target').innerHTML = `${escapeHtml(selection.title)}${selection.year ? ` (${selection.year})` : ''}
    <div class="row" style="margin-top:6px">attach to
      <select id="sel-subtitle-item" style="width:auto">
        <option value="">(pick a playlist item…)</option>
        ${items.map((item) => `<option value="${escapeHtml(item.streamId)}"${suggested && suggested.streamId === item.streamId ? ' selected' : ''}>${escapeHtml(item.title)}${item.year ? ` (${item.year})` : ''}</option>`).join('')}
      </select></div>`;
  $('#sel-subtitle-count').textContent = 'searching…';
  const host = $('#sel-subtitle-results');
  host.innerHTML = '<div class="meta" style="padding:14px">searching the enabled providers…</div>';
  try {
    const firstSeries = selection.kind === 'series' ? seriesSelectedEpisodes()[0] : null;
    const data = await api('/api/subtitles/search', {
      method: 'POST',
      silent: true,
      body: { title: selection.title, year: selection.year || null, kind: selection.kind || 'movie', season: selection.season || firstSeries?.season || null, episode: selection.episode || firstSeries?.episode || null },
    });
    state.findSubtitleResults = data.results || [];
    $('#sel-subtitle-count').textContent = `${state.findSubtitleResults.length} result(s)`;
    host.innerHTML = state.findSubtitleResults.length
      ? state.findSubtitleResults.slice(0, 40).map((result, index) => subtitleRowMarkup(result, index, 'find')).join('')
      : '<div class="meta" style="padding:14px">no subtitles found</div>';
  } catch (error) {
    $('#sel-subtitle-count').textContent = '';
    host.innerHTML = `<div class="meta" style="padding:14px">${escapeHtml(error.message)}</div>`;
  }
}

function subtitleRowMarkup(result, index, scope) {
  return `<div class="pick-row">
    <div class="pick-main">
      <div>${tag(result.language || '??', 'alt')} ${tag(result.providerId || '—')}
        ${result.downloads ? tag(`${result.downloads} downloads`) : ''}
        ${result.rating ? tag(`★ ${result.rating}`) : ''}</div>
      <div class="meta">${escapeHtml(result.release || result.title || '')}</div>
    </div>
    <div class="row">
      <button class="btn sm ghost" data-download-sub="${index}" data-scope="${scope}">⤓ download .srt</button>
      <button class="btn sm pri" data-attach-sub="${index}" data-scope="${scope}">attach to playlist</button>
    </div>
  </div>`;
}

function subtitleDownloadName(result, selection = {}) {
  const title = String(selection.title || result.title || result.release || 'subtitle')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'subtitle';
  const year = Number(selection.year) || Number(result.year) || '';
  const language = String(result.language || 'sub').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 8) || 'sub';
  return `${title}${year ? `-${year}` : ''}.${language}.srt`;
}

/** Download a provider result without requiring the title to be in the playlist. */
async function downloadSubtitle(result, selection = state.selection || {}) {
  if (!result?.providerId) return;
  const data = await api('/api/subtitles/download', {
    method: 'POST',
    body: { result, push: false },
    silent: true,
  });
  if (!data.srt) throw new Error('the subtitle provider returned an empty file');
  const blob = new Blob([data.srt], { type: 'application/x-subrip;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = subtitleDownloadName(result, selection);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Downloaded ${link.download}`, 'ok');
}

async function attachSubtitle(result, { streamId = null, language = null } = {}) {
  if (!streamId) {
    toast('Pick the playlist item this subtitle belongs to first', 'warn');
    return;
  }
  await api(`/api/playlist/items/${encodeURIComponent(streamId)}/subtitle`, {
    method: 'POST',
    body: { result, language: language || result.language || '' },
  });
  await VMPlaylist.refresh({ render: currentPage === 'list' });
  toast(`Subtitle attached to the playlist item (${result.language || 'srt'})`, 'ok');
}

/* ---------------- URL resolve tab ---------------- */

async function doResolveFromUrl() {
  const url = ($('#u-url')?.value || '').trim();
  if (!url) {
    toast('Paste the movie/series or player URL first', 'warn');
    return;
  }
  ui.search.url = url;
  ui.search.urlTitle = $('#u-title').value;
  ui.search.urlYear = $('#u-year').value;
  ui.search.urlKind = $('#u-kind').value;
  ui.search.urlSeason = $('#u-season').value;
  ui.search.urlEpisode = $('#u-episode').value;
  saveSearchState();
  const seq = ++resolveSeq;
  resolveAbort?.abort();
  resolveAbort = new AbortController();
  clearSelection();
  state.selection = {
    key: `url:${url}`,
    title: $('#u-title').value.trim() || url.replace(/^https?:\/\//, '').slice(0, 80),
    year: Number($('#u-year').value) || null,
    kind: $('#u-kind').value || 'movie',
    poster: '',
    entries: [],
    season: Number($('#u-season').value) || 0,
    episode: Number($('#u-episode').value) || 0,
    fromUrl: true,
  };
  state.resolving = true;
  $('#sel-name').textContent = state.selection.title;
  $('#sel-meta').textContent = 'scraping the pasted URL…';
  $('#candidates').innerHTML = '<div class="meta">resolving and probing…</div>';
  $('#btn-resolve').disabled = true;
  try {
    const data = await api('/api/find/resolve', {
      method: 'POST',
      body: {
        url,
        title: $('#u-title').value.trim() || undefined,
        year: Number($('#u-year').value) || undefined,
        kind: $('#u-kind').value,
        season: Number($('#u-season').value) || 0,
        episode: Number($('#u-episode').value) || 0,
        probe: $('#u-probe').checked,
        useBrowser: $('#u-browser').checked,
      },
      silent: true,
      signal: resolveAbort.signal,
    });
    if (seq !== resolveSeq) return;
    state.candidates = expandCandidateQualities((data.candidates || []).map((candidate) => ({ ...candidate, _entry: { sourceId: candidate.sourceId } })));
    state.resolving = false;
    renderCandidates(state.candidates, {});
    $('#sel-meta').textContent = `${state.candidates.length} quality option(s) found${data.error ? ` — ${data.error}` : ''}`;
    renderSelectionActions();
  } catch (error) {
    if (error.name === 'AbortError') return;
    state.resolving = false;
    $('#candidates').innerHTML = `<div class="meta">${escapeHtml(error.message)}</div>`;
  } finally {
    $('#btn-resolve').disabled = false;
  }
}

/* ---------------- find wiring ---------------- */

function wireFind() {
  $$('#find-tabs button').forEach((button) => button.addEventListener('click', () => setFindTab(button.dataset.t)));
  $('#btn-search')?.addEventListener('click', doSearch);
  $('#btn-search-discover')?.addEventListener('click', () => openDiscoveryModal('find'));
  $('#q')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') doSearch(); });
  $('#btn-sources-all')?.addEventListener('click', () => { state.selectedSources = state.sources.map((source) => source.id); renderSourceChips(); saveSearchState(); });
  $('#btn-sources-none')?.addEventListener('click', () => { state.selectedSources = []; renderSourceChips(); saveSearchState(); });
  $('#source-chips')?.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    const id = chip.dataset.id;
    state.selectedSources = state.selectedSources.includes(id)
      ? state.selectedSources.filter((value) => value !== id)
      : [...state.selectedSources, id];
    renderSourceChips();
    saveSearchState();
  });
  $('#source-chips')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.target.closest('.chip')?.click(); }
  });
  ['q', 'q-type', 'q-moviebox'].forEach((id) => $(`#${id}`)?.addEventListener('change', () => {
    ui.search.q = $('#q').value;
    ui.search.type = $('#q-type').value;
    ui.search.moviebox = $('#q-moviebox').checked;
    saveSearchState();
  }));
  ['u-url', 'u-title', 'u-year', 'u-season', 'u-episode'].forEach((id) => $(`#${id}`)?.addEventListener('input', () => {
    ui.search.url = $('#u-url').value;
    ui.search.urlTitle = $('#u-title').value;
    ui.search.urlYear = $('#u-year').value;
    ui.search.urlSeason = $('#u-season').value;
    ui.search.urlEpisode = $('#u-episode').value;
    saveSearchState();
  }));
  $('#u-kind')?.addEventListener('change', () => { ui.search.urlKind = $('#u-kind').value; saveSearchState(); });
  $('#btn-resolve')?.addEventListener('click', doResolveFromUrl);
  $('#results-title-filter')?.addEventListener('input', debounce(() => applyTitleFilter($('#results-title-filter').value), 200));
  // Filtering, not selecting: the box narrows the list, the cards resolve.
  $('#results-title-select')?.addEventListener('change', () => applyTitlePick($('#results-title-select').value));
  $('#results-provider-filter')?.addEventListener('change', () => {
    ui.providerFilter = $('#results-provider-filter').value;
    renderResults();
  });
  $('#results-kind-filter')?.addEventListener('change', () => {
    ui.kindFilter = $('#results-kind-filter').value;
    renderResults();
  });
  $('#results-sort')?.addEventListener('change', () => {
    ui.resultsSort = $('#results-sort').value;
    writeStoredText(RESULT_SORT_KEY, ui.resultsSort);
    renderResults();
  });
  $('#results-view')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (!button) return;
    ui.resultsView = button.dataset.view;
    writeStoredText(RESULT_VIEW_KEY, ui.resultsView);
    updateResultsViewButtons();
    renderResults();
  });
  $('#results')?.addEventListener('click', (event) => {
    // A provider chip inside a card: only that provider's formats.
    const provider = event.target.closest('[data-provider]');
    if (provider) {
      const card = provider.closest('[data-group]');
      selectGroup((state.groups || []).find((group) => group.key === card?.dataset.group), { sourceId: provider.dataset.provider || '' });
      return;
    }
    if (event.target.closest('[data-open-formats]')) {
      const card = event.target.closest('[data-group]');
      selectGroup((state.groups || []).find((group) => group.key === card?.dataset.group));
      return;
    }
  });
  // The same switch in the Selected-title panel (all providers ↔ one provider).
  $('#sel-providers')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-sel-provider]');
    if (!chip) return;
    const group = (state.groups || []).find((candidate) => candidate.key === state.selection?.key);
    if (group) selectGroup(group, { sourceId: chip.dataset.selProvider || '' });
  });
  $('#candidates')?.addEventListener('click', (event) => {
    const add = event.target.closest('[data-add-candidate]');
    if (add) { addCandidateToPlaylist(Number(add.dataset.addCandidate)); return; }
    const seriesAdd = event.target.closest('[data-series-add]');
    if (seriesAdd) {
      const [season, episode, index] = String(seriesAdd.dataset.seriesAdd).split(':');
      addSeriesCandidate(`${season}:${episode}`, Number(index), seriesAdd);
      return;
    }
    const seriesBest = event.target.closest('[data-series-add-best]');
    if (seriesBest) {
      const [season, episode] = String(seriesBest.dataset.seriesAddBest).split(':').map(Number);
      addEpisodeBestToPlaylist(season, episode, seriesBest);
      return;
    }
    const seriesQuality = event.target.closest('[data-series-add-quality]');
    if (seriesQuality) {
      seriesQuality.disabled = true;
      addQualityToPlaylist(seriesQuality.dataset.seriesAddQuality)
        .finally(() => { seriesQuality.disabled = false; });
      return;
    }
    const seriesLoad = event.target.closest('[data-series-load]');
    if (seriesLoad) {
      const [season, episode] = String(seriesLoad.dataset.seriesLoad).split(':').map(Number);
      const group = state.series?.episodes.get(seriesKey(season, episode));
      if (group) group.open = true;
      loadSeriesEpisode(season, episode);
      return;
    }
    const seriesReload = event.target.closest('[data-series-reload]');
    if (seriesReload) {
      const [season, episode] = String(seriesReload.dataset.seriesReload).split(':').map(Number);
      loadSeriesEpisode(season, episode, { force: true });
      return;
    }
    const probe = event.target.closest('[data-probe-url]');
    if (probe) probeUrl(probe.dataset.probeUrl);
  });
  // Expanding an episode group resolves it on demand (first open only).
  $('#candidates')?.addEventListener('toggle', (event) => {
    const group = event.target?.closest?.('[data-ep-group]');
    if (!group || !group.open) return;
    const [season, episode] = String(group.dataset.epGroup).split(':').map(Number);
    const entry = state.series?.episodes.get(seriesKey(season, episode));
    if (entry) entry.open = true;
    if (entry && entry.status !== 'done' && entry.status !== 'loading') {
      loadSeriesEpisode(season, episode);
    }
  }, true);
  $('#btn-sel-subs-close')?.addEventListener('click', () => $('#sel-subtitle-panel')?.classList.add('hide'));
  $('#sel-subtitle-results')?.addEventListener('click', (event) => {
    const download = event.target.closest('[data-download-sub]');
    if (download) {
      const result = state.findSubtitleResults[Number(download.dataset.downloadSub)];
      download.disabled = true;
      downloadSubtitle(result)
        .catch((error) => toast(`Subtitle download failed: ${error.message}`, 'err'))
        .finally(() => { download.disabled = false; });
      return;
    }
    const button = event.target.closest('[data-attach-sub]');
    if (!button) return;
    const result = state.findSubtitleResults[Number(button.dataset.attachSub)];
    const target = $('#sel-subtitle-item')?.value;
    attachSubtitle(result, { streamId: target })
      .then(() => { $('#sel-subtitle-selection')?.classList.remove('hide'); $('#sel-subtitle-selection').textContent = `attached to ${target}`; })
      .catch((error) => toast(error.message, 'err'));
  });
  // Series picker: season cards + episode pills + manual fallback.
  $('#sel-seasons')?.addEventListener('change', (event) => {
    const seasonCheck = event.target.closest('[data-season-check]');
    if (seasonCheck) {
      setSeasonSelection(seasonCheck.dataset.seasonCheck, seasonCheck.checked);
      return;
    }
    const epCheck = event.target.closest('[data-ep-check]');
    if (epCheck) {
      const [season, episode] = String(epCheck.dataset.epCheck).split(':').map(Number);
      const group = state.series?.episodes.get(seriesKey(season, episode));
      if (group) {
        group.selected = epCheck.checked;
        if (!epCheck.checked && group.status === 'loading') group.controller?.abort();
        if (!epCheck.checked) { group.status = 'idle'; group.candidates = []; group.error = null; }
      }
      renderSeriesPicker();
      renderSeriesCandidates();
    }
  });
  $('#sel-seasons')?.addEventListener('click', (event) => {
    const all = event.target.closest('[data-season-all]');
    if (all) { setSeasonSelection(all.dataset.seasonAll, true); return; }
    const none = event.target.closest('[data-season-none]');
    if (none) { setSeasonSelection(none.dataset.seasonNone, false); return; }
    const toggle = event.target.closest('[data-season-toggle]');
    if (toggle) {
      const season = Number(toggle.dataset.seasonToggle);
      if (state.series?.collapsed.has(season)) state.series.collapsed.delete(season);
      else state.series?.collapsed.add(season);
      renderSeriesPicker();
    }
  });
  $('#btn-sel-series-all')?.addEventListener('click', () => setAllSeasons(true));
  $('#btn-sel-series-clear')?.addEventListener('click', () => setAllSeasons(false));
  $('#btn-sel-series-load')?.addEventListener('click', () => loadSelectedEpisodes({ announce: true }));
  $('#btn-sel-manual-add')?.addEventListener('click', addManualEpisodes);
  $('#sel-manual-episodes')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') addManualEpisodes(); });
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-go-list]')) go('list');
    const open = event.target.closest('[data-open-stream]');
    if (open) { VMPlaylist.openMetadata(open.dataset.openStream, { popup: true }); }
  });
  $('#dash-jobs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cancel]');
    if (button) {
      api(`/api/jobs/${button.dataset.cancel}/cancel`, { method: 'POST' })
        .then(() => loadJobs())
        .catch(() => {});
    }
  });
  clearSelection();
}

async function probeUrl(url) {
  if (!url) return;
  try {
    const data = await api(`/api/probe?url=${encodeURIComponent(url)}`, { silent: true });
    const probe = data.probe || {};
    const video = probe.video ? `${probe.video.codec} ${probe.video.width}×${probe.video.height}` : 'no video track';
    toast(`probe ok: ${probe.container || '?'} · ${video} · ${probe.durationSec ? fmtDuration(probe.durationSec) : 'live/unknown'}`, 'ok', 9000);
  } catch (error) {
    toast(`probe failed: ${error.message}`, 'err');
  }
}

/* ====================================================================== *
 * subtitles
 * ====================================================================== */

async function initSubtitles() {
  wireSubtitles();
  await Promise.all([
    loadProviders().catch((error) => toast(error.message, 'err')),
    VMPlaylist.load().catch(() => {}),
  ]);
  refreshSubTargets();
}

async function loadProviders() {
  const data = await api('/api/subtitles/providers', { silent: true });
  state.providers = data.providers || [];
  renderProviders();
}

function renderProviders() {
  const host = $('#sub-providers');
  if (!host) return;
  host.innerHTML = state.providers.map((provider) => `
    <div class="srcrow">
      <div><b>${escapeHtml(provider.name || provider.id)}</b>
        <span class="mut" style="font-size:11px">${escapeHtml(provider.kind || '')}${provider.needs?.length ? ` · needs ${escapeHtml(provider.needs.join(', '))}` : ''}</span>
        ${provider.note ? `<div class="meta">${escapeHtml(provider.note)}</div>` : ''}</div>
      <div class="row" style="gap:6px">
        ${provider.state?.ok === true ? tag(provider.state.message || 'ok', 'ok') : provider.state?.ok === false ? tag(provider.state.message || 'failing', 'err') : tag(provider.enabled === false ? 'disabled' : 'not tested')}
        <button class="btn sm ghost" data-test-provider="${escapeHtml(provider.id)}">test</button>
      </div>
    </div>`).join('') || '<div class="meta" style="padding:14px">no providers</div>';
}

function refreshSubTargets() {
  const host = $('#sub-targets');
  if (!host) return;
  const items = VMPlaylist.items();
  if (!items.length) {
    host.innerHTML = '<div class="meta">The playlist is empty — add a title in the Search tab first.</div>';
    return;
  }
  const chosen = new Set($$('#sub-targets input:checked').map((input) => input.value));
  const preferred = ['nl', 'en'];
  const defaultLang = (item) => item.subtitleLanguage || preferred.find((lang) => (state.config?.subtitles?.languages || []).includes(lang)) || 'nl';
  host.innerHTML = items.map((item) => `<label class="check-row"${item.enabled ? '' : ' data-disabled="1"'}>
    <input type="checkbox" value="${escapeHtml(item.streamId)}"${chosen.size === 0 || chosen.has(item.streamId) ? ' checked' : ''}>
    <span>${escapeHtml(item.title)}${item.year ? ` <span class="mut">(${item.year})</span>` : ''}
      ${item.enabled ? '' : '<span class="tag warn">disabled</span>'}
      ${item.subtitlePath ? tag(item.subtitleLanguage || 'subtitle', 'ok') : ''}
      <span class="mut">· ${escapeHtml(defaultLang(item))}</span></span>
  </label>`).join('');
  const note = $('#sub-targets-note');
  if (note) note.textContent = `${items.length} item(s)`;
}

function subTargetIds() {
  return $$('#sub-targets input:checked').map((input) => input.value);
}

/**
 * The custom subtitle provider form, moved from the Subtitles tab to
 * Settings → Subtitles.
 */
function wireSubtitleSourceForm() {
  $('#btn-cp-save')?.addEventListener('click', async () => {
    const id = $('#cp-id').value.trim();
    const searchUrl = $('#cp-search').value.trim();
    const note = $('#cp-note');
    if (!/^[a-z0-9._-]+$/i.test(id) || !searchUrl) {
      toast('An id without spaces and a search URL are required', 'warn');
      return;
    }
    const kind = $('#cp-kind').value;
    const parse = { kind, map: { url: 'url', title: 'title', release: 'release', language: 'language' } };
    if (kind === 'json') parse.items = $('#cp-parse').value.trim() || 'data';
    else parse.regex = $('#cp-parse').value.trim() || '<a[^>]+href="([^"]+)"[^>]*>([^<]{2,120})<';
    if (note) note.textContent = 'saving…';
    try {
      await api('/api/subtitles/providers', {
        method: 'POST',
        body: { id, name: $('#cp-name').value.trim() || id, searchUrl, downloadUrl: $('#cp-download').value.trim(), parse, enabled: true },
      });
      toast('Custom subtitle provider saved — it is on the Subtitles tab now', 'ok');
      if (note) note.textContent = `saved “${id}”`;
      for (const field of ['cp-id', 'cp-name', 'cp-search', 'cp-parse', 'cp-download']) {
        const input = $(`#${field}`);
        if (input) input.value = '';
      }
      await loadProviders().catch(() => {});
    } catch (error) {
      if (note) note.textContent = '';
      toast(error.message, 'err');
    }
  });
}

async function searchSubtitles() {
  const ids = subTargetIds();
  const manualTitle = $('#sub-title')?.value.trim();
  const languages = String($('#sub-langs')?.value || 'nl,en').split(',').map((value) => value.trim()).filter(Boolean);
  const host = $('#sub-results');
  const progress = $('#sub-progress');
  if (!ids.length && !manualTitle) {
    toast('Select at least one playlist item, or type a title under “search manually”', 'warn');
    return;
  }
  state.subResults = [];
  if (progress) progress.textContent = 'searching…';
  $('#btn-sub-search').disabled = true;
  host.innerHTML = '<div class="meta" style="padding:14px">searching…</div>';
  try {
    if (ids.length) {
      let done = 0;
      for (const streamId of ids) {
        const item = VMPlaylist.itemFor(streamId);
        if (progress) progress.textContent = `searching ${++done}/${ids.length}: ${item?.title || streamId}…`;
        try {
          const data = await api('/api/subtitles/search', {
            method: 'POST',
            silent: true,
            body: {
              streamId,
              title: item?.title,
              year: item?.year || null,
              kind: item?.kind || 'movie',
              season: item?.season || null,
              episode: item?.episode || null,
              languages: [item?.subtitleLanguage].filter(Boolean).length ? [item.subtitleLanguage] : languages,
            },
          });
          state.subResults.push({ streamId, title: item?.title || streamId, results: data.results || [] });
        } catch (error) {
          state.subResults.push({ streamId, title: item?.title || streamId, results: [], error: error.message });
        }
      }
    } else {
      const data = await api('/api/subtitles/search', {
        method: 'POST',
        silent: true,
        body: { title: manualTitle, year: Number($('#sub-year')?.value) || null, imdb: $('#sub-imdb')?.value.trim() || null, languages },
      });
      state.subResults.push({ streamId: null, title: manualTitle, results: data.results || [] });
    }
  } finally {
    $('#btn-sub-search').disabled = false;
    if (progress) progress.textContent = '';
  }
  renderSubResults();
}

function renderSubResults() {
  const host = $('#sub-results');
  if (!host) return;
  const language = $('#sub-lang-filter')?.value || 'all';
  let total = 0;
  const blocks = (state.subResults || []).map((block) => {
    const results = (block.results || []).filter((result) => language === 'all' || (result.language || '').startsWith(language));
    total += results.length;
    return `<div class="sub-block">
      <div class="cardhead"><h3 style="margin:0">${escapeHtml(block.title)}</h3>
        <span class="mut">${results.length} of ${(block.results || []).length} result(s)${block.error ? ` · ${escapeHtml(block.error)}` : ''}</span></div>
      ${results.length
        ? results.slice(0, 60).map((result, index) => `<div class="pick-row">
            <div>
              <div>${tag(result.language || '??', 'alt')} ${tag(result.providerId || '—')}
                ${result.downloads ? tag(`${result.downloads} downloads`) : ''}
                ${result.rating ? tag(`★ ${result.rating}`) : ''}</div>
              <div class="meta">${escapeHtml(result.release || result.title || '')}</div>
            </div>
            <button class="btn sm pri" data-attach="${index}" data-stream="${escapeHtml(block.streamId || '')}" data-block="${escapeHtml(block.title)}">attach</button>
          </div>`).join('')
        : '<div class="meta" style="padding:10px 0">nothing in this language</div>'}
    </div>`;
  });
  $('#sub-count').textContent = total ? `${total} result(s)` : '';
  host.innerHTML = blocks.join('') || '<div class="meta" style="padding:14px">no search yet</div>';
}

function wireSubtitles() {
  $('#btn-providers-refresh')?.addEventListener('click', () => loadProviders().catch((error) => toast(error.message, 'err')));
  $('#sub-providers')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-test-provider]');
    if (!button) return;
    button.disabled = true;
    button.textContent = 'testing…';
    try {
      const data = await api('/api/subtitles/providers/test', { method: 'POST', body: { id: button.dataset.testProvider }, silent: true });
      toast(`${button.dataset.testProvider}: ${data.result?.message || (data.result?.ok ? 'ok' : 'failed')}`, data.result?.ok ? 'ok' : 'warn');
      await loadProviders();
    } catch (error) {
      toast(error.message, 'err');
      button.disabled = false;
      button.textContent = 'test';
    }
  });
  $('#btn-sub-targets-all')?.addEventListener('click', () => { $$('#sub-targets input').forEach((input) => { input.checked = true; }); });
  $('#btn-sub-targets-none')?.addEventListener('click', () => { $$('#sub-targets input').forEach((input) => { input.checked = false; }); });
  $('#btn-sub-search')?.addEventListener('click', searchSubtitles);
  $('#sub-lang-filter')?.addEventListener('change', renderSubResults);
  $('#sub-results')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-attach]');
    if (!button) return;
    const block = (state.subResults || []).find((entry) => entry.title === button.dataset.block);
    const result = block?.results?.[Number(button.dataset.attach)];
    if (!result) return;
    const streamId = button.dataset.stream || null;
    if (!streamId) {
      toast('This was a manual search — attach it from the Playlist tab item instead', 'warn');
      return;
    }
    button.disabled = true;
    attachSubtitle(result, { streamId, language: result.language })
      .then(() => { button.textContent = '✓ attached'; })
      .catch((error) => { toast(error.message, 'err'); button.disabled = false; });
  });
}

/* ====================================================================== *
 * stream — every output URL of the playlist
 * ====================================================================== */

const STREAM_URL_LABELS = [
  ['ts', 'VLC / any player (.ts)'],
  ['web', 'Web preview (no subtitles)'],
  ['mkv', 'VLC / any player (.mkv)'],
  ['hls', 'Playlist (.m3u8)'],
  ['playlist', 'Playlist (.m3u)'],
  ['forBox', 'Enigma2 / Duo2'],
  ['direct', 'Direct upstream link (302)'],
  ['download', 'Download to NAS'],
  ['watch', 'Watch in browser'],
];

function selectedStreamId() {
  const picked = $('#st-pick')?.value;
  if (picked) return picked;
  const stored = readStoredText(SELECTED_STREAM_KEY);
  if (stored && VMPlaylist.itemFor(stored)) return stored;
  return VMPlaylist.items()[0]?.streamId || '';
}

/** The per-stream URL list the old Stream tab showed (VLC, playlist, direct…). */
function renderStreamUrls() {
  const pick = $('#st-pick');
  const host = $('#st-urls');
  if (!pick || !host) return;
  const items = VMPlaylist.items();
  const previous = selectedStreamId();
  pick.innerHTML = items.length
    ? items.map((item) => `<option value="${escapeHtml(item.streamId)}"${item.streamId === previous ? ' selected' : ''}>${escapeHtml(item.title)}${item.year ? ` (${item.year})` : ''}</option>`).join('')
    : '<option value="">(the playlist is empty)</option>';
  const item = VMPlaylist.itemFor(pick.value || previous) || items[0] || null;
  if (!item) {
    host.innerHTML = '<div class="meta">No stream yet — add one from the Search tab and it appears here.</div>';
    return;
  }
  const urls = item.urls || {};
  host.innerHTML = `<div class="row" style="margin-bottom:8px">
      ${tag(item.quality || 'unknown', 'ok')} ${tag(item.kind || 'movie')} ${tag(item.sourceId || '—')}
      ${tag(VMPlaylist.templateLabel(item), item.hasTemplate ? 'alt' : '')}
      ${item.enabled ? tag('in the outputs', 'ok') : tag('disabled — not in the outputs', 'warn')}
      <span class="mut">${item.session ? `${item.session.clients || 0} player(s) connected` : 'no relay session running'}</span>
    </div>
    <div class="st-url-grid">${STREAM_URL_LABELS.map(([key, label]) => {
      const url = urls[key] || '';
      const canOpen = Boolean(url);
      const isWatch = key === 'watch';
      const isVlcLike = ['ts','mkv','forBox','hls','playlist','web'].includes(key);
      const openLabel = isWatch ? 'open ↗' : 'VLC';
      const openAttr = isWatch ? `data-open-url="${escapeHtml(url)}"` : `data-vlc-url="${escapeHtml(url)}"`;
      return `
      <div class="field" style="margin:0">
        <label>${escapeHtml(label)}</label>
        <div class="row">
          <input type="text" class="mono" readonly value="${escapeHtml(url)}" aria-label="${escapeHtml(label)} URL" style="flex:1;min-width:120px">
          <button type="button" class="btn sm" data-copy-url="${escapeHtml(url)}"${canOpen ? '' : ' disabled'}>copy</button>
          ${canOpen ? `<button type="button" class="btn sm ghost" ${openAttr} title="${isWatch ? 'open watch page' : 'open in VLC / player'}">${openLabel}</button>` : ''}
        </div>
      </div>`;
    }).join('')}</div>
    ${urls.directNote ? `<div class="note mut" style="margin:8px 0 0">Direct upstream link ${escapeHtml(urls.directNote)}.</div>` : ''}`;
  $$('#st-urls input[readonly]').forEach((input) => input.addEventListener('click', () => input.select()));
  const note = $('#st-url-note');
  if (note) note.textContent = `${item.title}${item.year ? ` (${item.year})` : ''}`;
}

async function streamUrlAction(action) {
  const id = selectedStreamId();
  if (!id) return toast('No stream selected', 'warn');
  const log = $('#st-url-log');
  const say = (text) => { if (log) { log.classList.remove('hide'); log.textContent = text; } };
  try {
    if (action === 'vlc') {
      const url = VMPlaylist.itemFor(id)?.urls?.ts;
      if (!url) return toast('This stream has no .ts URL', 'warn');
      window.location.href = String(url).replace(/^https?:/, 'vlc:');
      return;
    }
    if (action === 'start' || action === 'stop') {
      say(action === 'start' ? 'starting the relay session…' : 'stopping the session…');
      const data = await api(`/api/streams/${encodeURIComponent(id)}/session`, { method: action === 'start' ? 'POST' : 'DELETE', silent: true });
      say(action === 'start'
        ? `session running · ${data.session?.mode || 'copy'}/${data.session?.encoder || 'copy'} · ${data.session?.clients || 0} client(s)`
        : 'session stopped');
      toast(action === 'start' ? 'Relay session started' : 'Relay session stopped', 'ok');
      await VMPlaylist.refresh({ render: currentPage === 'list' });
      renderStreamUrls();
      return;
    }
    if (action === 'download') {
      say('queueing the download…');
      const data = await api(`/api/streams/${encodeURIComponent(id)}/download`, { method: 'POST', body: {}, silent: true });
      say(`download queued · job ${data.job?.id || '—'}${data.job?.filename ? ` → ${data.job.filename}` : ''}`);
      toast('Download queued — watch it on the Dashboard', 'ok');
      return;
    }
    if (action === 'm3u') {
      const res = await fetch(`/api/streams/${encodeURIComponent(id)}/playlist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const blob = new Blob([text], { type: 'audio/x-mpegurl' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${(VMPlaylist.itemFor(id)?.title || 'vu-movie').replace(/[^A-Za-z0-9._-]+/g, '-')}.m3u`;
      link.click();
      URL.revokeObjectURL(link.href);
      say(`playlist written: ${text.split('\n').filter((line) => line && !line.startsWith('#')).length} entrie(s)`);
      return;
    }
  } catch (error) {
    say(`✗ ${error.message}`);
    toast(error.message, 'err');
  }
}

function initStream() {
  $('#btn-st-refresh')?.addEventListener('click', () => refreshStream(true));
  $('#btn-st-dry')?.addEventListener('click', () => pushBouquet({ dryRun: true }));
  $('#btn-st-push')?.addEventListener('click', () => pushBouquet({}));
  $('#btn-st-test-box')?.addEventListener('click', testReceiver);
  $('#btn-e2-copy')?.addEventListener('click', () => copyText($('#e2-preview')?.textContent || ''));
  $('#btn-e2-download')?.addEventListener('click', () => {
    const text = $('#e2-preview')?.textContent || '';
    const blob = new Blob([text], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = state.playlist.urls?.bouquetName || 'userbouquet.vu-movie.tv';
    link.click();
    URL.revokeObjectURL(link.href);
  });
  $('#st-outputs')?.addEventListener('click', (event) => {
    const copyBtn = event.target.closest('[data-copy]');
    if (copyBtn) { copyText(copyBtn.dataset.copy); return; }
    const vlcPl = event.target.closest('[data-vlc-pl]');
    if (vlcPl?.dataset.vlcPl) {
      const u = vlcPl.dataset.vlcPl;
      try {
        const vlc = String(u).replace(/^https?:/, 'vlc:');
        window.location.href = vlc;
        setTimeout(() => toast(`VLC playlist: ${u} — if VLC did not open, copy the URL`, 'info', 6000), 500);
      } catch {
        window.open(u, '_blank');
      }
      return;
    }
  });
  $('#st-items')?.addEventListener('click', (event) => {
    const copyButton = event.target.closest('[data-copy-item]');
    if (copyButton) { copyText(copyButton.dataset.copyItem); return; }
    const watch = event.target.closest('[data-watch]');
    if (watch) window.open(watch.dataset.watch, '_blank');
  });
  // per-stream URL panel (the information the old Stream tab showed)
  $('#st-pick')?.addEventListener('change', () => { writeStoredText(SELECTED_STREAM_KEY, $('#st-pick').value); renderStreamUrls(); });
  $('#btn-st-copy-all')?.addEventListener('click', () => {
    const lines = $$('#st-urls input[readonly]').filter((input) => input.value)
      .map((input) => `${(input.getAttribute('aria-label') || 'url').replace(/ URL$/, '')}: ${input.value}`);
    if (!lines.length) return toast('Nothing to copy', 'warn');
    copyText(lines.join('\n'));
  });
  $('#st-urls')?.addEventListener('click', (event) => {
    const copyBtn = event.target.closest('[data-copy-url]');
    if (copyBtn?.dataset.copyUrl) { copyText(copyBtn.dataset.copyUrl); return; }
    const openBtn = event.target.closest('[data-open-url]');
    if (openBtn?.dataset.openUrl) { window.open(openBtn.dataset.openUrl, '_blank'); return; }
    const vlcBtn = event.target.closest('[data-vlc-url]');
    if (vlcBtn?.dataset.vlcUrl) {
      const u = vlcBtn.dataset.vlcUrl;
      // Try VLC protocol, fallback to opening URL
      try {
        const vlc = String(u).replace(/^https?:/, 'vlc:');
        window.location.href = vlc;
        // Also copy to clipboard as hint
        setTimeout(() => toast(`VLC URL: ${u} — if VLC did not open, copy the URL`, 'info', 6000), 500);
      } catch {
        window.open(u, '_blank');
      }
      return;
    }
  });
  $('#btn-st-vlc')?.addEventListener('click', () => streamUrlAction('vlc'));
  $('#btn-st-session-start')?.addEventListener('click', () => streamUrlAction('start'));
  $('#btn-st-session-stop')?.addEventListener('click', () => streamUrlAction('stop'));
  $('#btn-st-download')?.addEventListener('click', () => streamUrlAction('download'));
  $('#btn-st-m3u')?.addEventListener('click', () => streamUrlAction('m3u'));
  $('#btn-st-test-template')?.addEventListener('click', () => {
    // the Test tab runs the same command the relay would use for this stream
    const item = VMPlaylist.itemFor(selectedStreamId());
    writeStoredText(TEST_SOURCE_KEY, selectedStreamId());
    App.go('tpl-test');
    if (item) toast(`Test tab: pick “${item.title}” and press start test`, 'info', 6000);
  });
}

async function refreshStream(announce = false) {
  await VMPlaylist.load();
  const urls = state.playlist.urls || {};
  const summary = state.playlist.summary || { total: 0, enabled: 0 };
  $('#st-title').textContent = 'Playlist outputs';
  $('#st-meta').innerHTML = `${escapeHtml(state.playlist.name || 'vu-movie')} · ${summary.enabled}/${summary.total} item(s) enabled · ${escapeHtml(state.playlist.items.filter((item) => item.hasTemplate).length)} with an FFmpeg template`;
  const xtream = urls.xtream || {};
  const entries = [
    { name: 'Playlist page', hint: 'open in a browser — player + all URLs', url: urls.page, kind: 'link', pri: true, vlc: false },
    { name: 'M3U — VLC / Kodi', hint: 'plain .m3u for a desktop player (all enabled playlist items)', url: urls.m3u, kind: 'm3u', vlc: true },
    { name: 'M3U+ — IPTV apps', hint: 'with embedded metadata (all enabled)', url: urls.m3uPlus, kind: 'm3u', vlc: true },
    { name: 'VLC playlist', hint: 'VLC preset — complete playlist (all streams defined in Playlist tab, enabled only)', url: urls.vlc, kind: 'm3u', vlc: true, isCompleteVlc: true },
    { name: 'Kodi playlist', hint: 'Kodi preset (.m3u) — complete playlist', url: urls.kodi, kind: 'm3u', vlc: true },
    { name: 'JSON', hint: 'machine-readable catalogue', url: urls.json, kind: 'json', vlc: false },
    { name: 'Xtream Codes', hint: `player_api.php catalogue · user ${xtream.username || '—'} · complete enabled playlist below`, url: xtream.playerApi, kind: 'xtream', xtream, vlc: false },
    { name: 'Enigma2 bouquet', hint: urls.bouquetName || 'userbouquet.tv', url: urls.bouquet, kind: 'bouquet', vlc: false },
  ];
  $('#st-outputs').innerHTML = entries.map((entry) => `
    <div class="card" ${entry.isCompleteVlc ? 'style="border-color:var(--acc);box-shadow:0 0 0 1px rgba(56,189,248,.25)"' : ''}>
      <div class="spread">
        <div><h3 style="margin:0">${escapeHtml(entry.name)}${entry.isCompleteVlc ? ' <span class="tag info">complete playlist</span>' : ''}</h3><div class="meta">${escapeHtml(entry.hint || '')}</div></div>
        <div class="row" style="gap:6px">
          ${entry.kind === 'link' ? `<a class="btn sm" href="${escapeHtml(entry.url || '')}" target="_blank" rel="noreferrer">open ↗</a>` : ''}
          ${entry.vlc ? `<button class="btn sm" data-vlc-pl="${escapeHtml(entry.url || '')}" title="open in VLC">▶ VLC</button>` : ''}
          ${entry.kind === 'm3u' ? `<a class="btn sm ghost" href="${escapeHtml(entry.url || '')}" target="_blank" rel="noreferrer">open ↗</a>` : ''}
          <button class="btn sm ghost" data-copy="${escapeHtml(entry.url || '')}">copy</button>
        </div>
      </div>
      <div class="mono url-line">${escapeHtml(entry.url || '—')}</div>
      ${entry.kind === 'xtream' ? `<div class="meta" style="margin-top:6px">Xtream account — username <b>${escapeHtml(entry.xtream.username || '')}</b>, password <b>${escapeHtml(entry.xtream.password || '')}</b> <span class="tip" tabindex="0" role="note" aria-label="About the Xtream account" data-tip="Give these credentials to TiviMate, IPTV Smarters or another Xtream-compatible app; the player API URL above is the server address. Xtream catalogue and M3U+ output include every enabled playlist item in order.">i</span></div><div class="row" style="gap:6px;margin-top:8px"><a class="btn sm ghost" href="${escapeHtml(entry.xtream.get || '')}" target="_blank" rel="noreferrer">complete M3U+ ↗</a><button class="btn sm ghost" data-copy="${escapeHtml(entry.xtream.get || '')}">copy M3U+</button></div><div class="mono url-line">${escapeHtml(entry.xtream.get || '—')}</div>` : ''}
    </div>`).join('');

  $('#st-item-count').textContent = `${state.playlist.items.length} item(s)`;
  $('#st-items').innerHTML = state.playlist.items.length ? `<table>
    <thead><tr><th>#</th><th>Title</th><th>Quality</th><th>Template</th><th>Subtitle</th><th>URLs</th></tr></thead><tbody>
    ${state.playlist.items.map((item, index) => `<tr class="${item.enabled ? '' : 'row-off'}">
      <td class="mut">${index + 1}</td>
      <td>${escapeHtml(item.title)}${item.enabled ? '' : ' <span class="tag warn">off</span>'}</td>
      <td>${tag(item.quality || '—', 'ok')}</td>
      <td>${escapeHtml(VMPlaylist.templateLabel(item))}</td>
      <td>${item.subtitlePath ? tag(item.subtitleLanguage || 'yes', 'ok') : '<span class="mut">—</span>'}</td>
      <td class="row" style="gap:6px">
        <button class="btn sm ghost" data-copy-item="${escapeHtml(item.urls.forBox || '')}">copy box URL</button>
        <button class="btn sm ghost" data-watch="${escapeHtml(item.urls.watch || '')}">watch</button>
      </td>
    </tr>`).join('')}</tbody></table>` : '<div class="meta" style="padding:14px">the playlist is empty</div>';

  renderStreamUrls();
  renderStreamMonitor();
  await refreshBouquetPreview();
  if (announce) toast('Outputs refreshed', 'ok', 2500);
}

async function refreshBouquetPreview() {
  try {
    const data = await api('/api/playlist/enigma2', { method: 'POST', body: {}, silent: true });
    const bouquet = data.bouquet || data;
    $('#e2-preview').textContent = bouquet.text || '—';
    $('#e2-file').textContent = bouquet.fileName || 'userbouquet.vu-movie.tv';
    $('#e2-count').textContent = `${bouquet.entries ?? 0} entries`;
  } catch (error) {
    $('#e2-preview').textContent = `// could not build the bouquet: ${error.message}`;
  }
}

function renderStreamMonitor() {
  const host = $('#st-monitor');
  if (!host) return;
  const running = (state.playlist.items || []).filter((item) => item.session);
  if (!running.length) {
    host.innerHTML = '<div class="meta">no session running — the relay starts one when a player opens a URL.</div>';
    return;
  }
  host.innerHTML = running.map((item) => {
    const session = item.session;
    return `<div class="kv"><span>${escapeHtml(item.title)} <span class="mut">${escapeHtml(session.mode || '')}/${escapeHtml(session.encoder || '')}</span></span>
      <span>${session.clients} client(s) · ${fmtBytes(session.bytesOut || 0)} · up ${fmtDuration(session.uptimeSec)}${session.stats?.speed ? ` · ${escapeHtml(session.stats.speed)}` : ''}</span></div>`;
  }).join('');
}

async function pushBouquet({ dryRun = false } = {}) {
  const log = $('#st-push-log');
  log?.classList.remove('hide');
  if (log) log.textContent = dryRun ? 'building a dry run…' : 'pushing the bouquet to the receiver…';
  try {
    const data = await api('/api/playlist/enigma2', { method: 'POST', body: { action: 'push', dryRun }, silent: true });
    const lines = [
      dryRun ? '✓ dry run — nothing was written to the receiver' : (data.ok ? '✓ bouquet pushed to the receiver' : '✗ push failed'),
      `entries: ${data.bouquet?.entries ?? '—'} · file: ${data.bouquet?.fileName || '—'}`,
      data.transport ? `transport: ${data.transport.via || JSON.stringify(data.transport)}` : '',
      data.error ? `error: ${data.error}` : '',
      data.reload ? `reload: ${data.reload.ok ? 'ok' : data.reload.error || 'failed'}` : '',
    ].filter(Boolean);
    if (log) log.textContent = lines.join('\n') + (data.bouquet?.text ? `\n\n${data.bouquet.text.slice(0, 4000)}` : '');
    toast(dryRun ? 'Dry run finished' : (data.ok ? 'Bouquet pushed' : `Push failed: ${data.error || 'unknown error'}`), data.ok ? 'ok' : 'err');
    await refreshStream();
  } catch (error) {
    if (log) log.textContent = `✗ ${error.message}`;
    toast(error.message, 'err');
  }
}

async function testReceiver() {
  const host = $('#st-box');
  host.textContent = 'asking the receiver…';
  try {
    const data = await api('/api/enigma2/status', { silent: true });
    const status = data.status || {};
    host.innerHTML = `<div class="kv"><span>reachable</span><span><i class="dot ${dot(status.ok)}"></i> ${escapeHtml(status.message || '—')}</span></div>
      <div class="kv"><span>model</span><span>${escapeHtml(status.model || '—')}</span></div>
      <div class="kv"><span>webif</span><span>${escapeHtml(status.webif || status.via || '—')}</span></div>`;
    toast(status.ok ? 'Receiver reachable' : `Receiver: ${status.message || 'unreachable'}`, status.ok ? 'ok' : 'warn');
  } catch (error) {
    host.textContent = error.message;
  }
}

/* ====================================================================== *
 * transcode + test (the editor lives in ffmpeg-editor.js)
 * ====================================================================== */

/** The Test tab's own source picker, using the same options as the editor. */
function renderTestSourcePicker() {
  const select = $('#test-source');
  if (!select) return;
  const previous = select.value;
  const items = VMPlaylist.items();
  const saved = state.streams || [];
  const seen = new Set(items.map((item) => String(item.streamId)));
  const options = ['<option value="">(pick a source…)</option>'];
  if (items.length) {
    options.push('<optgroup label="Playlist">');
    for (const item of items) options.push(`<option value="stream:${escapeHtml(item.streamId)}">${escapeHtml(item.title)}${item.enabled ? '' : ' (disabled)'}</option>`);
    options.push('</optgroup>');
  }
  const others = saved.filter((stream) => !seen.has(String(stream.id)));
  if (others.length) {
    options.push('<optgroup label="Saved streams">');
    for (const stream of others) options.push(`<option value="stream:${escapeHtml(stream.id)}">${escapeHtml(stream.title)}${stream.year ? ` (${stream.year})` : ''}</option>`);
    options.push('</optgroup>');
  }
  options.push('<optgroup label="Other"><option value="url:">custom URL…</option></optgroup>');
  select.innerHTML = options.join('');
  const wanted = previous || readStoredText(TEST_SOURCE_KEY) || '';
  const candidate = wanted.startsWith('stream:') ? wanted : `stream:${wanted}`;
  if (wanted && [...select.options].some((option) => option.value === candidate)) select.value = candidate;
  else if (items.length) select.value = `stream:${items[0].streamId}`;
  syncTestTarget();
}

function wireTestSourcePicker() {
  $('#test-source')?.addEventListener('change', syncTestTarget);
  $('#test-url')?.addEventListener('input', syncTestTarget);
  $('#test-duration')?.addEventListener('change', syncTestTarget);
}

/** The Test tab's own start/stop/clear buttons drive the editor instance. */
function wireTestControls() {
  $('#btn-test-run')?.addEventListener('click', () => {
    syncTestTarget();
    VMFfmpegEditor.runTestTab();
  });
  $('#btn-test-stop')?.addEventListener('click', () => VMFfmpegEditor.stopTestTab());
  $('#btn-test-clear')?.addEventListener('click', () => {
    const editor = VMFfmpegEditor.testEditor;
    if (editor) VMFfmpegEditor.clearTestOutput?.(editor);
    const status = $('#test-status');
    if (status) status.textContent = '';
  });
  VMFfmpegEditor.syncTabButtons?.(false);
}

/** Keep the editor instance's working source in sync with the tab controls. */
function syncTestTarget() {
  const editor = VMFfmpegEditor.testEditor;
  const value = $('#test-source')?.value || '';
  $('#test-url-field')?.classList.toggle('hide', value !== 'url:');
  if (!editor) return;
  if (value === 'url:') editor.test.source = { kind: 'url', streamId: '', url: $('#test-url')?.value.trim() || '' };
  else if (value.startsWith('stream:')) editor.test.source = { kind: 'stream', streamId: value.slice(7), url: '' };
  else editor.test.source = { kind: 'stream', streamId: '', url: '' };
  editor.test.durationMs = (Number($('#test-duration')?.value) || 5) * 1000;
}

/* ====================================================================== *
 * logs (unchanged behaviour: level, component, text filter, live tail)
 * ====================================================================== */

function initLogs() {
  $('#btn-log-refresh')?.addEventListener('click', () => loadLogs());
  $('#btn-log-clear')?.addEventListener('click', () => { state.logs = []; renderLogs(); });
  $('#log-level')?.addEventListener('change', async () => {
    try {
      await api('/api/logs/level', { method: 'POST', body: { level: $('#log-level').value } });
      toast(`Server log level → ${$('#log-level').value}`, 'ok', 2500);
      loadLogs();
    } catch (error) { toast(error.message, 'err'); }
  });
  ['log-component', 'log-search'].forEach((id) => $(`#${id}`)?.addEventListener('input', renderLogs));
  subscribeToEvents();
}

async function loadLogs() {
  try {
    const data = await api('/api/logs?limit=400', { silent: true });
    state.logs = data.entries || [];
    const select = $('#log-component');
    if (select) {
      const previous = select.value;
      select.innerHTML = `<option value="">all components</option>${(data.components || []).map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}`;
      select.value = previous;
    }
    if ($('#log-level')) $('#log-level').value = data.level || 'info';
    renderLogs();
  } catch { /* the toast is enough */ }
}

function logLineMarkup(entry) {
  const level = String(entry.level || 'info');
  const cls = level === 'error' ? 'err' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'info';
  return `<div class="logline ${cls}"><span class="lt">${escapeHtml(fmtTime(entry.time || entry.timestamp))}</span>
    <span class="ll">${escapeHtml(level.slice(0, 4).toUpperCase())}</span>
    <span class="lc">${escapeHtml(entry.component || '')}</span>
    <span class="lm">${escapeHtml(entry.message || '')}${entry.meta && Object.keys(entry.meta).length ? ` <span class="mut">${escapeHtml(JSON.stringify(entry.meta))}</span>` : ''}</span></div>`;
}

function renderLogs() {
  const host = $('#log-view');
  if (!host) return;
  const level = $('#log-level')?.value || 'info';
  const levels = ['debug', 'info', 'warn', 'error'];
  const min = levels.indexOf(level);
  const component = $('#log-component')?.value || '';
  const search = ($('#log-search')?.value || '').toLowerCase();
  const rows = (state.logs || []).filter((entry) => {
    if (levels.indexOf(entry.level || 'info') < min) return false;
    if (component && entry.component !== component) return false;
    if (search && !`${entry.component} ${entry.message} ${JSON.stringify(entry.meta || {})}`.toLowerCase().includes(search)) return false;
    return true;
  });
  host.innerHTML = rows.length ? rows.map(logLineMarkup).join('') : '<div class="meta">no log lines match</div>';
  if ($('#log-live')?.checked) host.scrollTop = host.scrollHeight;
}

/** /api/events is the server's live log + job/session feed. */
function subscribeToEvents() {
  if (logStream?.readyState === EventSource.OPEN) return;
  try {
    logStream = new EventSource('/api/events');
  } catch { return; }
  logStream.addEventListener('log', (event) => {
    try {
      const entry = JSON.parse(event.data);
      state.logs = [...(state.logs || []).slice(-800), entry];
      if ($('#log-live')?.checked && !$('#p-logs')?.classList.contains('hide')) renderLogs();
    } catch { /* ignore malformed lines */ }
  });
  logStream.addEventListener('job', () => {
    // the server sends one job per event; re-reading the list keeps the bars
    // and the state tags in sync without guessing the payload shape
    if (!$('#p-dash')?.classList.contains('hide')) loadJobs();
  });
  logStream.addEventListener('sessions', (event) => {
    try { renderSessions(JSON.parse(event.data)); } catch { /* ignore */ }
  });
  logStream.addEventListener('error', () => { /* EventSource reconnects on its own */ });
}

/* ====================================================================== *
 * settings (same sections and behaviour as before)
 * ====================================================================== */

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
      ['realtime', 'bool'],
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
    key: 'metadata', title: 'Metadata',
    fields: [
      ['tmdbApiKey', 'password'], ['omdbApiKey', 'password'], ['language', 'text'],
    ],
  },
  {
    key: 'playlist', title: 'Playlist availability',
    fields: [
      ['autoCheckEnabled', 'bool'], ['autoCheckIntervalMinutes', 'number'], ['autoRepairEnabled', 'bool'],
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

/**
 * Human labels and one-line explanations for every settings field. The old
 * tab printed the raw config keys; these read like the section they belong to
 * (and the explanation is the "i" tooltip).
 */
const SETTINGS_NOTES = {
  transcode: 'Guided profile builder: what the relay does when a stream has no FFmpeg template of its own.',
  subtitles: 'Which languages are searched and whether a found subtitle is pushed to the receiver.',
  metadata: 'TMDB / OMDB for rich movie info — ratings, cast, plot, posters. Get a free key at themoviedb.org and omdbapi.com.',
  playlist: 'Scheduled stream health checks and automatic recovery. A refreshed upstream keeps the same stream id/token and existing playlist URLs.',
  enigma2: 'The VU+ / Enigma2 box that receives the bouquet.',
  scraper: 'Headless-browser and ffprobe behaviour while resolving a stream.',
  storage: 'Folders inside the container, and how much disk the cache may use.',
  app: 'The web server itself — port, login and token lifetime.',
};

const SETTINGS_LABELS = {
  'transcode.mode': ['Mode', 'auto picks copy vs. transcode from the source; copy/vaapi/x264/h265 force one.'],
  'transcode.resolution': ['Resolution cap', 'Longest edge the output may have. 0 or empty keeps the source.'],
  'transcode.aspect': ['Aspect ratio', 'source keeps the source, 169/43 force a specific ratio.'],
  'transcode.videoBitrate': ['Video bitrate', 'Target video bitrate in kbps for the software encoders.'],
  'transcode.audioBitrate': ['Audio bitrate', 'Target audio bitrate in kbps.'],
  'transcode.audioChannels': ['Audio channels', '1 mono, 2 stereo, 6 = 5.1. Empty keeps the source layout.'],
  'transcode.fps': ['Frame rate', 'source keeps the source, 25/30 force a rate.'],
  'transcode.container': ['Container', 'mpegts for live VLC/Enigma2, matroska for files, hls for segmented playback.'],
  'transcode.alwaysTranscode': ['Always transcode', 'Never stream-copy, even when the source already matches.'],
  'transcode.hardware': ['Use hardware (VAAPI)', 'Prefer the iGPU when the box exposes /dev/dri.'],
  'transcode.maxConcurrent': ['Max concurrent jobs', 'How many relay sessions and downloads may run at the same time.'],
  'transcode.device': ['VAAPI device', 'Usually /dev/dri/renderD128; renderD129 is the second GPU.'],
  'transcode.idleStopSeconds': ['Idle stop (s)', 'Stop a relay session when no player has read from it for this long.'],
  'transcode.encoderFallback': ['Encoder fallback', 'Encoder chain used when the preferred one is unavailable, e.g. vaapi:x264.'],
  'transcode.realtime': ['Pace live output', 'Throttle the relay to the source rate so real-time players do not starve.'],

  'subtitles.languages': ['Languages', 'Search order, comma separated — e.g. nl, en.'],
  'subtitles.autoSearch': ['Auto search', 'Search subtitles automatically after a title is resolved.'],
  'subtitles.pushToReceiver': ['Push to receiver', 'Upload the chosen subtitle to the Enigma2 box as well.'],
  'subtitles.receiverDir': ['Receiver directory', 'Folder on the box that receives the .srt files.'],
  'subtitles.disabledProviders': ['Disabled providers', 'Provider ids to skip, comma separated (see the Subtitles tab).'],

  'metadata.tmdbApiKey': ['TMDB API key', 'From https://www.themoviedb.org/settings/api — v3 key, free. Enables rich metadata in search and playlist.'],
  'metadata.omdbApiKey': ['OMDB API key', 'From https://www.omdbapi.com/apikey.aspx — optional, adds IMDb ratings.'],
  'metadata.language': ['Metadata language', 'e.g. en-US, nl-NL, de-DE for TMDB results.'],

  'playlist.autoCheckEnabled': ['Scheduled checks', 'Check every stream in the Playlist after startup and repeat on the interval below.'],
  'playlist.autoCheckIntervalMinutes': ['Check interval (min)', '15–10080 minutes; default is every 6 hours. The first scheduled check starts shortly after boot.'],
  'playlist.autoRepairEnabled': ['Auto-refresh inactive streams', 'When a check fails, resolve the same title on its current provider first, then try other enabled providers. The stream token and output URLs stay the same.'],

  'enigma2.host': ['Host', 'IP or hostname of the VU+ on the LAN.'],
  'enigma2.port': ['Port', 'Enigma2 web interface port, 80 by default.'],
  'enigma2.username': ['Username', 'Only needed when the box asks for a login.'],
  'enigma2.password': ['Password', 'Stored in /config/vumovie.json; shown masked after a reload.'],
  'enigma2.bouquetName': ['Bouquet name', 'Name the playlist gets in the receiver bouquet list.'],
  'enigma2.rootDir': ['Root directory', 'Folder on the box for the bouquet and the subtitle files.'],
  'enigma2.serviceType': ['Service type', 'Enigma2 service type for the bouquet entries: 4097 = GStreamer (non-TS stream, the default), 1 = DVB.'],
  'enigma2.ftpEnabled': ['FTP upload', 'Upload the bouquet and subtitles over FTP instead of HTTP.'],
  'enigma2.ftpPort': ['FTP port', '21 by default.'],
  'enigma2.autoPush': ['Auto push', 'Push the bouquet after every playlist change.'],

  'scraper.browserConcurrency': ['Browser concurrency', 'How many headless pages may resolve at the same time.'],
  'scraper.browserIdleSeconds': ['Browser idle (s)', 'Close the headless browser after this many idle seconds.'],
  'scraper.resolveTimeoutMs': ['Resolve timeout (ms)', 'Give up on one candidate after this long.'],
  'scraper.probeCandidates': ['Probe candidates', 'Run ffprobe on every candidate so dead mirrors are filtered out.'],
  'scraper.maxCandidates': ['Max candidates', 'How many mirrors are tried before a title is reported as failed.'],
  'scraper.flaresolverrUrl': ['FlareSolverr URL', 'Optional Cloudflare-bypass proxy, e.g. http://flaresolverr:8191.'],
  'scraper.externalExtractorUrl': ['External extractor URL', 'Optional helper service for sites the built-in resolvers cannot read.'],
  'scraper.sessionDir': ['Browser session dir', 'Where cookies and the browser profile are kept.'],
  'scraper.userAgent': ['User agent', 'User agent used for scraping and for the upstream requests.'],

  'storage.downloads': ['Downloads folder', 'Where “download to NAS” writes finished files.'],
  'storage.tmp': ['Temp folder', 'Scratch space for downloads and live tests.'],
  'storage.cacheBudgetMb': ['Cache budget (MB)', 'How much disk the relay cache may use before old segments are dropped.'],

  'app.port': ['HTTP port', 'Port the web interface listens on (restart required).'],
  'app.baseUrl': ['Public base URL', 'Address used in every output URL — set it when the box sits behind a proxy.'],
  'app.username': ['Username', 'Login for the web interface.'],
  'app.password': ['Password', 'Shown masked; leave it untouched to keep the current one.'],
  'app.logLevel': ['Log level', 'debug for troubleshooting, info for normal use.'],
  'app.tokenTtlMinutes': ['Token lifetime (min)', 'How long a stream token stays valid. 0 = never expires.'],
};

async function initSettings() {
  wireSettings();
  await loadSettings();
}

async function loadSettings() {
  try {
    const res = await api('/api/config');
    state.config = res.config;
    const draft = structuredClone(res.config);
    $('#settings-grid').innerHTML = SETTINGS_SECTIONS.map((section) => `
      <div class="card" data-set-section="${escapeHtml(section.key)}">
        <div class="cardhead"><h2 style="margin:0">${titleWithTip(section.title, SETTINGS_NOTES[section.key])}</h2>
          <span class="mut">${section.fields.length} field(s)</span></div>
        <div class="set-fields">
        ${section.fields.map(([key, type, options]) => {
          const value = draft[section.key]?.[key];
          const id = `set-${section.key}-${key}`;
          const [label, hint] = SETTINGS_LABELS[`${section.key}.${key}`] || [key, ''];
          if (type === 'bool') {
            return `<div class="field" data-set-field="${id}"><label class="check-row" style="margin:0"><input type="checkbox" id="${id}" ${value ? 'checked' : ''}> ${escapeHtml(label)} ${tip(hint)}</label></div>`;
          }
          if (type === 'select') {
            return `<div class="field" data-set-field="${id}"><label for="${id}">${escapeHtml(label)} ${tip(hint)}</label><select id="${id}">${(options || []).map((option) => `<option value="${escapeHtml(option)}" ${String(value) === String(option) ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select></div>`;
          }
          if (type === 'list') {
            const list = Array.isArray(value) ? value : String(value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
            return `<div class="field" data-set-field="${id}"><label for="${id}">${escapeHtml(label)} ${tip(hint)}</label><input id="${id}" value="${escapeHtml(list.join(', '))}" placeholder="comma separated"></div>`;
          }
          const inputType = type === 'password' ? 'password' : type === 'number' ? 'number' : 'text';
          const constraints = section.key === 'playlist' && key === 'autoCheckIntervalMinutes' ? ' min="15" max="10080" step="15"' : '';
          return `<div class="field" data-set-field="${id}"><label for="${id}">${escapeHtml(label)} ${tip(hint)}</label><input id="${id}" type="${inputType}"${constraints} value="${escapeHtml(value ?? '')}"></div>`;
        }).join('')}
        </div>
      </div>`).join('');
    const hint = $('#settings-hint');
    if (hint) hint.textContent = `${SETTINGS_SECTIONS.length} section(s) loaded from /api/config`;
  } catch (error) {
    const grid = $('#settings-grid');
    if (grid) grid.innerHTML = `<div class="card"><h2>Settings could not be loaded</h2>
      <div class="param-msg err">${escapeHtml(error.message)}</div>
      <div class="row"><button class="btn" id="btn-settings-retry">try again</button></div></div>`;
    $('#btn-settings-retry')?.addEventListener('click', () => loadSettings().catch(() => {}));
    throw error;
  }
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
      else if (type === 'list') value = el.value.split(',').map((part) => part.trim()).filter(Boolean);
      else value = el.value;
      if (type === 'password' && /^•+$/.test(String(value))) continue;
      patch[section.key][key] = value;
    }
  }
  await api('/api/config', { method: 'PUT', body: patch });
  toast('Settings saved to /config/vumovie.json', 'ok');
  loadHealth();
}

function wireSettings() {
  wireSubtitleSourceForm();
  $('#btn-save-settings')?.addEventListener('click', () => saveSettings().catch((error) => toast(error.message, 'err')));
  $('#btn-reload-settings')?.addEventListener('click', () => loadSettings().then(() => toast('Settings reloaded', 'ok', 2500)).catch((error) => toast(error.message, 'err')));
  $('#btn-hw-test')?.addEventListener('click', async () => {
    toast('Re-testing the hardware encoder — this can take ~30 s', 'info');
    try {
      const data = await api('/api/config/hwaccel/test', { method: 'POST', body: {} });
      const hw = data.hwaccel || {};
      toast(hw.available ? `VAAPI works (${hw.libvaDriver || hw.driver}, variant ${hw.fpsVariant})` : `No hardware acceleration: ${hw.reason || 'unknown reason'}`, hw.available ? 'ok' : 'warn', 10000);
      loadHealth();
    } catch (error) { toast(error.message, 'err'); }
  });
  $('#btn-diag')?.addEventListener('click', async () => {
    const out = $('#diag-out');
    out.textContent = 'running ffmpeg -version and a 2 s VAAPI encode per driver…';
    try {
      const data = await api('/api/diagnostics/ffmpeg', { silent: true });
      const report = data.report || {};
      out.textContent = JSON.stringify(report, null, 2);
      toast(report.ok ? 'ffmpeg diagnostics: ok' : 'ffmpeg diagnostics found a problem — see the report', report.ok ? 'ok' : 'warn');
    } catch (error) {
      out.textContent = error.message;
    }
  });
  $('#btn-cs-save')?.addEventListener('click', async () => {
    const id = $('#cs-id').value.trim();
    const home = $('#cs-home').value.trim();
    if (!/^[a-z0-9._-]+$/i.test(id) || !home) {
      toast('An id without spaces and a home URL are required', 'warn');
      return;
    }
    try {
      await api('/api/sources', {
        method: 'POST',
        body: {
          id,
          name: $('#cs-name').value.trim() || id,
          home,
          kind: 'browser',
          search: { url: $('#cs-search').value.trim() || `${home.replace(/\/$/, '')}/search/{query}` },
          resolve: { kind: 'browser' },
          enabled: true,
        },
      });
      toast('Custom source saved — it appears in the Search tab', 'ok');
      $('#cs-id').value = ''; $('#cs-name').value = ''; $('#cs-home').value = ''; $('#cs-search').value = '';
      await loadSources();
    } catch (error) { toast(error.message, 'err'); }
  });
}

/* ====================================================================== *
 * mobile — the same workflow, phone-sized
 * ====================================================================== */

async function initMobile() {
  await VMPlaylist.load().catch(() => {});
  // Mobile source selection — mirrors desktop but lives in state.mobile.selectedSources
  if (!Array.isArray(state.mobile.selectedSources)) state.mobile.selectedSources = [];
  try {
    const { sources } = await api('/api/sources', { silent: true });
    if (sources?.length) {
      state.sources = sources;
      if (!state.mobile.selectedSources.length) {
        state.mobile.selectedSources = sources.filter((s) => s.enabled).map((s) => s.id);
      }
      renderMobSourceChips();
    }
  } catch {}
  renderMobileSourceLinks();
  $('#btn-mob-search')?.addEventListener('click', mobileSearch);
  $('#btn-mob-discover')?.addEventListener('click', () => openDiscoveryModal('mobile'));
  $('#mob-q')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') mobileSearch(); });
  $('#mob-sources')?.addEventListener('change', () => {
    const v = $('#mob-sources')?.value;
    if (v === 'all') {
      state.mobile.selectedSources = state.sources.map((s) => s.id);
    } else if (v === 'enabled') {
      state.mobile.selectedSources = state.sources.filter((s) => s.enabled).map((s) => s.id);
    }
    // custom keeps current selection
    renderMobSourceChips();
  });
  $('#mob-source-chips')?.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip || !chip.dataset.id) return;
    const id = chip.dataset.id;
    const cur = state.mobile.selectedSources || [];
    state.mobile.selectedSources = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    // If user manually toggles, mark select as custom
    const sel = $('#mob-sources');
    if (sel) sel.value = 'custom';
    renderMobSourceChips();
  });
  $('#btn-mob-sources-all')?.addEventListener('click', () => {
    state.mobile.selectedSources = state.sources.map((s) => s.id);
    const sel = $('#mob-sources');
    if (sel) sel.value = 'all';
    renderMobSourceChips();
  });
  $('#btn-mob-sources-enabled')?.addEventListener('click', () => {
    state.mobile.selectedSources = state.sources.filter((s) => s.enabled).map((s) => s.id);
    const sel = $('#mob-sources');
    if (sel) sel.value = 'enabled';
    renderMobSourceChips();
  });
  $('#mob-results')?.addEventListener('click', (event) => {
    const metaBtn = event.target.closest('[data-mob-meta]');
    if (metaBtn) {
      const group = state.mobile.results.find((c) => c.key === metaBtn.dataset.mobMeta);
      if (group) openSearchMetadata(group);
      return;
    }
    const previewBtn = event.target.closest('[data-mob-preview]');
    if (previewBtn) {
      const group = state.mobile.results.find((c) => c.key === previewBtn.dataset.mobPreview);
      if (group) previewGroup(group, previewBtn);
      return;
    }
    // A provider chip: only that provider's formats. The row itself: all of them.
    const provider = event.target.closest('[data-mprovider]');
    if (provider) {
      const row = provider.closest('[data-mgroup]');
      const group = state.mobile.results.find((candidate) => candidate.key === row?.dataset.mgroup);
      mobileSelect(group, { sourceId: provider.dataset.mprovider || '' });
      return;
    }
    const card = event.target.closest('[data-mgroup]');
    if (!card) return;
    const group = state.mobile.results.find((candidate) => candidate.key === card.dataset.mgroup);
    mobileSelect(group);
  });
  $('#mob-formats')?.addEventListener('click', (event) => {
    const scope = event.target.closest('[data-mscope-provider]');
    if (scope) {
      mobileSelect(state.mobile.group, { sourceId: scope.dataset.mscopeProvider || '' });
      return;
    }
    // Series picker: same data attributes as the Search tab's picker, scoped
    // here to the Mobile tab's own formats container.
    const seriesQuality = event.target.closest('[data-series-add-quality]');
    if (seriesQuality) {
      mobAddQuality(seriesQuality.dataset.seriesAddQuality, seriesQuality);
      return;
    }
    const seriesBest = event.target.closest('[data-series-add-best]');
    if (seriesBest) {
      const [season, episode] = String(seriesBest.dataset.seriesAddBest).split(':').map(Number);
      mobAddEpisodeBest(season, episode, seriesBest);
      return;
    }
    const seriesAdd = event.target.closest('[data-series-add]');
    if (seriesAdd) {
      const [season, episode, index] = String(seriesAdd.dataset.seriesAdd).split(':');
      const group = state.mobile.series?.episodes.get(seriesKey(season, episode));
      const candidate = group?.candidates?.[Number(index)];
      if (candidate) mobAddSeriesCandidate(candidate, Number(season), Number(episode), seriesAdd);
      return;
    }
    const seriesLoad = event.target.closest('[data-series-load]');
    if (seriesLoad) {
      const [season, episode] = String(seriesLoad.dataset.seriesLoad).split(':').map(Number);
      const group = state.mobile.series?.episodes.get(seriesKey(season, episode));
      if (group) group.open = true;
      mobLoadSeriesEpisode(season, episode);
      return;
    }
    const seriesReload = event.target.closest('[data-series-reload]');
    if (seriesReload) {
      const [season, episode] = String(seriesReload.dataset.seriesReload).split(':').map(Number);
      mobLoadSeriesEpisode(season, episode, { force: true });
      return;
    }
    const seasonAll = event.target.closest('[data-season-all]');
    if (seasonAll) { mobSetSeasonSelection(seasonAll.dataset.seasonAll, true); return; }
    const seasonNone = event.target.closest('[data-season-none]');
    if (seasonNone) { mobSetSeasonSelection(seasonNone.dataset.seasonNone, false); return; }
    const seasonToggle = event.target.closest('[data-season-toggle]');
    if (seasonToggle) {
      const season = Number(seasonToggle.dataset.seasonToggle);
      if (state.mobile.series?.collapsed.has(season)) state.mobile.series.collapsed.delete(season);
      else state.mobile.series?.collapsed.add(season);
      mobRenderSeriesPicker();
      return;
    }
    if (event.target.closest('#mob-series-all')) { mobSetAllSeasons(true); return; }
    if (event.target.closest('#mob-series-clear')) { mobSetAllSeasons(false); return; }
    if (event.target.closest('#mob-series-load')) { mobLoadSelectedEpisodes({ announce: true }); return; }
    if (event.target.closest('#mob-manual-add')) { mobAddManualEpisodes(); return; }
    const probe = event.target.closest('[data-probe-url]');
    if (probe && probe.dataset.probeUrl) { probeUrl(probe.dataset.probeUrl); return; }
    const add = event.target.closest('[data-madd]');
    if (!add) return;
    mobileAdd(Number(add.dataset.madd));
  });
  $('#mob-formats')?.addEventListener('change', (event) => {
    const series = state.mobile.series;
    if (!series) return;
    const seasonCheck = event.target.closest('[data-season-check]');
    if (seasonCheck) {
      mobSetSeasonSelection(seasonCheck.dataset.seasonCheck, seasonCheck.checked);
      return;
    }
    const epCheck = event.target.closest('[data-ep-check]');
    if (epCheck) {
      const [season, episode] = String(epCheck.dataset.epCheck).split(':').map(Number);
      const group = series.episodes.get(seriesKey(season, episode));
      if (group) {
        group.selected = epCheck.checked;
        if (!epCheck.checked && group.status === 'loading') group.controller?.abort();
        if (!epCheck.checked) { group.status = 'idle'; group.candidates = []; group.error = null; }
      }
      mobRenderSeriesPicker();
      mobRenderSeriesCandidates();
    }
  });
  // Expanding an episode group resolves it on demand (first open only).
  $('#mob-formats')?.addEventListener('toggle', (event) => {
    const details = event.target?.closest?.('[data-ep-group]');
    if (!details || !details.open) return;
    const [season, episode] = String(details.dataset.epGroup).split(':').map(Number);
    const entry = state.mobile.series?.episodes.get(seriesKey(season, episode));
    if (entry) entry.open = true;
    if (entry && entry.status !== 'done' && entry.status !== 'loading') {
      mobLoadSeriesEpisode(season, episode);
    }
  }, true);
  $('#mob-formats')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target?.id === 'mob-manual-episodes') {
      event.preventDefault();
      mobAddManualEpisodes();
    }
  });
  $('#btn-mob-refresh')?.addEventListener('click', () => VMPlaylist.refresh().then(refreshMobile));
  $('#mob-list')?.addEventListener('change', (event) => {
    const select = event.target.closest('[data-mtpl]');
    if (!select) return;
    VMPlaylist.assignTemplate(select.dataset.mtpl, select.value).then(() => refreshMobile());
  });
  $('#mob-list')?.addEventListener('click', (event) => {
    const play = event.target.closest('[data-mob-play]');
    if (play) {
      const url = play.dataset.mobPlay;
      if (url) window.open(url, '_blank');
      return;
    }
    const rem = event.target.closest('[data-mob-remove]');
    if (rem) {
      VMPlaylist.removeItem(rem.dataset.mobRemove).then(() => refreshMobile());
      return;
    }
  });
  $('#btn-mob-sub-search')?.addEventListener('click', mobileSubtitleSearch);
  $('#mob-subs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-mattach]');
    if (!button) return;
    const result = state.mobile.subs[Number(button.dataset.mattach)];
    if (!result) return;
    button.disabled = true;
    attachSubtitle(result, { streamId: $('#mob-sub-item').value })
      .then(() => { button.textContent = '✓'; refreshMobile(); })
      .catch((error) => { toast(error.message, 'err'); button.disabled = false; });
  });
  $('#btn-mob-generate')?.addEventListener('click', () => {
    const url = state.playlist.urls?.m3u;
    if (!url) return toast('No playlist URL yet', 'warn');
    window.location.href = url;
    mobileHint('playlist .m3u handed to the browser');
  });
  $('#btn-mob-push')?.addEventListener('click', async () => {
    const log = $('#mob-push-log');
    log.classList.remove('hide');
    log.textContent = 'pushing…';
    try {
      const data = await api('/api/playlist/enigma2', { method: 'POST', body: { action: 'push' }, silent: true });
      log.textContent = data.ok ? `✓ pushed ${data.bouquet?.entries ?? 0} entries (${data.transport?.via || 'receiver'})` : `✗ ${data.error || 'push failed'}`;
      toast(data.ok ? 'Bouquet pushed to the box' : 'Push failed', data.ok ? 'ok' : 'err');
    } catch (error) {
      log.textContent = `✗ ${error.message}`;
    }
  });
  $('#btn-mob-copy-url')?.addEventListener('click', () => copyText(state.playlist.urls?.page || ''));
}

function renderMobSourceChips() {
  const host = $('#mob-source-chips');
  const count = $('#mob-sources-count');
  if (!host) return;
  const sources = state.sources || [];
  const selected = state.mobile.selectedSources || [];
  if (!sources.length) {
    host.innerHTML = '<span class="meta">no sources</span>';
    if (count) count.textContent = '';
    return;
  }
  host.innerHTML = sources.map((s) => {
    const domains = sourceHomeEntries(s).map((entry) => entry.label).join(', ');
    const details = [s.notes, domains ? `Domains: ${domains}` : ''].filter(Boolean).join(' — ');
    return `<span class="source-chip-option">
      <span class="chip ${selected.includes(s.id) ? 'on' : ''}" data-id="${escapeHtml(s.id)}" role="button" tabindex="0" title="${escapeHtml(details || s.name)}">${escapeHtml(s.name)}${s.mirrors?.length ? ` <small class="chip-count">+${s.mirrors.length}</small>` : ''}</span>
      ${sourceHomeOpenLink(s)}
    </span>`;
  }).join('');
  if (count) count.textContent = `${selected.length}/${sources.length} selected`;
  // Sync the quick select
  const sel = $('#mob-sources');
  if (sel) {
    if (selected.length === sources.length) sel.value = 'all';
    else if (selected.length === sources.filter((x) => x.enabled).length && selected.every((id) => sources.find((x) => x.id === id)?.enabled)) sel.value = 'enabled';
    else sel.value = 'custom';
  }
}

function mobileHint(text) {
  const hint = $('#mob-search-hint');
  if (hint) hint.textContent = text;
}

/**
 * The Mobile pane's version of beginSearch: the previous rows, the open title
 * and its formats must go before the request goes out — a search that takes
 * half a minute must not look like it answered with the old titles.
 */
function beginMobileSearch(query) {
  mobAbortSeriesLoads();
  state.mobile.results = [];
  state.mobile.group = null;
  state.mobile.activeSource = '';
  state.mobile.candidates = [];
  state.mobile.series = null;
  const host = $('#mob-results');
  if (host) host.innerHTML = `<div class="meta">searching “${escapeHtml(query)}”…</div>`;
  const formats = $('#mob-formats');
  if (formats) formats.innerHTML = '<div class="meta">Pick a title above — its metadata and every playable format appear here.</div>';
}

async function mobileSearch() {
  const q = ($('#mob-q')?.value || '').trim();
  if (!q) { mobileHint('type a title first'); return; }
  mobileHint('searching…');
  beginMobileSearch(q);
  const params = new URLSearchParams({ q, moviebox: 'true' });
  if ($('#mob-type')?.value) params.set('type', $('#mob-type').value);
  const selSources = state.mobile.selectedSources || [];
  if (selSources.length && selSources.length !== (state.sources||[]).length) {
    params.set('sources', selSources.join(','));
  } else if (!selSources.length) {
    // No sources selected -> fallback to enabled
    const enabled = (state.sources||[]).filter((s) => s.enabled).map((s) => s.id);
    if (enabled.length) params.set('sources', enabled.join(','));
  }
  try {
    const data = await api(`/api/find/search?${params}`, { silent: true });
    state.mobile.results = buildGroups(data.results || []).slice(0, 12);
    const host = $('#mob-results');
    host.innerHTML = state.mobile.results.length ? state.mobile.results.map((group) => {
      const providers = [...new Set(group.entries.map((entry) => entry.sourceId))];
      const poster = group.poster || group.entries.find((e) => e.poster)?.poster || '';
      return `<div class="mob-result-wrap" data-mgroup="${escapeHtml(group.key)}">
        <div class="row" style="gap:6px;align-items:flex-start">
          <button class="mob-result" style="flex-direction:row;align-items:flex-start;gap:10px;flex:1">
            ${poster ? `<img src="${escapeHtml(poster)}" alt="" style="width:54px;height:81px;object-fit:cover;border-radius:6px;flex-shrink:0" loading="lazy" onerror="this.remove()">` : '<div style="width:54px;height:81px;border-radius:6px;background:var(--card2);display:grid;place-items:center;flex-shrink:0">—</div>'}
            <span style="display:flex;flex-direction:column;gap:2px;min-width:0;text-align:left">
              <span class="mob-title">${escapeHtml(titleText(group))}</span>
              <span class="meta">${escapeHtml(group.kind)} · ${group.entries.length} format(s) from ${providers.length} provider(s)</span>
              <span class="meta" style="white-space:normal">${providers.map((id) => escapeHtml(sourceName(id))).join(', ')}</span>
            </span>
          </button>
          <button class="btn sm ghost" data-mob-meta="${escapeHtml(group.key)}" title="TMDB/IMDb metadata" style="flex-shrink:0">ⓘ</button>
        </div>
        ${providers.length > 1 ? `<div class="row mob-provider-label">${providerChipsMarkup(group, { attr: 'data-mprovider' })}</div>` : ''}
      </div>`;
    }).join('') : '<div class="meta">nothing found</div>';
    mobileHint(`${state.mobile.results.length} title(s)`);
  } catch (error) {
    mobileHint(error.message);
    const host = $('#mob-results');
    if (host) host.innerHTML = `<div class="meta">search failed — ${escapeHtml(error.message)}</div>`;
  }
}

async function mobileSelect(group, { sourceId = '' } = {}) {
  if (!group) return;
  const full = state.mobile.results.find((candidate) => candidate.key === group.key) || group;
  const entries = sourceId ? full.entries.filter((entry) => entry.sourceId === sourceId) : full.entries;
  if (!entries.length) { mobileHint(`no ${sourceName(sourceId)} format`); return; }
  mobAbortSeriesLoads();
  state.mobile.group = full;
  state.mobile.activeSource = sourceId || '';
  state.mobile.series = null;
  if (full.kind === 'series') {
    renderMobSeriesSkeleton(full, sourceId);
    mobLoadSeriesSeasons();
    return;
  }
  const host = $('#mob-formats');
  host.innerHTML = `<div class="meta">resolving ${entries.length} provider(s)${sourceId ? ` from ${escapeHtml(sourceName(sourceId))}` : ''}…</div>`;
  const collected = [];
  for (const entry of entries) {
    try {
      const data = await api('/api/find/resolve', {
        method: 'POST', silent: true,
        body: { url: entry.url, sourceId: entry.sourceId, title: entry.title, year: entry.year || null, kind: entry.kind || group.kind, probe: true, useBrowser: entry.sourceId !== 'moviebox' },
      });
      for (const candidate of data.candidates || []) collected.push({ ...candidate, _entry: entry });
    } catch { /* show what the other providers gave */ }
  }
  state.mobile.candidates = expandCandidateQualities(collected);
  const providerCount = new Set(full.entries.map((entry) => entry.sourceId)).size;
  const baseHtml = `
    <div class="mob-head"><b>${escapeHtml(titleText(full))}</b>
      <span class="meta">${escapeHtml(full.kind)} · ${sourceId ? `formats from ${escapeHtml(sourceName(sourceId))} only` : `formats from all ${providerCount} provider(s)`} · pick a quality to add it to the playlist</span></div>
    <div id="mob-enriched" class="meta" style="margin:6px 0">loading TMDB/IMDb…</div>
    ${providerCount > 1 ? `<div class="row mob-provider-label">${providerChipsMarkup(full, { activeSource: sourceId, attr: 'data-mscope-provider', all: true })}</div>` : ''}
    ${state.mobile.candidates.filter((candidate) => candidate.ok !== false).map((candidate) => {
      const index = state.mobile.candidates.indexOf(candidate);
      return `<button class="mob-format" data-madd="${index}">
        <span>${escapeHtml(candidate.quality || candidate.label || 'format')}</span>
        <span class="meta">${escapeHtml(sourceName(candidate.sourceId || candidate._entry?.sourceId))}${candidate.probe?.video ? ` · ${escapeHtml(` ${candidate.probe.video.width}×${candidate.probe.video.height}`)}` : ''}</span>
      </button>`;
    }).join('') || '<div class="meta">no playable formats</div>'}`;
  host.innerHTML = baseHtml;
  fillMobileEnriched(host, full);
}

function fillMobileEnriched(host, full) {
  // Enrich async
  fetchEnrichedSearch(full).then((enriched)=>{
    const eh = host.querySelector('#mob-enriched');
    if (!eh) return;
    if (!enriched || (!enriched.tmdb && !enriched.omdb)) {
      eh.textContent = 'No TMDB/IMDb — add API key in Settings → Metadata';
      return;
    }
    const tmdb = enriched.tmdb;
    const omdb = enriched.omdb;
    const parts = [];
    if (tmdb?.overview) parts.push(`<div style="margin:4px 0">${escapeHtml(tmdb.overview.slice(0,280))}${tmdb.overview.length>280?'…':''}</div>`);
    if (tmdb?.genres?.length) parts.push(`<div class="meta">Genres: ${escapeHtml(tmdb.genres.join(', '))}</div>`);
    if (tmdb?.rating) parts.push(`<div class="meta">TMDB ★ ${tmdb.rating} (${tmdb.votes||0})</div>`);
    if (omdb?.imdbRating) parts.push(`<div class="meta">IMDb ★ ${omdb.imdbRating}</div>`);
    if (tmdb?.director?.length) parts.push(`<div class="meta">Director: ${escapeHtml(tmdb.director.join(', '))}</div>`);
    const links = [];
    if (tmdb?.tmdbUrl) links.push(`<a href="${escapeHtml(tmdb.tmdbUrl)}" target="_blank" rel="noreferrer">TMDB ↗</a>`);
    if (tmdb?.imdbUrl||omdb?.imdbUrl) links.push(`<a href="${escapeHtml(tmdb?.imdbUrl||omdb?.imdbUrl)}" target="_blank" rel="noreferrer">IMDb ↗</a>`);
    if (links.length) parts.push(`<div class="row" style="gap:6px;margin-top:4px">${links.join(' · ')}</div>`);
    eh.innerHTML = parts.join('') || 'No extra metadata';
  }).catch(()=>{ const eh=host.querySelector('#mob-enriched'); if(eh) eh.textContent='TMDB/IMDb failed'; });
}

async function mobileAdd(index) {
  const candidate = state.mobile.candidates[index];
  const group = state.mobile.group;
  if (!candidate || !group) return;
  const entry = candidate._entry || {};
  try {
    await api('/api/streams', {
      method: 'POST',
      body: {
        title: group.title,
        year: entry.year || group.year || null,
        kind: entry.kind || group.kind || 'movie',
        poster: group.poster || entry.poster || '',
        description: entry.description || '',
        sourceId: candidate.sourceId || entry.sourceId || '',
        candidate: { url: candidate.url, quality: candidate.quality, label: candidate.label, sourceId: candidate.sourceId || entry.sourceId, kind: candidate.kind, headers: candidate.headers, variants: candidate.variants, probe: candidate.probe },
      },
    });
    await VMPlaylist.refresh({ render: false });
    refreshMobile();
    toast(`“${group.title}” added to the playlist`, 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
}

/* ---------------- mobile series picker (same cards as the Search tab) ----------------
 *
 * A series selected on the Mobile tab gets the same picker as the Search tab:
 * one card per season with episode pills above the formats, then the
 * quality-first matrix plus one collapsible per-episode group resolved on
 * demand when expanded. The card/group/matrix markup is shared
 * (seasonCardMarkup / seriesMatrixMarkup / seriesEpisodeGroupMarkup); only the
 * state (state.mobile.series) and the add path (mobile group instead of the
 * Search selection) are mobile-specific.
 */

function mobAbortSeriesLoads() {
  const series = state.mobile.series;
  if (!series) return;
  for (const group of series.episodes.values()) {
    try { group.controller?.abort(); } catch { /* already settled */ }
    if (group.status === 'loading') group.status = 'idle';
  }
  series.loadingAll = false;
  series.seq = (series.seq || 0) + 1;
}

/** Provider entries for the mobile series loads, honoring the scope chips. */
function mobSeriesEntries() {
  const group = state.mobile.group;
  if (!group) return [];
  const scope = state.mobile.activeSource || '';
  return scope
    ? (group.entries || []).filter((entry) => entry.sourceId === scope)
    : (group.entries || []);
}

function mobSeriesEpisodeKey() {
  const group = state.mobile.group;
  return `${group?.key || ''}|${state.mobile.activeSource || ''}`;
}

function mobSeriesSelectedEpisodes() {
  const series = state.mobile.series;
  if (!series) return [];
  return [...series.episodes.values()]
    .filter((group) => group.selected)
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
}

function mobSeriesLoadedEpisodes() {
  return mobSeriesSelectedEpisodes().filter((group) => group.status === 'done' && (group.candidates || []).length);
}

function renderMobSeriesSkeleton(full, sourceId) {
  const host = $('#mob-formats');
  const providerCount = new Set((full.entries || []).map((entry) => entry.sourceId)).size;
  host.innerHTML = `
    <div class="mob-head"><b>${escapeHtml(titleText(full))}</b>
      <span class="meta">${escapeHtml(full.kind)} · ${sourceId ? `formats from ${escapeHtml(sourceName(sourceId))} only` : `formats from all ${providerCount} provider(s)`} · tick episodes below, expand one to load it</span></div>
    <div id="mob-enriched" class="meta" style="margin:6px 0">loading TMDB/IMDb…</div>
    ${providerCount > 1 ? `<div class="row mob-provider-label">${providerChipsMarkup(full, { activeSource: sourceId, attr: 'data-mscope-provider', all: true })}</div>` : ''}
    <div class="series-picker">
      <div class="series-picker-head"><b>Seasons &amp; episodes</b><span class="mut" id="mob-series-source"></span></div>
      <div id="mob-seasons" class="season-cards"><div class="meta"><span class="spin"></span> loading seasons…</div></div>
      <div id="mob-series-manual" class="series-manual hide">
        <div class="field"><label for="mob-manual-season">Season</label><input id="mob-manual-season" type="number" min="0" value="1"></div>
        <div class="field"><label for="mob-manual-episodes">Episodes (e.g. 1-8)</label><input id="mob-manual-episodes" placeholder="1-8"></div>
        <button type="button" class="btn sm pri" id="mob-manual-add">add</button>
      </div>
      <div class="row series-picker-actions">
        <button type="button" class="btn sm ghost" id="mob-series-all">✓ all</button>
        <button type="button" class="btn sm ghost" id="mob-series-clear">✕ clear</button>
        <button type="button" class="btn sm pri" id="mob-series-load">⤓ load selected</button>
        <span class="mut" id="mob-series-summary"></span>
      </div>
      <div id="mob-series-status" class="meta episode-status" role="status" aria-live="polite"></div>
    </div>
    <div id="mob-series-formats"></div>`;
  fillMobileEnriched(host, full);
}

async function mobLoadSeriesSeasons() {
  const full = state.mobile.group;
  if (!full || full.kind !== 'series') return;
  const subjectEntry = (full.entries || []).find((entry) => entry.movieboxSubjectId);
  const series = newSeriesState({ key: full.key, movieboxSubjectId: subjectEntry?.movieboxSubjectId || null });
  state.mobile.series = series;
  const seq = ++series.seq;
  mobRenderSeriesCandidates();
  try {
    const params = new URLSearchParams({ title: full.title || '' });
    if (full.year) params.set('year', String(full.year));
    if (series.subjectId) params.set('subjectId', series.subjectId);
    const meta = (full.entries || []).find((entry) => entry.imdbId || entry.tmdbId) || {};
    if (meta.tmdbId) params.set('tmdbId', meta.tmdbId);
    if (meta.imdbId) params.set('imdbId', meta.imdbId);
    const data = await api(`/api/find/series?${params}`, { silent: true });
    if (state.mobile.series !== series || seq !== series.seq) return;
    series.source = data.source || 'none';
    series.seasons = Array.isArray(data.seasons) ? data.seasons : [];
    series.subjectId = data.subjectId || series.subjectId;
    series.tmdbId = data.tmdbId || null;
    series.errors = Array.isArray(data.errors) ? data.errors : [];
    if (!series.seasons.length) {
      mobRenderSeriesManual();
      return;
    }
    // Default: first season, all episodes selected — the first episode group
    // auto-loads so the formats area is not empty.
    const firstSeason = series.seasons[0];
    for (const entry of series.seasons) {
      for (const ep of entry.episodes || []) {
        series.episodes.set(seriesKey(entry.season, ep.episode), {
          season: entry.season,
          episode: ep.episode,
          name: ep.name || '',
          airDate: ep.airDate || null,
          selected: entry.season === firstSeason.season,
          status: 'idle',
          candidates: [],
          error: null,
          controller: null,
          open: entry.season === firstSeason.season && ep.episode === (entry.episodes[0]?.episode ?? 1),
        });
      }
    }
    mobRenderSeriesPicker();
    mobRenderSeriesCandidates();
    const first = mobSeriesSelectedEpisodes()[0];
    if (first) mobLoadSeriesEpisode(first.season, first.episode);
  } catch (error) {
    if (state.mobile.series !== series) return;
    series.source = 'none';
    series.errors = [{ source: 'series', error: error.message }];
    mobRenderSeriesManual();
  }
}

/** No season source answered: manual season/episode number inputs. */
function mobRenderSeriesManual() {
  const series = state.mobile.series;
  $('#mob-series-source').textContent = 'manual entry';
  const host = $('#mob-seasons');
  if (host) {
    const reasons = (series?.errors || []).map((entry) => `${entry.source}: ${entry.error}`).join(' · ');
    host.innerHTML = `<div class="meta">No season list available${reasons ? ` — ${escapeHtml(reasons)}` : ''}. Add episodes by hand:</div>`;
  }
  $('#mob-series-manual')?.classList.remove('hide');
  mobUpdateSeriesSummary();
  mobRenderSeriesCandidates();
}

function mobAddManualEpisodes() {
  const series = state.mobile.series;
  if (!series) return;
  const season = Number($('#mob-manual-season')?.value) || 0;
  const episodes = parseEpisodeList($('#mob-manual-episodes')?.value);
  if (!season || !episodes.length) {
    toast('Enter a season and at least one episode (e.g. 1-8)', 'warn');
    return;
  }
  if (!series.seasons.some((entry) => entry.season === season)) {
    series.seasons.push({ season, name: `Season ${season}`, episodeCount: 0, episodes: [] });
    series.seasons.sort((a, b) => a.season - b.season);
  }
  const seasonEntry = series.seasons.find((entry) => entry.season === season);
  for (const episode of episodes) {
    const key = seriesKey(season, episode);
    if (!series.episodes.has(key)) {
      series.episodes.set(key, {
        season, episode, name: '', airDate: null,
        selected: true, status: 'idle', candidates: [], error: null, controller: null, open: false,
      });
    } else {
      series.episodes.get(key).selected = true;
    }
    if (!seasonEntry.episodes.some((item) => item.episode === episode)) {
      seasonEntry.episodes.push({ episode, name: `Episode ${episode}` });
      seasonEntry.episodes.sort((a, b) => a.episode - b.episode);
    }
  }
  if (series.source === 'none') series.source = 'manual';
  $('#mob-manual-episodes').value = '';
  mobRenderSeriesPicker();
  mobRenderSeriesCandidates();
  mobUpdateSeriesSummary();
}

function mobRenderSeriesPicker() {
  const series = state.mobile.series;
  const host = $('#mob-seasons');
  if (!series || !host) return;
  const sourceLabel = {
    moviebox: 'MovieBox', tmdb: 'TMDB', manual: 'manual', loading: '…', none: 'manual entry',
  }[series.source] || series.source;
  $('#mob-series-source').textContent = series.seasons.length
    ? `${sourceLabel} · ${series.seasons.length} season(s)`
    : sourceLabel;
  $('#mob-series-manual')?.classList.toggle('hide', series.source !== 'none' && series.source !== 'manual');
  host.innerHTML = series.seasons.map((entry) => seasonCardMarkup(series, entry)).join('') || '<div class="meta">No seasons listed.</div>';
  mobUpdateSeriesSummary();
}

function mobUpdateSeriesSummary() {
  const series = state.mobile.series;
  const host = $('#mob-series-summary');
  if (!host) return;
  if (!series) { host.textContent = ''; return; }
  const selected = mobSeriesSelectedEpisodes();
  const loaded = selected.filter((group) => group.status === 'done').length;
  const loading = selected.filter((group) => group.status === 'loading').length;
  host.textContent = selected.length
    ? `${selected.length} episode(s) selected · ${loaded} loaded${loading ? ` · ${loading} loading` : ''}`
    : 'nothing selected';
}

function mobSetSeasonSelection(season, selected) {
  const series = state.mobile.series;
  if (!series) return;
  for (const group of series.episodes.values()) {
    if (group.season === Number(season)) group.selected = selected;
  }
  mobRenderSeriesPicker();
  mobRenderSeriesCandidates();
}

function mobSetAllSeasons(selected) {
  const series = state.mobile.series;
  if (!series) return;
  for (const group of series.episodes.values()) group.selected = selected;
  mobRenderSeriesPicker();
  mobRenderSeriesCandidates();
}

/**
 * Resolve one S/E across the mobile result's (scoped) provider entries.
 * Cached: a loaded episode is not re-resolved unless `force`. Renders
 * progressively — each provider's answer appears as soon as it arrives.
 */
async function mobLoadSeriesEpisode(season, episode, { force = false } = {}) {
  const group = state.mobile.group;
  const series = state.mobile.series;
  if (!group || !series) return;
  const key = seriesKey(season, episode);
  const ep = series.episodes.get(key);
  if (!ep || !ep.selected) return;
  if (ep.status === 'loading') return;
  if (ep.status === 'done' && !force && ep.scopeKey === mobSeriesEpisodeKey()) {
    mobRenderSeriesCandidates();
    return;
  }
  ep.controller?.abort();
  const controller = new AbortController();
  ep.controller = controller;
  ep.status = 'loading';
  ep.error = null;
  ep.candidates = [];
  ep.scopeKey = mobSeriesEpisodeKey();
  mobRenderSeriesCandidates();
  mobUpdateSeriesSummary();
  const status = $('#mob-series-status');
  const entries = mobSeriesEntries();
  const collected = [];
  const errors = [];
  let finished = 0;
  const render = () => {
    if (state.mobile.series !== series || ep.controller !== controller) return;
    ep.candidates = expandCandidateQualities(collected);
    mobRenderSeriesCandidates();
    const playable = ep.candidates.filter((candidate) => candidate.ok !== false).length;
    if (status) {
      status.textContent = finished < entries.length
        ? `${seriesLabel(season, episode)}: resolving ${finished}/${entries.length} provider(s) · ${playable} format(s) ready…`
        : `${seriesLabel(season, episode)}: ${playable}/${ep.candidates.length} playable`;
    }
  };
  await Promise.all(entries.map(async (entry) => {
    if (controller.signal.aborted) return;
    try {
      const data = await api('/api/find/resolve', {
        method: 'POST',
        silent: true,
        signal: controller.signal,
        body: {
          url: entry.url,
          sourceId: entry.sourceId,
          title: entry.title || group.title,
          year: entry.year || group.year || null,
          kind: entry.kind || group.kind || 'series',
          season, episode,
          probe: true,
          useBrowser: entry.sourceId !== 'moviebox',
        },
      });
      if (controller.signal.aborted) return;
      for (const candidate of data.candidates || []) {
        collected.push({
          ...candidate,
          season, episode,
          sourceId: candidate.sourceId || entry.sourceId,
          _entry: entry,
        });
      }
      if (data.error) errors.push(data.error);
    } catch (error) {
      if (error?.name !== 'AbortError') errors.push(`${sourceName(entry.sourceId)}: ${error.message}`);
    } finally {
      finished += 1;
      render();
    }
  }));
  if (state.mobile.series !== series || ep.controller !== controller) return;
  ep.status = errors.length && !collected.length ? 'error' : 'done';
  ep.error = ep.status === 'error' ? errors[0] : (errors.length ? `${errors.length} provider(s) failed` : null);
  ep.candidates = expandCandidateQualities(collected);
  ep.controller = null;
  mobRenderSeriesCandidates();
  mobUpdateSeriesSummary();
}

/** Resolve every selected episode with a small concurrency (browser sniffs are slow). */
async function mobLoadSelectedEpisodes({ announce = false, force = false } = {}) {
  const series = state.mobile.series;
  if (!series) return;
  const queue = mobSeriesSelectedEpisodes().filter((group) =>
    force || (group.status !== 'done' && group.status !== 'loading'));
  if (!queue.length) {
    if (announce) toast('Every selected episode is already loaded', 'info', 3000);
    return;
  }
  if (queue.length > 25) {
    toast(`Loading ${queue.length} episodes — each browser-source episode costs a full page sniff`, 'warn', 8000);
  }
  series.loadingAll = true;
  mobUpdateSeriesSummary();
  let index = 0;
  const workers = Array.from({ length: Math.min(SERIES_LOAD_CONCURRENCY, queue.length) }, async () => {
    while (index < queue.length && state.mobile.series === series && series.loadingAll) {
      const next = queue[index++];
      await mobLoadSeriesEpisode(next.season, next.episode, { force });
    }
  });
  await Promise.all(workers);
  if (state.mobile.series !== series) return;
  series.loadingAll = false;
  mobUpdateSeriesSummary();
  if (announce) {
    const loaded = mobSeriesLoadedEpisodes().length;
    toast(loaded ? `${loaded} episode(s) loaded` : 'No episode formats resolved', loaded ? 'ok' : 'warn');
  }
}

/** Mobile formats area for a series: quality matrix + per-episode groups. */
function mobRenderSeriesCandidates() {
  const series = state.mobile.series;
  const group = state.mobile.group;
  const host = $('#mob-series-formats');
  if (!host) return;
  if (!group || group.kind !== 'series' || !series) return;
  const selected = mobSeriesSelectedEpisodes();
  if (series.source === 'loading') {
    host.innerHTML = '<div class="meta"><span class="spin"></span> loading seasons…</div>';
    return;
  }
  if (!selected.length) {
    host.innerHTML = '<div class="meta">Tick episodes above — each one resolves on demand when expanded.</div>';
    return;
  }
  const rows = seriesMatrixRows(mobSeriesLoadedEpisodes());
  const loadedCount = mobSeriesLoadedEpisodes().length;
  host.innerHTML = `
    ${rows.length ? seriesMatrixMarkup(rows, selected.length, loadedCount) : `<div class="meta">No episode loaded yet — expand one below or press “load selected”. ${selected.length} episode(s) selected.</div>`}
    <div class="episode-groups">
      ${selected.map((ep) => seriesEpisodeGroupMarkup(ep, mobSeriesEntries().length)).join('')}
    </div>`;
}

/** Mobile counterpart of addCandidateToPlaylist: adds from the mobile group. */
async function mobAddSeriesCandidate(candidate, season, episode, button = null) {
  const group = state.mobile.group;
  if (!candidate || !group) return null;
  const entry = candidate._entry || {};
  if (button) button.disabled = true;
  try {
    const se = Number(season ?? candidate.season) || null;
    const ep = Number(episode ?? candidate.episode) || null;
    const data = await api('/api/streams', {
      method: 'POST',
      body: {
        title: se && ep ? `${group.title} ${seriesLabel(se, ep)}` : group.title,
        year: entry.year || group.year || null,
        kind: entry.kind || group.kind || 'series',
        poster: group.poster || entry.poster || '',
        description: entry.description || '',
        sourceId: candidate.sourceId || entry.sourceId || '',
        candidate: {
          url: candidate.url,
          quality: candidate.quality,
          label: candidate.label,
          sourceId: candidate.sourceId || entry.sourceId,
          kind: candidate.kind,
          headers: candidate.headers,
          variants: candidate.variants,
          probe: candidate.probe,
        },
        season: se,
        episode: ep,
      },
    });
    await VMPlaylist.refresh({ render: false });
    refreshMobile();
    toast(`Added “${data.stream.title}” to the playlist`, 'ok');
    if (button) button.textContent = '✓ added';
    return data.stream;
  } catch (error) {
    toast(error.message, 'err');
    if (button) button.disabled = false;
    return null;
  }
}

/** Add the single best playable candidate of one mobile episode. */
async function mobAddEpisodeBest(season, episode, button = null) {
  const series = state.mobile.series;
  const group = series?.episodes.get(seriesKey(season, episode));
  if (!group?.candidates?.length) return;
  const best = [...group.candidates]
    .filter((c) => c.ok !== false)
    .sort((a, b) => seriesQualityHeight(seriesQualityKey(b)) - seriesQualityHeight(seriesQualityKey(a)))[0]
    || group.candidates[0];
  if (button) button.disabled = true;
  try {
    await mobAddSeriesCandidate(best, season, episode, button);
  } finally {
    mobRenderSeriesCandidates();
  }
}

/** Bulk add: one playlist item per episode for the given quality row. */
async function mobAddQuality(quality, button = null) {
  const series = state.mobile.series;
  if (!series) return;
  const rows = seriesMatrixRows(mobSeriesLoadedEpisodes());
  const row = rows.find((candidate) => candidate.quality === quality);
  if (!row) return;
  if (button) button.disabled = true;
  toast(`Adding ${row.episodes.length} episode(s) in ${quality}…`, 'info', 4000);
  let added = 0;
  let failed = 0;
  try {
    for (const { season, episode } of row.episodes) {
      const group = series.episodes.get(seriesKey(season, episode));
      const candidate = (group?.candidates || []).find((c) => seriesQualityKey(c) === quality && c.ok !== false)
        || (group?.candidates || []).find((c) => seriesQualityKey(c) === quality);
      if (!candidate) { failed += 1; continue; }
      const stream = await mobAddSeriesCandidate(candidate, season, episode);
      if (stream) added += 1; else failed += 1;
    }
  } finally {
    if (button) button.disabled = false;
  }
  toast(added ? `Added ${added} episode(s) in ${quality}${failed ? ` (${failed} failed)` : ''}` : `Nothing added in ${quality}`, added ? 'ok' : 'warn');
  mobRenderSeriesCandidates();
}

function refreshMobile() {
  const host = $('#mob-list');
  const summary = $('#mob-list-summary');
  const items = VMPlaylist.items();
  if (summary) summary.textContent = `${items.filter((item) => item.enabled).length}/${items.length} enabled`;
  if (!host) return;
  if (!items.length) {
    host.innerHTML = '<div class="meta">the playlist is empty — search above and pick a format</div>';
  } else {
    host.innerHTML = items.map((item) => {
      const poster = item.poster || '';
      const watchUrl = item.urls?.watch || '';
      const tsUrl = item.urls?.ts || '';
      return `
      <div class="mob-item" style="gap:10px">
        ${poster ? `<img src="${escapeHtml(poster)}" alt="" style="width:48px;height:72px;object-fit:cover;border-radius:6px;flex-shrink:0" loading="lazy" onerror="this.remove()">` : '<div style="width:48px;height:72px;border-radius:6px;background:var(--card2);display:grid;place-items:center;flex-shrink:0">—</div>'}
        <div class="mob-item-main">
          <div class="mob-title">${escapeHtml(item.title)}${item.year ? ` <span class="mut">(${item.year})</span>` : ''}</div>
          <div class="meta">${escapeHtml(item.quality || '')} ${item.subtitlePath ? tag(item.subtitleLanguage || 'sub', 'ok') : ''} ${item.enabled ? '' : '<span class="tag warn">off</span>'}</div>
          <div class="row" style="margin-top:6px;gap:6px">
            <button class="btn sm pri" data-mob-play="${escapeHtml(watchUrl || tsUrl)}" title="stream on your mobile">▶ stream</button>
            <button class="btn sm ghost" data-mob-remove="${escapeHtml(item.streamId)}" title="remove from playlist">⊖</button>
          </div>
        </div>
        <select class="mob-tpl" data-mtpl="${escapeHtml(item.streamId)}" aria-label="FFmpeg template for ${escapeHtml(item.title)}" title="FFmpeg template">
          <option value="">guided builder</option>
          ${VMPlaylist.templates().map((tpl) => `<option value="${escapeHtml(tpl.id)}"${(item.templateId || item.profileTemplateId) === tpl.id ? ' selected' : ''}>${escapeHtml(tpl.name)}</option>`).join('')}
        </select>
      </div>`;
    }).join('');
  }
  const select = $('#mob-sub-item');
  if (select) {
    const previous = select.value;
    select.innerHTML = items.map((item) => `<option value="${escapeHtml(item.streamId)}">${escapeHtml(item.title)}</option>`).join('') || '<option value="">(playlist empty)</option>';
    if (items.some((item) => item.streamId === previous)) select.value = previous;
  }
  const hint = $('#mob-output-hint');
  if (hint) hint.textContent = state.playlist.urls?.m3u ? `${items.filter((item) => item.enabled).length} item(s) in the outputs` : '';
  $('#btn-mob-copy-url')?.classList.toggle('hide', !state.playlist.urls?.page);
}

async function mobileSubtitleSearch() {
  const streamId = $('#mob-sub-item')?.value;
  if (!streamId) { toast('The playlist is empty', 'warn'); return; }
  const item = VMPlaylist.itemFor(streamId);
  const host = $('#mob-subs');
  host.innerHTML = '<div class="meta">searching…</div>';
  try {
    const data = await api('/api/subtitles/search', {
      method: 'POST', silent: true,
      body: { streamId, title: item?.title, year: item?.year || null, kind: item?.kind || 'movie', season: item?.season || null, episode: item?.episode || null },
    });
    const filter = $('#mob-sub-lang')?.value || 'nl';
    const results = (data.results || []).filter((result) => filter === 'all' || (result.language || '').startsWith(filter));
    state.mobile.subs = results;
    host.innerHTML = results.length ? results.slice(0, 25).map((result, index) => `
      <div class="mob-sub">
        <div><b>${escapeHtml(result.language || '??')}</b> <span class="meta">${escapeHtml(result.providerId || '')}</span>
          <div class="meta">${escapeHtml(result.release || result.title || '')}</div></div>
        <button class="btn sm pri" data-mattach="${index}">attach</button>
      </div>`).join('') : '<div class="meta">nothing found for this language</div>';
  } catch (error) {
    host.innerHTML = `<div class="meta">${escapeHtml(error.message)}</div>`;
  }
}

/* ====================================================================== *
 * bootstrap
 * ====================================================================== */

/* ---------------- sidebar: mini (icons) / pinned (icons + labels) ---------------- */

const NAV_PIN_KEY = 'vu-movie.nav-pinned';

function initSidebar() {
  const app = $('.app');
  const button = $('#btn-nav-pin');
  const apply = (pinned) => {
    app.classList.toggle('nav-mini', !pinned);
    app.classList.toggle('nav-pinned', pinned);
    if (button) {
      button.textContent = pinned ? '⇤' : '⇥';
      button.title = pinned ? 'unpin — collapse to icons (hover expands)' : 'pin the large menu';
      button.setAttribute('aria-pressed', pinned ? 'true' : 'false');
      button.classList.toggle('on', pinned);
    }
    writeStoredText(NAV_PIN_KEY, pinned ? '1' : '0');
  };
  apply(readStoredText(NAV_PIN_KEY) === '1');
  button?.addEventListener('click', () => apply(!app.classList.contains('nav-pinned')));
}

/* ---------------- collapsible panes (the mobile sub-panes) ---------------- */

/**
 * Where a pane remembers that it was opened or closed.
 *
 * `.v2`: the Mobile tab's five panes now start **collapsed** (they are the five
 * steps of one workflow, and a phone should show the steps, not their forms).
 * A preference stored under the old key says "everything open" — it would
 * silently undo that default — so the key is bumped once; choices made from now
 * on are remembered again.
 */
const FOLD_KEY = 'vu-movie.folded.v2';

function foldedState() {
  const stored = readStoredJson(FOLD_KEY);
  return stored && typeof stored === 'object' ? stored : {};
}

/** Open/close one pane: body, glyph, aria and title move together. */
function setFold(button, folded, persist = true) {
  const key = button.dataset.fold;
  const body = $(`[data-fold-body="${key}"]`);
  if (!body) return;
  body.classList.toggle('hide', folded);
  button.textContent = folded ? '▸' : '▾';
  button.setAttribute('aria-expanded', folded ? 'false' : 'true');
  button.title = folded ? 'show this pane' : 'hide this pane';
  if (persist) writeStoredText(FOLD_KEY, JSON.stringify({ ...foldedState(), [key]: folded }));
  syncFoldAll();
}

/** Every foldable pane of the Mobile tab (the only tab that has them today). */
const mobileFoldButtons = () => $$('#p-mobile .foldbtn[data-fold]');

/** Keep the “collapse all / expand all” button in step with the panes. */
function syncFoldAll() {
  const button = $('#btn-mob-fold');
  if (!button) return;
  const buttons = mobileFoldButtons();
  const folded = buttons.filter((entry) => entry.getAttribute('aria-expanded') !== 'true').length;
  const allFolded = buttons.length > 0 && folded === buttons.length;
  button.textContent = allFolded ? '▾ expand all' : '▸ collapse all';
  button.title = allFolded ? 'open every pane of this tab' : 'close every pane of this tab';
}

function wireFolds() {
  const stored = foldedState();
  $$('.foldbtn[data-fold]').forEach((button) => {
    // The markup carries the default: a button rendered with aria-expanded
    // "false" means "this pane starts collapsed" (the five Mobile panes).
    const fallback = button.getAttribute('aria-expanded') === 'false';
    const saved = stored[button.dataset.fold];
    setFold(button, typeof saved === 'boolean' ? saved : fallback, false);
    const toggle = () => {
      const body = $(`[data-fold-body="${button.dataset.fold}"]`);
      if (body) setFold(button, !body.classList.contains('hide'));
    };
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });
    const head = button.closest('.cardhead');
    if (head) {
      head.style.cursor = 'pointer';
      head.addEventListener('click', (e) => {
        if (e.target.closest('.tip')) return;
        if (e.target.closest('.foldbtn')) return;
        toggle();
      });
    }
  });
  $('#btn-mob-fold')?.addEventListener('click', () => {
    const buttons = mobileFoldButtons();
    const allFolded = buttons.every((entry) => entry.getAttribute('aria-expanded') !== 'true');
    buttons.forEach((entry) => setFold(entry, !allFolded));
  });
  syncFoldAll();
}

function wireShell() {
  $('#nav')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-p]');
    if (button) go(button.dataset.p);
  });
  window.addEventListener('hashchange', () => {
    const page = pageFromHash();
    if (page && page !== currentPage) go(page, { hash: false });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && event.target?.matches?.('input,select,textarea')) event.target.blur();
  });
  document.addEventListener('click', (event) => {
    const hashLink = event.target.closest('a[href^="#"]');
    if (hashLink && APP_PAGES.includes(hashLink.getAttribute('href').slice(1))) {
      event.preventDefault();
      go(hashLink.getAttribute('href').slice(1));
    }
  });
}

Object.assign(App, {
  go,
  copy: copyText,
  openModal,
  closeModal,
  loadHealth,
  loadJobs,
  loadStreams,
  loadSources,
  loadFfmpegTemplates: async () => {
    const data = await api('/api/ffmpeg/templates', { silent: true });
    state.ffmpegTemplates = data.templates || [];
    state.defaultFfmpegTemplateId = data.defaultFfmpegTemplateId || '';
    state.ffmpegDefaults = data.ffmpegDefaults || {};
    state.ffmpegTemplatesLoaded = true;
    return state.ffmpegTemplates;
  },
  onTemplatesChanged: async () => {
    await VMPlaylist.refresh({ render: currentPage === 'list' }).catch(() => {});
    VMFfmpegEditor.renderLibrary();
    VMFfmpegEditor.renderTestTemplatePicker();
    if (VMFfmpegEditor.libraryEditor) VMFfmpegEditor.renderTestSources(VMFfmpegEditor.libraryEditor);
    if (currentPage === 'tpl-test') renderTestSourcePicker();
  },
  openStream: (id) => VMPlaylist.openMetadata(id, { popup: true }),
  cancelJob: async (id) => { await api(`/api/jobs/${id}/cancel`, { method: 'POST' }); loadJobs(); },
});
window.App = App;

async function bootstrap() {
  initTips();
  initSidebar();
  wireFolds();
  wireShell();
  VMPlaylist.wire();
  loadHealth();
  healthTimer = setInterval(() => {
    if (document.hidden) return;
    loadHealth();
    if (currentPage === 'dash') loadJobs();
  }, 15000);
  window.addEventListener('beforeunload', () => clearInterval(healthTimer));

  // The Mobile tab is the front door: it walks the same workflow as the desktop
  // tabs, in the order it has to be used, so the site always opens there. A
  // `#page` in the URL still wins, so deep links and bookmarks keep working.
  await go(pageFromHash() || 'mobile', { hash: false });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
else bootstrap();
