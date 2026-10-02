/* vu-movie — UI logic (no framework, no build step, one file). */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  health: null,
  sources: [],
  selectedSources: [],
  results: [],
  selected: null,
  candidates: [],
  stream: null,
  streams: [],
  providers: [],
  subResults: [],
  config: null,
  logs: [],
  jobs: [],
  sessions: [],
};

/* ---------------- tiny helpers ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = { ok: false, error: `invalid JSON (HTTP ${res.status})` }; }
  if (!res.ok || data?.ok === false) {
    const message = data?.error || `HTTP ${res.status}`;
    toast(`${path}: ${message}`, 'err');
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
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.p === page));
  $$('main > section').forEach((s) => s.classList.toggle('hide', s.id !== `p-${page}`));
  if (page === 'dash') { loadHealth(); loadJobs(); loadStreams(); }
  if (page === 'stream' && state.stream) loadStream(state.stream.id);
  if (page === 'logs') loadLogs();
  if (page === 'set') loadSettings();
  if (page === 'subs') loadProviders();
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
          ['reachable', h.enigma2?.message || '—', h.enigma2?.ok],
          ['model', h.enigma2?.model || '—', null],
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

$$('#find-tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#find-tabs button').forEach((x) => x.classList.toggle('on', x === b));
  ['title', 'url', 'browse'].forEach((t) => $(`#tab-${t}`).classList.toggle('hide', t !== b.dataset.t));
}));

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
  }));
  $('#browse-links').innerHTML = sources.map((s) => `<a class="btn sm" href="${escapeHtml(s.home)}" target="_blank" rel="noreferrer">${escapeHtml(s.name)} ↗</a>`).join('');
  renderSourceHealth();
}

async function doSearch() {
  const query = $('#q').value.trim();
  if (!query) return toast('Enter a title first', 'warn');
  $('#find-hint').innerHTML = '<span class="spin"></span> searching…';
  try {
    const params = new URLSearchParams({
      q: query,
      type: $('#q-type').value,
      sources: state.selectedSources.join(','),
      moviebox: String($('#q-moviebox').checked),
    });
    const res = await api(`/api/find/search?${params}`);
    state.results = res.results;
    $('#results-count').textContent = `${res.results.length} results`;
    renderResults();
    $('#find-hint').textContent = `${res.results.length} results`;
  } finally {
    $('#find-hint').textContent = $('#find-hint').textContent.replace(' searching…', '');
  }
}

function renderResults() {
  if (!state.results.length) {
    $('#results').innerHTML = '<div class="meta">No results. Try fewer sources, or use “Paste URL” with the movie page you have open.</div>';
    return;
  }
  $('#results').innerHTML = `<div class="grid g3">${state.results.map((r, i) => `
    <div class="moviecard" data-i="${i}">
      <div class="poster"><span class="tag ok badge">${escapeHtml(r.kind)}</span><b>${escapeHtml(r.title)}</b></div>
      <div class="meta">${r.year ? `${r.year} · ` : ''}${escapeHtml(r.sourceName)}${r.rating ? ` · ★ ${r.rating}` : ''}</div>
    </div>`).join('')}</div>`;
  $$('#results .moviecard').forEach((card) => card.addEventListener('click', () => selectResult(Number(card.dataset.i))));
}

async function selectResult(index) {
  const r = state.results[index];
  state.selected = r;
  $$('#results .moviecard').forEach((c) => c.classList.toggle('sel', Number(c.dataset.i) === index));
  $('#sel-name').textContent = `${r.title}${r.year ? ` (${r.year})` : ''}`;
  $('#sel-meta').innerHTML = `${escapeHtml(r.sourceName)} · ${escapeHtml(r.kind)}${r.url ? ` · <span class="mono">${escapeHtml(r.url.slice(0, 60))}…</span>` : ''}`;
  $('#sel-poster').innerHTML = r.poster
    ? `<img src="${escapeHtml(r.poster)}" alt="" style="width:100%;border-radius:8px">`
    : `<b>${escapeHtml(r.title)}</b>`;
  $('#sel-note').textContent = r.description || 'Resolving candidates — every URL is probed with ffprobe before it is offered.';
  $('#sel-actions').innerHTML = '';
  $('#candidates').innerHTML = '<div class="meta"><span class="spin"></span> resolving…</div>';
  await resolve({ url: r.url, title: r.title, year: r.year, kind: r.kind, sourceId: r.sourceId });
}

async function doResolveFromUrl() {
  const url = $('#u-url').value.trim();
  if (!url) return toast('Paste a URL first', 'warn');
  $('#candidates').innerHTML = '<div class="meta"><span class="spin"></span> scraping…</div>';
  await resolve({
    url,
    title: $('#u-title').value.trim() || null,
    year: Number($('#u-year').value) || null,
    kind: $('#u-kind').value,
    season: Number($('#u-season').value) || 0,
    episode: Number($('#u-episode').value) || 0,
    useBrowser: $('#u-browser').checked,
    probe: $('#u-probe').checked,
  });
}

async function resolve(payload) {
  try {
    const res = await api('/api/find/resolve', { method: 'POST', body: { ...payload, probe: payload.probe !== false } });
    state.candidates = res.candidates || [];
    renderCandidates(res);
  } catch (err) {
    $('#candidates').innerHTML = `<div class="note err">${escapeHtml(err.message)}</div>`;
  }
}

function renderCandidates(res) {
  const list = res.candidates || [];
  $('#sel-note').innerHTML = `Resolve timings: ${Object.entries(res.timeline || {}).map(([k, v]) => `${k} ${v}ms`).join(' · ') || '—'}`;
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
  $('#sel-actions').innerHTML = `<button class="btn" onclick="App.go('subs')">▭ find subtitles</button>`;
}

async function createStream(candidate) {
  const sel = state.selected || {};
  try {
    const res = await api('/api/streams', {
      method: 'POST',
      body: {
        title: sel.title || $('#u-title').value || 'Untitled',
        year: sel.year || Number($('#u-year').value) || null,
        kind: sel.kind || $('#u-kind').value,
        poster: sel.poster || null,
        description: sel.description || null,
        sourceId: candidate.sourceId,
        season: Number($('#u-season').value) || null,
        episode: Number($('#u-episode').value) || null,
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
      },
    });
    state.stream = res.stream;
    toast(`Stream created: ${res.stream.title}`, 'ok');
    renderStream(res);
    go('stream');
    loadStreams();
  } catch { /* toast shown */ }
}

