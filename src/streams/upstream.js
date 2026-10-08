/**
 * vu-movie — chunked upstream proxy ("how the complete movie keeps playing").
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Several CDNs that serve the scraped movies deliver video with a chunked
 * transfer that they simply *end* after a few minutes of footage (and some
 * rotate the signing or drop long-lived connections altogether). Handing such
 * a URL to ffmpeg means: one connection, one EOF, playback stops at ~3 min.
 *
 * MovieBox-TUI (mesamirh/MovieBox-TUI, MIT/Apache-2.0) solves exactly this by
 * never letting the player talk to the CDN: a local sidecar pulls every piece
 * of media in **many small HTTP Range requests** (95 KB per sub-request, see
 * `fetch_m4s_chunked` / `DASH_RANGE_CHUNK_BYTES` in its `proxy.rs`), replays
 * the auth headers on every one of them, rewrites DASH manifests so every
 * segment loops back through the proxy, and caches/prefetches segments. A
 * connection the CDN cuts after a few MB only loses that one 95 KB request —
 * the next request resumes at the last complete byte.
 *
 * This module ports that core mechanism into the relay:
 *
 *   - `file` sources (progressive mp4/mkv/ts mirrors) are served to ffmpeg
 *     from `/up/<secret>/f` with a real Content-Length and Accept-Ranges,
 *     backed by a chunk-aligned fetcher with per-chunk retries and an LRU
 *     byte cache (so ffmpeg can seek into the moov atom and reconnects are
 *     cheap). A CDN that ignores Range is captured to a temp file under
 *     `storage.tmp/upstream/` instead, removed when the session closes;
 *   - `dash` sources get their MPD fetched with the source headers and
 *     rewritten so every init/segment URL points back at
 *     `/up/<secret>/dash/...`; each segment is assembled from ranged
 *     sub-requests exactly like the TUI does, then cached;
 *   - the upstream headers (signed Cookie, Referer, UA) are replayed on
 *     **every** CDN request, never just on the first one.
 *
 * What is deliberately NOT ported (see docs/MOVIEBOX-TUI-COMPARISON.md):
 * segment *prefetch* (ffmpeg paces its own reads), the max_height filter (the
 * relay's profile/transcode decides the resolution), and a separate sidecar
 * process (this runs in-process on the app's own port, protected by a random
 * 96-bit per-session secret).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log, errorText, truncate } from '../core/log.js';
import { getConfig } from '../core/config.js';
import { headerObject, streamKind } from '../core/media.js';

/* ------------------------------------------------------------------ tunables */

const MAX_MANIFEST_BYTES = 10 * 1024 * 1024; // TUI: MAX_MANIFEST_BYTES
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;  // TUI: MAX_SEGMENT_BYTES
const IDLE_CLOSE_MS = 10 * 60 * 1000;        // TUI: WATCHDOG_IDLE_SECS

function tune() {
  const t = getConfig().transcode || {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    chunkBytes: Math.min(Math.max(num(t.upstreamChunkBytes, 1024 * 1024), 64 * 1024), 8 * 1024 * 1024),
    segmentChunkBytes: Math.min(Math.max(num(t.upstreamSegmentChunkBytes, 95 * 1024), 16 * 1024), 4 * 1024 * 1024),
    parallel: Math.min(Math.max(Math.round(num(t.upstreamParallel, 4)), 1), 16),
    cacheBytes: Math.max(8, num(t.upstreamCacheMb, 64)) * 1024 * 1024,
    requestTimeoutMs: num(t.upstreamRequestTimeoutMs, 30000),
    maxAttempts: 6,
  };
}

function localBase() {
  // ffmpeg runs in the same container as the HTTP server, so the loopback
  // address is always reachable regardless of what BASE_URL advertises.
  return `http://127.0.0.1:${getConfig().app.port}`;
}

const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
const backoff = (attempt) => Math.min(4000, 250 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200);

/* ------------------------------------------------------------------ registry */

/** secret → proxy session. The secret is the only access control needed: it is
 *  a random 96-bit string, same pattern as the /s/<token>/ stream URLs. */
const proxies = new Map();

/**
 * Pure: parse an HTTP Range request header against a known total size.
 * `total` may be null (unknown size) — then only the start is validated.
 */
export function parseClientRange(header, total) {
  const known = Number.isFinite(total) && total > 0 ? total : null;
  const spec = String(header || '').trim();
  if (!spec.startsWith('bytes=')) return null;
  const [startRaw, endRaw] = spec.slice(6).split('-', 2).map((s) => String(s).trim());
  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0) return null;
  if (known !== null && start >= known) return null;
  let end = endRaw === '' || endRaw === undefined ? Infinity : Number(endRaw);
  if (!Number.isFinite(end)) end = Infinity;
  if (known !== null) end = Math.min(end, known - 1);
  if (end < start) return null;
  return { start, end };
}

/* ------------------------------------------------------------------ *
 * chunked fetch engine
 *
 * Every CDN request is small and individually retryable. A connection the CDN
 * cuts mid-body is not an error for the playback — the partial bytes are kept
 * and the very next request resumes at the last complete byte.
 * ------------------------------------------------------------------ */

class ChunkedFetchError extends Error {
  constructor(message, { status = null, permanent = false, body = '' } = {}) {
    super(body ? `${message} — ${body}` : message);
    this.status = status;
    this.permanent = permanent;
  }
}

