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
      maintenance: data.maintenance || null,
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

  /* ---------------- stream health: “is this one still working?” ------------- */

  /**
   * The upstream URLs in a playlist rot (signed tokens expire, mirrors die,
   * CDNs start geo-blocking) and the only honest answer is a probe. Results
   * live in `state.playlist.health[streamId]` and are painted per row, so a
   * long playlist fills in one item at a time instead of blocking on one
   * request that probes everything.
   */
  const healthOf = (streamId) => (state.playlist.health || {})[String(streamId)] || null;
  const isChecking = (streamId) => (state.playlist.checkingIds || new Set()).has(String(streamId));

  /** What ffprobe found, in one line: “1920×1080 h264 · 1h 32m”. */
  function probeLine(health) {
    const probe = health?.probe;
    if (!probe) return '';
    const video = probe.video && probe.video.height
      ? ` ${probe.video.width ? `${probe.video.width}×` : ''}${probe.video.height}${probe.video.codec ? ` ${probe.video.codec}` : ''}`
      : '';
    const duration = probe.durationSec ? ` · ${fmtDuration(probe.durationSec)}` : '';
    return `${video}${duration}`;
  }

  /** One state → the tag the row shows, with the full reason in the tooltip. */
  function healthTag(health) {
    if (!health) return '';
    const probe = probeLine(health);
    if (health.state === 'working') {
      const ms = health.probeMs ? ` (${Math.round(health.probeMs / 1000)} s)` : '';
      return tag(`${health.repaired ? 'refreshed' : 'working'}${probe}${ms}`, 'ok');
    }
    if (health.state === 'dead') return tag('not working', 'err');
    if (health.state === 'expired') return tag('token expired', 'err');
    if (health.state === 'unverified') return tag('unverified', 'warn');
    return tag('cannot check', 'warn');
  }

  /** The `title` attribute: the ffprobe detail on success, the reason on failure. */
  function healthTitle(health) {
    if (!health) return '';
    const probe = health.probe;
    const found = probe
      ? [
        probe.container ? `container ${probe.container}` : '',
        probe.video?.codec ? `video ${probe.video.codec}${probe.video.width ? ` ${probe.video.width}×${probe.video.height}` : ''}` : '',
        probe.audio?.length ? `audio ${probe.audio.map((track) => track.codec).filter(Boolean).join('/')}` : '',
        probe.durationSec ? `duration ${fmtDuration(probe.durationSec)}` : 'live / unknown duration',
        probe.subtitleTracks ? `${probe.subtitleTracks} subtitle track(s)` : '',
      ].filter(Boolean).join(' · ')
      : '';
    if (health.state === 'working') {
      const refreshed = health.repaired
        ? ` · automatically refreshed${health.sourceChanged ? ` from ${health.previousSourceId || 'the old provider'} to ${health.sourceId || 'a new provider'}` : ''}`
        : '';
      return `checked${health.at ? ` ${fmtTime(health.at)}` : ''}${found ? ` — ${found}` : ''}${refreshed}`;
    }
    if (health.state === 'unverified') {
      const detail = health.error || 'probing is switched off in Settings or ffprobe is missing';
      return `${health.repaired ? 'automatically refreshed, but not proven' : 'not proven'}: ${detail}`;
    }
    const detail = [health.error || (health.state === 'skipped' ? 'no upstream URL stored for this stream' : 'the upstream URL did not answer'),
      health.repairError ? `automatic refresh failed: ${health.repairError}` : ''].filter(Boolean).join(' · ');
    return `${detail}${health.at ? ` (checked ${fmtTime(health.at)})` : ''}`;
  }

  /** The row's health cell — replaced in place while a check is running. */
  function healthCellMarkup(item) {
    const health = healthOf(item.streamId);
    const checking = isChecking(item.streamId);
    if (checking) return tag('checking…', 'info');
    if (!health) return '';
    return `<span class="pl-health-tag" title="${escapeHtml(healthTitle(health))}">${healthTag(health)}</span>`;
  }

  /** Repaint one row's health without re-rendering the list under the user. */
  function renderRowHealth(streamId) {
    const item = itemFor(streamId);
    if (!item) return;
    $$('[data-pl-health]').forEach((node) => {
      if (String(node.dataset.plHealth) !== String(streamId)) return;
      node.innerHTML = healthCellMarkup(item);
      node.closest('[data-pl-row]')?.classList.toggle('bad', ['dead', 'expired'].includes(healthOf(streamId)?.state));
    });
    const button = $(`[data-pl-check="${String(streamId).replace(/"/g, '')}"]`);
    if (button) {
      button.disabled = isChecking(streamId);
      button.textContent = isChecking(streamId) ? '…' : '⚡';
    }
  }

  function renderCheckNote() {
    const note = $('#list-check-note');
    const button = $('#btn-list-check');
    const progress = state.playlist.checkProgress || null;
    const running = (state.playlist.checkingIds || new Set()).size > 0;
    if (button) button.disabled = running || !items().length;
    if (!note) return;
    if (running && progress) {
      note.textContent = `checking ${progress.done}/${progress.total} stream(s)…`;
      return;
    }
    const health = Object.entries(state.playlist.health || {})
      .filter(([streamId]) => itemFor(streamId))
      .map(([, value]) => value);
    if (!health.length) {
      note.textContent = '';
      return;
    }
    const broken = health.filter((result) => ['dead', 'expired'].includes(result.state));
    const working = health.filter((result) => result.state === 'working').length;
    const repaired = health.filter((result) => result.repaired).length;
    const unknown = health.filter((result) => ['unverified', 'skipped'].includes(result.state)).length;
    const parts = [`${working}/${health.length} working`];
    if (repaired) parts.push(`${repaired} auto-refreshed`);
    if (broken.length) {
      const names = broken.slice(0, 3).map((result) => `${result.title || result.streamId} (${result.repairError || result.error || result.state})`);
      parts.push(`${broken.length} not working: ${names.join('; ')}${broken.length > 3 ? ` +${broken.length - 3} more` : ''}`);
    }
    if (unknown) parts.push(`${unknown} unverified`);
    note.textContent = parts.join(' · ');
    note.classList.toggle('has-broken', broken.length > 0);
  }

  function renderCheckSchedule() {
    const note = $('#list-check-schedule');
    if (!note) return;
    const schedule = state.playlist.maintenance;
    if (!schedule) { note.textContent = ''; return; }
    if (!schedule.enabled) {
      note.textContent = 'Automatic Playlist checks are off; streams are still checked before playback starts.';
      return;
    }
    const last = schedule.lastSummary
      ? ` · last: ${schedule.lastSummary.checked} checked, ${schedule.lastSummary.repaired || 0} refreshed`
      : '';
    note.textContent = schedule.running
      ? `Automatic Playlist check is running${last}`
      : `Automatic check every ${schedule.intervalMinutes} min${schedule.nextRunAt ? ` · next ${fmtTime(schedule.nextRunAt)}` : ''}${last}`;
  }

  /**
   * Check the upstreams. The Playlist tab asks per item (two in flight) so each
   * row is painted as soon as its probe answers; `checkAll` is also usable with
   * a batch, which is what curl/ops would do.
   */
  async function checkStreams(streamIds = null, { concurrency = 2 } = {}) {
    const wanted = streamIds ? streamIds.map(String) : null;
    const list = wanted ? items().filter((item) => wanted.includes(String(item.streamId))) : items();
    if (!list.length) {
      toast('Nothing to check — the playlist is empty', 'warn');
      return null;
    }
    state.playlist.health = { ...(state.playlist.health || {}) };
    for (const item of list) delete state.playlist.health[String(item.streamId)];
    state.playlist.checkingIds = new Set(list.map((item) => String(item.streamId)));
    state.playlist.checkProgress = { done: 0, total: list.length };
    for (const item of list) renderRowHealth(item.streamId);
    renderCheckNote();

    let index = 0;
    let requestFailures = 0;
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), list.length) }, async () => {
      while (index < list.length) {
        const item = list[index++];
        try {
          const data = await api('/api/playlist/check', {
            method: 'POST', silent: true,
            body: { streamIds: [String(item.streamId)], concurrency: 1 },
          });
          for (const result of data.results || []) {
            state.playlist.health[String(result.streamId)] = { ...result, at: data.summary?.checkedAt || new Date().toISOString() };
          }
          if (!data.results?.length) {
            state.playlist.health[String(item.streamId)] = {
              streamId: item.streamId, state: 'skipped', title: item.title,
              error: 'the server did not answer for this stream', at: new Date().toISOString(),
            };
          }
        } catch (error) {
          requestFailures += 1;
          state.playlist.health[String(item.streamId)] = {
            streamId: item.streamId, title: item.title, state: 'dead',
            error: `check failed: ${error.message}`, probeMs: null, probe: null, at: new Date().toISOString(),
          };
        } finally {
          state.playlist.checkingIds.delete(String(item.streamId));
          state.playlist.checkProgress.done += 1;
          renderRowHealth(item.streamId);
          renderCheckNote();
        }
      }
    }));

    state.playlist.checkingIds = new Set();
    renderCheckNote();
    const health = list.map((item) => healthOf(item.streamId)).filter(Boolean);
    const refreshedCount = health.filter((result) => result.repaired).length;
    if (refreshedCount) await refresh();
    const broken = health.filter((result) => ['dead', 'expired'].includes(result.state));
    if (broken.length) {
      toast(`${refreshedCount ? `${refreshedCount} refreshed; ` : ''}${broken.length} of ${health.length} stream(s) are still not working: ${broken.slice(0, 3).map((result) => result.title || result.streamId).join(', ')}`, 'err', 12000);
    } else if (health.some((result) => ['unverified', 'skipped'].includes(result.state))) {
      toast(`${refreshedCount ? `${refreshedCount} stream(s) refreshed. ` : ''}Checked — some streams could not be verified or have no usable upstream URL`, 'warn', 9000);
    } else if (requestFailures) {
      toast(`${requestFailures} check(s) could not reach the server`, 'err');
    } else {
      toast(refreshedCount ? `${refreshedCount} stream(s) refreshed; all ${health.length} answered` : `All ${health.length} stream(s) answered`, 'ok');
    }
    return { health };
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
    const health = healthOf(item.streamId);
    const broken = ['dead', 'expired'].includes(health?.state);
    const checking = isChecking(item.streamId);
    return `<article class="pl-row${item.enabled ? '' : ' off'}${broken ? ' bad' : ''}" data-pl-row="${escapeHtml(item.streamId)}" data-pl-index="${index}">
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
        <div class="pl-tags">${templateTag}${subtitle}${session}<span class="pl-health" data-pl-health="${escapeHtml(item.streamId)}">${healthCellMarkup(item)}</span></div>
      </div>
      ${templateSelect(item)}
      <div class="pl-actions">
        <button class="btn sm ghost" data-pl-check="${escapeHtml(item.streamId)}" ${checking ? 'disabled' : ''} title="check whether this stream still works (ffprobe on the upstream URL)">${checking ? '…' : '⚡'}</button>
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
    renderCheckNote();
    renderCheckSchedule();

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
    $$('[data-pl-check]', host).forEach((button) => button.addEventListener('click', () => checkStreams([button.dataset.plCheck])));
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

  async function fetchEnrichedForStream(stream) {
    try {
      const params = new URLSearchParams({
        title: stream.title || '',
        year: stream.year ? String(stream.year) : '',
        type: stream.kind || 'movie',
      });
      const meta = stream.payload?.meta || {};
      if (meta.imdbId) params.set('imdbId', meta.imdbId);
      if (meta.tmdbId) params.set('tmdbId', meta.tmdbId);
      const data = await api(`/api/metadata/tmdb?${params}`, { silent: true });
      return data;
    } catch (e) {
      return null;
    }
  }

  function tmdbMarkup(enriched) {
    if (!enriched) return '<div class="meta">No TMDB/OMDB data — configure API key in Settings → Metadata.</div>';
    const tmdb = enriched.tmdb;
    const omdb = enriched.omdb;
    const hasAny = tmdb || omdb;
    if (!hasAny) {
      const err = (enriched.errors||[]).map(er=>`${er.source}: ${er.error}`).join('; ') || 'No results from TMDB/OMDB';
      return `<div class="meta">TMDB/OMDB: ${escapeHtml(err)} — check API key in Settings → Metadata.</div>`;
    }
    const rows = [];
    if (tmdb) {
      rows.push(`<div class="kv"><span>TMDB title</span><span>${escapeHtml(tmdb.title||'—')}${tmdb.year?` (${tmdb.year})`:''}</span></div>`);
      if (tmdb.originalTitle && tmdb.originalTitle !== tmdb.title) rows.push(`<div class="kv"><span>Original title</span><span>${escapeHtml(tmdb.originalTitle)}</span></div>`);
      if (tmdb.tagline) rows.push(`<div class="kv"><span>Tagline</span><span>${escapeHtml(tmdb.tagline)}</span></div>`);
      if (tmdb.overview) rows.push(`<div class="kv"><span>Plot (TMDB)</span><span>${escapeHtml(tmdb.overview)}</span></div>`);
      if (tmdb.genres?.length) rows.push(`<div class="kv"><span>Genres (TMDB)</span><span>${escapeHtml(tmdb.genres.join(', '))}</span></div>`);
      if (tmdb.rating) rows.push(`<div class="kv"><span>TMDB rating</span><span>★ ${tmdb.rating} (${tmdb.votes||0} votes)</span></div>`);
      if (tmdb.runtime) rows.push(`<div class="kv"><span>Runtime (TMDB)</span><span>${tmdb.runtime} min</span></div>`);
      if (tmdb.director?.length) rows.push(`<div class="kv"><span>Director (TMDB)</span><span>${escapeHtml(tmdb.director.join(', '))}</span></div>`);
      if (tmdb.cast?.length) rows.push(`<div class="kv"><span>Cast (TMDB)</span><span>${escapeHtml(tmdb.cast.slice(0,5).map(c=>c.name).join(', '))}</span></div>`);
      if (tmdb.releaseDate) rows.push(`<div class="kv"><span>Released (TMDB)</span><span>${escapeHtml(tmdb.releaseDate)}</span></div>`);
    }
    if (omdb) {
      if (omdb.plot && (!tmdb || !tmdb.overview)) rows.push(`<div class="kv"><span>Plot (OMDB)</span><span>${escapeHtml(omdb.plot)}</span></div>`);
      if (omdb.imdbRating) rows.push(`<div class="kv"><span>IMDb rating</span><span>★ ${omdb.imdbRating} (${omdb.imdbVotes||''})</span></div>`);
      if (omdb.metascore && omdb.metascore !== 'N/A') rows.push(`<div class="kv"><span>Metascore</span><span>${escapeHtml(omdb.metascore)}</span></div>`);
      if (omdb.rated) rows.push(`<div class="kv"><span>Rated</span><span>${escapeHtml(omdb.rated)}</span></div>`);
      if (omdb.awards && omdb.awards !== 'N/A') rows.push(`<div class="kv"><span>Awards</span><span>${escapeHtml(omdb.awards)}</span></div>`);
      if (omdb.actors?.length) rows.push(`<div class="kv"><span>Actors (OMDB)</span><span>${escapeHtml(omdb.actors.join(', '))}</span></div>`);
      if (omdb.director?.length) rows.push(`<div class="kv"><span>Director (OMDB)</span><span>${escapeHtml(omdb.director.join(', '))}</span></div>`);
    }
    const links = [];
    if (tmdb?.tmdbUrl) links.push(`<a href="${escapeHtml(tmdb.tmdbUrl)}" target="_blank" rel="noreferrer">TMDB ↗</a>`);
    if (tmdb?.imdbUrl || omdb?.imdbUrl) links.push(`<a href="${escapeHtml(tmdb?.imdbUrl||omdb?.imdbUrl)}" target="_blank" rel="noreferrer">IMDb ↗</a>`);
    if (enriched.imdbId) links.push(`<a href="https://www.imdb.com/title/${escapeHtml(enriched.imdbId)}/" target="_blank" rel="noreferrer">IMDb (${escapeHtml(enriched.imdbId)}) ↗</a>`);
    if (links.length) rows.push(`<div class="kv"><span>Links</span><span>${links.join(' · ')}</span></div>`);
    return `<div class="meta-table">${rows.join('')}</div>`;
  }

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
          <div id="tmdb-section" class="card" style="margin-top:14px"><h3 style="margin:0 0 8px">TMDB / IMDb metadata <span class="tip" tabindex="0" role="note" aria-label="About TMDB" data-tip="Rich info from themoviedb.org and omdbapi.com — configure API keys in Settings → Metadata.">i</span></h3><div class="meta"><span class="spin"></span> loading TMDB/IMDb…</div></div>
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
          // Load TMDB async
          fetchEnrichedForStream(stream).then((enriched) => {
            const host = root.querySelector('#tmdb-section');
            if (!host) return;
            if (!enriched) {
              host.innerHTML = `<h3 style="margin:0 0 8px">TMDB / IMDb metadata</h3><div class="meta">TMDB not configured — add API key in Settings → Metadata (free at themoviedb.org).</div>`;
              return;
            }
            host.innerHTML = `<h3 style="margin:0 0 8px">TMDB / IMDb metadata ${enriched.sources?.length?`<span class="tag ok">${escapeHtml(enriched.sources.join(', '))}</span>`:''}</h3>${tmdbMarkup(enriched)}`;
          }).catch(() => {
            const host = root.querySelector('#tmdb-section');
            if (host) host.innerHTML = `<h3>TMDB / IMDb metadata</h3><div class="meta">Could not load TMDB/IMDb — check API key.</div>`;
          });
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
  /**
   * `onClose` runs when the player modal closes (or is replaced by another
   * modal). The search-result preview uses it to delete its ephemeral stream;
   * playlist playback passes nothing.
   */
  async function openPlayer(streamId, { onClose = null } = {}) {
    const notifyClosed = () => { try { onClose?.(); } catch { /* best-effort preview cleanup */ } };
    openModal({
      title: 'Preview web player',
      className: 'wide',
      body: `<div class="player-box"><div class="meta" id="player-status"><span class="spin"></span> loading stream info…</div></div>`,
    });
    const status = $('#player-status');
    try {
      const res = await api(`/api/streams/${encodeURIComponent(streamId)}`, { silent: true });
      const stream = res.stream;
      const urls = res.urls || {};
      // Build modal that embeds the same /watch page that "Watch in browser" uses,
      // so the preview button works exactly like the Stream URLs watch button.
      const watchUrl = urls.watch || '';
      const tsUrl = urls.ts || '';
      const webUrl = urls.web || '';
      openModal({
        title: `${stream.title}${stream.year ? ` (${stream.year})` : ''}`,
        className: 'wide',
        body: `
          <div class="player-box">
            <div class="row" style="margin-bottom:8px">
              <button class="btn sm pri" data-player-watch>▶ open Watch in browser ↗</button>
              <button class="btn sm" data-player-vlc>▶ open in VLC</button>
              <button class="btn sm ghost" data-player-copy>copy VLC URL</button>
              <button class="btn sm ghost" data-player-sub>▤ subtitle</button>
            </div>
            <div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;background:#000">
              <iframe id="player-iframe" src="${escapeHtml(watchUrl)}" style="width:100%;height:56vh;min-height:360px;border:0;background:#000" allow="autoplay; fullscreen" loading="lazy"></iframe>
            </div>
            <div id="player-status" class="meta" style="margin-top:8px">embedded Watch page — same player as "Watch in browser". If it does not start, use VLC or open the Watch page in a new tab.</div>
            <details class="meta" style="margin-top:8px"><summary style="cursor:pointer">inline preview (same as Watch page, without iframe)</summary>
              <div style="margin-top:8px">
                <video id="player-video" controls autoplay playsinline style="width:100%;max-height:42vh;background:#000;border-radius:8px"></video>
                <div class="meta" style="margin-top:6px">Fallback inline player — uses mpegts.js directly, same URL as the Watch page.</div>
                <div class="mono" id="player-weburl" style="word-break:break-all;margin-top:4px">${escapeHtml(webUrl)}</div>
              </div>
            </details>
          </div>`,
        onMount: (root) => {
          const video = $('#player-video', root);
          const statusEl = $('#player-status', root);
          const iframe = $('#player-iframe', root);
          $('[data-player-watch]', root)?.addEventListener('click', () => window.open(watchUrl, '_blank'));
          $('[data-player-vlc]', root)?.addEventListener('click', () => {
            try { window.location.href = String(tsUrl).replace(/^(https?:\/\/)/i, 'vlc://$1'); } catch { window.open(tsUrl, '_blank'); }
          });
          $('[data-player-copy]', root)?.addEventListener('click', () => copyText(tsUrl || ''));
          $('[data-player-sub]', root)?.addEventListener('click', () => openSubtitlePicker(stream.id));
          // Also start inline fallback player
          const cleanup = startPlayback({ stream, urls, video, statusEl: statusEl || { textContent: '', className: '' } });
          // Cleanup should also clear iframe
          return () => {
            try { if (iframe) iframe.src = 'about:blank'; } catch {}
            try { cleanup?.(); } catch {}
            notifyClosed();
          };
        },
      });
    } catch (error) {
      // The player never started, so there is no modal cleanup to run later —
      // release the preview stream right away instead of waiting for the TTL.
      notifyClosed();
      if (status) status.textContent = `could not load the stream: ${error.message}`;
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
    // The preview URL carries this browser's codec report; the relay answers it
    // with a subtitle-free, browser-compatible session (see /web-codecs.js).
    // The guard keeps a stale cached page working: without the probe the relay
    // gets no report and transcodes to H.264/AAC, which is the safe path.
    const webUrl = (window.VMWebCodecs?.previewUrl || ((url) => url))(urls.web || urls.ts);
    const webUrlEl = $('#player-weburl');
    if (webUrlEl) webUrlEl.textContent = webUrl;
    // The relay's decision (copy vs transcode, which codec) is only known after
    // the session exists, so it is fetched once for the status line.
    const note = { web: '' };
    const fallback = (message) => {
      if (stopped) return;
      failed = true;
      statusEl.className = 'note warn';
      statusEl.innerHTML = `${escapeHtml(message)}<br>
        <span class="mut">Preview URL: <code>${escapeHtml(webUrl)}</code> · VLC URL (keeps subtitles): <code>${escapeHtml(urls.ts || '')}</code></span>`;
    };
    const markPlaying = () => {
      if (stopped) return;
      statusEl.className = 'meta ok-text';
      statusEl.textContent = note.web ? `playing — ${note.web}` : 'playing';
    };
    video.addEventListener('playing', markPlaying);
    statusEl.innerHTML = '<span class="spin"></span> starting the MPEG-TS relay and buffering…';

    // Fetch once the session exists and show what the relay decided. A failure
    // here is silent on purpose: the status line is a nicety, the video is the
    // product.
    api(`/api/streams/${encodeURIComponent(stream.id)}`, { silent: true })
      .then((res) => {
        if (stopped || !res?.session?.web) return;
        note.web = window.VMWebCodecs?.describeDecisions?.(res.session.webDecisions) || '';
        if (note.web && statusEl.classList.contains('ok-text')) markPlaying();
      })
      .catch(() => {});

    if (window.mpegts?.isSupported?.() && webUrl) {
      try {
        player = window.mpegts.createPlayer({
          type: 'mpegts',
          isLive: true,
          url: webUrl,
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
      // Safari can play some relay/container combinations natively (it demuxes
      // MPEG-TS). Keep this as a fallback for browsers without
      // MediaSource/mpegts.js — the same preview URL, so the relay still drops
      // the subtitles and picks a codec the browser reported.
      video.src = webUrl || urls.raw || urls.ts;
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
    $('#btn-list-check')?.addEventListener('click', () => checkStreams());
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
    checkStreams, healthOf, renderRowHealth, renderCheckNote,
  };
})();

if (typeof window !== 'undefined') window.VMPlaylist = VMPlaylist;
