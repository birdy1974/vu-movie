/**
 * vu-movie — native MovieBox client.
 *
 * You asked to use https://github.com/mesamirh/MovieBox-TUI for scraping. That
 * project is a Rust TUI under Apache-2.0 whose real value is the *protocol* it
 * speaks: a signed REST API (`api*.aoneroom.com`, `/wefeed-mobile-bff/...`) with
 *   - a visitor-login that returns a bearer token,
 *   - `x-client-token: <ts>,<md5(reversed ts)>`,
 *   - `x-tr-signature: <ts>|2|<base64(hmac-md5(secret, canonical string))>`,
 *   - a device-spoofing `x-client-info` header and a spoofed `x-forwarded-for`.
 *
 * This file re-implements that protocol in ~250 lines of JavaScript instead of
 * bundling a Rust binary: same endpoints, same signing, no CLI parsing, and it
 * fits in the same container as the rest of the app. Attribution: protocol
 * reverse-engineered by the MovieBox-TUI authors (Apache-2.0).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { errorText, log, logError, truncate } from '../core/log.js';
import { getConfig } from '../core/config.js';
import { request } from './http.js';
import { normalizeSearchMetadata } from './metadata.js';

const API_PREFIX = '/wefeed-mobile-bff';
const HOST_POOL = [
  'https://api6.aoneroom.com',
  'https://api5.aoneroom.com',
  'https://api4.aoneroom.com',
  'https://api4sg.aoneroom.com',
  'https://api3.aoneroom.com',
  'https://api6sg.aoneroom.com',
  'https://api.inmoviebox.com',
];
const HOST_REQUEST_TIMEOUT_MS = 12_000;
/** Referer the client app uses when fetching media from the CDN. */
export const STREAM_REFERER = 'https://sportslive.wine';
/** 32-byte key baked into the client (Apache-2.0 MovieBox-TUI, crypto.rs). */
const SECRET = Buffer.from([
  0xef, 0xa8, 0x91, 0x97, 0x4e, 0xec, 0xd3, 0x14, 0x8d, 0xf6, 0x3a, 0xa6,
  0x11, 0x60, 0x2d, 0xef, 0xd1, 0x01, 0x25, 0x9b, 0xa5, 0x21, 0x02, 0x2c,
  0x57, 0xae, 0x05, 0x66, 0xbd, 0x8e, 0x12,
]);
const SIGNATURE_BODY_MAX = 102_400;

let session = null;      // { token, uid, savedAt }
let hostIndex = 0;
let lastError = null;

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
  for (let hop = 0; hop < hosts.length; hop += 1) {
    if (signal?.aborted) throw abortError(signal);
    const index = (startIndex + hop) % hosts.length;
    const host = hosts[index];
    try {
      const result = await requestHost(host, index, hop);
      if (result?.ok) return { ok: true, result, index };
      lastError = result?.error instanceof Error
        ? result.error
        : new Error(String(result?.error || `HTTP ${result?.status || 'request failed'}`));
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

const sessionFile = () => path.join(getConfig().scraper.sessionDir, 'moviebox.json');

function loadSession() {
  try {
    const file = sessionFile();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.token) {
        log.debug('moviebox', 'restored visitor session from disk', { savedAt: data.savedAt });
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
    fs.writeFileSync(file, JSON.stringify(s, null, 2));
  } catch (err) {
    log.warn('moviebox', 'could not persist session', { error: String(err?.message || err) });
  }
}

function clearSession() {
  session = null;
  try { fs.rmSync(sessionFile(), { force: true }); }
  catch (err) { log.warn('moviebox', 'could not remove the rejected visitor session', { error: String(err?.message || err) }); }
}

async function login(identity, { signal = null } = {}) {
  const body = '{}';
  log.info('moviebox', 'requesting a visitor token', { startHost: HOST_POOL[hostIndex % HOST_POOL.length] });
  const outcome = await loginWithHostFailover({
    startIndex: hostIndex,
    signal,
    requestHost: async (base) => {
      const url = `${base}${API_PREFIX}/user-api/visitor-login`;
      return request(url, {
        method: 'POST', body,
        headers: signedHeaders({ method: 'POST', url, body, identity }),
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
      log.warn('moviebox', `visitor-login failed on ${host} — trying next host`, { hop: hop + 1, error: lastError });
    },
  });

  if (!outcome.ok) {
    lastError = errorText(outcome.error);
    logError('moviebox', 'visitor-login failed on every API host', outcome.error);
    throw new Error(`MovieBox visitor-login failed: ${lastError}`, { cause: outcome.error });
  }

  hostIndex = outcome.index;
  session = outcome.result.session;
  lastError = null;
  saveSession(session);
  log.info('moviebox', 'visitor token acquired', { uid: session.uid, host: HOST_POOL[hostIndex] });
  return session;
}

async function ensureSession(identity, { signal = null } = {}) {
  if (session?.token) return session;
  session = loadSession();
  if (session?.token) return session;
  return login(identity, { signal });
}

/** Signed API request with per-host transport/status failover and one re-login on 401/403. */
export async function apiRequest(pathAndQuery, { method = 'GET', body, authenticated = true, signal = null } = {}) {
  const identity = clientIdentity();
  if (authenticated) await ensureSession(identity, { signal });

  let reauthenticationAttempted = false;
  const outcome = await requestHostPool({
    startIndex: hostIndex,
    signal,
    requestHost: async (base) => {
      const url = `${base}${API_PREFIX}${pathAndQuery}`;
      const send = () => request(url, {
        method, body,
        headers: signedHeaders({ method, url, body, token: authenticated ? session?.token : null, identity }),
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
          await ensureSession(identity, { signal });
        } catch (err) {
          throw Object.assign(err, { terminal: true });
        }
        res = await send();
      }
      return res;
    },
    onFailure: ({ host, hop, error, result }) => {
      lastError = errorText(error);
      const status = result?.status;
      log.warn('moviebox', status
        ? `host ${host} answered ${status} — trying next host`
        : `request failed on ${host} — trying next host`, {
        path: pathAndQuery, hop: hop + 1, error: lastError,
      });
    },
  });

  if (!outcome.ok) {
    lastError = errorText(outcome.error);
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

function isDeprecationUrl(url = '') {
  return !/^https?:/i.test(url) || /deprecat|notice|unavailable/i.test(url);
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

/** High level: search → pick best match → candidate list. */
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
  const info = await playInfo(best.subjectId, { se: season, ep: episode, signal });
  return { item: best, candidates: releasesFromPlayInfo(info, { season, episode }) };
}

export function status() {
  return { session: session ? { uid: session.uid, savedAt: session.savedAt } : null, host: HOST_POOL[hostIndex % HOST_POOL.length], lastError };
}

export default { search, detail, seasonInfo, playInfo, resources, captions, findStreamsByTitle, releasesFromPlayInfo, status };