/**
 * One ranged request to the CDN. Reads the body incrementally so a truncated
 * transfer still returns the bytes that arrived (the caller resumes from
 * there) instead of throwing them away.
 *
 * Returns { status, buf, total, contentLength, truncated, cancelled }:
 *   status    — 206 (range honoured) or 200 (server ignored Range)
 *   total     — full object size from Content-Range, or null
 *   truncated — the CDN cut the body (buf holds what arrived before the cut)
 *   cancelled — a 200 body was stopped early at `maxBytes` (buf is the head
 *               of the object; the rest was NOT downloaded)
 *
 * A 200 answer is the whole object from byte 0. Callers pass `maxBytes` (the
 * end of the window they need), so a range-less server is read only that far.
 */
async function rangedRequest(session, url, start, end, signal, { maxBytes = Infinity } = {}) {
  const headers = { ...session.headers, Range: `bytes=${start}-${end}` };
  session.stats.cdnRequests += 1;
  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.any([session.abort.signal, AbortSignal.timeout(session.tune.requestTimeoutMs), ...(signal ? [signal] : [])]),
  });

  if (res.status === 416) throw new ChunkedFetchError('HTTP 416 range not satisfiable (past EOF?)', { status: 416, permanent: true });
  if (!res.ok) {
    // Drain a little of the body so the error message is useful in the log.
    const body = await res.text().catch(() => '');
    throw new ChunkedFetchError(`HTTP ${res.status} from upstream`, {
      status: res.status,
      permanent: [401, 403, 404, 410].includes(res.status),
      body: truncate(body, 160),
    });
  }

  const totalHeader = res.headers.get('content-range');
  let total = null;
  if (totalHeader) {
    const m = /\/(\d+)\s*$/.exec(totalHeader);
    if (m) total = Number(m[1]);
  }
  // A 200 answer (Range ignored) can still tell us the full size via
  // Content-Length; a chunked 200 cannot (total stays unknown).
  let contentLength = null;
  if (res.status === 200) {
    const cl = Number(res.headers.get('content-length'));
    if (Number.isFinite(cl) && cl > 0) contentLength = cl;
  }
  const contentType = res.headers.get('content-type') || null;

  // Read a 200 only as far as the caller needs, then cancel the rest of the
  // body. Without this, a range-less CDN would have the whole movie pulled
  // into memory before the first byte is served.
  const limit = res.status === 200 ? maxBytes : Infinity;
  const chunks = [];
  let received = 0;
  let truncated = false;
  let cancelled = false;
  try {
    for await (const part of res.body) {
      chunks.push(Buffer.from(part));
      received += part.byteLength;
      if (received >= limit) { cancelled = true; break; }
    }
  } catch (err) {
    truncated = true;
    session.stats.truncations += 1;
    log.debug('upstream', `CDN cut the transfer after ${received} bytes — resuming with the next ranged request`, {
      session: session.id, url: truncate(url, 110), error: errorText(err),
    });
  }
  const all = Buffer.concat(chunks);
  const buf = all.length > limit ? all.subarray(0, limit) : all;
  session.stats.cdnBytes += received;
  session.lastActivity = Date.now();
  return { status: res.status, buf, total, contentLength, truncated, cancelled, contentType };
}

/**
 * Fetch the byte window [start, end] as a chain of small ranged requests with
 * retries. This is the direct analogue of MovieBox-TUI's `fetch_m4s_chunked`,
 * minus the fixed segment semantics (a window can be any size).
 */
async function fetchByteWindow(session, url, start, end, signal) {
  const parts = [];
  let pos = start;
  let consecutiveErrors = 0;
  let firstStatus = null;
  let firstContentType = null;
  // Per-window, NOT session-wide: in DASH mode every segment has its own
  // size, so a total discovered here must never leak into other objects
  // (that cut later segment fetches short at the first segment's size).
  let windowTotal = null;
  while (pos <= end) {
    if (session.abort.signal.aborted) throw new ChunkedFetchError('proxy session closed');
    if (signal?.aborted) throw new ChunkedFetchError('client went away');
    const reqEnd = Math.min(end, pos + session.tune.chunkBytes - 1);
    try {
      // On a 200 the body is read from byte 0 up to `end` only (the window's
      // end is all we need), never the rest of the object.
      const { status, buf, total, contentLength, contentType, truncated, cancelled } = await rangedRequest(
        session, url, pos, reqEnd, signal, { maxBytes: end + 1 },
      );
      if (total != null && windowTotal == null) windowTotal = total;
      if (status === 200) {
        // The server ignored Range and answered with the whole object from
        // byte 0. Keep what falls inside the requested window; the caller
        // (file store) additionally caches the head for probe/moov reads.
        const usable = pos === 0 ? buf : buf.subarray(Math.min(buf.length, pos));
        if (!usable.length) throw new ChunkedFetchError('range-less server sent no usable bytes');
        return { buf: usable, fromFullObject: buf, total, contentLength, truncated, cancelled };
      }
      if (!buf.length) throw new ChunkedFetchError('empty 206 response');
      if (firstStatus == null) { firstStatus = status; firstContentType = contentType; }
      parts.push(buf);
      pos += buf.length;
      consecutiveErrors = 0;
      if (windowTotal != null && pos >= windowTotal) break;
    } catch (err) {
      if (err instanceof ChunkedFetchError && err.permanent) throw err;
      if (err?.name === 'TimeoutError') session.stats.timeouts += 1;
      consecutiveErrors += 1;
      session.stats.retries += 1;
      if (consecutiveErrors >= session.tune.maxAttempts) {
        throw new ChunkedFetchError(`giving up after ${consecutiveErrors} failed attempts: ${errorText(err)}`);
      }
      log.debug('upstream', `ranged request failed — retry ${consecutiveErrors}/${session.tune.maxAttempts}`, {
        session: session.id, pos, error: errorText(err),
      });
      await sleep(backoff(consecutiveErrors));
    }
  }
  // The FIRST response decides the semantics (Range honoured or ignored) —
  // later retries of the same window all behave the same way.
  return { buf: Buffer.concat(parts), status: firstStatus ?? 206, contentType: firstContentType, total: windowTotal };
}

