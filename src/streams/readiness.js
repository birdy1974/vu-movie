/**
 * vu-movie — "is this stream ready to play *right now*, without waiting?"
 *
 * A saved stream points at an upstream URL that rots: signed tokens expire
 * (often within hours), mirrors disappear, CDNs start geo-blocking. Verifying
 * that URL costs an ffprobe run, and repairing a dead one costs a full
 * re-resolve through Chromium — in the log that prompted this module that was
 * a 20 s probe timeout followed by ~2 minutes of provider searches, all while
 * the Enigma2 box sat on the channel waiting for its first byte.
 *
 * Readiness is the bookkeeping that lets that work happen *before* play is
 * pressed (see the keep-warm loop in playlist/maintenance.js and the manual
 * "prepare" endpoints):
 *
 *   • every successful probe is remembered together with the URL it proved;
 *   • a proof is trusted for a configurable window
 *     (`playlist.prewarmTrustMinutes`, default 30), capped by the expiry the
 *     signed URL itself carries when one can be parsed out of it;
 *   • playback inside the trust window skips the probe entirely, so a
 *     pre-warmed title starts the moment the box zaps to it;
 *   • a relay session that dies uncleanly forgets the proof, so a link that
 *     died inside its trust window is re-checked (and repaired) on the next
 *     play instead of being trusted into a black screen repeatedly;
 *   • failed repairs back off exponentially, so the keep-warm loop never
 *     turns into a Chromium search storm against a title nobody can find.
 *
 * Deliberately a leaf module (config + log only): recovery.js, relay.js, the
 * playlist maintenance loop and both HTTP APIs all need it, and recovery
 * already imports relay — the cache cannot live in either of them without a
 * cycle. State is in-memory only; a restart simply means the keep-warm loop
 * re-proves the playlist once, shortly after boot.
 */

import { getConfig } from '../core/config.js';

/** Default trust window when the setting is missing or unusable. */
export const DEFAULT_TRUST_MINUTES = 30;
const MIN_TRUST_MS = 5_000;
const MAX_TRUST_MS = 240 * 60_000;
/**
 * Never trust a proof right up to the signed URL's own expiry: the token is
 * usually re-checked per HLS segment / range request, so a movie that starts
 * 5 s before expiry dies a minute in. Proofs stop being trusted this long
 * before the parsed expiry, which is also when keep-warm re-resolves.
 */
const EXPIRY_LEAD_MS = 15_000;
/** First failed repair waits this long before keep-warm retries it. */
const FAILURE_BACKOFF_BASE_MS = 15 * 60_000;
const FAILURE_BACKOFF_MAX_MS = 6 * 60 * 60_000;

const entries = new Map(); // streamId → proof/failure record
const checking = new Set(); // streamIds with a check/repair in flight

/* ---------------- configuration ---------------- */

/** The keep-warm settings, read live so a Settings save applies at once. */
export function prewarmConfig() {
  const playlist = getConfig().playlist || {};
  const raw = Number(playlist.prewarmTrustMinutes);
  const trustMs = Math.max(MIN_TRUST_MS, Math.min(MAX_TRUST_MS,
    (Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TRUST_MINUTES) * 60_000));
  return {
    enabled: playlist.prewarmEnabled !== false,
    trustMinutes: Math.round((trustMs / 60_000) * 100) / 100,
    trustMs,
  };
}

/** How long keep-warm waits before retrying after `failures` failed repairs. */
export function failureBackoffMs(failures) {
  const count = Math.max(1, Math.round(Number(failures) || 1));
  return Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_BASE_MS * 2 ** (count - 1));
}

/* ---------------- signed-URL expiry ---------------- */

const EPOCH_MIN_MS = Date.UTC(2000, 0, 1);
const EPOCH_MAX_MS = Date.UTC(2100, 0, 1);

