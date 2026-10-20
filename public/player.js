/* vu-movie — the playlist web player.
 *
 * Modelled on the browser player of stalker-proxy-manager (same family:
 * mpegts.js over a plain same-origin MPEG-TS relay URL), with one deliberate
 * difference: instead of a dropdown, every title of the playlist is shown as
 * a poster card, so picking (or switching) a title is always one click.
 *
 * Data comes from whichever entry the page was opened through:
 *   /pl/<token>/player   → GET /pl/<token>/player.json  (token-guarded, public)
 *   /player              → GET /api/playlist            (login-guarded, admin)
 * Admin mode additionally gets "prepare all" (pre-warm every link) — a
 * token-only visitor can watch, not trigger server work.
 *
 * Playback reuses the existing browser slot: each item's `.ts.web` URL plus
 * VMWebCodecs (the browser reports which codecs it can decode; the relay
 * copies what it can and transcodes the rest), exactly like /watch/<token>
 * and the Playlist tab's preview. The browser slot drops subtitles — the
 * VLC `.ts` link next to the controls keeps them.
 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* "1920×1080" when both dimensions are known, else "1080p", else ''.
   * Keep in agreement with formatResolution (src/core/media.js) and
   * fmtResolution (public/core.js) — this page is standalone and loads
   * neither. */
  function fmtResolution(source) {
    const video = source?.probe?.video || source?.video || source || {};
    const width = Number(video.width) || Number(source?.width) || 0;
    const height = Number(video.height) || Number(source?.height) || 0;
    if (width > 0 && height > 0) return `${width}×${height}`;
    if (typeof source?.resolution === 'string' && source.resolution.includes('×')) return source.resolution;
    if (height > 0) return `${height}p`;
    return String(source?.quality || '').trim();
  }

  function fmtDuration(seconds) {
    const total = Math.round(Number(seconds) || 0);
    if (!total) return '';
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  const videoEl = $('video');
  const state = {
    items: [],
    name: '',
    mode: 'public',
    token: '',
    kind: 'all',
    q: '',
    sort: 'playlist',
    currentId: '',
    engine: null,
    sawPlaying: false,
    prepareTimer: null,
  };

  const status = (text, kind = '') => {
    const el = $('status');
    el.textContent = text;
    el.className = kind;
  };

  const currentItem = () => state.items.find((item) => item.streamId === state.currentId) || null;

  /* ---------------------------------------------------------------- data */

  function normalizeAdmin(item, index) {
    const probe = item.probe || {};
    return {
      index: index + 1,
      streamId: item.streamId,
      title: item.title || 'Untitled',
      year: item.year || null,
      kind: item.kind || 'movie',
      season: item.season || null,
      episode: item.episode || null,
      description: item.description || item.overview || '',
      poster: item.poster || '',
      sourceId: item.sourceId || '',
      quality: item.quality || null,
      width: Number(item.width) || Number(probe.video?.width) || null,
      height: Number(item.height) || Number(probe.video?.height) || null,
      resolution: fmtResolution(item) || null,
      videoCodec: probe.video?.codec || null,
      audioCodec: (Array.isArray(probe.audio) ? probe.audio[0]?.codec : probe.audio?.codec) || null,
      durationSec: Number(probe.durationSec) || Number(item.durationSec) || null,
      subtitle: { attached: Boolean(item.subtitle?.attached), language: item.subtitle?.language || '' },
      readiness: item.readiness || null,
      urls: item.urls || {},
    };
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
  }

  async function loadItems({ autoplayDeepLink = false } = {}) {
    status('loading the playlist…');
    const params = new URLSearchParams(location.search);
    const pathToken = (/^\/pl\/([^/]+)\/player(?:\.html)?$/.exec(location.pathname) || [])[1] || '';
    state.token = params.get('playlist') || params.get('token') || pathToken;

    if (state.token) {
      state.mode = 'public';
      const data = await fetchJson(`/pl/${encodeURIComponent(state.token)}/player.json`);
      state.name = data.name || 'vu-movie playlist';
      state.items = (data.items || []).map((item) => ({ ...item, resolution: fmtResolution(item) || null }));
    } else {
      state.mode = 'admin';
      const data = await fetchJson('/api/playlist');
      state.name = data.name || 'vu-movie playlist';
      state.items = (data.items || []).filter((item) => item.enabled).map(normalizeAdmin);
    }

    $('btn-prepare').hidden = state.mode !== 'admin';
    document.title = `${state.name} — web player`;
    renderGrid();
    const movies = state.items.filter((item) => item.kind !== 'series').length;
    const series = state.items.length - movies;
    $('foot').textContent = `${state.name} · ${state.items.length} title(s) — ${movies} movie(s), ${series} series episode(s) · `
      + 'browser playback drops subtitles; use "copy VLC link" for a player that keeps them.';
    status(state.items.length
      ? `${state.items.length} title(s) ready — click a poster to play it.`
      : 'The playlist has no enabled titles yet — add some in the admin UI.', state.items.length ? 'ok' : '');

    if (autoplayDeepLink) {
      const wanted = params.get('play') || decodeURIComponent(location.hash.replace(/^#/, ''));
      const item = state.items.find((entry) => entry.streamId === wanted);
      if (item) play(item, { muted: true });
    }
  }

  /* ------------------------------------------------------------ rendering */

  function visibleItems() {
    let items = state.items.slice();
    if (state.kind !== 'all') items = items.filter((item) => item.kind === state.kind);
    if (state.q) {
      const q = state.q.toLowerCase();
      items = items.filter((item) => `${item.title} ${item.year || ''}`.toLowerCase().includes(q));
    }
    if (state.sort === 'title') items.sort((a, b) => a.title.localeCompare(b.title));
    if (state.sort === 'year') items.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0) || a.title.localeCompare(b.title));
    return items;
  }

  function readinessChip(readiness) {
    if (!readiness) return '';
    if (readiness.preparing) return '<span class="tag warn">preparing…</span>';
    if (readiness.state === 'ready') return '<span class="tag ok">ready</span>';
    if (readiness.state === 'ready-unverified') return '<span class="tag ok">ready (unverified)</span>';
    if (readiness.state === 'needs-attention') return '<span class="tag err">needs attention</span>';
    return '';
  }

  function cardMarkup(item) {
    const initials = esc(String(item.title || '?').split(/\s+/).slice(0, 2).map((word) => word[0] || '').join('').toUpperCase());
    const resolution = fmtResolution(item);
    const ep = item.season || item.episode
      ? `S${String(item.season || 0).padStart(2, '0')}E${String(item.episode || 0).padStart(2, '0')}`
      : '';
    const meta = [item.year || '', fmtDuration(item.durationSec), item.videoCodec || '']
      .filter(Boolean).join(' · ');
    const playing = item.streamId === state.currentId;
    return `<button type="button" class="item${playing ? ' playing' : ''}" data-play="${esc(item.streamId)}"
      title="Play ${esc(item.title)}${resolution ? ` (${esc(resolution)})` : ''}">
      <span class="poster"><span class="initials">${initials}</span>
        ${item.poster ? `<img src="${esc(item.poster)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
        <span class="badge kind">${item.kind === 'series' ? 'series' : 'movie'}</span>
        ${resolution ? `<span class="badge res">${esc(resolution)}</span>` : ''}
        ${ep ? `<span class="badge ep">${esc(ep)}</span>` : ''}
        <span class="playhint">${playing ? '♪ now playing' : '▶'}</span>
      </span>
      <span class="body">
        <span class="title">${esc(item.title)}</span>
        ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
        <span class="chips">${readinessChip(item.readiness)}${item.subtitle?.attached ? '<span class="tag info">subs in VLC</span>' : ''}</span>
      </span>
    </button>`;
  }

  function renderGrid() {
    const items = visibleItems();
    $('grid').innerHTML = items.map(cardMarkup).join('');
    $('count').textContent = `${items.length} of ${state.items.length} title(s)`;
    const empty = $('empty');
    empty.hidden = items.length > 0;
    if (!items.length) {
      empty.textContent = state.items.length
        ? 'No titles match the filter.'
        : 'No enabled titles in this playlist yet — add titles in the admin UI, then reload.';
    }
  }

  function renderNow(item) {
    const poster = $('now-poster');
    if (item?.poster) { poster.src = item.poster; poster.hidden = false; } else { poster.hidden = true; poster.removeAttribute('src'); }
    $('now-title').textContent = item ? `${item.title}${item.year ? ` (${item.year})` : ''}` : 'Pick a title below';
    const pieces = item ? [
      fmtResolution(item),
      item.videoCodec || '',
      fmtDuration(item.durationSec),
      item.season || item.episode ? `S${String(item.season || 0).padStart(2, '0')}E${String(item.episode || 0).padStart(2, '0')}` : '',
      item.sourceId || '',
      item.subtitle?.attached ? 'subtitle attached (VLC link)' : '',
    ].filter(Boolean) : [];
    $('now-meta').textContent = item
      ? (pieces.join(' · ') || 'playing from the playlist')
      : 'Every enabled title of the playlist is one click away — no dropdown to dig through.';
    $('btn-copy-vlc').hidden = !item?.urls?.ts;
  }

  function highlightCurrent() {
    document.querySelectorAll('.item').forEach((el) => {
      const on = el.dataset.play === state.currentId;
      el.classList.toggle('playing', on);
      const hint = el.querySelector('.playhint');
      if (hint) hint.textContent = on ? '♪ now playing' : '▶';
    });
  }

  /* ------------------------------------------------------------- playback */

  function destroyEngine() {
    if (state.engine) {
      const engine = state.engine;
      state.engine = null;
      try { engine.pause(); } catch { /* already stopped */ }
      try { engine.unload(); } catch { /* already stopped */ }
      try { engine.detachMediaElement(); } catch { /* already stopped */ }
      try { engine.destroy(); } catch { /* already stopped */ }
    }
    try { videoEl.pause(); } catch { /* already stopped */ }
    videoEl.removeAttribute('src');
    videoEl.load();
  }

  function attemptPlay(muted) {
    videoEl.muted = muted;
    const promise = videoEl.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => {
        if (!muted) { attemptPlay(true); status('playing muted — the browser blocked sound; use “enable sound”.'); }
      });
    }
  }

  function explainRelayError(item, detail) {
    return detail
      ? `“${item.title}” could not start: ${detail} The relay prints the real reason in vu-movie → Logs.`
      : `“${item.title}” sent no playable video. If the source is dead, use “prepare all” (admin) to repair it, `
        + 'or re-check the title in the admin UI; the Logs tab has the ffmpeg output.';
  }

  function play(item, { muted = false } = {}) {
    if (!item?.urls?.web) { status('This title has no browser play URL.', 'err'); return; }
    destroyEngine();
    state.currentId = item.streamId;
    state.sawPlaying = false;
    try { history.replaceState(null, '', `#${encodeURIComponent(item.streamId)}`); } catch { /* file:// */ }
    renderNow(item);
    highlightCurrent();
    status(`loading “${item.title}”${item.readiness?.ready ? ' (prepared link — should start at once)' : ''}…`);

    const url = window.VMWebCodecs ? window.VMWebCodecs.previewUrl(item.urls.web) : item.urls.web;
    if (window.mpegts && window.mpegts.isSupported()) {
      const engine = window.mpegts.createPlayer(
        { type: 'mpegts', isLive: true, url },
        {
          enableStashBuffer: true,
          stashInitialSize: 4096,
          enableWorker: true,
          lazyLoad: false,
          liveBufferLatencyChasing: true,
          liveBufferLatencyMaxLatency: 8,
          liveBufferLatencyMinRemain: 1,
        },
      );
      state.engine = engine;
      engine.attachMediaElement(videoEl);
      engine.on(window.mpegts.Events.MEDIA_INFO, (info) => {
        if (state.engine !== engine) return;
        const dims = info && info.width ? ` · ${info.width}×${info.height}` : '';
        status(`playing “${item.title}”${dims}${info?.mimeType ? ` · ${info.mimeType}` : ''}`, 'ok');
      });
      engine.on(window.mpegts.Events.ERROR, () => {
        if (state.engine !== engine) return;
        status(explainRelayError(item), 'err');
      });
      engine.on(window.mpegts.Events.LOADING_COMPLETE, () => {
        if (state.engine !== engine) return;
        advanceIfEnded();
      });
      engine.load();
    } else {
      videoEl.src = url;
    }
    attemptPlay(muted);
    videoEl.scrollIntoView({ block: 'nearest' });
  }

  function playById(id) {
    const item = state.items.find((entry) => entry.streamId === id);
    if (item) play(item);
  }

  function step(delta) {
    if (!state.items.length) return;
    const index = state.items.findIndex((item) => item.streamId === state.currentId);
    const next = index < 0
      ? state.items[delta > 0 ? 0 : state.items.length - 1]
      : state.items[(index + delta + state.items.length) % state.items.length];
    if (next) play(next);
  }

  function advanceIfEnded() {
    if (!$('opt-autonext').checked || !state.sawPlaying) return;
    const order = state.items;
    const index = order.findIndex((item) => item.streamId === state.currentId);
    const next = order[index + 1];
    if (next) {
      status(`finished — next: “${next.title}”`);
      play(next, { muted: videoEl.muted });
    } else {
      status('end of the playlist.', 'ok');
    }
  }

  videoEl.addEventListener('playing', () => {
    state.sawPlaying = true;
    const item = currentItem();
    if (item) status(`playing “${item.title}”`, 'ok');
  });
  videoEl.addEventListener('waiting', () => { if (state.currentId) status('buffering…'); });
  videoEl.addEventListener('ended', advanceIfEnded);
  videoEl.addEventListener('error', () => {
    const item = currentItem();
    if (item && !state.engine) status(explainRelayError(item, videoEl.error ? `media error ${videoEl.error.code}.` : ''), 'err');
  });

  /* -------------------------------------------------------------- controls */

  $('grid').addEventListener('click', (event) => {
    const card = event.target.closest('[data-play]');
    if (card) playById(card.dataset.play);
  });
  $('btn-prev').addEventListener('click', () => step(-1));
  $('btn-next').addEventListener('click', () => step(1));
  $('btn-sound').addEventListener('click', () => {
    videoEl.muted = false;
    videoEl.volume = 1;
    attemptPlay(false);
  });
  $('btn-fullscreen').addEventListener('click', () => {
    const frame = videoEl.closest('.video-frame') || videoEl;
    if (frame.requestFullscreen) frame.requestFullscreen().catch(() => {});
  });
  $('btn-stop').addEventListener('click', () => {
    destroyEngine();
    state.currentId = '';
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* file:// */ }
    renderNow(null);
    highlightCurrent();
    status('stopped — pick a title below.');
  });
  $('btn-copy-vlc').addEventListener('click', async () => {
    const item = currentItem();
    if (!item?.urls?.ts) return;
    try {
      await navigator.clipboard.writeText(item.urls.ts);
      status('VLC link copied — it keeps the attached subtitles.', 'ok');
    } catch {
      status(`VLC link: ${item.urls.ts}`);
    }
  });
  $('btn-reload').addEventListener('click', () => {
    loadItems().catch((error) => status(`could not reload the playlist: ${error.message}`, 'err'));
  });

  document.querySelectorAll('[data-kind]').forEach((pill) => {
    pill.addEventListener('click', () => {
      state.kind = pill.dataset.kind;
      document.querySelectorAll('[data-kind]').forEach((el) => el.classList.toggle('on', el === pill));
      renderGrid();
    });
  });
  $('q').addEventListener('input', (event) => { state.q = event.target.value.trim(); renderGrid(); });
  $('sort').addEventListener('change', (event) => { state.sort = event.target.value; renderGrid(); });

  document.addEventListener('keydown', (event) => {
    const tag = String(event.target?.tagName || '');
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
    if (event.key === '/') { event.preventDefault(); $('q').focus(); }
    if (event.key === 'ArrowRight') step(1);
    if (event.key === 'ArrowLeft') step(-1);
  });

  /* ---------------------------------------------- prepare all (admin only) */

  function stopPreparePolling(note) {
    if (state.prepareTimer) { clearInterval(state.prepareTimer); state.prepareTimer = null; }
    $('btn-prepare').disabled = false;
    if (note !== undefined) $('prepare-note').textContent = note;
  }

  async function pollReadiness() {
    try {
      const data = await fetchJson('/api/playlist/readiness');
      const byItem = new Map((data.items || []).map((entry) => [entry.streamId, entry.readiness]));
      let preparing = 0;
      for (const item of state.items) {
        const readiness = byItem.get(item.streamId);
        if (readiness) item.readiness = readiness;
        if (readiness?.preparing) preparing += 1;
      }
      renderGrid();
      if (!preparing) {
        const ready = (data.items || []).filter((entry) => entry.readiness?.ready).length;
        stopPreparePolling(`prepared: ${ready}/${state.items.length} ready`);
      } else {
        $('prepare-note').textContent = `preparing ${preparing} title(s)…`;
      }
    } catch (error) {
      stopPreparePolling(`preparation status lost: ${error.message}`);
    }
  }

  $('btn-prepare').addEventListener('click', async () => {
    const btn = $('btn-prepare');
    btn.disabled = true;
    $('prepare-note').textContent = 'preparing every title…';
    try {
      const data = await fetchJson('/api/playlist/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      $('prepare-note').textContent = data.message || 'preparation started';
      stopPreparePolling($('prepare-note').textContent);
      btn.disabled = true;
      pollReadiness();
      state.prepareTimer = setInterval(pollReadiness, 4000);
      setTimeout(() => stopPreparePolling(), 10 * 60 * 1000);
    } catch (error) {
      stopPreparePolling(`prepare failed: ${error.message}`);
    }
  });

  loadItems({ autoplayDeepLink: true }).catch((error) => {
    $('empty').hidden = false;
    $('empty').textContent = `Could not load the playlist: ${error.message}. `
      + 'Open the player from the admin UI (Stream/Playlist tab) or via your playlist link.';
    status(`could not load the playlist: ${error.message}`, 'err');
  });
})();