/**
 * Fetch one object (a DASH segment / init) the way MovieBox-TUI does: probe
 * with one small ranged request, then pull the remainder in parallel ranged
 * sub-requests; assemble in memory.
 */
async function fetchObjectChunked(session, url, signal) {
  const chunk = session.tune.segmentChunkBytes;
  let first = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // A range-less 200 is read only up to the segment cap (one byte over it
    // is enough to know it is too large).
    first = await rangedRequest(session, url, 0, chunk - 1, signal, { maxBytes: MAX_SEGMENT_BYTES + 1 });
    // A truncated 200 cannot be resumed with Range on this server — retry it
    // wholesale. A truncated 206 resumes below through the remaining ranges.
    if (!(first.truncated && first.status === 200)) break;
    if (attempt < 3) await sleep(backoff(attempt));
  }
  if (first.truncated && first.status === 200) throw new ChunkedFetchError('the CDN keeps truncating this segment');
  if (!first.buf.length) throw new ChunkedFetchError('empty segment response');
  if (first.status === 200) {
    if (first.buf.length > MAX_SEGMENT_BYTES) throw new ChunkedFetchError('object too large');
    return { buf: first.buf, contentType: first.contentType };
  }
  const total = first.total;
  if (total == null || total <= first.buf.length || total > MAX_SEGMENT_BYTES) {
    return { buf: first.buf, contentType: first.contentType };
  }

  const ranges = [];
  for (let pos = first.buf.length; pos < total; pos += chunk) {
    ranges.push([pos, Math.min(pos + chunk - 1, total - 1)]);
  }
  const pieces = [first.buf];
  for (let i = 0; i < ranges.length; i += session.tune.parallel) {
    const batch = ranges.slice(i, i + session.tune.parallel);
    const results = await Promise.all(batch.map(([s, e]) => fetchByteWindow(session, url, s, e, signal)));
    for (const r of results) pieces.push(r.buf);
  }
  return { buf: Buffer.concat(pieces), contentType: first.contentType };
}

/* ------------------------------------------------------------------ *
 * byte cache for progressive files — chunk-aligned, LRU, head-pinned.
 * ------------------------------------------------------------------ */

class ByteStore {
  constructor(budgetBytes, chunkSize) {
    this.chunkSize = chunkSize;
    this.budget = budgetBytes;
    this.chunks = new Map(); // index → { buf, usedAt }
    this.size = 0;
  }

  index(offset) { return Math.floor(offset / this.chunkSize); }

  /** Store bytes; only complete chunks (and a flagged final one) are kept. */
  put(offset, buf, { allowPartialTail = false, total = null } = {}) {
    let pos = offset;
    let rest = buf;
    while (rest.length > 0) {
      const idx = this.index(pos);
      const chunkStart = idx * this.chunkSize;
      const skip = pos - chunkStart;
      if (skip !== 0 && this.chunks.has(idx)) {
        // A partial write into an already-held chunk: merge.
        const have = this.chunks.get(idx).buf;
        if (skip <= have.length) {
          const merged = Buffer.concat([have.subarray(0, skip), rest.subarray(0, Math.min(rest.length, this.chunkSize - skip))]);
          this.size += merged.length - have.length;
          this.chunks.set(idx, { buf: merged, usedAt: Date.now() });
        }
        const advance = Math.max(this.chunkSize - skip, 1);
        rest = rest.subarray(Math.min(rest.length, advance));
        pos += advance;
        continue;
      }
      const piece = rest.subarray(0, this.chunkSize - skip);
      const complete = piece.length === this.chunkSize
        || (allowPartialTail && total != null && chunkStart + piece.length === total);
      if (skip === 0 && (complete || piece.length > 0)) {
        // Store whatever we have; a leading chunk is worth it even partial
        // because the probe/moov reads hit it.
        const prev = this.chunks.get(idx);
        if (!prev || piece.length > prev.buf.length) {
          this.size += piece.length - (prev?.buf.length || 0);
          this.chunks.set(idx, { buf: Buffer.from(piece), usedAt: Date.now() });
        }
      }
      rest = rest.subarray(piece.length);
      pos += piece.length;
    }
    this.evict();
  }

  /** Fully-cached window or null. */
  get(start, len) {
    const end = start + len;
    const out = [];
    for (let pos = start; pos < end;) {
      const idx = this.index(pos);
      const entry = this.chunks.get(idx);
      const chunkStart = idx * this.chunkSize;
      if (!entry) return null;
      const from = pos - chunkStart;
      const to = Math.min(entry.buf.length, end - chunkStart);
      if (to <= from) return null;
      out.push(entry.buf.subarray(from, to));
      entry.usedAt = Date.now();
      pos = chunkStart + to;
    }
    return Buffer.concat(out);
  }

  evict() {
    while (this.size > this.budget && this.chunks.size > 1) {
      let oldestKey = null;
      let oldestAt = Infinity;
      // Chunk 0 is head-pinned (probe/moov reads hit it constantly): only
      // evict it when it is the only chunk left over budget.
      for (const [key, entry] of this.chunks) {
        if (key === 0 && this.chunks.size > 2) continue;
        if (entry.usedAt < oldestAt) { oldestAt = entry.usedAt; oldestKey = key; }
      }
      if (oldestKey === null) {
        const entry = this.chunks.get(0);
        if (!entry || this.chunks.size <= 1) break;
        oldestKey = 0;
      }
      this.size -= this.chunks.get(oldestKey).buf.length;
      this.chunks.delete(oldestKey);
    }
  }
}

