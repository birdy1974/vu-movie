/**
 * vu-movie — native MovieBox client.
 *
 * You asked to use https://github.com/mesamirh/MovieBox-TUI for scraping. That
 * project is a Rust TUI (MIT OR Apache-2.0) whose real value is the *protocol* it
 * speaks: a signed REST API (`api*.aoneroom.com`, `/wefeed-mobile-bff/...`) with
 *   - a visitor-login that returns a bearer token,
 *   - `x-client-token: <ts>,<md5(reversed ts)>`,
 *   - `x-tr-signature: <ts>|2|<base64(hmac-md5(secret, canonical string))>`,
 *   - a device-spoofing `x-client-info` header and a spoofed `x-forwarded-for`.
 *
 * This file re-implements that protocol in ~250 lines of JavaScript instead of
 * bundling a Rust binary: same endpoints, same signing, no CLI parsing, and it
 * fits in the same container as the rest of the app. Attribution: protocol
 * reverse-engineered by the MovieBox-TUI authors (MIT OR Apache-2.0).
 *
 * Deliberate parity notes (see docs/MOVIEBOX-TUI-COMPARISON.md for the full
 * selection-vs-fetching walkthrough):
 *  - the device identity (UA + `x-client-info` + spoofed `x-forwarded-for`) is
 *    generated ONCE and persisted with the visitor token, exactly like the
 *    reference client's `MovieBoxClient::new()`. Rotating the fingerprint on
 *    every request while reusing a token is what makes a token look stolen.
 *  - `findStreamsByTitle()` asks `play-info/v2` AND `subject-api/resource` in
 *    parallel and unions the results, like `episode_streams()` does: play-info
 *    carries the signed DASH manifests, `resource` carries the direct mirrors.
 *  - a `200` with a body we cannot parse is a host failure, not an empty
 *    result (that is how the reference client treats a JSON parse error).
 *  - the visitor token is a JWT; its `exp` claim decides validity, so a stale
 *    /config/sessions/moviebox.json is not replayed for weeks.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { errorText, log, logError, truncate } from '../core/log.js';
import { getConfig } from '../core/config.js';
import { request, sleep } from './http.js';
import { diagnoseReachability } from './diagnostics.js';
import { normalizeSearchMetadata } from './metadata.js';

/** Lazy browser import to avoid circular dependency at load time. */
let browserModule = null;
async function getBrowserModule() {
  if (browserModule) return browserModule;
  try {
    browserModule = await import('./browser.js');
    return browserModule;
  } catch {
    return null;
  }
}
function browserFallbackEnabled() {
  try {
    const cfg = getConfig?.();
    if (cfg?.scraper?.movieboxBrowserFallback === false) return false;
    if (String(process.env.MOVIEBOX_BROWSER_FALLBACK || '').toLowerCase() === 'false') return false;
  } catch { /* ignore */ }
  return true;
}

const API_PREFIX = '/wefeed-mobile-bff';
/**
 * Host pool — order matters; api*.aoneroom.com are primary, api.inmoviebox.com
 * is the legacy fallback. `api6sg.aoneroom.com` was removed 2026-10 after it
 * stopped resolving (ENOTFOUND); keep the list trim so we don't waste a 12 s
 * timeout per search on a dead NLB.
 *
 * 2026-10 extension: several users behind SNI-filtering ISPs reported that the
 * direct api*.aoneroom.com edge is blocked even though the H5/web BFF mirrors
 * (h5-api.aoneroom.com, h5.aoneroom.com) and the i-api mirror are still
 * reachable via a different ALB/certificate. Add those as secondary hosts so
 * the pool can hop there automatically. Operators can also extend the pool via
 * MOVIEBOX_EXTRA_HOSTS (comma-separated) without editing code. The web BFF
 * uses /wefeed-mobile-bff as well, so no prefix change is needed for these.
 */
