/* vu-movie — the Playlist.
 *
 * The playlist is the ordered list of streams every output is built from (see
 * src/playlist/index.js on the server). This file owns:
 *   - the shared client-side copy of that list (state.playlist)
 *   - the Playlist tab: enable/disable, remove, drag & drop order, per-item
 *     FFmpeg template, subtitle assignment, metadata popup and web player
 *   - the small helpers the Mobile and Subtitles tabs use to read the same list
 */
'use strict';

const VMPlaylist = (() => {
  // Drag & drop state. The HTML5 drag & drop API is not used: it never fires
  // on touch devices and desktop browsers cancel it as soon as the pointer
  // crosses any form control inside the row, which is why the order silently
  // never changed. A plain pointer drag (see beginRowDrag) replaces it.
  let dragState = null;
  let searchSeq = 0;

  const items = () => state.playlist.items || [];
  const templates = () => state.playlist.templates || [];
  const urls = () => state.playlist.urls || null;
  const itemFor = (streamId) => items().find((item) => String(item.streamId) === String(streamId)) || null;
  const enabledItems = () => items().filter((item) => item.enabled);

  const templateLabel = (item) => {
    if (item.hasTemplate && !item.profileTemplateId) return 'custom command';
    const found = templates().find((tpl) => tpl.id === (item.templateId || item.profileTemplateId));
    if (found) return found.name;
    return item.profileTemplateName || 'guided builder';
  };

  /** Load the playlist (and the saved template library) from the server. */
  async function load({ silent = true, force = false } = {}) {
    const data = await api('/api/playlist', { silent });
    state.playlist = {
      ...state.playlist,
      items: data.items || [],
      available: data.available || [],
      summary: data.summary || null,
      urls: data.urls || null,
      templates: data.templates || [],
      defaultTemplateId: data.defaultTemplateId || '',
      // The server reports whether playlist changes reach the config file. They
      // always apply to the running process; on a read-only /config mount they
      // do not survive a restart, which the tab says out loud instead of
      // pretending the save worked.
      writable: data.storage?.writable !== false,
      loaded: true,
    };
    if (force) state.playlist.loadedAt = Date.now();
    return state.playlist;
  }

  async function refresh({ render = true } = {}) {
    await load();
    if (render) renderTab();
    renderAddPicker();
    return state.playlist;
  }

  /* ---------------- mutations ---------------- */

  /** Warn once when a change was applied but could not be written to the config file. */
  let persistWarned = false;
  function notePersisted(data) {
    if (data?.storage) state.playlist.writable = data.storage.writable !== false;
    if (data?.persisted === false && !persistWarned) {
      persistWarned = true;
      toast('The config file is not writable here — playlist changes are kept in memory and are lost when the container restarts', 'warn', 10000);
      renderTab();
    }
    return data;
  }

  async function addToPlaylist(streamIds, { silent = false } = {}) {
    const list = (Array.isArray(streamIds) ? streamIds : [streamIds]).filter(Boolean);
    if (!list.length) return null;
    const data = await api('/api/playlist/items', { method: 'POST', body: { streamIds: list }, silent });
    notePersisted(data);
    state.playlist.items = data.items || state.playlist.items;
    if (!silent) toast(`${data.added || 0} item(s) added to the playlist`, 'ok');
    return data;
  }

  async function patchItem(streamId, patch) {
    const data = await api(`/api/playlist/items/${encodeURIComponent(streamId)}`, { method: 'PATCH', body: patch, silent: true });
    notePersisted(data);
    state.playlist.items = data.items || state.playlist.items;
    renderTab();
    renderAddPicker();
    return data;
  }

  async function assignTemplate(streamId, templateId) {
    notePersisted(await api(`/api/playlist/items/${encodeURIComponent(streamId)}/template`, {
      method: 'POST', body: { templateId }, silent: true,
    }));
    await refresh();
    const label = templateId ? (templates().find((tpl) => tpl.id === templateId)?.name || templateId) : 'guided profile builder';
    toast(`FFmpeg template → ${label}`, 'ok', 4000);
  }

  async function removeItem(streamId) {
    const item = itemFor(streamId);
    if (!window.confirm(`Remove “${item?.title || streamId}” from the playlist?\n\nThe stream itself stays in the library and can be added again.`)) return;
    notePersisted(await api(`/api/playlist/items/${encodeURIComponent(streamId)}`, { method: 'DELETE' }));
    await refresh();
    toast('Removed from the playlist', 'info', 4000);
  }

  async function removeStream(streamId) {
    const item = itemFor(streamId);
    if (!window.confirm(`Delete “${item?.title || streamId}” completely?\n\nThis removes the stream (and its token) as well as the playlist entry.`)) return;
    await api(`/api/streams/${encodeURIComponent(streamId)}`, { method: 'DELETE' });
    await refresh();
    toast('Stream deleted', 'info', 4000);
  }

  async function reorder(streamIds) {
    const data = notePersisted(await api('/api/playlist', { method: 'PUT', body: { streamIds }, silent: true }));
    state.playlist.items = data.items || state.playlist.items;
    renderTab();
  }

  async function setAllEnabled(enabled) {
    const list = items();
    if (!list.length) return;
    // One request per item keeps the server-side patch semantics (and the log
    // lines) simple; a playlist is small, and this is a rare, deliberate click.
    for (const item of list) {
      if (item.enabled !== enabled) await patchItem(item.streamId, { enabled });
    }
    renderTab();
    toast(enabled ? 'Whole playlist enabled' : 'Whole playlist disabled', 'info', 4000);
  }

  /* ---------------- rendering: the Playlist tab ---------------- */

  function thumbMarkup(item, size = 44) {
    const url = item.poster ? safePoster(item.poster) : '';
    const initials = String(item.title || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    return `<div class="pl-thumb" style="width:${size}px;height:${Math.round(size * 1.5)}px">
      <span class="pl-thumb-fallback">${escapeHtml(initials || '▶')}</span>
      ${url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
    </div>`;
  }

  function safePoster(value) {
    try {
      const url = new URL(String(value), window.location.href);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  }

  function templateSelect(item) {
    const current = item.templateId || '';
    const options = [
      `<option value=""${current ? '' : ' selected'}>(default / guided)</option>`,
      ...templates().map((tpl) => `<option value="${escapeHtml(tpl.id)}"${tpl.id === current ? ' selected' : ''}>${escapeHtml(tpl.name)}${tpl.enabled === false ? ' (disabled)' : ''}${tpl.isDefault ? ' ★' : ''}</option>`),
    ];
    // The stream's *effective* template may come from the global default while
    // the item itself has no explicit assignment — say so instead of pretending
    // the command is guided.
    const effective = current ? '' : (item.profileTemplateName
      ? `<span class="mut">using: ${escapeHtml(item.profileTemplateName)}</span>`
      : `<span class="mut">using: ${escapeHtml(templateLabel(item))}</span>`);
    return `<div class="pl-template">
      <label>FFmpeg template</label>
      <select data-pl-template="${escapeHtml(item.streamId)}" aria-label="FFmpeg template for ${escapeHtml(item.title || '')}">${options.join('')}</select>
      <div class="meta">${effective}</div>
    </div>`;
  }

  function rowMarkup(item, index) {
    const meta = [
      item.year ? String(item.year) : '',
      item.quality || '',
      item.sourceId || '',
      item.kind === 'series' && item.season ? `S${item.season}E${item.episode || '?'}` : '',
    ].filter(Boolean).join(' · ');
    const subtitleMode = item.subtitleMode || 'none';
    const modeSuffix = { burn: ' · burned in', none: ' · off', push: ' · on the box', soft: ' · soft track' }[subtitleMode] || '';
    const subtitle = item.subtitlePath
      ? tag(`subtitle ${(item.subtitleLanguageStored || '').toUpperCase() || ''}${modeSuffix}`.trim(), subtitleMode === 'none' ? '' : 'ok')
      : tag('no subtitle');
    const templateTag = item.hasTemplate ? tag(templateLabel(item), 'alt') : tag(templateLabel(item));
    const session = item.session ? tag(`${item.session.clients || 0} client(s)`, 'info') : '';
    return `<article class="pl-row${item.enabled ? '' : ' off'}" data-pl-row="${escapeHtml(item.streamId)}" data-pl-index="${index}">
      <div class="pl-handle" title="drag to change the order" aria-hidden="true">⠿</div>
      <div class="pl-order">${index + 1}</div>
      <label class="pl-switch" title="include this item in every output">
        <input type="checkbox" data-pl-enabled="${escapeHtml(item.streamId)}" ${item.enabled ? 'checked' : ''} aria-label="enable ${escapeHtml(item.title || '')}">
        <span></span>
      </label>
      ${thumbMarkup(item)}
      <div class="pl-main">
        <div class="pl-title">${escapeHtml(item.title || 'Untitled')}${item.year ? ` <span class="mut">(${item.year})</span>` : ''}</div>
        <div class="meta">${escapeHtml(meta || '—')}</div>
        <div class="pl-tags">${templateTag}${subtitle}${session}</div>
      </div>
      ${templateSelect(item)}
      <div class="pl-actions">
        <button class="btn sm" data-pl-play="${escapeHtml(item.streamId)}" title="start the preview web player">▶ preview</button>
        <button class="btn sm ghost" data-pl-meta="${escapeHtml(item.streamId)}" title="show all metadata">ⓘ meta</button>
        <button class="btn sm ghost" data-pl-sub="${escapeHtml(item.streamId)}" title="assign a subtitle file">▤ subtitle</button>
        <button class="btn sm ghost" data-pl-up="${index}" ${index === 0 ? 'disabled' : ''} title="move up">▲</button>
        <button class="btn sm ghost" data-pl-down="${index}" ${index === items().length - 1 ? 'disabled' : ''} title="move down">▼</button>
        <button class="btn sm ghost" data-pl-remove="${escapeHtml(item.streamId)}" title="remove from the playlist (keeps the stream)">⊖</button>
        <button class="btn sm ghost" data-pl-delete="${escapeHtml(item.streamId)}" title="delete the stream itself">✕</button>
      </div>
    </article>`;
  }

  function renderTab() {
    const host = $('#playlist-items');
    if (!host) return;
    if (dragState) return; // never redraw the list under an active drag
    const list = items();
    const summary = state.playlist.summary || {};
    const summaryEl = $('#list-summary');
    if (summaryEl) {
      summaryEl.textContent = `${summary.enabled ?? 0} of ${summary.total ?? list.length} enabled · ${summary.withTemplate ?? 0} with template · ${summary.withSubtitle ?? 0} with subtitle`;
    }
    const hint = $('#list-hint');
    if (hint) {
      const base = state.playlist.defaultTemplateId
        ? `Items without their own template use the default: ${templates().find((t) => t.id === state.playlist.defaultTemplateId)?.name || state.playlist.defaultTemplateId}`
        : 'No default template set — items without one use the guided profile builder.';
      hint.textContent = state.playlist.writable === false
        ? `${base} ⚠ the config file is not writable, so changes live in memory and are lost on restart (mount /config read-write to keep them).`
        : base;
    }
    const openStreamBtn = $('#btn-list-open-stream');
    if (openStreamBtn) openStreamBtn.disabled = !list.length;

    if (!list.length) {
      host.innerHTML = '<div class="card"><div class="meta">The playlist is empty. Search a title on the Search tab and pick a format, or use “add a stream” above.</div></div>';
      return;
    }
    host.innerHTML = list.map((item, index) => rowMarkup(item, index)).join('');
    attachRowListeners(host);
  }

  function attachRowListeners(host) {
    $$('[data-pl-enabled]', host).forEach((input) => input.addEventListener('change', () => {
      patchItem(input.dataset.plEnabled, { enabled: input.checked }).catch(() => { input.checked = !input.checked; });
    }));
    $$('[data-pl-template]', host).forEach((select) => select.addEventListener('change', () => {
      assignTemplate(select.dataset.plTemplate, select.value);
    }));
    $$('[data-pl-play]', host).forEach((button) => button.addEventListener('click', () => openPlayer(button.dataset.plPlay)));
    $$('[data-pl-meta]', host).forEach((button) => button.addEventListener('click', () => openMetadata(button.dataset.plMeta)));
    $$('[data-pl-sub]', host).forEach((button) => button.addEventListener('click', () => openSubtitlePicker(button.dataset.plSub)));
    $$('[data-pl-remove]', host).forEach((button) => button.addEventListener('click', () => removeItem(button.dataset.plRemove)));
    $$('[data-pl-delete]', host).forEach((button) => button.addEventListener('click', () => removeStream(button.dataset.plDelete)));
    $$('[data-pl-up]', host).forEach((button) => button.addEventListener('click', () => move(Number(button.dataset.plUp), -1)));
    $$('[data-pl-down]', host).forEach((button) => button.addEventListener('click', () => move(Number(button.dataset.plDown), 1)));

    // Drag & drop ordering: press anywhere on the row (the ⠿ handle is the
    // obvious place) and drag up/down; the row under the pointer marks where it
    // will land. Mouse, pen and finger all work because this is a pointer drag.
    $$('[data-pl-row]', host).forEach((row) => {
      row.addEventListener('pointerdown', (event) => onRowPointerDown(row, event));
    });
  }

  const DRAG_IGNORE = 'select,input,button,a,label,textarea';

  function onRowPointerDown(row, event) {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (event.target.closest(DRAG_IGNORE)) return; // let the controls work normally
    if (dragState) return;
    const host = row.parentElement;
    if (!host) return;
    dragState = { host, row, streamId: row.dataset.plRow, pointerId: event.pointerId, target: null, after: false, moved: false };
    row.classList.add('dragging');
    try { row.setPointerCapture(event.pointerId); } catch { /* not supported */ }
    // Listen on the window too, so the drag survives leaving the row when the
    // browser has no pointer capture.
    window.addEventListener('pointermove', onRowPointerMove);
    window.addEventListener('pointerup', onRowPointerUp);
    window.addEventListener('pointercancel', onRowPointerUp);
    event.preventDefault(); // no text selection, no page scroll while dragging
  }

  /** Mark the row under the pointer as the drop target (above or below its middle). */
  function markDropTarget(clientX, clientY) {
    const state = dragState;
    if (!state) return;
    let over = document.elementFromPoint(clientX, clientY)?.closest?.('[data-pl-row]') || null;
    if (over === state.row) over = null;
    $$('.pl-row', state.host).forEach((node) => node.classList.remove('drop-before', 'drop-after'));
    state.target = over?.dataset?.plRow || null;
    if (!over) return;
    const rect = over.getBoundingClientRect();
    state.after = clientY > rect.top + rect.height / 2;
    over.classList.add(state.after ? 'drop-after' : 'drop-before');
  }

  function onRowPointerMove(event) {
    if (!dragState) return;
    dragState.moved = true;
    markDropTarget(event.clientX, event.clientY);
    event.preventDefault();
  }

  function onRowPointerUp(event) {
    const state = dragState;
    if (!state) return;
    dragState = null;
    const { host, row, streamId, target, after } = state;
    row.classList.remove('dragging');
    window.removeEventListener('pointermove', onRowPointerMove);
    window.removeEventListener('pointerup', onRowPointerUp);
    window.removeEventListener('pointercancel', onRowPointerUp);
    $$('.pl-row', host).forEach((node) => node.classList.remove('drop-before', 'drop-after'));
    try { row.releasePointerCapture(event.pointerId); } catch { /* fine */ }
    if (!target || target === streamId) return;
    const order = items().map((item) => item.streamId).filter((id) => id !== streamId);
    const index = order.indexOf(target);
    if (index < 0) return;
    order.splice(after ? index + 1 : index, 0, streamId);
    reorder(order).catch(() => {});
  }

  function move(index, delta) {
    const order = items().map((item) => item.streamId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    reorder(order).catch(() => {});
  }

  /** The "add a stream that is not in the playlist" picker. */
  function renderAddPicker() {
    const select = $('#list-add');
    const button = $('#btn-list-add');
    if (!select) return;
    const available = state.playlist.available || [];
    select.innerHTML = available.length
      ? `<option value="">(pick a stream…)</option>${available.map((stream) =>
        `<option value="${escapeHtml(stream.streamId)}">${escapeHtml(stream.title)}${stream.year ? ` (${stream.year})` : ''}${stream.quality ? ` · ${escapeHtml(stream.quality)}` : ''}</option>`).join('')}`
      : '<option value="">(every stream is already in the playlist)</option>';
    if (button) button.disabled = !available.length;
  }

  /* ---------------- metadata popup ---------------- */

  async function openMetadata(streamId) {
    openModal({
      title: 'Metadata',
      className: 'wide',
      body: '<div class="meta"><span class="spin"></span> loading metadata…</div>',
    });
    try {
      const res = await api(`/api/streams/${encodeURIComponent(streamId)}`, { silent: true });
      const stream = res.stream;
      const item = itemFor(streamId) || {};
      const probe = stream.upstream?.probe || {};
      const video = probe.video || {};
      const meta = stream.payload?.meta || {};
      const rows = [
        ['Title', `${stream.title}${stream.year ? ` (${stream.year})` : ''}`],
        ['Kind', stream.kind || '—'],
        ['Year', stream.year || '—'],
        ['Source', stream.source_id || meta.sourceId || '—'],
        ['Quality', stream.upstream?.quality || '—'],
        ['Duration', probe.durationSec ? fmtDuration(probe.durationSec) : '—'],
        ['Container', probe.container || stream.profile?.container || '—'],
        ['Video', video.codec ? `${video.codec} ${video.width || '?'}x${video.height || '?'} @${video.fps || '?'}` : '—'],
        ['Audio', (probe.audio || []).map((a) => `${a.codec}${a.channels ? ` ${a.channels}ch` : ''}`).join(', ') || '—'],
        ['Subtitle tracks (source)', String((probe.subtitles || []).length)],
        ['Bitrate', probe.bitrate ? `${Math.round(probe.bitrate / 1000)} kbps` : '—'],
        ['Season / episode', stream.upstream?.season ? `S${stream.upstream.season}E${stream.upstream.episode || '?'}` : '—'],
        ['FFmpeg template', item.hasTemplate ? item.profileTemplateName || templateLabel(item) : templateLabel(item)],
        ['Container (profile)', stream.profile?.container || '—'],
        ['Transcode', stream.profile?.transcode ? 'yes' : 'no (copy when possible)'],
        ['Subtitle attached', stream.profile?.subtitlePath ? `${(stream.profile.subtitleLanguage || '').toUpperCase()} · ${stream.profile.subtitlePath}` : 'none'],
        ['Upstream URL', stream.upstream?.url || '—'],
        ['Headers', Object.keys(stream.upstream?.headers || {}).join(', ') || 'none'],
        ['Resolved via', stream.upstream?.via || '—'],
        ['Created', fmtDateTime(stream.created_at)],
        ['Token expires', stream.expires_at ? fmtDateTime(stream.expires_at) : 'never'],
        ['Stream id', stream.id],
        ['In playlist', item.streamId ? `yes · position ${items().findIndex((entry) => entry.streamId === stream.id) + 1}${item.enabled ? '' : ' (disabled)'}` : 'no'],
      ];
      const urls = res.urls || {};
      const linkRows = Object.entries(urls)
        .filter(([key, value]) => typeof value === 'string' && value && !['directNote', 'outputType', 'token'].includes(key))
        .map(([key, value]) => `<div class="kv"><span>${escapeHtml(key)}</span><span class="mono" style="word-break:break-all">${escapeHtml(value)}</span></div>`)
        .join('');
      const json = JSON.stringify({ stream, urls }, null, 2);
      openModal({
        title: `${stream.title}${stream.year ? ` (${stream.year})` : ''}`,
        className: 'wide',
        body: `
          <div class="meta-flex">
            ${stream.poster ? thumbMarkup({ ...stream, poster: stream.poster }, 120) : ''}
            <div style="flex:1;min-width:240px">
              ${stream.description ? `<p>${escapeHtml(stream.description)}</p>` : '<p class="mut">No description stored for this stream.</p>'}
              <div class="row">
                <button class="btn sm" data-meta-play="${escapeHtml(stream.id)}">▶ preview web player</button>
                <button class="btn sm ghost" data-meta-sub="${escapeHtml(stream.id)}">▤ subtitle</button>
                <button class="btn sm ghost" data-meta-copy-json>copy JSON</button>
              </div>
            </div>
          </div>
          <h3 style="margin-top:14px">Stream metadata</h3>
          <div class="meta-table">${rows.map(([key, value]) => `<div class="kv"><span>${escapeHtml(key)}</span><span>${escapeHtml(String(value))}</span></div>`).join('')}</div>
          <h3 style="margin-top:14px">Output URLs</h3>
          <div class="meta-table">${linkRows || '<div class="meta">none</div>'}</div>
          <details style="margin-top:14px"><summary class="sub" style="cursor:pointer">Raw JSON (stream + urls)</summary>
            <pre style="max-height:320px">${escapeHtml(json)}</pre></details>`,
        onMount: (root) => {
          $('[data-meta-play]', root)?.addEventListener('click', () => openPlayer(stream.id));
          $('[data-meta-sub]', root)?.addEventListener('click', () => openSubtitlePicker(stream.id));
          $('[data-meta-copy-json]', root)?.addEventListener('click', () => copyText(json));
        },
      });
    } catch (error) {
      openModal({ title: 'Metadata', body: `<div class="note err">${escapeHtml(error.message)}</div>` });
    }
  }

  /* ---------------- preview web player ---------------- */

  /**
   * Play a stream in the browser.
   *
   * Chrome/Firefox do not demux MPEG-TS in <video> and do not accept video/mp2t
   * SourceBuffers. mpegts.js transmuxes the relay's TS bytes to fragmented MP4
   * in MediaSource, locally in the browser. Safari/native playback remains the
   * fallback, and VLC is always offered for a codec the browser cannot decode.
   */
  async function openPlayer(streamId) {
    openModal({
      title: 'Preview web player',
      className: 'wide',
      body: `<div class="player-box"><div class="meta" id="player-status"><span class="spin"></span> starting the relay session…</div></div>`,
    });
    const status = $('#player-status');
    try {
      const res = await api(`/api/streams/${encodeURIComponent(streamId)}`, { silent: true });
      const stream = res.stream;
      const urls = res.urls || {};
      openModal({
        title: `${stream.title}${stream.year ? ` (${stream.year})` : ''}`,
        className: 'wide',
        body: `
          <div class="player-box">
            <video id="player-video" controls autoplay playsinline></video>
            <div id="player-status" class="meta" style="margin-top:8px">connecting…</div>
            <div class="row" style="margin-top:8px">
              <button class="btn sm" data-player-vlc>▶ open in VLC</button>
              <button class="btn sm ghost" data-player-copy>copy stream URL</button>
              <button class="btn sm ghost" data-player-newtab>open /watch page ↗</button>
              <button class="btn sm ghost" data-player-sub>▤ subtitle</button>
            </div>
            <div class="meta" style="margin-top:8px">The web player transmuxes the MPEG-TS relay in your browser. If the source uses a browser-unsupported codec such as HEVC, use VLC or assign an H.264/AAC transcode template.</div>
          </div>`,
        onMount: (root) => {
          const video = $('#player-video', root);
          const statusEl = $('#player-status', root);
          $('[data-player-vlc]', root)?.addEventListener('click', () => { window.location.href = String(urls.ts).replace(/^https?:/, 'vlc:'); });
          $('[data-player-copy]', root)?.addEventListener('click', () => copyText(urls.ts || ''));
          $('[data-player-newtab]', root)?.addEventListener('click', () => window.open(urls.watch || '', '_blank'));
          $('[data-player-sub]', root)?.addEventListener('click', () => openSubtitlePicker(stream.id));
          return startPlayback({ stream, urls, video, statusEl });
        },
      });
    } catch (error) {
      status.textContent = `could not load the stream: ${error.message}`;
    }
  }

  /**
   * Turn a MediaSource/mpegts.js failure into something an operator can act on.
   *
   * The common case is not a codec problem at all: the relay had nothing to
   * send (the upstream mirror was dead, the link expired, or the container has
   * no usable ffmpeg), and Chromium reports that as
   * "DEMUXER_ERROR_COULD_NOT_OPEN: MediaSource endOfStream before demuxer
   * initialization completes", which says nothing about the actual cause.
   */
  function explainPlaybackFailure(reason) {
    const text = String(reason || '');
    if (/endOfStream before demuxer|COULD_NOT_OPEN|src not supported|MEDIA_ERR_SRC_NOT_SUPPORTED/i.test(text)) {
      return 'the relay sent no playable video — the source did not start (dead mirror, expired link, or ffmpeg unavailable). The Logs tab shows the ffmpeg error';
    }
    if (/media_source|MediaSource.*not supported/i.test(text)) {
      return 'this browser has no Media Source Extensions support';
    }
    return text || 'unknown playback error';
  }

  function startPlayback({ stream, urls, video, statusEl }) {
    if (!video) return null;
    let player = null;
    let stopped = false;
    let failed = false;
    const fallback = (message) => {
      if (stopped) return;
      failed = true;
      statusEl.className = 'note warn';
      statusEl.innerHTML = `${escapeHtml(message)}<br>
        <span class="mut">Stream URL: <code>${escapeHtml(urls.ts || '')}</code></span>`;
    };
    const markPlaying = () => {
      if (stopped) return;
      statusEl.className = 'meta ok-text';
      statusEl.textContent = 'playing';
    };
    video.addEventListener('playing', markPlaying);
    statusEl.innerHTML = '<span class="spin"></span> starting the MPEG-TS relay and buffering…';

    if (window.mpegts?.isSupported?.() && urls.ts) {
      try {
        player = window.mpegts.createPlayer({
          type: 'mpegts',
          isLive: true,
          url: urls.ts,
        }, {
          enableWorker: true,
          lazyLoad: false,
          liveBufferLatencyChasing: true,
          liveBufferLatencyMaxLatency: 8,
          liveBufferLatencyMinRemain: 1,
        });
        player.attachMediaElement(video);
        player.on(window.mpegts.Events.ERROR, (type, detail, info) => {
          const reason = info?.msg || info?.message || detail || type || 'unknown playback error';
          fallback(`Web preview failed: ${explainPlaybackFailure(reason)}. “open in VLC” always plays the same URL.`);
        });
        player.load();
        player.play().catch(() => {
          // Autoplay is blocked (or the source never starts): only offer
          // "press Play" when nothing has failed — an error message must not be
          // overwritten by this hint a moment later.
          if (!stopped && !failed) statusEl.textContent = 'ready — press Play to start';
        });
      } catch (error) {
        fallback(`Could not start the browser transmuxer: ${error.message}`);
      }
    } else {
      // Safari can play some relay/container combinations natively. Keep this as
      // a fallback for browsers without MediaSource/mpegts.js.
      const nativeUrl = urls.raw || urls.ts;
      video.src = nativeUrl;
      video.addEventListener('error', () => fallback('This browser cannot play the relay natively and MPEG-TS transmuxing is unavailable.'), { once: true });
      video.play().catch(() => {
        if (!stopped && !failed) statusEl.textContent = 'ready — press Play to start';
      });
    }

    // openModal/closeModal calls this cleanup. Without it, closing Preview left
    // the fetch open and FFmpeg kept running until the idle timeout.
    return () => {
      stopped = true;
      video.removeEventListener('playing', markPlaying);
      try { player?.pause(); } catch { /* ignore */ }
      try { player?.unload(); } catch { /* ignore */ }
      try { player?.detachMediaElement(); } catch { /* ignore */ }
      try { player?.destroy(); } catch { /* ignore */ }
      player = null;
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
    };
  }

  /* ---------------- subtitle assignment ---------------- */

  async function openSubtitlePicker(streamId) {
    const item = itemFor(streamId);
    const title = item?.title || '';
    const year = item?.year || '';
    openModal({
      title: `Subtitle — ${title || streamId}`,
      className: 'wide',
      body: `
        <div id="sub-current" class="meta"></div>
        <div class="tabs" style="margin-top:12px" id="sub-pick-tabs">
          <button class="on" data-st="search">Search providers</button>
          <button data-st="file">Upload .srt</button>
        </div>
        <div id="sub-pick-search">
          <div class="f2">
            <div class="field"><label>Title</label><input id="pick-title" value="${escapeHtml(title)}"></div>
            <div class="field"><label>Year</label><input id="pick-year" type="number" value="${escapeHtml(year || '')}"></div>
          </div>
          <div class="row">
            <button class="btn pri" id="btn-pick-search">⌕ search subtitles</button>
            <label class="row" style="gap:6px;margin:0;color:var(--fg)"><span class="mut">Show</span>
              <select id="pick-lang-filter" style="width:auto"><option value="all">all</option><option value="nl">NL</option><option value="en">EN</option></select></label>
            <span class="mut" id="pick-progress"></span>
          </div>
          <div id="pick-results" class="pick-results"><div class="meta" style="padding:10px 0">Search by the title above, or upload a file you already have.</div></div>
        </div>
        <div id="sub-pick-file" class="hide">
          <div class="field"><label>Subtitle file (.srt)</label><input id="pick-file" type="file" accept=".srt,.txt,.vtt,text/plain,application/x-subrip"></div>
          <div class="f2">
            <div class="field"><label>Language</label>
              <select id="pick-file-lang"><option value="nl">nl</option><option value="en">en</option><option value="de">de</option><option value="fr">fr</option><option value="es">es</option></select></div>
            <div class="field"><label>&nbsp;</label><button class="btn pri" id="btn-pick-upload">attach file <span class="tip" tabindex="0" role="note" aria-label="About attaching a subtitle file" data-tip="The file is stored next to the stream and muxed as a soft subtitle track — the relay restarts automatically.">i</span></button></div>
          </div>
        </div>`,
      onMount: (root) => {
        $('#sub-pick-tabs', root).addEventListener('click', (event) => {
          const button = event.target.closest('button[data-st]');
          if (!button) return;
          $$('#sub-pick-tabs button', root).forEach((node) => node.classList.toggle('on', node === button));
          $('#sub-pick-search', root).classList.toggle('hide', button.dataset.st !== 'search');
          $('#sub-pick-file', root).classList.toggle('hide', button.dataset.st !== 'file');
        });
        $('#btn-pick-search', root).addEventListener('click', () => runPickerSearch(streamId));
        $('#pick-lang-filter', root).addEventListener('change', () => renderPickerResults(streamId));
        $('#btn-pick-upload', root).addEventListener('click', () => uploadSubtitle(streamId));
        renderCurrentSubtitle(streamId);
      },
    });
  }

  async function renderCurrentSubtitle(streamId) {
    const host = $('#sub-current');
    if (!host) return;
    try {
      const res = await api(`/api/streams/${encodeURIComponent(streamId)}`, { silent: true });
      const path = res.stream.profile?.subtitlePath;
      // The item owns the mode: "copy the .srt to the box" never writes the
      // stream profile, so reading the profile alone would draw "off" again
      // right after the push succeeded.
      const mode = items().find((entry) => entry.streamId === streamId)?.subtitleMode
        || res.stream.profile?.subtitles || 'none';
      host.innerHTML = path
        ? `Current subtitle: <b>${escapeHtml((res.stream.profile.subtitleLanguage || '').toUpperCase())}</b> · <span class="mono">${escapeHtml(path)}</span>
           <button class="btn sm ghost" id="btn-sub-detach" style="margin-left:8px">detach</button>
           <div class="field" style="margin-top:10px;max-width:640px"><label>How the box gets it</label>
             <select id="sub-mode">
               <option value="push"${mode === 'push' ? ' selected' : ''}>copy the .srt to the box — no CPU at all</option>
               <option value="soft"${mode === 'soft' ? ' selected' : ''}>soft track in the .mkv — no re-encode</option>
               <option value="burn"${mode === 'burn' ? ' selected' : ''}>burn into the picture — costs an encode</option>
               <option value="none"${mode === 'none' ? ' selected' : ''}>off — do not use it</option>
             </select></div>
           <div class="meta" style="max-width:640px">
             <b>copy the .srt to the box</b> uploads the file to the receiver directory (FTP or a mounted share, named like the
             movie) — the NAS does no transcoding at all. Enigma2/EMC pick it up next to a recording of the same name; it does
             not show while merely zapping a live stream.<br>
             <b>soft track</b> muxes the .srt into the Matroska (.mkv) output: no re-encode, but the player must select the
             track — ServiceApp <b>5002</b> (exteplayer3) shows it, Enigma2's own menu does not list it.<br>
             <b>burn into the picture</b> re-encodes the video (the only mode that costs the DS918+ real work) and shows on
             every receiver, including service type 1. It needs the guided profile: an FFmpeg template bound to this output
             keeps its own filters.</div>`
        : 'No subtitle attached to this item yet.';
      $('#btn-sub-detach')?.addEventListener('click', async () => {
        await api(`/api/playlist/items/${encodeURIComponent(streamId)}/subtitle`, { method: 'DELETE' });
        toast('Subtitle detached', 'info');
        await refresh();
        renderCurrentSubtitle(streamId);
      });
      $('#sub-mode')?.addEventListener('change', async (event) => {
        const value = event.target.value;
        const messages = {
          burn: 'Subtitles will be burned into the picture (the relay re-encodes)',
          soft: 'Soft subtitle track in the Matroska output',
          push: 'Copying the .srt to the receiver…',
          none: 'Subtitle off for this item',
        };
        try {
          const res = await api(`/api/playlist/items/${encodeURIComponent(streamId)}`, { method: 'PATCH', body: { subtitleMode: value } });
          const pushed = res.item?.pushedSubtitle;
          toast(pushed ? `Subtitle copied to the box (${pushed.via}): ${pushed.path}` : messages[value] || value, 'ok', pushed ? 6000 : 3000);
          await refresh();
          renderCurrentSubtitle(streamId);
        } catch (error) {
          // A failed copy leaves the mode saved; say why instead of pretending.
          toast(error.message || 'could not change the subtitle mode', 'err', 6000);
          renderCurrentSubtitle(streamId);
        }
      });
    } catch { /* modal already shows errors */ }
  }

  async function runPickerSearch(streamId) {
    const title = $('#pick-title')?.value.trim();
    if (!title) return toast('Enter a title first', 'warn');
    const seq = ++searchSeq;
    const results = $('#pick-results');
    $('#pick-progress').textContent = 'searching…';
    if (results) results.innerHTML = '<div class="meta" style="padding:10px 0"><span class="spin"></span> searching providers…</div>';
    try {
      const res = await api('/api/subtitles/search', {
        method: 'POST',
        body: {
          title,
          year: Number($('#pick-year')?.value) || null,
          kind: 'movie',
          languages: ['nl', 'en'],
        },
      });
      if (seq !== searchSeq) return;
      state.pickerResults = res.results || [];
      $('#pick-progress').textContent = `${state.pickerResults.length} candidate(s)`;
      renderPickerResults(streamId);
    } catch (error) {
      if (seq !== searchSeq) return;
      $('#pick-progress').textContent = 'search failed';
      if (results) results.innerHTML = `<div class="note err">${escapeHtml(error.message)}</div>`;
    }
  }

  function renderPickerResults(streamId) {
    const host = $('#pick-results');
    if (!host) return;
    const filter = $('#pick-lang-filter')?.value || 'all';
    const all = state.pickerResults || [];
    const list = filter === 'all' ? all : all.filter((r) => String(r.language || '').toLowerCase().startsWith(filter));
    if (!list.length) {
      host.innerHTML = `<div class="meta" style="padding:10px 0">${all.length ? 'No result in that language.' : 'No subtitle results yet.'}</div>`;
      return;
    }
    host.innerHTML = list.slice(0, 60).map((result) => {
      const index = all.indexOf(result);
      const release = result.release || result.title || 'Untitled release';
      return `<div class="pick-row">
        <div class="pick-main">
          <div>${escapeHtml(String(release).slice(0, 110))}</div>
          <div class="meta">${tag(String(result.language || '?').toUpperCase(), String(result.language || '').startsWith('nl') ? 'ok' : 'info')}
            ${tag(result.providerId || '—')} score ${escapeHtml(String(result.score ?? '—'))} · ${Number(result.downloads) || 0} downloads
            ${result.hashMatch ? tag('hash match', 'ok') : ''} ${result.episodeMatch ? tag('episode match', 'ok') : ''}</div>
        </div>
        <button class="btn sm pri" data-pick-attach="${index}">attach</button>
      </div>`;
    }).join('');
    $$('[data-pick-attach]', host).forEach((button) => button.addEventListener('click', async () => {
      const result = all[Number(button.dataset.pickAttach)];
      if (!result) return;
      button.disabled = true;
      button.textContent = 'attaching…';
      try {
        const res = await api(`/api/playlist/items/${encodeURIComponent(streamId)}/subtitle`, { method: 'POST', body: { result } });
        if (res.pushed?.ok) toast(`Subtitle attached and copied to the box (${res.pushed.via})`, 'ok', 6000);
        else if (res.pushed) toast(`Subtitle attached, but the copy to the box failed: ${res.pushed.error}`, 'warn', 6000);
        else toast(`Subtitle attached (${String(result.language || '').toUpperCase()})`, 'ok');
        await refresh();
        renderCurrentSubtitle(streamId);
      } finally {
        button.disabled = false;
        button.textContent = 'attach';
      }
    }));
  }

  async function uploadSubtitle(streamId) {
    const input = $('#pick-file');
    const file = input?.files?.[0];
    if (!file) return toast('Pick an .srt file first', 'warn');
    const srt = await file.text();
    const language = $('#pick-file-lang')?.value || 'nl';
    try {
      const res = await api(`/api/playlist/items/${encodeURIComponent(streamId)}/subtitle`, { method: 'POST', body: { srt, language } });
      if (res.pushed?.ok) toast(`Subtitle attached and copied to the box (${res.pushed.via})`, 'ok', 6000);
      else if (res.pushed) toast(`Subtitle attached, but the copy to the box failed: ${res.pushed.error}`, 'warn', 6000);
      else toast(`Subtitle file attached (${language})`, 'ok');
      await refresh();
      renderCurrentSubtitle(streamId);
    } catch { /* api() already reported it */ }
  }

  /* ---------------- boot ---------------- */

  function wire() {
    $('#btn-list-refresh')?.addEventListener('click', () => refresh().then(() => toast('Playlist reloaded', 'ok', 2500)));
    $('#btn-list-enable-all')?.addEventListener('click', () => setAllEnabled(true));
    $('#btn-list-disable-all')?.addEventListener('click', () => setAllEnabled(false));
    $('#btn-list-add')?.addEventListener('click', async () => {
      const id = $('#list-add')?.value;
      if (!id) return toast('Pick a stream first', 'warn');
      await addToPlaylist(id);
      await refresh();
    });
    $('#btn-list-open-stream')?.addEventListener('click', () => App.go('stream'));
    // The modal closes on the backdrop and on any [data-modal-close] button.
    $('#modal-root')?.addEventListener('click', (event) => {
      if (event.target.closest('[data-modal-close]')) closeModal();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('#modal-root')?.classList.contains('hide')) closeModal();
    });
  }

  return {
    load, refresh, wire, renderTab, renderAddPicker, addToPlaylist, patchItem, assignTemplate,
    removeItem, removeStream, reorder, setAllEnabled, openMetadata, openPlayer, openSubtitlePicker,
    items, enabledItems, itemFor, templates, urls, templateLabel, thumbMarkup,
  };
})();

if (typeof window !== 'undefined') window.VMPlaylist = VMPlaylist;