/* ------------------------------------------------------------------ *
 * DASH segment cache — LRU by bytes, with in-flight dedupe (both straight
 * from the TUI's SegmentCache).
 * ------------------------------------------------------------------ */

class SegmentCache {
  constructor(budgetBytes) {
    this.budget = budgetBytes;
    this.done = new Map();       // url → { buf, contentType, usedAt }
    this.inFlight = new Map();   // url → Promise
    this.size = 0;
  }

  get(url) {
    const entry = this.done.get(url);
    if (!entry) return null;
    entry.usedAt = Date.now();
    return entry;
  }

  async obtain(url, fetcher) {
    const hit = this.get(url);
    if (hit) return { ...hit, cached: true };
    const running = this.inFlight.get(url);
    if (running) return running;
    const promise = (async () => {
      try {
        const { buf, contentType } = await fetcher();
        if (buf.length <= MAX_SEGMENT_BYTES) {
          this.done.set(url, { buf, contentType, usedAt: Date.now() });
          this.size += buf.length;
          this.evict(url);
        }
        return { buf, contentType };
      } finally {
        this.inFlight.delete(url);
      }
    })();
    this.inFlight.set(url, promise);
    return promise;
  }

  evict(keepUrl) {
    while (this.size > this.budget && this.done.size > 1) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, entry] of this.done) {
        if (key === keepUrl) continue;
        if (entry.usedAt < oldestAt) { oldestAt = entry.usedAt; oldestKey = key; }
      }
      if (oldestKey === null) break;
      this.size -= this.done.get(oldestKey).buf.length;
      this.done.delete(oldestKey);
    }
  }
}

/* ------------------------------------------------------------------ *
 * DASH manifest rewriting (regex-based, like the TUI's rewrite_dash_manifest)
 * ------------------------------------------------------------------ */

/**
 * Rewrite an MPD so every init/segment reference points back at the local
 * proxy. `registerUrl/...` callbacks record the original target and return
 * the local replacement. Pure — unit tested.
 *
 * Handles, in document order:
 *   <BaseURL>…</BaseURL>          → local base-prefix mapping (stacked bases)
 *   media="…" / initialization="…" on SegmentTemplate / SegmentURL:
 *     absolute http(s) URLs        → /dash/u/<id>
 *     relative with $Tokens$       → /dash/t/<id>/<template-with-tokens>
 *     relative plain               → resolved against the current base → /dash/u/<id>
 */
export function rewriteDashManifest(text, { mpdUrl, localPrefix, register }) {
  let base = String(mpdUrl);
  let out = '';
  let last = 0;
  const re = /<BaseURL\b[^>]*>([\s\S]*?)<\/BaseURL>|\b(media|initialization)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    out += String(text).slice(last, m.index);
    last = m.index + m[0].length;

    if (m[1] !== undefined) {
      // <BaseURL>…</BaseURL> — resolve it, remember it as the new base for
      // whatever follows, and replace it with a local prefix that maps back.
      const content = m[1].trim();
      let resolved;
      try { resolved = new URL(content, base).toString(); } catch { resolved = content; }
      const id = register({ type: 'base', url: resolved.endsWith('/') ? resolved : `${resolved}/` });
      base = resolved;
      out += `<BaseURL>${localPrefix}/dash/b/${id}/</BaseURL>`;
      continue;
    }

    const attrName = m[2];
    const value = m[4] !== undefined ? m[4] : m[5];
    if (!value) { out += m[0]; continue; }

    if (/^https?:\/\//i.test(value)) {
      const id = register({ type: 'url', url: value });
      out += `${attrName}="${localPrefix}/dash/u/${id}"`;
    } else if (value.includes('$')) {
      // Keep the $Tokens$ intact — ffmpeg expands them; we only reroute.
      const [tmpl, query = ''] = splitQuery(value);
      const dir = baseDirOf(base);
      const id = register({ type: 'template', dir, template: tmpl, query });
      out += `${attrName}="${localPrefix}/dash/t/${id}/${tmpl}"`;
    } else {
      let resolved;
      try { resolved = new URL(value, base).toString(); } catch { resolved = value; }
      const id = register({ type: 'url', url: resolved });
      out += `${attrName}="${localPrefix}/dash/u/${id}"`;
    }
  }
  out += String(text).slice(last);
  return out;
}

function splitQuery(value) {
  const idx = value.indexOf('?');
  return idx < 0 ? [value, ''] : [value.slice(0, idx), value.slice(idx + 1)];
}

function baseDirOf(url) {
  const [noHash] = String(url).split('#');
  const [noQuery, query = ''] = noHash.split('?');
  const dir = noQuery.slice(0, noQuery.lastIndexOf('/') + 1);
  return query ? `${dir}?${query}` : dir;
}

/* ------------------------------------------------------------------ *
 * sessions
 * ------------------------------------------------------------------ */

let idleSweeper = null;

function ensureIdleSweeper() {
  if (idleSweeper) return;
  idleSweeper = setInterval(() => {
    for (const [secret, session] of proxies) {
      if (Date.now() - session.lastActivity > IDLE_CLOSE_MS) {
        log.info('upstream', `closing idle upstream proxy ${session.id} (no fetches for ${Math.round(IDLE_CLOSE_MS / 60000)} min)`);
        closeUpstreamProxy(session, 'idle');
        proxies.delete(secret);
      }
    }
    if (proxies.size === 0) { clearInterval(idleSweeper); idleSweeper = null; }
  }, 60 * 1000);
  idleSweeper.unref?.();
}

/**
 * Create a proxy session for one upstream. Lazy by design: nothing is fetched
 * until ffmpeg asks, so starting a session costs no CDN request.
 */
