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
import { log, logError, truncate } from '../core/log.js';
import { getConfig } from '../core/config.js';
import { request, sleep } from './http.js';

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
const RETRY_STATUS = new Set([403, 406, 407, 429, 500, 502, 503, 504]);
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

async function login(identity) {
  const base = HOST_POOL[hostIndex % HOST_POOL.length];
  const url = `${base}${API_PREFIX}/user-api/visitor-login`;
  const body = '{}';
  log.info('moviebox', 'requesting a visitor token', { host: base });
  const res = await request(url, {
    method: 'POST', body, headers: signedHeaders({ method: 'POST', url, body, identity }), retries: 1,
    allowFailure: true, useJar: false,
  });
  if (!res.ok) {
    lastError = `visitor-login failed: ${res.error || res.status}`;
    logError('moviebox', 'visitor-login failed', new Error(lastError), { host: base });
    return null;
  }
  const token = res.data?.token;
  if (!token) {
    lastError = 'visitor-login returned no token';
    log.error('moviebox', lastError, { body: truncate(res.text, 200) });
    return null;
  }
  session = { token, uid: res.data?.uid || res.data?.userId || null, savedAt: new Date().toISOString() };
  saveSession(session);
  log.info('moviebox', 'visitor token acquired', { uid: session.uid, host: base });
  return session;
}

async function ensureSession(identity) {
  if (session?.token) return session;
  session = loadSession();
  if (session?.token) return session;
  return login(identity);
}

/**
 * Perform a signed request, walking the host pool and re-authenticating once on
 * 401/403 (the reference client does exactly this).
 */
async function apiRequest(pathAndQuery, { method = 'GET', body, authenticated = true } = {}) {
  const identity = clientIdentity();
  if (authenticated) await ensureSession(identity);

  for (let hop = 0; hop < HOST_POOL.length; hop += 1) {
    const idx = (hostIndex + hop) % HOST_POOL.length;
    const base = HOST_POOL[idx];
    const url = `${base}${API_PREFIX}${pathAndQuery}`;
    const headers = signedHeaders({ method, url, body, token: authenticated ? session?.token : null, identity });
    const res = await request(url, { method, body, headers, retries: 0, json: true, allowFailure: true, useJar: false });

    if (res.ok) {
      hostIndex = idx; // stick to a host that works
      return res.data;
    }
    if (res.status && RETRY_STATUS.has(res.status)) {
      log.warn('moviebox', `host ${base} answered ${res.status} — switching host`, { path: pathAndQuery });
      if (res.status === 401 || res.status === 403) { session = null; await ensureSession(identity); }
      await sleep(120 * (hop + 1));
      continue;
    }
    lastError = res.error || `HTTP ${res.status}`;
    log.warn('moviebox', 'request failed on this host', { host: base, path: pathAndQuery, error: lastError });
  }
  log.error('moviebox', 'all API hosts exhausted', { path: pathAndQuery, lastError });
  throw new Error(`MovieBox request failed (${pathAndQuery}): ${lastError || 'all hosts exhausted'}`);
}

/* ---------------- public API ---------------- */

export function isAvailable() { return true; }

export async function search(query, { page = 1, perPage = 15 } = {}) {
  if (!query) throw new Error('search needs a query');
  const data = await apiRequest(`${API_PREFIX ? '' : ''}/subject-api/search/v2`, {
    method: 'POST',
    body: JSON.stringify({ keyword: query, page, perPage }),
  });
  const items = data?.items || data?.data?.items || data?.list || [];
  log.info('moviebox', `search "${query}" → ${items.length} items`);
  return items.map((item) => ({
    subjectId: String(item.subjectId || item.id || ''),
    title: item.title || item.name || '',
    year: Number(item.year || item.releaseDate?.slice(0, 4) || 0) || null,
    kind: /tv|series|show/i.test(String(item.subjectType ?? item.type ?? '')) ? 'series' : 'movie',
    poster: item.cover?.url || item.poster || null,
    rating: item.imdbRatingValue ? Number(item.imdbRatingValue) : null,
    description: item.description || null,
    seasonCount: item.seasonCount || null,
    duration: item.duration || null,
  })).filter((i) => i.subjectId);
}

export async function detail(subjectId) {
  const data = await apiRequest(`/subject-api/get?subjectId=${encodeURIComponent(subjectId)}`);
  return data?.data || data;
}

export async function seasonInfo(subjectId) {
  const data = await apiRequest(`/subject-api/season-info?subjectId=${encodeURIComponent(subjectId)}`);
  return data?.data || data;
}

export async function resources(subjectId, { page = 1, perPage = 20, se = null, ep = null, resolution = null } = {}) {
  const params = [`subjectId=${encodeURIComponent(subjectId)}`];
  if (se) params.push(`se=${se}`);
  if (ep) params.push(`ep=${ep}`);
  params.push(`page=${page}`, `perPage=${perPage}`);
  if (resolution) params.push(`resolution=${resolution}`);
  const data = await apiRequest(`/subject-api/resource?${params.join('&')}`);
  return data?.data || data;
}

export async function playInfo(subjectId, { se = 0, ep = 0 } = {}) {
  const q = se && ep
    ? `/subject-api/play-info/v2?subjectId=${encodeURIComponent(subjectId)}&se=${se}&ep=${ep}`
    : `/subject-api/play-info/v2?subjectId=${encodeURIComponent(subjectId)}`;
  const data = await apiRequest(q);
  return data?.data || data;
}

export async function captions(subjectId, resourceId) {
  const q = `/subject-api/get-ext-captions?subjectId=${encodeURIComponent(subjectId)}&resourceId=${encodeURIComponent(resourceId)}`;
  const data = await apiRequest(q);
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
export async function findStreamsByTitle(title, { year = null, kind = null, season = 0, episode = 0 } = {}) {
  const results = await search(title, { perPage: 20 });
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
  const info = await playInfo(best.subjectId, { se: season, ep: episode });
  return { item: best, candidates: releasesFromPlayInfo(info, { season, episode }) };
}

export function status() {
  return { session: session ? { uid: session.uid, savedAt: session.savedAt } : null, host: HOST_POOL[hostIndex % HOST_POOL.length], lastError };
}

export default { search, detail, playInfo, resources, captions, findStreamsByTitle, releasesFromPlayInfo, status };