const BUILTIN_HOST_POOL = [
  'https://api6.aoneroom.com',
  'https://api5.aoneroom.com',
  'https://api4.aoneroom.com',
  'https://api4sg.aoneroom.com',
  'https://api3.aoneroom.com',
  'https://api.inmoviebox.com',
];
const EXTRA_MIRRORS = [
  'https://h5-api.aoneroom.com',
  'https://h5.aoneroom.com',
  'https://api.aoneroom.com',
  'https://i-api.aoneroom.com',
  'https://apii.inmoviebox.com',
];
export function getHostPool() {
  const cfg = (() => { try { return getConfig?.(); } catch { return null; } })();
  const extra = cfg?.scraper?.movieboxExtraHosts || [];
  const envExtra = (process.env.MOVIEBOX_EXTRA_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const merged = [...BUILTIN_HOST_POOL, ...EXTRA_MIRRORS, ...extra, ...envExtra];
  // Deduplicate while preserving order (first occurrence wins)
  const seen = new Set();
  return merged.filter((h) => {
    const key = h.toLowerCase().replace(/\/+$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
const HOST_POOL = getHostPool();
const HOST_REQUEST_TIMEOUT_MS = 12_000;

/**
 * Classify Node/undici fetch failures into actionable categories. `fetch failed`
 * by itself is useless — callers (and logs) need to know whether this is DNS,
 * TCP, TLS or a timeout so the operator can diagnose proxy/geo/TLS-fingerprint
 * problems rather than just seeing a wall of identical errors.
 *
 * `fetch failed` errors nest: undici wraps the socket error, which in turn may
 * wrap an OpenSSL error whose message is empty (rendered as the useless
 * "Error: Error" the UI used to show). We therefore walk the whole cause chain
 * and classify on the first frame that actually says something.
 */
export function classifyFetchError(err) {
  const chain = [];
  const seen = new Set();
  for (let current = err, depth = 0; current && depth < 6; depth += 1) {
    if (typeof current !== 'object' || seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  const codes = new Set(chain.map((e) => e?.code || e?.errno).filter(Boolean));
  const messages = chain.map((e) => String(e?.message || '')).filter((m) => m && m !== 'Error');
  const raw = messages[0] || String(err?.message || err || 'fetch failed');
  const detail = messages.join(' <- ').slice(0, 240) || raw;
  const all = `${messages.join(' ')} ${[...codes].join(' ')}`;

  if (codes.has('ENOTFOUND') || /getaddrinfo|ENOTFOUND|EAI_AGAIN/.test(all)) {
    return { kind: 'dns', detail, host: chain.find((e) => e?.hostname)?.hostname };
  }
  if (codes.has('ECONNREFUSED')) return { kind: 'connection-refused', detail, port: chain.find((e) => e?.port)?.port };
  // A TLS reset often surfaces as ECONNRESET with a TLS message (“Client network
  // socket disconnected before secure TLS connection was established”). Treat that
  // as TLS, not generic reset, so diagnostics can report tls-or-ip-block.
  if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|unable to verify the first certificate|self.signed certificate/i.test(all)) {
    return { kind: 'tls-intercepted', detail };
  }
  if (/TLS|ssl|alert|handshake|secure TLS connection|WRONG_VERSION|CERTIFICATE/i.test(all)) {
    return { kind: 'tls', detail };
  }
  if (codes.has('ECONNRESET') || codes.has('EPIPE')) return { kind: 'connection-reset', detail };
  if (codes.has('ETIMEDOUT') || /timed out|timeout/i.test(all)) return { kind: 'timeout', detail };
  if (!codes.size && !messages.length) return { kind: 'fetch-failed', detail: 'fetch failed (no cause information — undici could not report why)' };
  return { kind: 'fetch-failed', detail: (messages.length > 1 ? detail : raw).slice(0, 240) };
}
/** Referer the client app uses when fetching media from the CDN. */
export const STREAM_REFERER = 'https://sportslive.wine';
/** 32-byte key baked into the client (MovieBox-TUI, crypto.rs — MIT OR Apache-2.0). */
const SECRET = Buffer.from([
  0xef, 0xa8, 0x91, 0x97, 0x4e, 0xec, 0xd3, 0x14, 0x8d, 0xf6, 0x3a, 0xa6,
  0x11, 0x60, 0x2d, 0xef, 0xd1, 0x01, 0x25, 0x9b, 0xa5, 0x21, 0x02, 0x2c,
  0x57, 0xae, 0x05, 0x66, 0xbd, 0x8e, 0x12,
]);
const SIGNATURE_BODY_MAX = 102_400;

let session = null;      // { token, uid, savedAt }
let hostIndex = 0;
let lastError = null;
/** Tracks consecutive transport failures so we can back off instead of spamming every search. */
let consecutiveFailures = 0;
let disabledUntil = 0;
export const FAILURE_BACKOFF = [0, 0, 30_000, 120_000, 600_000]; // ms added per failure tier
export { HOST_POOL };

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function randomHex(len) {
  const bytes = crypto.randomBytes(Math.ceil(len / 2));
  return bytes.toString('hex').slice(0, len);
}
const randomUuid = () => `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}`;

function randomIp() {
  // The reference client spoofs APAC prefixes; a random public IP is enough here.
  const first = [1, 14, 27, 36, 42, 49, 58, 61, 101, 103, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119][Math.floor(Math.random() * 20)];
  return `${first}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
}

/** Device fingerprint + matching UA (must look like the Android app). */
function clientIdentity() {
  const android = [['9', 'PQ3A.190605.03081104'], ['10', 'QP1A.191005.007.A3'], ['11', 'RP1A.200720.011'], ['12', 'S1B.220414.015'], ['13', 'TQ2A.230405.003']][Math.floor(Math.random() * 5)];
  const device = ['23078RKD5C', '2201117TY', '2201117TG', '22101316G', '21121210G', 'M2012K11AG', 'M2007J20CG'][Math.floor(Math.random() * 7)];
  const versionCode = [50020117, 50020118, 50020119, 50020120, 50020121][Math.floor(Math.random() * 5)];
  const network = Math.random() > 0.5 ? 'NETWORK_WIFI' : 'NETWORK_MOBILE';
  const timezone = ['Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'America/New_York', 'Europe/London'][Math.floor(Math.random() * 5)];
  const userAgent = `com.community.oneroom/${versionCode} (Linux; U; Android ${android[0]}; en_US; ${device}; Build/${android[1]}; Cronet/135.0.7012.3)`;
  const clientInfo = JSON.stringify({
    package_name: 'com.community.oneroom',
    version_name: '4.0.01.0813.03',
    version_code: versionCode,
    os: 'android',
    os_version: android[0],
    install_ch: 'ps',
    device_id: randomHex(32),
    install_store: 'ps',
    gaid: randomUuid(),
    brand: 'Redmi',
    model: device,
    system_language: 'en',
    net: network,
    region: 'US',
    timezone,
    sp_code: '40401',
    'X-Play-Mode': '2',
  });
  return { userAgent, clientInfo, spoofedIp: randomIp() };
}

/* ---------------- signing (ported 1:1 from crypto.rs) ---------------- */

function sortedQuery(url) {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return params.map(([k, v]) => `${k}=${v}`).join('&');
  } catch { return ''; }
}

export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    const q = sortedQuery(url);
    return q ? `${u.pathname}?${q}` : u.pathname;
  } catch { return url; }
}

export function buildCanonicalString({ method, url, body, timestampMs }) {
  const accept = 'application/json';
  const contentType = 'application/json';
  let bodyHash = '';
  let bodyLength = '';
  if (body !== undefined && body !== null) {
    const buf = Buffer.from(String(body));
    bodyHash = md5(buf.subarray(0, SIGNATURE_BODY_MAX));
    bodyLength = String(buf.length);
  }
  return [`${method}`.toUpperCase(), accept, contentType, bodyLength, String(timestampMs), bodyHash, canonicalUrl(url)].join('\n');
}

export function generateXClientToken(ts) {
  const tsStr = String(ts);
  const reversed = tsStr.split('').reverse().join('');
  return `${tsStr},${md5(reversed)}`;
}

export function generateXTrSignature({ method, url, body, timestampMs }) {
  const canonical = buildCanonicalString({ method, url, body, timestampMs });
  const mac = crypto.createHmac('md5', SECRET).update(canonical).digest('base64');
  return `${timestampMs}|2|${mac}`;
}

function signedHeaders({ method, url, body, token, identity }) {
  const ts = Date.now();
  return {
    'User-Agent': identity.userAgent,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Connection: 'keep-alive',
    'x-client-token': generateXClientToken(ts),
    'x-tr-signature': generateXTrSignature({ method, url, body, timestampMs: ts }),
    'x-client-info': identity.clientInfo,
    'x-client-status': '0',
    'x-forwarded-for': identity.spoofedIp,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error('MovieBox request aborted'), { name: 'AbortError' });
}

/** Try each API host until one succeeds; transport failures and retryable HTTP responses both advance the pool. */
export async function requestHostPool({ hosts = HOST_POOL, startIndex = 0, signal = null, requestHost, onFailure = null }) {
  if (typeof requestHost !== 'function') throw new TypeError('requestHostPool needs requestHost(host, index, hop)');
  if (!hosts.length) return { ok: false, result: null, index: null, error: new Error('MovieBox host pool is empty') };
  let lastError = null;
  let backoffMs = 0;
  for (let hop = 0; hop < hosts.length; hop += 1) {
    if (signal?.aborted) throw abortError(signal);
    if (hop > 0) {
      // Reference parity (`request_hosts`): a 50 ms breather between hosts, and
      // on HTTP 429 sleep for the server's Retry-After (capped at 3 s, like the
      // reference client) so we do not turn rate-limiting into a ban.
      await sleep(backoffMs || 50);
      backoffMs = 0;
    }
    const index = (startIndex + hop) % hosts.length;
    const host = hosts[index];
    try {
      const result = await requestHost(host, index, hop);
      if (result?.ok) return { ok: true, result, index };
      lastError = result?.error instanceof Error
        ? result.error
        : new Error(String(result?.error || `HTTP ${result?.status || 'request failed'}`));
      if (result?.status === 429) backoffMs = retryDelayMs(result);
      onFailure?.({ host, index, hop, error: lastError, result });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      onFailure?.({ host, index, hop, error: err, result: null });
      if (err?.terminal) break;
    }
  }
  return { ok: false, result: null, index: null, error: lastError || new Error('all MovieBox hosts exhausted') };
}

/**
 * Pause before the next host after a 429, mirroring the reference client:
 * honour `Retry-After` but never wait longer than 3 s (a rate-limited edge is
 * not worth stalling the whole resolve for).
 */
export function retryDelayMs(result) {
  const retryAfter = Number(result?.headers?.['retry-after']);
  return Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 3000) : 400;
}

/** Visitor-login variant that only treats a response with a token as authenticated success. */
export async function loginWithHostFailover({ hosts = HOST_POOL, startIndex = 0, signal = null, requestHost, onFailure = null }) {
  return requestHostPool({
    hosts,
    startIndex,
    signal,
    onFailure,
    requestHost: async (host, index, hop) => {
      const response = await requestHost(host, index, hop);
      if (!response?.ok) return response || { ok: false, error: 'visitor-login returned no response' };
      const data = response.data?.data || response.data;
      const token = data?.token;
      if (!token) return { ok: false, status: response.status, error: 'visitor-login returned no token' };
      return {
        ok: true,
        session: { token, uid: data?.uid || data?.userId || null, savedAt: new Date().toISOString() },
      };
    },
  });
}

/* ---------------- session handling ---------------- */

/**
 * Device identity — generated once per token and persisted with it.
 *
 * The reference client builds one `MovieBoxClient` (one UA + one
 * `x-client-info` + one spoofed `x-forwarded-for`) and reuses it for every
 * request until the process restarts. Regenerating the fingerprint per request
 * while replaying a cached token is exactly the pattern an anti-abuse edge
 * looks for, so we mirror the reference behaviour here.
 */
function identity() {
  if (!deviceIdentity) deviceIdentity = clientIdentity();
  return deviceIdentity;
}
let deviceIdentity = null;

/** Test/ops helper: force a fresh fingerprint (used on a hard re-login). */
export function resetIdentity() {
  deviceIdentity = null;
}
export { identity as currentIdentity };

const sessionFile = () => path.join(getConfig().scraper.sessionDir, 'moviebox.json');

/**
 * Read `exp` / `userId` out of the visitor JWT, like the reference client's
 * `parse_jwt_claims`. Used so a token that expired last week is not replayed.
 */
export function parseJwtClaims(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return { userId: null, exp: null };
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    const rawExp = Number(json.exp);
    const userId = json.userId ?? json.uid ?? json.sub ?? null;
    return {
      userId: userId == null ? null : String(userId),
      exp: Number.isFinite(rawExp) && rawExp > 0 ? rawExp : null,
    };
  } catch { return { userId: null, exp: null }; }
}

/**
 * Is this token still usable? `exp` minus a minute when the JWT says so, else a
 * conservative 7-day ceiling (same as the reference client's `is_valid()`).
 */
export function sessionIsValid(candidate, nowSec = Math.floor(Date.now() / 1000)) {
  if (!candidate?.token || !String(candidate.token).trim()) return false;
  if (candidate.expiresAt) return nowSec + 60 < Number(candidate.expiresAt);
  const created = Date.parse(candidate.savedAt || candidate.createdAt || '') / 1000;
  if (Number.isFinite(created) && created > 0) return nowSec < created + 7 * 24 * 3600;
  return true; // no timestamp at all: assume usable, the 401 path re-logs in
}

function loadSession() {
  try {
    const file = sessionFile();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.token) {
        if (!sessionIsValid(data)) {
          log.info('moviebox', 'saved visitor session has expired — logging in again', { savedAt: data.savedAt, expiresAt: data.expiresAt });
          return null;
        }
        if (data.identity?.userAgent) deviceIdentity = data.identity;
        log.debug('moviebox', 'restored visitor session from disk', { savedAt: data.savedAt, expiresAt: data.expiresAt });
        return data;
      }
    }
  } catch (err) {
    log.warn('moviebox', 'could not read saved session (starting fresh)', { error: String(err?.message || err) });
  }
  return null;
}

function saveSession(s) {
  try {
    const file = sessionFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...s, identity: deviceIdentity }, null, 2));
  } catch (err) {
    log.warn('moviebox', 'could not persist session', { error: String(err?.message || err) });
  }
}

function clearSession() {
  session = null;
  try { fs.rmSync(sessionFile(), { force: true }); }
  catch (err) { log.warn('moviebox', 'could not remove the rejected visitor session', { error: String(err?.message || err) }); }
}

/**
 * Browser-TLS fallback: reissue the same signed request through Chromium's
 * network stack (BoringSSL) when Node's OpenSSL handshake is fingerprinted
 * or SNI-blocked. Chromium's JA3 is different and, when a proxy is configured,
 * it tunnels through the same proxy — so a tls-or-ip-block that kills Node
 * may still succeed from the browser.
 */
async function browserSignedRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = HOST_REQUEST_TIMEOUT_MS, signal = null } = {}) {
  const mod = await getBrowserModule();
  if (!mod?.fetchViaBrowser) throw new Error('browser transport not available');
  if (signal?.aborted) throw abortError(signal);
  // fetchViaBrowser already handles proxy + ignoreHTTPSErrors internally
  const res = await mod.fetchViaBrowser(url, { method, headers, body, timeoutMs });
  // Normalize to the shape `request()` returns (ok, status, data, headers, error)
  return res;
}

async function loginViaBrowser({ id, body, signal }) {
  const pool = getHostPool();
  let lastErr = null;
  const breakdown = new Map();
  const outcome = await loginWithHostFailover({
    hosts: pool,
    signal,
    requestHost: async (base) => {
      const url = `${base}${API_PREFIX}/user-api/visitor-login`;
      const headers = signedHeaders({ method: 'POST', url, body, identity: id });
      const res = await browserSignedRequest(url, { method: 'POST', headers, body, timeoutMs: HOST_REQUEST_TIMEOUT_MS, signal });
      // Mirror the http path's allowFailure behaviour: non-JSON 2xx is a host failure
      if (res.ok && res.data == null) {
        return { ok: false, status: res.status, error: `HTTP 200 from ${base} but the body was not JSON (browser)` };
      }
      if (!res.ok) return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}` };
      return { ok: true, status: res.status, data: res.data, headers: res.headers };
    },
    onFailure: ({ host, hop, error }) => {
      lastErr = errorText(error);
      const info = classifyFetchError(error);
      breakdown.set(info.kind, (breakdown.get(info.kind) || 0) + 1);
      log.warn('moviebox', `browser visitor-login failed on ${host} — trying next host`, {
        hop: hop + 1, error: lastErr, kind: info.kind, via: 'browser',
      });
    },
  });
  return { outcome, breakdown, lastErr };
}

async function apiRequestViaBrowser(pathAndQuery, { method = 'GET', body, authenticated = true, signal = null, id }) {
  const pool = getHostPool();
  let reauth = false;
  let sawHttp = false;
  const outcome = await requestHostPool({
    hosts: pool,
    signal,
    requestHost: async (base) => {
      const url = `${base}${API_PREFIX}${pathAndQuery}`;
      const send = async () => {
        const headers = signedHeaders({ method, url, body, token: authenticated ? session?.token : null, identity: id });
        const res = await browserSignedRequest(url, { method, headers, body, timeoutMs: HOST_REQUEST_TIMEOUT_MS, signal });
        // Handle 401/403 re-login once, same as the http path
        if ([401, 403].includes(res.status) && authenticated && !reauth) {
          reauth = true;
          clearSession();
          try { await ensureSession({ signal }); } catch (err) { throw Object.assign(err, { terminal: true }); }
          const retryHeaders = signedHeaders({ method, url, body, token: authenticated ? session?.token : null, identity: id });
          const retry = await browserSignedRequest(url, { method, headers: retryHeaders, body, timeoutMs: HOST_REQUEST_TIMEOUT_MS, signal });
          if (retry.headers) absorbXUser(retry.headers);
          if (retry.ok && retry.data == null) return { ...retry, ok: false, error: `HTTP 200 from ${base} but the body was not JSON (browser)` };
          absorbXUser(retry.headers || {});
          return retry;
        }
        if (res.headers) absorbXUser(res.headers);
        if (res.ok && res.data == null) return { ...res, ok: false, error: `HTTP 200 from ${base} but the body was not JSON (browser)` };
        return res;
      };
      const res = await send();
      if (res.ok) return res;
      // Signal host-pool to continue to next host
      const err = new Error(res.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    },
    onFailure: ({ host, hop, error, result }) => {
      const status = result?.status || error?.status;
      if (status) sawHttp = true;
      log.warn('moviebox', `${status ? `host ${host} answered ${status} (browser) — trying next host` : `request failed on ${host} via browser — trying next host`}`, {
        path: pathAndQuery, hop: hop + 1, error: errorText(error), via: 'browser',
      });
    },
  });
  // requestHostPool returns {ok, result, error}; adapt
  if (outcome.ok) {
    // outcome.result is the raw browser response shape; convert to data
    return { ok: true, data: outcome.result.data, headers: outcome.result.headers, index: outcome.index };
  }
  return { ok: false, error: outcome.error, sawHttp };
}

async function login({ signal = null } = {}) {
  if (Date.now() < disabledUntil) {
    const waitSec = Math.round((disabledUntil - Date.now()) / 1000);
    throw new Error(`MovieBox is temporarily backed off for ${waitSec}s after ${consecutiveFailures} consecutive failures`);
  }
  const id = identity();
  const body = '{}';
  const pool = getHostPool();
  log.info('moviebox', 'requesting a visitor token', { startHost: pool[hostIndex % pool.length] });
  const failureBreakdown = new Map(); // kind → count (for a useful aggregated log line)
  let outcome = await loginWithHostFailover({
    hosts: pool,
    startIndex: hostIndex,
    signal,
    requestHost: async (base) => {
      const url = `${base}${API_PREFIX}/user-api/visitor-login`;
      return request(url, {
        method: 'POST', body,
        headers: signedHeaders({ method: 'POST', url, body, identity: id }),
        timeoutMs: HOST_REQUEST_TIMEOUT_MS,
        retries: 0,
        json: true,
        allowFailure: true,
        useJar: false,
        signal,
      });
    },
    onFailure: ({ host, hop, error }) => {
      lastError = errorText(error);
      const info = classifyFetchError(error);
      failureBreakdown.set(info.kind, (failureBreakdown.get(info.kind) || 0) + 1);
      log.warn('moviebox', `visitor-login failed on ${host} — trying next host`, {
        hop: hop + 1, error: lastError, kind: info.kind, detail: info.detail?.slice?.(0, 140) || info.detail,
      });
    },
  });

  // Direct Node fetch failed on every host with a TLS/SNI block → retry via
  // Chromium's BoringSSL stack (different JA3, plus proxy support) before we
  // declare the service dead. This is the user-visible fix for
  // `tls-or-ip-block` when the container sits behind an ISP that filters
  // api*.aoneroom.com at the SNI layer.
  if (!outcome.ok && browserFallbackEnabled() && !signal?.aborted) {
    const breakdownKinds = [...failureBreakdown.keys()];
    const looksLikeTlsBlock = breakdownKinds.includes('tls') || breakdownKinds.includes('tls-intercepted');
    // We also check the diagnosis verdict — but don't wait for it if we already suspect TLS.
    let verdictIsTlsBlock = looksLikeTlsBlock;
    if (!verdictIsTlsBlock) {
      try {
        const diag = await diagnoseReachability({ hosts: pool, signal }).catch(() => null);
        verdictIsTlsBlock = diag?.verdict === 'tls-or-ip-block' || diag?.verdict === 'tls-intercepted';
      } catch { /* ignore */ }
    }
    if (verdictIsTlsBlock) {
      log.info('moviebox', 'direct TLS failed on every host — retrying visitor-login via browser transport (Chromium BoringSSL)', { breakdown: [...failureBreakdown.entries()].map(([k, v]) => `${k}:${v}`).join(',') });
      try {
        const browserAttempt = await loginViaBrowser({ id, body, signal });
        if (browserAttempt.outcome?.ok) {
          log.info('moviebox', 'visitor-login via browser transport succeeded', { host: pool[browserAttempt.outcome.index] });
          // Merge browser breakdown into the main one for logging
          for (const [k, v] of browserAttempt.breakdown) failureBreakdown.set(k, (failureBreakdown.get(k) || 0) + v);
          outcome = browserAttempt.outcome;
        } else {
          log.warn('moviebox', 'browser transport also failed for visitor-login', { breakdown: [...browserAttempt.breakdown.entries()].map(([k, v]) => `${k}:${v}`).join(',') });
        }
      } catch (err) {
        log.warn('moviebox', `browser fallback for visitor-login threw: ${errorText(err)}`);
      }
    }
  }

  if (!outcome.ok) {
    consecutiveFailures += 1;
    const tier = Math.min(consecutiveFailures, FAILURE_BACKOFF.length - 1);
    const backoffMs = FAILURE_BACKOFF[tier];
    if (backoffMs > 0) disabledUntil = Date.now() + backoffMs;
    lastError = errorText(outcome.error);
    const breakdown = [...failureBreakdown.entries()].map(([k, v]) => `${k}:${v}`).join(',') || 'no detail';
    // A wall of identical `fetch failed` lines is not a diagnosis. Probe a
    // control host + compare DNS answers so the log says whether this is the
    // network, DNS filtering, a TLS-interception proxy, or MovieBox itself.
    const diagnosis = await diagnoseReachability({ hosts: pool, signal }).catch(() => null);
    let hint = diagnosis ? ` (${diagnosis.verdict}: ${diagnosis.hint})` : '';
    // Append actionable proxy hint for the SNI-block case — the most common
    // fix on filtered ISPs is to route through a proxy/VPN outside the filter.
    const proxyConfigured = (() => {
      try {
        const cfg = getConfig?.();
        if (cfg?.scraper?.proxyUrl) return true;
      } catch { /* ignore */ }
      return Boolean(process.env.MOVIEBOX_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY);
    })();
    if (diagnosis?.verdict === 'tls-or-ip-block' && !proxyConfigured) {
      hint += ' — fix: set MOVIEBOX_PROXY / HTTP_PROXY (e.g. http://proxy:3128) or route the container through a VPN; alternatively ensure MOVIEBOX_BROWSER_FALLBACK=true (default) and that Chromium is available.';
    } else if (diagnosis?.verdict === 'tls-intercepted') {
      hint += ' — fix: install the intercepting proxy CA via NODE_EXTRA_CA_CERTS or set HTTP_PROXY to bypass it.';
    }
    logError('moviebox', `visitor-login failed on every API host [${breakdown}]${hint}`, outcome.error);
    if (diagnosis) log.warn('moviebox', 'MovieBox reachability diagnosis', { verdict: diagnosis.verdict, summary: diagnosis.summary });
    throw new Error(`MovieBox visitor-login failed: ${lastError}${hint}`, { cause: outcome.error });
  }

  consecutiveFailures = 0;
  disabledUntil = 0;
  hostIndex = outcome.index;
  const loginSession = outcome.result.session;
  const claims = parseJwtClaims(loginSession.token);
  session = {
    ...loginSession,
    uid: loginSession.uid || claims.userId,
    expiresAt: claims.exp,
  };
  lastError = null;
  saveSession(session);
  const poolForLog = getHostPool();
  log.info('moviebox', 'visitor token acquired', {
    uid: session.uid, host: poolForLog[hostIndex % poolForLog.length] || poolForLog[hostIndex], expiresAt: session.expiresAt || null,
  });
  return session;
}

async function ensureSession({ signal = null } = {}) {
  if (session?.token && sessionIsValid(session)) return session;
  session = loadSession();
  if (session?.token) return session;
  return login({ signal });
}

/**
 * Adopt a rotated `x-user` response header (the API hands out a refreshed
 * token there). The reference client does the same in `absorb_x_user`; skipping
 * it means we keep using a token the server already considers stale.
 */
function absorbXUser(headers = {}) {
  const raw = headers['x-user'] || headers['X-User'];
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    const token = parsed?.token;
    if (!token || token === session?.token) return;
    const claims = parseJwtClaims(token);
    session = { ...(session || {}), token, uid: parsed.uid || parsed.userId || claims.userId || session?.uid || null, expiresAt: claims.exp || null, savedAt: new Date().toISOString() };
    saveSession(session);
    log.debug('moviebox', 'adopted a rotated visitor token from x-user', { uid: session.uid });
  } catch { /* not JSON: ignore */ }
}

/**
 * Signed API request with per-host transport/status failover, a parse check,
 * one 401/403 re-login and — like the reference client's `request()` — one
 * retry with a fresh visitor token when *every* host rejected the stored one.
 */
export async function apiRequest(pathAndQuery, {
  method = 'GET', body, authenticated = true, signal = null, allowFreshTokenRetry = true,
} = {}) {
  const id = identity();
  if (authenticated) await ensureSession({ signal });

  let reauthenticationAttempted = false;
  let sawHttpStatus = false;
  const failureKinds = new Map();
  const pool = getHostPool();
  let outcome = await requestHostPool({
    hosts: pool,
    startIndex: hostIndex,
    signal,
    requestHost: async (base) => {
      const url = `${base}${API_PREFIX}${pathAndQuery}`;
      const send = () => request(url, {
        method, body,
        headers: signedHeaders({ method, url, body, token: authenticated ? session?.token : null, identity: id }),
        timeoutMs: HOST_REQUEST_TIMEOUT_MS,
        retries: 0,
        json: true,
        allowFailure: true,
        useJar: false,
        signal,
      });
      let res = await send();
      if ([401, 403].includes(res.status) && authenticated && !reauthenticationAttempted) {
        reauthenticationAttempted = true;
        clearSession();
        try {
          await ensureSession({ signal });
        } catch (err) {
          throw Object.assign(err, { terminal: true });
        }
        res = await send();
      }
      absorbXUser(res.headers || {});
      // A 200 with an unparseable body is a host failure, not an empty result:
      // WAF/block pages arrive as HTML with a 2xx status. The reference client
      // hops to the next host on a JSON parse error, so we do the same.
      if (res.ok && res.data == null) {
        return { ...res, ok: false, error: `HTTP 200 from ${base} but the body was not JSON` };
      }
      return res;
    },
    onFailure: ({ host, hop, error, result }) => {
      lastError = errorText(error);
      const status = result?.status;
      if (status) sawHttpStatus = true;
      const info = !status ? classifyFetchError(error) : null;
      if (info) failureKinds.set(info.kind, (failureKinds.get(info.kind) || 0) + 1);
      log.warn('moviebox', status
        ? `host ${host} answered ${status} — trying next host`
        : `request failed on ${host} — trying next host`, {
        path: pathAndQuery, hop: hop + 1, error: lastError,
        ...(info ? { kind: info.kind, detail: info.detail?.slice?.(0, 140) || info.detail } : {}),
      });
    },
  });

  // Direct Node fetch failed with transport errors (no HTTP status) and the
  // failure looks like SNI/JA3 filtering → retry the same signed request via
  // Chromium (BoringSSL) before we surface the error to the operator.
  if (!outcome.ok && !sawHttpStatus && browserFallbackEnabled() && !signal?.aborted) {
    const hasTlsHint = [...failureKinds.keys()].some((k) => ['tls', 'tls-intercepted'].includes(k));
    let verdictIsTlsBlock = hasTlsHint;
    if (!verdictIsTlsBlock) {
      try {
        const diag = await diagnoseReachability({ hosts: pool, signal }).catch(() => null);
        verdictIsTlsBlock = diag?.verdict === 'tls-or-ip-block' || diag?.verdict === 'tls-intercepted';
      } catch { /* ignore */ }
    }
    if (verdictIsTlsBlock) {
      log.info('moviebox', `direct TLS failed for ${pathAndQuery} — retrying via browser transport`, { breakdown: [...failureKinds.entries()].map(([k, v]) => `${k}:${v}`).join(',') });
      try {
        const browserOutcome = await apiRequestViaBrowser(pathAndQuery, { method, body, authenticated, signal, id });
        if (browserOutcome.ok) {
          log.info('moviebox', `apiRequest via browser succeeded for ${pathAndQuery}`, { host: pool[browserOutcome.index] });
          hostIndex = browserOutcome.index;
          lastError = null;
          return browserOutcome.data;
        }
        log.warn('moviebox', `browser transport also failed for ${pathAndQuery}`, { error: errorText(browserOutcome.error) });
      } catch (err) {
        log.warn('moviebox', `browser fallback for ${pathAndQuery} threw: ${errorText(err)}`);
      }
    }
  }

  if (!outcome.ok) {
    lastError = errorText(outcome.error);
    // A *response-based* failure (401/403/404/5xx everywhere) can mean the
    // stored token is dead in a way the per-host 401 handler did not catch.
    // Retry once against a brand-new visitor session, exactly like the
    // reference client's `HostsExhausted => invalidate + re-login + retry`.
    // Transport failures (DNS/TCP/TLS) are not retried: a second full sweep
    // would only double the wait before the operator sees the diagnosis.
    if (authenticated && allowFreshTokenRetry && sawHttpStatus && !signal?.aborted) {
      log.warn('moviebox', 'every host answered with an error — retrying once with a fresh visitor token', { path: pathAndQuery });
      clearSession();
      try {
        await login({ signal });
      } catch (err) {
        log.error('moviebox', 're-login after a full host sweep failed', { error: errorText(err) });
        throw err;
      }
      return apiRequest(pathAndQuery, { method, body, authenticated, signal, allowFreshTokenRetry: false });
    }
    log.error('moviebox', 'all API hosts exhausted', { path: pathAndQuery, error: lastError });
    throw new Error(`MovieBox request failed (${pathAndQuery}): ${lastError}`, { cause: outcome.error });
  }
  hostIndex = outcome.index; // stick to a host that works
  lastError = null;
  return outcome.result.data;
}

/* ---------------- public API ---------------- */

export function isAvailable() { return true; }

export function buildSearchRequest(query, { page = 1, perPage = 15 } = {}) {
  return { keyword: query, page, perPage, subjectType: 0 };
}

/** Adapt both legacy and current MovieBox search payloads into stable subject rows. */
export function mapSearchResults(data) {
  const payload = data?.data || data;
  const items = payload?.items
    || payload?.data?.items
    || payload?.list
    || payload?.results?.[0]?.subjects
    || data?.results?.[0]?.subjects
    || [];
  return (Array.isArray(items) ? items : []).map((item) => {
    const rawType = item.subjectType ?? item.subject_type ?? item.stype ?? item.type;
    const numericType = Number(rawType);
    const kind = numericType === 2 || /tv|series|show/i.test(String(rawType ?? ''))
      ? 'series'
      : 'movie';
    const metadata = normalizeSearchMetadata({
      rating: item.imdbRatingValue ?? item.rating,
      genres: item.genres ?? item.genreList ?? item.genreNames ?? item.genre,
      description: item.description ?? item.overview ?? item.summary,
      releaseDate: item.releaseDate ?? item.release_date ?? item.firstAirDate ?? item.first_air_date,
      language: item.originalLanguage ?? item.original_language ?? item.language,
      runtime: item.duration ?? item.runtime,
    }, item.description || item.overview || '');
    const releaseDate = item.releaseDate || item.release_date || item.firstAirDate || item.first_air_date || metadata.releaseDate;
    return {
      subjectId: String(item.subjectId || item.id || ''),
      title: item.title || item.name || '',
      year: Number(item.year || releaseDate?.slice?.(0, 4) || 0) || null,
      kind,
      subjectType: Number.isFinite(numericType) ? numericType : rawType ?? null,
      poster: item.cover?.url || (typeof item.cover === 'string' ? item.cover : null) || item.poster || item.coverUrl || item.pic || null,
      ...metadata,
      releaseDate,
      seasonCount: item.seasonCount || item.season_count || item.season || null,
      duration: item.duration || item.runtime || metadata.runtime || null,
    };
  }).filter((item) => item.subjectId);
}

export async function search(query, { page = 1, perPage = 15, signal = null } = {}) {
  if (!query) throw new Error('search needs a query');
  const data = await apiRequest('/subject-api/search/v2', {
    method: 'POST',
    body: JSON.stringify(buildSearchRequest(query, { page, perPage })),
    signal,
  });
  const results = mapSearchResults(data);
  log.info('moviebox', `search "${query}" → ${results.length} items`);
  return results;
}

export async function detail(subjectId, { signal = null } = {}) {
  const data = await apiRequest(`/subject-api/get?subjectId=${encodeURIComponent(subjectId)}`, { signal });
  return data?.data || data;
}

export async function seasonInfo(subjectId, { signal = null } = {}) {
  const data = await apiRequest(`/subject-api/season-info?subjectId=${encodeURIComponent(subjectId)}`, { signal });
  return data?.data || data;
}

export async function resources(subjectId, { page = 1, perPage = 20, se = null, ep = null, resolution = null, signal = null } = {}) {
  const params = [`subjectId=${encodeURIComponent(subjectId)}`];
  if (se) params.push(`se=${se}`);
  if (ep) params.push(`ep=${ep}`);
  params.push(`page=${page}`, `perPage=${perPage}`);
  if (resolution) params.push(`resolution=${resolution}`);
  const data = await apiRequest(`/subject-api/resource?${params.join('&')}`, { signal });
  return data?.data || data;
}

export async function playInfo(subjectId, { se = 0, ep = 0, signal = null } = {}) {
  const q = se && ep
    ? `/subject-api/play-info/v2?subjectId=${encodeURIComponent(subjectId)}&se=${se}&ep=${ep}`
    : `/subject-api/play-info/v2?subjectId=${encodeURIComponent(subjectId)}`;
  const data = await apiRequest(q, { signal });
  return data?.data || data;
}

export async function captions(subjectId, resourceId, { signal = null } = {}) {
  const q = `/subject-api/get-ext-captions?subjectId=${encodeURIComponent(subjectId)}&resourceId=${encodeURIComponent(resourceId)}`;
  const data = await apiRequest(q, { signal });
  return data?.data || data;
}

/* ---------------- response parsing (pure — unit tested) ---------------- */

/** Decode the base64 inside `Edge-Cache-Cookie=urlprefix=<b64>:sign=…:t=…`. */
export function dashManifestFromSignCookie(cookie = '') {
  if (!cookie) return null;
  const prefixMatch = /urlprefix=([A-Za-z0-9_\-=+/]+)/.exec(cookie);
  if (prefixMatch) {
    try {
      const decoded = Buffer.from(prefixMatch[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (/^https?:\/\//.test(decoded)) {
        const base = decoded.endsWith('/') ? decoded : `${decoded}/`;
        return `${base}index.mpd`;
      }
    } catch { /* fall through to CloudFront handling */ }
  }
  const policyMatch = /CloudFront-Policy=([A-Za-z0-9_\-=+/]+)/.exec(cookie);
  if (policyMatch) {
    try {
      const json = JSON.parse(Buffer.from(policyMatch[1], 'base64').toString('utf8'));
      const statement = json.Statement?.[0] || json.statement?.[0];
      const resource = statement?.Resource || statement?.resource;
      const first = Array.isArray(resource) ? resource[0] : resource;
      if (typeof first === 'string') {
        const base = first.replace(/\*+$/, '').replace(/\/?$/, '/');
        return `${base}index.mpd`;
      }
    } catch { /* ignore */ }
  }
  return null;
}

/** Clean up a `signCookie` header value for reuse as a Cookie header. */
export function cookieHeaderFromSignCookie(signCookie = '') {
  return String(signCookie).trim().replace(/;$/, '').split(';').map((s) => s.trim()).filter(Boolean).join('; ');
}

/**
 * "Not a stream" URLs, byte-for-byte the reference client's
 * `is_deprecation_notice_url()`: three baked-in placeholder hashes, a
 * `/notice.mp4` file and macdn's `/other/` bucket. The old generic
 * `deprecat|notice|unavailable` regex both missed these real payloads and
 * dropped legitimate files with "notice" in the name.
 */
export const DEPRECATION_MARKERS = [
  '1c7de0bd3393702d9191801f15f88f8d',
  '9a0461bc39da389663bf3dbb17091d3f',
  'b164fbfb4347792950bdfbfb563d39d9',
  '/notice.mp4',
];

function isDeprecationUrl(url = '') {
  const value = String(url);
  if (!/^https?:/i.test(value)) return true;
  const lower = value.toLowerCase();
  if (DEPRECATION_MARKERS.some((marker) => lower.includes(marker))) return true;
  return lower.includes('macdn.aoneroom.com') && lower.includes('/other/');
}

/**
 * Convert a play-info payload into ranked stream candidates.
 * Mirror of `moviebox_play_info_json_to_releases` from the reference client.
 */
export function releasesFromPlayInfo(payload, { season = 0, episode = 0, userAgent = getConfig().scraper.userAgent } = {}) {
  const data = payload?.data || payload || {};
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const titlePrefix = data.title || 'MovieBox';
  const out = [];

  for (const stream of streams) {
    const resolutions = String(stream.resolutions || data.displayResolutions || '1080,720,480');
    const signCookie = stream.signCookie || '';
    const streamUrl = stream.url || '';
    const manifest = dashManifestFromSignCookie(signCookie)
      || (!isDeprecationUrl(streamUrl) && /^https?:/i.test(streamUrl) ? streamUrl : null);
    if (!manifest) {
      log.warn('moviebox', 'skipping stream without a playable manifest', {
        id: stream.id, format: stream.format, url: truncate(streamUrl, 90),
      });
      continue;
    }
    const headers = { Referer: STREAM_REFERER, 'User-Agent': userAgent };
    const cookies = cookieHeaderFromSignCookie(signCookie);
    if (cookies) headers.Cookie = cookies;

    const list = [...new Set(String(resolutions).split(',').map((s) => Number(String(s).trim())).filter((n) => n > 0))]
      .sort((a, b) => b - a);
    const highest = list[0] || 1080;
    const sizeBytes = stream.size ? Number(stream.size) : null;

    for (const res of (list.length ? list : [1080])) {
      out.push({
        url: manifest,
        sourceId: 'moviebox',
        label: `${res}p ${stream.codecName || stream.format || ''}`.trim(),
        quality: `${res}p`,
        height: res,
        codec: stream.codecName || stream.format || null,
        sizeBytes: sizeBytes && res < highest ? Math.round(sizeBytes * (res / highest) ** 1.6) : sizeBytes,
        headers,
        kind: 'dash',
        meta: {
          movieboxId: stream.id,
          resourceId: stream.id,
          title: season && episode ? `${titlePrefix} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : titlePrefix,
          duration: stream.duration || data.duration || null,
        },
      });
    }
  }
  log.info('moviebox', `play-info produced ${out.length} candidates`, {
    qualities: [...new Set(out.map((c) => c.quality))].join(','),
  });
  return out;
}

/**
 * Mirror of the reference client's `moviebox_resource_item_to_release()`:
 * one `/subject-api/resource` item becomes one candidate (its `resourceLink`),
 * with the same field fallbacks (`fileName`/`title`, `codecName`/`codec`,
 * `resourceId`/`id`, `se`/`ep`).
 */
export function releasesFromResources(payload, { season = 0, episode = 0 } = {}) {
  const data = payload?.data || payload || {};
  const items = Array.isArray(data?.list) ? data.list
    : Array.isArray(data) ? data
      : Array.isArray(data?.items) ? data.items
        : [];
  const out = [];
  for (const item of items) {
    const se = Number(item?.se ?? item?.season ?? 0) || 0;
    const ep = Number(item?.ep ?? item?.episode ?? 0) || 0;
    // The reference client filters resource rows to the requested episode; the
    // same listing endpoint returns every episode of a season otherwise.
    if ((season || episode) && (se || ep) && (se !== season || ep !== episode)) continue;
    const link = item?.resourceLink || item?.url || '';
    if (!link || isDeprecationUrl(link)) {
      if (link) log.debug('moviebox', 'skipping resource link that is not a stream', { link: truncate(link, 90) });
      continue;
    }
    const resolution = item?.resolution ?? item?.quality ?? null;
    const height = Number(String(resolution ?? '').replace(/[^0-9]/g, '')) || null;
    const sizeRaw = item?.size ?? item?.sizeBytes ?? null;
    const sizeBytes = Number.isFinite(Number(sizeRaw)) && sizeRaw !== null ? Number(sizeRaw) : null;
    const title = item?.fileName || item?.title || 'MovieBox resource';
    out.push({
      url: String(link),
      sourceId: 'moviebox',
      label: `${item?.uploadBy || item?.source || 'direct'}${height ? ` ${height}p` : ''}`.trim(),
      quality: height ? `${height}p` : (resolution ? String(resolution) : null),
      height,
      codec: item?.codecName || item?.codec || null,
      sizeBytes,
      // The reference client attaches no headers to resource links (they are
      // plain CDN files), so we deliberately do not invent a Referer here.
      headers: {},
      kind: streamKindFor(String(link)),
      via: 'moviebox-resource',
      meta: {
        movieboxId: item?.resourceId ? String(item.resourceId) : (item?.id != null ? String(item.id) : null),
        resourceId: item?.resourceId ? String(item.resourceId) : (item?.id != null ? String(item.id) : null),
        title,
        language: item?.language || item?.lanName || null,
        season: se || null,
        episode: ep || null,
      },
    });
  }
  if (out.length) log.info('moviebox', `resource endpoint produced ${out.length} candidate(s)`, {
    qualities: [...new Set(out.map((c) => c.quality).filter(Boolean))].join(','),
  });
  return out;
}

/** Minimal extension-based kind detection (kept local so this module stays standalone). */
function streamKindFor(url = '') {
  const clean = String(url).split('#')[0];
  if (/\.m3u8(\?|$)/i.test(clean)) return 'hls';
  if (/\.mpd(\?|$)/i.test(clean)) return 'dash';
  if (/\.(mp4|m4v|mov|webm|mkv)(\?|$)/i.test(clean)) return 'file';
  return 'file';
}

/**
 * High level: search → pick best match → candidate list.
 *
 * Reference-client parity: `play-info/v2` and `subject-api/resource` are
 * requested *in parallel* and unioned (see `episode_streams()`). play-info is
 * the only endpoint that yields the signed DASH manifests, but for some titles
 * it returns nothing usable while `resource` still lists direct mirrors — and
 * vice versa. Asking only one of them was the difference between "0
 * candidates" and a playable list.
 */
export async function findStreamsByTitle(title, { year = null, kind = null, season = 0, episode = 0, signal = null } = {}) {
  const results = await search(title, { perPage: 20, signal });
  if (!results.length) return { item: null, candidates: [] };
  const scored = results.map((item) => {
    let score = 0;
    const t = item.title.toLowerCase();
    const q = title.toLowerCase();
    if (t === q) score += 60; else if (t.includes(q) || q.includes(t)) score += 35;
    if (year && item.year && Math.abs(item.year - year) <= 1) score += 25;
    if (kind && item.kind === kind) score += 10;
    return { item, score };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0].item;
  log.info('moviebox', `best match for "${title}"`, { matched: best.title, year: best.year, score: scored[0].score });

  const resourcePage = episode > 0 ? Math.floor((episode - 1) / 20) + 1 : 1;
  const [playOutcome, resourceOutcome] = await Promise.allSettled([
    playInfo(best.subjectId, { se: season, ep: episode, signal }),
    resources(best.subjectId, { page: resourcePage, perPage: 20, se: season || null, ep: episode || null, signal }),
  ]);

  const candidates = [];
  const seen = new Set();
  const push = (list) => {
    for (const candidate of list) {
      const key = String(candidate.url).split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  };

  if (playOutcome.status === 'fulfilled') {
    push(releasesFromPlayInfo(playOutcome.value, { season, episode, userAgent: identity().userAgent }));
  } else if (playOutcome.reason?.name !== 'AbortError') {
    log.warn('moviebox', 'play-info failed for the selected title', { error: errorText(playOutcome.reason) });
  }
  if (resourceOutcome.status === 'fulfilled') {
    push(releasesFromResources(resourceOutcome.value, { season, episode }));
  } else if (resourceOutcome.reason?.name !== 'AbortError') {
    log.warn('moviebox', 'resource listing failed for the selected title', { error: errorText(resourceOutcome.reason) });
  }

  if (!candidates.length) {
    log.warn('moviebox', 'selected title resolved to zero candidates', {
      matched: best.title, subjectId: best.subjectId,
      playInfo: playOutcome.status, resources: resourceOutcome.status,
    });
  }
  return { item: best, candidates };
}

export function status() {
  const pool = getHostPool();
  const proxy = (() => { try { return getConfig()?.scraper?.proxyUrl || ''; } catch { return ''; } })() || process.env.MOVIEBOX_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  return {
    session: session ? { uid: session.uid, savedAt: session.savedAt, expiresAt: session.expiresAt || null } : null,
    identity: deviceIdentity ? { userAgent: deviceIdentity.userAgent.slice(0, 60), spoofedIp: deviceIdentity.spoofedIp } : null,
    host: pool[hostIndex % pool.length],
    hostsTotal: pool.length,
    hosts: pool,
    proxy: proxy ? proxy.replace(/:\/\/[^@]*@/, '://***@') : null,
    proxyConfigured: Boolean(proxy),
    browserFallback: browserFallbackEnabled(),
    lastError,
    consecutiveFailures,
    backoffUntilMs: disabledUntil > Date.now() ? disabledUntil : null,
    backedOff: Date.now() < disabledUntil,
  };
}

/** Test/ops helper: reset backoff state so an operator can retry immediately. */
export function resetBackoff() {
  consecutiveFailures = 0;
  disabledUntil = 0;
  lastError = null;
}

export default {
  search, detail, seasonInfo, playInfo, resources, captions, findStreamsByTitle,
  releasesFromPlayInfo, releasesFromResources, status, resetBackoff, resetIdentity,
  classifyFetchError, parseJwtClaims, sessionIsValid, HOST_POOL, getHostPool,
};