export async function createUpstreamProxy({ streamId, url, headers = {}, kind = 'file', baseOverride = null }) {
  const t = tune();
  const secret = crypto.randomBytes(12).toString('hex');
  const session = {
    id: `up-${secret.slice(0, 8)}`,
    secret,
    streamId,
    upstreamUrl: url,
    headers: headerObject(headers),
    kind,                                  // 'file' | 'dash'
    base: baseOverride || localBase(),     // tests point this at their own server
    tune: t,
    abort: new AbortController(),
    meta: { total: null, rangeSupported: null, contentType: null },
    metaPromise: null,
    store: kind === 'file' ? new ByteStore(t.cacheBytes, t.chunkBytes) : null,
    segments: kind === 'dash' ? new SegmentCache(t.cacheBytes) : null,
    refs: { byId: new Map(), next: 1 },
    mpd: null,                             // { rewritten, fetchedAt }
    stats: { cdnRequests: 0, cdnBytes: 0, retries: 0, truncations: 0, timeouts: 0, servedBytes: 0, cacheHits: 0 },
    startedAt: Date.now(),
    lastActivity: Date.now(),
    closed: false,
    linear: null,                          // 200-mode background capture (no Range support)
  };
  session.inputUrl = kind === 'dash'
    ? `${session.base}/up/${secret}/m`
    : `${session.base}/up/${secret}/f`;
  proxies.set(secret, session);
  ensureIdleSweeper();
  log.info('upstream', `upstream proxy ready — fetching in ${kind === 'dash' ? '95 KB ranged sub-requests' : `${Math.round(t.chunkBytes / 1024)} KB ranged chunks`} (MovieBox-TUI style)`, {
    session: session.id, stream: streamId, kind, upstream: truncate(url, 110),
  });
  return session;
}

export function closeUpstreamProxy(session, reason = 'stopped') {
  if (!session || session.closed) return;
  session.closed = true;
  try { session.abort.abort(); } catch { /* ignore */ }
  proxies.delete(session.secret);
  removeCaptureFile(session);
  log.info('upstream', `upstream proxy closed (${reason})`, {
    session: session.id, stream: session.streamId,
    cdnRequests: session.stats.cdnRequests, cdnMb: Math.round(session.stats.cdnBytes / 1048576),
    retries: session.stats.retries, truncations: session.stats.truncations,
  });
}

export function proxyStats(session) {
  if (!session) return null;
  return {
    mode: session.kind,
    cdnRequests: session.stats.cdnRequests,
    cdnBytes: session.stats.cdnBytes,
    retries: session.stats.retries,
    truncations: session.stats.truncations,
    servedBytes: session.stats.servedBytes,
    cacheBytes: session.kind === 'file' ? session.store.size : session.segments.size,
    total: session.meta.total,
  };
}

/**
 * Decide whether a relay session should be served through the chunked proxy.
 * HLS stays on the direct path: ffmpeg's HLS demuxer already fetches small
 * segments on its own, and the relay's improved restart logic covers the rest.
 */
export function shouldProxyUpstream(upstream, cfg = getConfig()) {
  if (cfg.transcode.upstreamProxy === false) return false;
  const url = String(upstream?.url || '');
  if (!/^https?:/i.test(url)) return false;
  const kind = upstream.kind || streamKind(url);
  return kind === 'file' || kind === 'dash';
}