/** A query value that is itself an epoch (seconds or milliseconds), or null. */
function epochValueMs(raw) {
  const text = String(raw ?? '').trim();
  if (/^\d{9,13}$/.test(text)) {
    const value = Number(text);
    const ms = value >= 1e12 ? value : value * 1000;
    return ms >= EPOCH_MIN_MS && ms <= EPOCH_MAX_MS ? ms : null;
  }
  // ISO timestamps (Azure SAS `se=2026-10-20T16:00:00Z`, AWS `Expires=` is an
  // epoch but some CDNs spell it as a date). A bare number is handled above;
  // anything date-shaped goes through Date.parse with the same sanity range.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) && ms >= EPOCH_MIN_MS && ms <= EPOCH_MAX_MS ? ms : null;
  }
  return null;
}

/** `exp` claim of a JWT-shaped value, or null. The signature is never checked — this is a scheduling hint, not auth. */
function jwtExpiryMs(value) {
  const match = /^eyJ[\w-]+\.(eyJ[\w-]+)\.[\w-]+$/.exec(String(value || '').trim());
  if (!match) return null;
  try {
    const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    return epochValueMs(payload?.exp);
  } catch { return null; }
}

/** CloudFront `Policy=` (base64 JSON with DateLessThan), or null. */
function cloudFrontPolicyExpiryMs(value) {
  try {
    const json = Buffer.from(String(value || '').replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64').toString('utf8');
    const match = /"AWS:EpochTime"\s*:\s*(\d{9,13})/.exec(json);
    return match ? epochValueMs(match[1]) : null;
  } catch { return null; }
}

const EXPIRY_PARAMS = new Set([
  'exp', 'expires', 'expire', 'expiry', 'expiration', 'validuntil', 'valid_until',
  'se', // Azure SAS signed expiry (ISO)
  'e', // several CDNs use a bare `e=<epoch>`; epochValueMs rejects small numbers
]);
const NESTED_URL_PARAMS = new Set(['url', 'u', 'src', 'source', 'file', 'manifest', 'redirect', 'uri', 'target']);

function collectExpiries(rawUrl, depth, out) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { return; }
  // AWS SigV4 presigned URLs carry a *duration*: X-Amz-Date + X-Amz-Expires.
  const amzDate = url.searchParams.get('X-Amz-Date');
  const amzExpires = Number(url.searchParams.get('X-Amz-Expires'));
  if (amzDate && Number.isFinite(amzExpires) && amzExpires > 0) {
    const parsed = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
    if (parsed) {
      const start = Date.UTC(+parsed[1], +parsed[2] - 1, +parsed[3], +parsed[4], +parsed[5], +parsed[6]);
      const ms = start + amzExpires * 1000;
      if (ms >= EPOCH_MIN_MS && ms <= EPOCH_MAX_MS) out.push(ms);
    }
  }
  for (const [name, value] of url.searchParams) {
    const key = name.toLowerCase();
    if (EXPIRY_PARAMS.has(key)) {
      const ms = epochValueMs(value);
      if (ms) out.push(ms);
    }
    if (key === 'policy') {
      const ms = cloudFrontPolicyExpiryMs(value);
      if (ms) out.push(ms);
    }
    const jwt = jwtExpiryMs(value);
    if (jwt) out.push(jwt);
    // Akamai-style tokens pack the expiry inside another parameter's value:
    // `hdnea=st=1729…~exp=1729…~acl=/*`, `token=exp=1729…~hmac=…`.
    for (const embedded of String(value).matchAll(/(?:^|[~&;])exp(?:ires?)?=(\d{9,13})/g)) {
      const ms = epochValueMs(embedded[1]);
      if (ms) out.push(ms);
    }
    // Bridge/proxy wrappers (the dash-hls bridge in the field nests the real
    // signed CDN URL in `?url=`): the inner expiry is the binding one.
    if (depth < 3 && NESTED_URL_PARAMS.has(key) && /^https?:\/\//i.test(value)) {
      collectExpiries(value, depth + 1, out);
    }
  }
}

