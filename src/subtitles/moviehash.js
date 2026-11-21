/**
 * vu-movie — the OpenSubtitles "moviehash" for a stream we only know by URL.
 *
 * The hash is the file size plus the sum of the 64-bit little-endian words of
 * the first and the last 64 KiB, as a 16-digit hex string. A hit on it means
 * "somebody uploaded a subtitle for *this exact file*", which is as close to a
 * sync guarantee as subtitle search gets — Bazarr/subliminal let it override
 * every other criterion.
 *
 * We never have the file: it lives on a CDN. Two `Range` requests fetch the
 * 128 KiB the hash needs, so a 4 GB movie costs two small round trips. A
 * server that ignores `Range` (answers 200) would have to send the whole
 * file to reach the tail, so the attempt is abandoned after the head arrives
 * and the search simply runs without a hash. HLS/DASH manifests have no
 * single file to hash; the caller skips those.
 */

import { log, truncate } from '../core/log.js';

export const CHUNK = 65536;

/** The hash of a file given its size and its first/last 64 KiB (pure). */
export function movieHashFromChunks(size, head, tail) {
  const sum64 = (buf) => {
    let acc = 0n;
    const words = Math.floor(buf.length / 8);
    for (let i = 0; i < words; i += 1) acc += buf.readBigUInt64LE(i * 8);
    return acc;
  };
  const total = (BigInt(size) + sum64(head) + sum64(tail)) & 0xFFFFFFFFFFFFFFFFn;
  return total.toString(16).padStart(16, '0');
}

/** The hash of a whole file held in memory (small files, tests). */
export function movieHashFromBuffer(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const head = buf.subarray(0, Math.min(CHUNK, buf.length));
  const tail = buf.subarray(Math.max(0, buf.length - CHUNK));
  return movieHashFromChunks(buf.length, head, tail);
}

/** Total size out of `Content-Range: bytes 0-65535/4123456789`. */
function totalFromContentRange(value) {
  const m = /\/(\d+)\s*$/.exec(String(value || ''));
  return m ? Number(m[1]) : null;
}

/** Read at most `limit` bytes of a response body, then cancel the rest. */
async function readUpTo(res, limit) {
  const chunks = [];
  let received = 0;
  const reader = res.body?.getReader ? res.body.getReader() : null;
  if (!reader) return Buffer.from(await res.arrayBuffer()).subarray(0, limit);
  try {
    while (received < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      received += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

/**
 * Compute the moviehash of a remote file with two ranged requests.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {object} [opts.headers]   the stream's upstream headers (Referer, UA …)
 * @param {number} [opts.timeoutMs] per request (default 6 s)
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{hash:string, size:number}|null>} null when the server
 *   does not honour Range or the file is unreachable — never throws.
 */
export async function fetchMovieHash(url, { headers = {}, timeoutMs = 6000, fetchImpl = fetch } = {}) {
  const get = async (range, limit) => {
    const res = await fetchImpl(url, {
      headers: { ...headers, Range: range },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      res.body?.cancel?.().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    const buf = await readUpTo(res, limit);
    return { status: res.status, buf, headers: res.headers };
  };
  try {
    const head = await get(`bytes=0-${CHUNK - 1}`, CHUNK);
    let size = null;
    if (head.status === 206) size = totalFromContentRange(head.headers.get('content-range'));
    else {
      const cl = Number(head.headers.get('content-length'));
      size = Number.isFinite(cl) && cl > 0 ? cl : null;
      if (size === null || size > CHUNK) {
        // The server sent the whole object from byte 0: the tail is out of reach.
        log.debug('subtitles', 'moviehash skipped — the server ignores Range requests', { url: truncate(url, 100) });
        return null;
      }
    }
    if (!(size > 0)) {
      log.debug('subtitles', 'moviehash skipped — no file size in the answer', { url: truncate(url, 100) });
      return null;
    }
    let tail;
    if (size <= CHUNK) tail = head.buf.subarray(0, size);
    else {
      const start = size - CHUNK;
      const res = await get(`bytes=${start}-${size - 1}`, CHUNK);
      if (res.status !== 206) {
        log.debug('subtitles', 'moviehash skipped — tail range not honoured', { url: truncate(url, 100) });
        return null;
      }
      tail = res.buf;
    }
    if (head.buf.length < Math.min(CHUNK, size) || tail.length < Math.min(CHUNK, size)) {
      log.debug('subtitles', 'moviehash skipped — short read', { url: truncate(url, 100), head: head.buf.length, tail: tail.length });
      return null;
    }
    const hash = movieHashFromChunks(size, head.buf, tail);
    log.debug('subtitles', 'moviehash computed', { url: truncate(url, 100), size, hash });
    return { hash, size };
  } catch (err) {
    log.debug('subtitles', 'moviehash skipped', { url: truncate(url, 100), error: String(err?.message || err) });
    return null;
  }
}

/* A hash per URL is stable, and a search page asks several times in a row. */
const cache = new Map();
const HIT_TTL_MS = 6 * 3600 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;

/** fetchMovieHash() with a small in-memory cache (hits 6 h, misses 10 min). */
export async function cachedMovieHash(url, opts = {}) {
  const key = String(url || '');
  if (!key) return null;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fetchMovieHash(url, opts);
  cache.set(key, { value, until: Date.now() + (value ? HIT_TTL_MS : MISS_TTL_MS) });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

export function resetMovieHashCache() { cache.clear(); }

export default { movieHashFromChunks, movieHashFromBuffer, fetchMovieHash, cachedMovieHash, resetMovieHashCache, CHUNK };