/** Convenience wrapper used by the relay: proxy or null (never throws). */
export async function maybeCreateUpstreamProxy({ streamId, upstream }) {
  if (!shouldProxyUpstream(upstream)) return null;
  try {
    return await createUpstreamProxy({
      streamId,
      url: upstream.url,
      headers: upstream.headers,
      kind: upstream.kind || streamKind(upstream.url),
    });
  } catch (err) {
    log.warn('upstream', `could not create the upstream proxy — falling back to a direct fetch`, {
      stream: streamId, error: errorText(err),
    });
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * request serving
 * ------------------------------------------------------------------ */

function sendError(res, code, message) {
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  res.status(code).set('Content-Type', 'text/plain').send(`vu-movie upstream proxy: ${message}`);
}

/** Probe the file source once: total size, Range support, first cached chunk. */
function ensureFileMeta(session, signal) {
  if (!session.metaPromise) {
    session.metaPromise = (async () => {
      const probeEnd = Math.min(session.tune.chunkBytes - 1, 2 * 1024 * 1024);
      const {
        status, buf, total, contentLength, contentType, fromFullObject, truncated, cancelled,
      } = await fetchByteWindow(session, session.upstreamUrl, 0, probeEnd, signal);
      session.meta.contentType = contentType || session.meta.contentType;
      if (fromFullObject) {
        // The CDN ignored Range and streamed the object from byte 0 (we read
        // only as far as the probe needed). The size is known from
        // Content-Length, or from a body that ended by itself inside the
        // probe (a small chunked object). Otherwise the total stays unknown
        // and the linear capture below finishes the object.
        session.meta.rangeSupported = false;
        const knownSize = contentLength != null ? contentLength : (cancelled || truncated ? null : fromFullObject.length);
        if (knownSize != null) session.meta.total = knownSize;
        const complete = knownSize != null && fromFullObject.length >= knownSize;
        session.store.put(0, fromFullObject, { allowPartialTail: complete, total: complete ? fromFullObject.length : null });
        if (!complete) startLinearCapture(session);
        return;
      }
      session.meta.rangeSupported = status === 206;
      // For FILE sources the window total is the whole object's size.
      if (total != null && session.meta.total == null) session.meta.total = total;
      if (status === 206) session.store.put(0, buf, { allowPartialTail: true, total: session.meta.total });
    })().catch((err) => {
      session.metaPromise = null; // a failed probe must not poison later reads
      throw err;
    });
  }
  return session.metaPromise;
}

/** Serve the progressive file to ffmpeg (GET, optional Range). */
async function serveFile(session, req, res) {
  const signal = new AbortController();
  req.on('close', () => signal.abort());
  try {
    await ensureFileMeta(session, signal.signal);
    // While a range-less capture is still running the size is unknown, and a
    // Range request (a seek, a reconnect) can only be answered with it. Hold
    // such a request until the capture has finished. A plain sequential GET
    // is not held: it streams as the capture fills in.
    if (session.meta.total == null && req.headers.range && session.linear && !session.linear.done) {
      await waitForLinearSize(session, signal.signal);
    }
  } catch (err) {
    return sendError(res, 502, `upstream unreachable: ${err.message}`);
  }

  const total = session.meta.total;
  const range = parseClientRange(req.headers.range, total);
  const start = range ? range.start : 0;
  const end = range && Number.isFinite(range.end) ? range.end : (total != null ? total - 1 : Infinity);

  res.setHeader('Accept-Ranges', 'bytes');
  if (session.meta.contentType) res.setHeader('Content-Type', session.meta.contentType);
  res.setHeader('Cache-Control', 'no-store');
  if (total != null) {
    const len = Math.max(0, Math.min(end, total - 1) - start + 1);
    if (range) {
      res.status(206).setHeader('Content-Range', `bytes ${start}-${Math.min(end, total - 1)}/${total}`);
    } else {
      res.status(200);
    }
    res.setHeader('Content-Length', len);
  } else {
    res.status(200); // unknown size → chunked response
    res.setHeader('Transfer-Encoding', 'chunked');
  }
  if (req.method === 'HEAD') return res.end();

  const chunk = session.tune.chunkBytes;
  let pos = start;
  try {
    for (;;) {
      if (signal.signal.aborted || session.closed) break;
      if (Number.isFinite(end) && pos > end) break;
      if (total != null && pos >= total) break;

      const chunkStart = Math.floor(pos / chunk) * chunk;
      const wantLen = Math.min(chunk - (pos - chunkStart), Number.isFinite(end) ? end - pos + 1 : chunk);
      let buf = session.store.get(pos, wantLen);
      if (buf) session.stats.cacheHits += 1;
      if (!buf) {
        if (session.meta.rangeSupported === false) {
          buf = await waitForLinearBytes(session, pos, wantLen, signal.signal);
        } else {
          const windowEnd = total != null ? Math.min(pos + wantLen - 1, total - 1) : pos + wantLen - 1;
          try {
            const fetched = await fetchByteWindow(session, session.upstreamUrl, pos, windowEnd, signal.signal);
            if (fetched.total != null && session.meta.total == null) session.meta.total = fetched.total;
            if (fetched.fromFullObject) {
              session.store.put(0, fetched.fromFullObject, { allowPartialTail: true, total: session.meta.total });
              buf = session.store.get(pos, wantLen) || fetched.buf;
            } else {
              buf = fetched.buf;
              session.store.put(pos, buf, { allowPartialTail: true, total: session.meta.total });
            }
          } catch (err) {
            // 416 past the (previously unknown) EOF = the file is complete.
            if (err instanceof ChunkedFetchError && err.status === 416 && total == null) break;
            throw err;
          }
        }
      }
      if (!buf || !buf.length) break;
      session.stats.servedBytes += buf.length;
      const ok = res.write(buf);
      if (!ok) await new Promise((resolve) => res.once('drain', resolve));
      pos += buf.length;
    }
    res.end();
  } catch (err) {
    if (!signal.signal.aborted && !session.closed) {
      log.warn('upstream', 'file serving failed', { session: session.id, pos, error: errorText(err) });
    }
    try { res.end(); } catch { /* ignore */ }
  }
  return undefined;
}

/**
 * Background capture for servers that ignore Range (a plain or chunked 200):
 * keep one GET open and write its bytes to a temp file as they arrive. A GET
 * always starts at byte 0, so when the CDN cuts a transfer we reopen it and
 * read past the bytes already on disk.
 *
 * The file, not RAM, is the store for these objects. The capture can run far
 * ahead of the player, and the player may read anywhere in the object at any
 * time (an MP4 index at the end, a seek back to the start); a RAM cache evicts
 * the bytes the player still needs first. `session.linear.captured` is the
 * frontier: every byte before it is in the file.
 */
function startLinearCapture(session) {
  if (session.linear) return;
  const dir = path.join(getConfig().storage?.tmp || '/tmp/vumovie', 'upstream');
  sweepStaleCaptureFiles(dir);
  session.linear = {
    started: true, done: false, failed: false, captured: 0, listeners: new Set(),
    file: path.join(dir, `${session.id}-${session.secret.slice(0, 8)}.part`), fh: null,
  };
  linearCaptureLoop(session).catch((err) => {
    log.warn('upstream', 'range-less capture loop ended', { session: session.id, error: errorText(err) });
  });
}

let captureDirSwept = false;

/** Capture files left behind by an earlier process (crash, power cut): once
 *  per process, and only ones nobody has written to for a day. */
function sweepStaleCaptureFiles(dir) {
  if (captureDirSwept) return;
  captureDirSwept = true;
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.part')) continue;
      const file = path.join(dir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch { /* no directory yet — it is created on demand */ }
}

/** Close and delete a session's capture file (the session is over). */
function removeCaptureFile(session) {
  const linear = session.linear;
  if (!linear?.file) return;
  const { fh } = linear;
  linear.fh = null;
  if (fh) fh.close().catch(() => { /* already closed */ });
  try { fs.rmSync(linear.file, { force: true }); } catch { /* ignore */ }
}

async function linearCaptureLoop(session) {
  try {
    await fs.promises.mkdir(path.dirname(session.linear.file), { recursive: true });
    session.linear.fh = await fs.promises.open(session.linear.file, 'w+');
  } catch (err) {
    session.linear.failed = true;
    notifyLinear(session, 0);
    log.error('upstream', 'cannot create the capture file — this range-less upstream cannot be played', {
      session: session.id, file: session.linear.file, error: errorText(err),
    });
    return;
  }
  if (session.closed) { removeCaptureFile(session); return; }
  let stuck = 0;
  let lastCaptured = -1;
  while (!session.closed) {
    // Bytes before `resumeFrom` are already held: this GET re-reads them from
    // the start and drops them. `position` counts the bytes of THIS GET only,
    // so the offset to store at is always derived from it.
    const resumeFrom = session.linear.captured;
    let position = 0;
    try {
      session.stats.cdnRequests += 1;
      const res = await fetch(session.upstreamUrl, {
        headers: session.headers,
        signal: AbortSignal.any([session.abort.signal, AbortSignal.timeout(session.tune.requestTimeoutMs * 10)]),
      });
      if (!res.ok) throw new ChunkedFetchError(`HTTP ${res.status} from upstream`, { status: res.status });
      for await (const part of res.body) {
        const buf = Buffer.from(part);
        const partStart = position;
        position += buf.length;
        session.stats.cdnBytes += buf.length;
        session.lastActivity = Date.now();
        if (position <= resumeFrom) continue; // all of it is captured already
        const from = Math.max(0, resumeFrom - partStart);
        // Written at its absolute offset; the frontier moves only once it is on disk.
        await session.linear.fh.write(buf, from, buf.length - from, partStart + from);
        notifyLinear(session, position);
      }
      if (position < resumeFrom) {
        throw new ChunkedFetchError(`upstream sent ${position} bytes, fewer than the ${resumeFrom} already captured`);
      }
      // Clean EOF: `position` is the size of the whole object. A chunked
      // response that the CDN cut short surfaces as an error above instead.
      session.meta.total = position;
      session.linear.done = true;
      notifyLinear(session, position);
      return;
    } catch (err) {
      if (session.closed) return;
      session.stats.retries += 1;
      const at = session.linear.captured;
      // Give up when the capture makes no progress at all — otherwise a CDN
      // that cuts every plain GET at the same spot would loop forever.
      stuck = at === lastCaptured ? stuck + 1 : 0;
      lastCaptured = at;
      if (stuck >= 8) {
        log.error('upstream', 'range-less capture makes no progress — giving up on this upstream', {
          session: session.id, at,
        });
        session.linear.failed = true;
        notifyLinear(session, at);
        return;
      }
      log.warn('upstream', 'range-less capture interrupted — reopening the GET and skipping ahead', {
        session: session.id, at, error: errorText(err),
      });
      await sleep(1000);
    }
  }
}

function notifyLinear(session, captured) {
  session.linear.captured = Math.max(session.linear.captured, captured);
  for (const listener of [...session.linear.listeners]) {
    try { listener(); } catch { /* ignore */ }
  }
}

function waitForLinearBytes(session, pos, len, signal) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearInterval(timer);
      session.linear?.listeners.delete(check);
    };
    const check = () => {
      if (signal?.aborted) { cleanup(); return reject(new ChunkedFetchError('client went away')); }
      if (session.closed) { cleanup(); return reject(new ChunkedFetchError('proxy session closed')); }
      if (session.linear?.failed) { cleanup(); return reject(new ChunkedFetchError('the range-less upstream keeps cutting the transfer')); }
      const have = session.linear?.captured ?? 0;
      // Everything asked for is on disk — or the object ended before it.
      if (have >= pos + len || (session.linear?.done && have > pos)) {
        cleanup();
        return readLinearFile(session, pos, Math.min(len, have - pos)).then(resolve, reject);
      }
      if (session.linear?.done) { cleanup(); return resolve(Buffer.alloc(0)); } // at or past EOF
      return undefined;
    };
    timer = setInterval(check, 100);
    timer.unref?.();
    if (!session.linear) startLinearCapture(session);
    session.linear.listeners.add(check);
    check();
  });
}