/**
 * When the signed upstream URL itself says it stops working (epoch ms), or
 * null when it carries no parseable expiry. The *earliest* candidate wins —
 * with a wrapper URL that is the inner CDN token.
 *
 * This is only ever a hint for scheduling and for capping trust: ffprobe
 * stays the ground truth. A CDN that ignores its own `exp` still probes
 * "working", and markVerified then trusts the proof, not the parameter.
 */
export function upstreamUrlExpiresAt(rawUrl) {
  if (!rawUrl) return null;
  const found = [];
  collectExpiries(rawUrl, 0, found);
  return found.length ? Math.min(...found) : null;
}

/* ---------------- the proof cache ---------------- */

const streamIdOf = (streamOrId) => String(
  (typeof streamOrId === 'object' ? streamOrId?.id : streamOrId) || '',
);
const urlOf = (stream) => (typeof stream === 'object' ? String(stream?.upstream?.url || '') : '');
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

/**
 * Remember that `stream`'s current upstream URL was just proved playable
 * (or, for state 'unverified', that probing could not disprove it).
 * Returns the stored entry, or null without an id/URL.
 */
export function markVerified(stream, result = {}, { at = Date.now(), trustMs = null } = {}) {
  const id = streamIdOf(stream);
  const url = urlOf(stream) || String(result?.url || '');
  if (!id || !url) return null;
  const state = result?.state === 'unverified' ? 'unverified' : 'working';
  const urlExpiresAt = upstreamUrlExpiresAt(url);
  let trustUntil = at + (Number.isFinite(trustMs) && trustMs > 0 ? trustMs : prewarmConfig().trustMs);
  // Cap by the URL's own expiry — but only when that expiry is still ahead.
  // A probe that succeeds *after* the nominal expiry proves the CDN does not
  // enforce it; trusting the parameter over the probe would re-resolve a
  // working link on every keep-warm tick.
  if (urlExpiresAt && urlExpiresAt > at) trustUntil = Math.min(trustUntil, urlExpiresAt - EXPIRY_LEAD_MS);
  const entry = {
    streamId: id,
    url,
    state,
    at,
    trustUntil,
    urlExpiresAt,
    result: { ...result, state },
    failures: 0,
    lastFailureAt: null,
    nextRetryAt: null,
    lastError: null,
  };
  entries.set(id, entry);
  return entry;
}

/**
 * Remember that checking/repairing `stream` just failed. Playback and a
 * manual prepare always retry immediately; only the keep-warm loop honours
 * the backoff this records.
 */
export function markFailed(streamOrId, error = null, { at = Date.now(), state = 'dead' } = {}) {
  const id = streamIdOf(streamOrId);
  if (!id) return null;
  const previous = entries.get(id);
  const failures = (previous?.failures || 0) + 1;
  const entry = {
    streamId: id,
    url: urlOf(streamOrId) || previous?.url || '',
    state,
    at: previous?.at || null,
    trustUntil: at, // a failed proof trusts nothing
    urlExpiresAt: previous?.urlExpiresAt || upstreamUrlExpiresAt(urlOf(streamOrId)),
    result: previous?.result || null,
    failures,
    lastFailureAt: at,
    nextRetryAt: at + failureBackoffMs(failures),
    lastError: error ? String(error) : (previous?.lastError || null),
  };
  entries.set(id, entry);
  return entry;
}

/** Drop any proof for a stream (deleted, upstream replaced, session died). */
export function forget(streamId) {
  entries.delete(String(streamId || ''));
}

/* ---------------- queries ---------------- */

export function beginCheck(streamId) { checking.add(String(streamId || '')); }
export function endCheck(streamId) { checking.delete(String(streamId || '')); }
export function isChecking(streamId) { return checking.has(String(streamId || '')); }