/* ================= STREAM ================= */

async function openStream(id) {
  try {
    const res = await api(`/api/streams/${id}`);
    state.stream = res.stream;
    renderStream(res);
    go('stream');
  } catch { /* toast */ }
}

function renderStream(res) {
  const s = res.stream || state.stream;
  const urls = res.urls || {};
  $('#stream-empty').classList.add('hide');
  $('#stream-body').classList.remove('hide');
  $('#st-title').textContent = `${s.title}${s.year ? ` (${s.year})` : ''}`;
  $('#st-meta').innerHTML = `${tag(s.upstream?.quality || 'unknown', 'ok')} ${tag(s.upstream?.kind || 'file')} ${tag(s.source_id || s.sourceId || '—')}
    ${s.expires_at ? `<span class="mut">token until ${new Date(s.expires_at).toLocaleString()}</span>` : '<span class="mut">token never expires</span>'}`;
  $('#st-tags').innerHTML = `${tag(s.profile?.transcode ? 'transcode' : 'stream copy', s.profile?.transcode ? 'alt' : 'ok')}
    ${tag(s.profile?.encoder || 'copy')} ${tag(s.profile?.container || 'mpegts', 'info')}
    ${(s.profile?.reasons || []).slice(0, 2).map((r) => tag(r)).join('')}`;

  const rows = [
    ['VLC / any player (.ts)', urls.ts],
    ['VLC / any player (.mkv)', urls.mkv],
    ['Playlist (.m3u8)', urls.hls],
    ['Playlist (.m3u)', urls.playlist],
    ['Enigma2 / Duo2', urls.forBox],
    ['Direct upstream link (302)', urls.direct],
    ['Watch in browser', urls.watch],
  ];
  $('#st-client-urls').innerHTML = rows.map(([label, url]) => `
    <div class="field" style="flex:1;min-width:260px;margin-bottom:0">
      <label>${escapeHtml(label)}</label>
      <div class="row"><input class="mono" readonly value="${escapeHtml(url || '')}" style="flex:1">
      <button class="btn sm" onclick="App.copy('${escapeHtml(url || '')}')">copy</button></div>
    </div>`).join('');

  const p = s.profile || {};
  if (p.resolution) $('#pf-res').value = String(p.resolution);
  if (p.aspect) $('#pf-aspect').value = p.aspect === 'source' ? 'source' : p.aspect;
  if (p.container) { try { $('#pf-container').value = p.container; } catch { /* hls etc. */ } }
  if (p.fps) $('#pf-fps').value = p.fps === 'source' ? 'source' : String(p.fps);
  if (p.videoBitrate) { $('#pf-vbr').value = p.videoBitrate; $('#pf-vbr-l').textContent = `${p.videoBitrate} kbps`; }
  if (p.audioBitrate) { $('#pf-abr').value = p.audioBitrate; $('#pf-abr-l').textContent = `${p.audioBitrate} kbps`; }
  $('#pf-always').checked = Boolean(p.alwaysTranscode);
  $('#pf-mode').value = p.mode || 'auto';
  $('#pf-subs').value = p.subtitles || 'none';
  $('#pf-note').innerHTML = (p.reasons || []).length
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
function updateCommandPreview() {
  clearTimeout(commandTimer);
  commandTimer = setTimeout(async () => {
    if (!state.stream) return;
    const params = new URLSearchParams({
      mode: $('#pf-mode').value,
      resolution: $('#pf-res').value,
      aspect: $('#pf-aspect').value,
      container: $('#pf-container').value,
      videoBitrate: $('#pf-vbr').value,
      audioBitrate: $('#pf-abr').value,
      fps: $('#pf-fps').value,
      subtitles: $('#pf-subs').value,
      alwaysTranscode: String($('#pf-always').checked),
    });
    try {
      const res = await api(`/api/streams/${state.stream.id}/command?${params}`);
      $('#cmd-preview').textContent = res.command;
      $('#pf-note').innerHTML = `${res.profile.transcode ? '<b>encode</b>' : '<b>stream copy</b>'} — ${escapeHtml((res.profile.reasons || []).join('; '))}
        ${res.profile.transcode && res.profile.encoder === 'vaapi' && !res.hw.available ? '<br><span class="tag warn">vaapi unavailable here — this command will use software encoding</span>' : ''}`;
    } catch { /* preview is best-effort */ }
  }, 250);
}

async function applyProfile() {
  if (!state.stream) return;
  const body = {
    profile: {
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
    },
  };
  const res = await api(`/api/streams/${state.stream.id}/profile`, { method: 'POST', body });
  toast(`Profile saved (${res.profile.transcode ? 'transcode' : 'copy'})`, 'ok');
  const fresh = await api(`/api/streams/${state.stream.id}`);
  state.stream = fresh.stream;
  renderStream(fresh);
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

async function downloadSubtitle(result) {
  try {
    const res = await api('/api/subtitles/download', {
      method: 'POST',
      body: {
        result, offsetMs: Number($('#sub-offset').value) || 0,
        streamId: state.stream?.id || null,
        push: false,
      },
    });
    $('#sub-attached').textContent = `${res.language} · ${res.cues} cues · ${res.provider}`;
    toast(`Subtitle ready: ${res.language} ${res.cues} cues (${res.provider})`, 'ok');
    if (state.stream) {
      const fresh = await api(`/api/streams/${state.stream.id}`);
      state.stream = fresh.stream;
      toast('Subtitle attached to the stream profile (soft mux). Restart the session to apply.', 'info', 9000);
    }
  } catch { /* toast */ }
}

/* ================= ENIGMA2 ================= */

async function loadEnigmaStatus() {
  try {
    const { status } = await api('/api/enigma2/status');
    $('#e2-status').textContent = status.message || (status.ok ? 'ok' : 'unreachable');
    $('#e2-status').className = `tag ${status.ok ? 'ok' : status.configured ? 'err' : 'warn'}`;
    if (status.configured && status.ok) {
      const cfgRes = await api('/api/config');
      const e = cfgRes.config.enigma2;
      $('#e2-host').value = e.host || '';
      $('#e2-port').value = e.port || 80;
      $('#e2-user').value = e.username || 'root';
      $('#e2-name').value = e.bouquetName || 'vu-movie';
      $('#e2-service').value = String(e.serviceType || 4097);
      $('#e2-ftp').checked = Boolean(e.ftpEnabled);
    }
  } catch { /* toast */ }
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
  await api('/api/config', {
    method: 'PUT',
    body: {
      enigma2: {
        host: $('#e2-host').value.trim(),
        port: Number($('#e2-port').value) || 80,
        username: $('#e2-user').value.trim(),
        password: $('#e2-pass').value,
        bouquetName: $('#e2-name').value.trim() || 'vu-movie',
        serviceType: Number($('#e2-service').value) || 4097,
        ftpEnabled: $('#e2-ftp').checked,
      },
    },
  });
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
      ['ftpEnabled', 'bool'], ['ftpPort', 'number'], ['autoPush', 'bool'], ['mountDir', 'text'],
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

const App = {
  go, openStream, cancelJob: async (id) => { await api(`/api/jobs/${id}/cancel`, { method: 'POST' }); loadJobs(); },
  copy: async (text) => {
    try { await navigator.clipboard.writeText(text); toast('Copied to the clipboard', 'ok', 2500); }
    catch { toast('Copy failed — select the text manually', 'warn'); }
  },
  loadJobs, loadStreams, loadHealth,
};
window.App = App;

function wire() {
  $('#btn-search').addEventListener('click', doSearch);
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  $('#btn-resolve').addEventListener('click', doResolveFromUrl);

  ['pf-vbr', 'pf-abr'].forEach((id) => $(`#${id}`).addEventListener('input', () => {
    $(`#${id}-l`).textContent = `${$(`#${id}`).value} kbps`;
    updateCommandPreview();
  }));
  ['pf-mode', 'pf-res', 'pf-aspect', 'pf-container', 'pf-fps', 'pf-subs', 'pf-always', 'pf-deint']
    .forEach((id) => $(`#${id}`).addEventListener('change', updateCommandPreview));
  $('#btn-profile-apply').addEventListener('click', applyProfile);
  $('#btn-profile-reset').addEventListener('click', async () => {
    if (!state.stream) return;
    await api(`/api/streams/${state.stream.id}/profile`, { method: 'POST', body: { profile: { mode: 'auto', container: 'mpegts', alwaysTranscode: false, resolution: 1080, videoBitrate: 2500, audioBitrate: 128, fps: 'source', aspect: 'source', subtitles: 'none' } } });
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
loadHealth();
loadSources();
loadStreams();
loadJobs();
connectEvents();
setInterval(() => { if (!$('#p-dash').classList.contains('hide')) loadHealth(); }, 15000);