/** Resolve once the capture has finished (the size is known), or reject. */
function waitForLinearSize(session, signal) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearInterval(timer);
      session.linear?.listeners.delete(check);
    };
    const check = () => {
      if (signal?.aborted) { cleanup(); return reject(new ChunkedFetchError('client went away')); }
      if (session.closed) { cleanup(); return reject(new ChunkedFetchError('proxy session closed')); }
      if (!session.linear || session.linear.failed) {
        cleanup();
        return reject(new ChunkedFetchError('the range-less upstream keeps cutting the transfer'));
      }
      if (session.linear.done) { cleanup(); return resolve(); }
      return undefined;
    };
    timer = setInterval(check, 100);
    timer.unref?.();
    session.linear.listeners.add(check);
    check();
  });
}

/** Read [pos, pos+len) of a range-less object from its capture file. */
async function readLinearFile(session, pos, len) {
  const out = Buffer.alloc(len);
  const { bytesRead } = await session.linear.fh.read(out, 0, len, pos);
  session.lastActivity = Date.now();
  return out.subarray(0, bytesRead);
}

/** Serve the rewritten MPD. */
async function serveMpd(session, req, res) {
  try {
    if (!session.mpd) {
      let first = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        first = await rangedRequest(session, session.upstreamUrl, 0, MAX_MANIFEST_BYTES - 1, undefined, { maxBytes: MAX_MANIFEST_BYTES });
        if (!first.truncated) break;
        // A truncated manifest would rewrite into broken XML — fetch it again.
        if (attempt < 3) await sleep(backoff(attempt));
      }
      if (first.truncated) throw new ChunkedFetchError('the CDN keeps truncating the manifest');
      if (first.cancelled) throw new ChunkedFetchError('the DASH manifest is larger than the 10 MB limit');
      const body = first.status === 206 && first.total != null && first.total < first.buf.length
        ? first.buf.subarray(0, first.total)
        : first.buf;
      if (!body.length) throw new ChunkedFetchError('empty MPD');
      const original = body.toString('utf8');
      const rewritten = rewriteDashManifest(original, {
        mpdUrl: session.upstreamUrl,
        localPrefix: `${session.base}/up/${session.secret}`,
        register: ({ type, url, dir, template, query }) => {
          const id = `r${session.refs.next}`;
          session.refs.next += 1;
          session.refs.byId.set(id, { type, url, dir, template, query });
          return id;
        },
      });
      session.mpd = { rewritten, fetchedAt: Date.now() };
      log.info('upstream', 'DASH manifest fetched and rewritten — all segments now loop back through the proxy', {
        session: session.id, refs: session.refs.next - 1, bytes: rewritten.length,
      });
    }
    const body = session.mpd.rewritten;
    res.status(200)
      .set('Content-Type', 'application/dash+xml')
      .set('Content-Length', Buffer.byteLength(body))
      .set('Cache-Control', 'no-store')
      .send(body);
  } catch (err) {
    sendError(res, 502, `could not fetch the DASH manifest: ${err.message}`);
  }
}