/**
 * The playback fast path: a still-trusted proof for the stream's *current*
 * URL, or null. When this answers, playback starts without an ffprobe run.
 */
export function cachedProof(stream, { now = Date.now() } = {}) {
  const entry = entries.get(streamIdOf(stream));
  if (!entry) return null;
  if (!['working', 'unverified'].includes(entry.state)) return null;
  if (urlOf(stream) && entry.url !== urlOf(stream)) return null;
  if (now >= entry.trustUntil) return null;
  return entry;
}

/**
 * Should the keep-warm loop (re)prove this stream now? Due when there is no
 * proof for the current URL, or the proof's trust runs out within `leadMs`
 * (so the refresh lands *before* playback would stop trusting it). A failed
 * repair inside its backoff is not due; a check already in flight is not due.
 */
export function isDue(stream, { now = Date.now(), leadMs = 60_000, respectBackoff = true } = {}) {
  if (isChecking(streamIdOf(stream))) return false;
  const entry = entries.get(streamIdOf(stream));
  if (!entry) return true;
  if (urlOf(stream) && entry.url !== urlOf(stream)) return true;
  if (respectBackoff && entry.nextRetryAt && now < entry.nextRetryAt
    && !cachedProof(stream, { now })) return false;
  return now >= entry.trustUntil - leadMs;
}

/**
 * The public readiness shape the API/UI render. Pass the stream record when
 * available (the URL is compared, so a proof for a replaced upstream is not
 * reported as ready); a bare id reports the stored entry as-is.
 *
 *   state: preparing | ready | stale | failed | unknown
 *     ready   proved working and still inside the trust window — playback
 *             starts without a probe ("zap and it plays")
 *     stale   was proved, but the trust window (or the URL's own expiry)
 *             has passed; keep-warm will re-prove it, playback re-checks
 *     failed  the last check/repair failed; `error`/`nextRetryAt` say more
 */
export function getReadiness(streamOrId, { now = Date.now() } = {}) {
  const id = streamIdOf(streamOrId);
  const preparing = isChecking(id);
  const entry = entries.get(id);
  const urlMatches = !entry || !urlOf(streamOrId) || entry.url === urlOf(streamOrId);
  const current = entry && urlMatches ? entry : null;
  const proof = current ? cachedProof(streamOrId, { now }) : null;
  const urlExpiresAt = current?.urlExpiresAt ?? upstreamUrlExpiresAt(urlOf(streamOrId));
  let state = 'unknown';
  if (preparing) state = 'preparing';
  else if (proof && proof.state === 'working') state = 'ready';
  else if (proof) state = 'ready'; // unverified-but-trusted: playback proceeds, say verified:false
  else if (current?.failures > 0 && current.lastFailureAt && (!current.at || current.lastFailureAt >= current.at)) state = 'failed';
  else if (current?.at) state = 'stale';
  return {
    streamId: id,
    state,
    ready: state === 'ready',
    preparing,
    verified: current?.state === 'working' && Boolean(current?.at),
    checkedState: current?.state || null,
    checkedAt: iso(current?.at),
    trustedUntil: iso(current?.trustUntil),
    upstreamExpiresAt: iso(urlExpiresAt),
    sourceId: current?.result?.sourceId || null,
    probeMs: Number.isFinite(current?.result?.probeMs) ? current.result.probeMs : null,
    repaired: current?.result?.repaired === true,
    error: current?.lastError || current?.result?.error || null,
    failures: current?.failures || 0,
    nextRetryAt: iso(current?.nextRetryAt),
    trustMinutes: prewarmConfig().trustMinutes,
  };
}

export default {
  upstreamUrlExpiresAt,
  prewarmConfig,
  failureBackoffMs,
  markVerified,
  markFailed,
  forget,
  beginCheck,
  endCheck,
  isChecking,
  cachedProof,
  isDue,
  getReadiness,
  DEFAULT_TRUST_MINUTES,
};
