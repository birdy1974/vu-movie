/* vu-movie — shared UI foundation (loaded first, used by every other file).
 *
 * The UI is plain classic scripts, no framework and no build step: this file
 * carries the helpers (DOM, fetch, toasts, modal, formatting) and the one shared
 * `state` object, so playlist.js, ffmpeg-editor.js and app.js all work on the
 * same data without importing anything.
 */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------------- compatibility ---------------- */

/**
 * Deep clone for plain JSON data (config, FFmpeg templates).
 *
 * `structuredClone` only exists in newer browsers (Chrome 98+, Safari 15.4+,
 * Firefox 94+). Without it, `structuredClone(config)` threw and left the whole
 * Settings grid empty, and the Test tab never loaded its template — so this is
 * shimmed here and the call sites keep using the standard name.
 */
function cloneJson(value) {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}
if (typeof globalThis.structuredClone !== 'function') globalThis.structuredClone = (value) => cloneJson(value);

/* ---------------- storage ---------------- */

function readStoredJson(key) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch { return null; }
}

function readStoredText(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function writeStoredText(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* storage may be disabled */ }
}

/* ---------------- formatting ---------------- */

const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtBytes = (n) => (n > 1073741824 ? `${(n / 1073741824).toFixed(1)} GB`
  : n > 1048576 ? `${(n / 1048576).toFixed(0)} MB`
    : n > 1024 ? `${Math.round(n / 1024)} KB` : `${Math.round(n || 0)} B`);

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '—');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

function fmtDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (!total) return '—';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

const tag = (text, kind = '') => `<span class="tag ${kind}">${escapeHtml(text)}</span>`;

/* ---------------- API + toasts ---------------- */

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
  const host = $('#toasts');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => node.remove(), ms);
}

/**
 * `POST` a JSON body and read the answer as Server-Sent Events.
 *
 * The live ffmpeg test uses this: EventSource cannot send a body and cannot be
 * aborted cleanly, but fetch() can do both. Returns a handle with `abort()`.
 */
function apiSse(path, body, handlers = {}) {
  const controller = new AbortController();
  const run = (async () => {
    let response;
    try {
      response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name !== 'AbortError') handlers.onError?.(error);
      return;
    }
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try { message = (await response.json())?.error || message; } catch { /* not JSON */ }
      handlers.onError?.(new Error(message));
      return;
    }
    const reader = response.body?.getReader();
    if (!reader) {
      handlers.onError?.(new Error('the browser cannot stream this response'));
      return;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = { name: 'message', data: '' };
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event.name = line.slice(6).trim();
            else if (line.startsWith('data:')) event.data += line.slice(5).trim();
          }
          if (event.data) {
            let payload = null;
            try { payload = JSON.parse(event.data); } catch { payload = { raw: event.data }; }
            handlers[event.name]?.(payload);
          }
          index = buffer.indexOf('\n\n');
        }
      }
      handlers.onEnd?.();
    } catch (error) {
      if (error?.name !== 'AbortError') handlers.onError?.(error);
    }
  })();
  return { abort: () => controller.abort(), done: run };
}

/* ---------------- modal ---------------- */

function openModal({ title = '', body = '', className = '', onMount = null } = {}) {
  const root = $('#modal-root');
  if (!root) return;
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('.modal', root).className = `modal ${className}`;
  root.classList.remove('hide');
  onMount?.($('#modal-body'));
}

function closeModal() {
  $('#modal-root')?.classList.add('hide');
  const body = $('#modal-body');
  if (body) body.innerHTML = '';
}

function isPhone() {
  return window.matchMedia('(max-width: 760px)').matches;
}

function debounce(fn, ms = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* ---------------- clipboard ---------------- */

async function copyText(text) {
  const value = String(text ?? '');
  if (!value) {
    toast('Nothing to copy', 'warn');
    return false;
  }
  // The Clipboard API needs a secure context; vu-movie is usually opened over
  // plain HTTP on the LAN, so keep the synchronous fallback.
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      toast('Copied to the clipboard', 'ok', 2500);
      return true;
    } catch { /* fall through while the click is still active */ }
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  Object.assign(textarea.style, { position: 'fixed', top: '0', left: '-9999px', opacity: '0', pointerEvents: 'none' });
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { /* unsupported */ }
  textarea.remove();
  if (copied) {
    toast('Copied to the clipboard', 'ok', 2500);
    return true;
  }
  toast('Copy failed — select the text manually', 'warn');
  return false;
}

/* ---------------- shared state ---------------- */

const APP_PAGES = ['mobile', 'dash', 'find', 'subs', 'tpl', 'list', 'stream', 'tpl-test', 'logs', 'set'];

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

const state = {
  health: null,
  sources: [],
  selectedSources: [],
  results: [],
  providerErrors: [],
  streams: [],
  providers: [],
  subResults: [],
  findSubtitleResults: [],
  config: null,
  logs: [],
  jobs: [],
  sessions: [],
  ffmpegTemplates: [],
  ffmpegTemplateSchema: null,
  ffmpegTemplatesLoaded: false,
  defaultFfmpegTemplateId: '',
  ffmpegDefaults: {},
  /* playlist.js fills these */
  playlist: { items: [], available: [], urls: null, summary: null, templates: [], loaded: false },
  /* ffmpeg-editor.js fills these */
  editors: {},
};

/** Filled in by app.js; other files only ever call into it. */
const App = {
  copy: copyText,
  go: () => {},
  openModal,
  closeModal,
};

if (typeof window !== 'undefined') window.App = App;