/** Resolve one local segment reference back to its CDN URL. */
function resolveRef(session, kind, id, rest = '') {
  const entry = session.refs.byId.get(id);
  if (!entry || entry.type !== kind) return null;
  if (kind === 'url') return entry.url;
  if (kind === 'base') return `${entry.url}${rest}`;
  if (kind === 'template') {
    const [dirNoQuery, dirQuery = ''] = String(entry.dir).split('?');
    const filename = decodeURIComponent(rest);
    const query = entry.query || dirQuery;
    return `${dirNoQuery}${filename}${query ? `?${query}` : ''}`;
  }
  return null;
}

/** Serve one DASH object (segment/init) from cache or the chunked fetcher. */
async function serveSegment(session, url, req, res) {
  try {
    const obtained = await session.segments.obtain(url, () => fetchObjectChunked(session, url));
    const { buf, contentType } = obtained;
    if (obtained.cached) session.stats.cacheHits += 1;
    const range = parseClientRange(req.headers.range, buf.length);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    if (contentType) res.setHeader('Content-Type', contentType);
    if (range) {
      const slice = buf.subarray(range.start, range.end + 1);
      res.status(206)
        .setHeader('Content-Range', `bytes ${range.start}-${range.end}/${buf.length}`)
        .setHeader('Content-Length', slice.length)
        .end(slice);
    } else {
      res.status(200).setHeader('Content-Length', buf.length).end(buf);
    }
    session.stats.servedBytes += range ? range.end - range.start + 1 : buf.length;
  } catch (err) {
    sendError(res, 502, `segment fetch failed: ${err.message}`);
  }
}

/**
 * Express middleware handling everything under /up/:secret/…
 * Mounted by src/http/server.js; lives outside the password middleware because
 * (like /s/) it is protected by the per-session secret instead.
 */
export function upstreamProxyMiddleware(req, res, next) {
  if (!req.path.startsWith('/up/')) return next();
  const raw = req.url.startsWith('/') ? req.url : `/${req.url}`;
  const withoutUp = raw.slice('/up/'.length);
  const slash = withoutUp.indexOf('/');
  const secret = decodeURIComponent(slash < 0 ? withoutUp : withoutUp.slice(0, slash));
  const rest = slash < 0 ? '' : withoutUp.slice(slash + 1);
  const session = proxies.get(secret);
  if (!session || session.closed) return sendError(res, 404, 'unknown or closed upstream proxy session');

  const [mode, ...tail] = rest.split('/');
  if (mode === 'f') {
    if (session.kind !== 'file') return sendError(res, 404, 'this session is not a progressive file');
    return serveFile(session, req, res);
  }
  if (mode === 'm') {
    if (session.kind !== 'dash') return sendError(res, 404, 'this session is not DASH');
    return serveMpd(session, req, res);
  }
  if (mode === 'dash' && tail.length >= 2) {
    const [, id, ...remaining] = tail;
    const remainingPath = remaining.join('/');
    if (tail[0] === 'u') {
      const url = resolveRef(session, 'url', id);
      if (!url) return sendError(res, 404, 'unknown segment reference');
      return serveSegment(session, url, req, res);
    }
    if (tail[0] === 't') {
      const url = resolveRef(session, 'template', id, remainingPath);
      if (!url) return sendError(res, 404, 'unknown segment template');
      return serveSegment(session, url, req, res);
    }
    if (tail[0] === 'b') {
      const url = resolveRef(session, 'base', id, remainingPath);
      if (!url) return sendError(res, 404, 'unknown base reference');
      return serveSegment(session, url, req, res);
    }
  }
  return sendError(res, 404, 'no such upstream proxy route');
}

/** For tests / diagnostics: how many proxy sessions are alive. */
export function listUpstreamProxies() {
  return [...proxies.values()].map((s) => ({ id: s.id, streamId: s.streamId, kind: s.kind, stats: proxyStats(s) }));
}

export default {
  createUpstreamProxy, maybeCreateUpstreamProxy, shouldProxyUpstream, closeUpstreamProxy,
  proxyStats, upstreamProxyMiddleware, rewriteDashManifest, parseClientRange, listUpstreamProxies,
};
