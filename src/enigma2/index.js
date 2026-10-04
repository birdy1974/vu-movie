/**
 * vu-movie — Enigma2 bouquets for the VU+ Duo2.
 *
 * What we write (both files live in /etc/enigma2 on the box):
 *
 *   userbouquet.vumovie.tv
 *     #NAME vu-movie (TV)
 *     #SERVICE 4097:0:1:0:0:0:0:0:0:0:http%3a//192.168.1.10%3a8080/s/<token>/x.ts:Title (2024) [NL]
 *     #DESCRIPTION Title (2024) — 1080p · NL subs
 *
 *   bouquets.tv  (one line per bouquet, added only once)
 *     #SERVICE 1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "userbouquet.vumovie.tv" ORDER BY bouquet
 *
 * Delivery is OpenWebif over HTTP (your decision D5): upload → servicelistreload
 * → verify with getservices. A curl/FTP fallback exists for boxes where WebIF's
 * upload is disabled or password protected in a way we cannot satisfy.
 *
 * Service type 4097 (GStreamer/exteplayer3) is the safe default for IPTV on a
 * Duo2. The service reference numbers must be unique per entry or Enigma2 will
 * silently drop duplicates, which is why we generate them from the stream token.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { log, truncate } from '../core/log.js';
import { getConfig } from '../core/config.js';
import { repo } from '../core/db.js';

/** Enigma2 expects the URL percent-encoded, but with the slashes readable. */
export function encodeE2Url(url) {
  return String(url)
    .split('?')[0] // keep it simple: query strings confuse many E2 players
    .replace(/:/g, '%3a')
    .replace(/\s/g, '%20');
}

/** Service reference: <type>:0:1:<sid>:<tsid>:<onid>:0:0:0:0:<url>:<name> */
export function serviceRef({ url, name, type = 4097, sid = null, tsid = 0, onid = 0 }) {
  const cleanName = String(name || 'vu-movie').replace(/:/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60);
  const id = sid || hashCode(url);
  const sidHex = (id % 0xffff).toString(16).padStart(4, '0').toUpperCase();
  return `#SERVICE ${type}:0:1:${sidHex}:${tsid.toString(16).padStart(4, '0')}:${onid.toString(16).padStart(4, '0')}:0:0:0:0:${encodeE2Url(url)}:${cleanName}`;
}

function hashCode(text) {
  let hash = 0;
  for (let i = 0; i < String(text).length; i += 1) {
    hash = (hash * 31 + String(text).charCodeAt(i)) % 0xffff;
  }
  return hash || 1;
}

/**
 * Build the bouquet file content.
 * @param {object} o
 * @param {string} o.name      bouquet name ("vu-movie")
 * @param {number} o.serviceType
 * @param {object[]} o.entries [{ title, url, description, poster, subtitle, season }]
 */
export function buildBouquet({ name = 'vu-movie', serviceType = 4097, entries = [] }) {
  const lines = [`#NAME ${name} (TV)`];
  const used = new Set();
  let count = 0;
  let lastSeason = null;

  for (const entry of entries) {
    if (!entry?.url) continue;
    // Season separators make a series usable on the box.
    if (entry.season && entry.season !== lastSeason) {
      lastSeason = entry.season;
      lines.push(`#NAME ── ${entry.series || entry.title} · Season ${entry.season} ──`);
    }
    const label = entry.label || `${entry.title}${entry.year ? ` (${entry.year})` : ''}${entry.subtitle ? ` [${entry.subtitle}]` : ''}`;
    let ref = serviceRef({ url: entry.url, name: label, type: serviceType });
    // Duplicate service references are dropped by Enigma2 → disambiguate.
    if (used.has(ref)) ref = `${ref}${count}`;
    used.add(ref);
    lines.push(ref);
    lines.push(`#DESCRIPTION ${entry.description || label}`);
    count += 1;
  }

  return {
    name,
    text: `${lines.join('\n')}\n`,
    entries: count,
    fileName: `userbouquet.${name.replace(/[^A-Za-z0-9._-]/g, '')}.tv`,
    bouquetsLine: `#SERVICE 1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "userbouquet.${name.replace(/[^A-Za-z0-9._-]/g, '')}.tv" ORDER BY bouquet`,
  };
}

/** Add our bouquet to bouquets.tv exactly once (idempotent). */
export function patchBouquetsTv(existingText, bouquetFile) {
  const line = `#SERVICE 1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "${bouquetFile}" ORDER BY bouquet`;
  const current = String(existingText || '');
  if (current.includes(bouquetFile)) return { text: current, changed: false, line };
  const base = current.trim().length ? current.replace(/\s*$/, '') : '#NAME User - bouquets (TV)';
  return { text: `${base}\n${line}\n`, changed: true, line };
}

/* ------------------------------------------------------------------ *
 * OpenWebif transport
 * ------------------------------------------------------------------ */

function webifBase(cfg = getConfig().enigma2) {
  return `http://${cfg.host}:${cfg.port || 80}`;
}

function authHeader(cfg = getConfig().enigma2) {
  if (!cfg.username) return {};
  const token = Buffer.from(`${cfg.username}:${cfg.password || ''}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

/** First non-empty `<tag>…</tag>` in an OpenWebif XML response. */
export function xmlTag(text, tags = []) {
  for (const tag of tags) {
    // Deliberately escape-free: XML values here never contain '<', and a
    // character class inside a template literal is a backslash-quoting trap
    // (a stray '\s' silently becomes 's', so the tag never matches).
    const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(String(text || ''));
    if (match && String(match[1]).trim()) return String(match[1]).trim();
  }
  return '';
}

/**
 * How long a cached status stays valid.
 *
 * `/api/health` answers the container healthcheck (every 30 s) *and* the
 * dashboard (every 15 s), and both used to forward a fresh request to the
 * receiver — a VU+ Duo2 got woken up every 15 seconds for a value that changes
 * roughly never. Callers that really need the truth (the UI's "test
 * connection", a bouquet push) pass `force: true`.
 */
export const STATUS_TTL_MS = 60_000;
let statusCache = { at: 0, value: null };
let lastReachability = null;

/** Forget a cached receiver status (after the host/credentials change). */
export function resetStatusCache() {
  statusCache = { at: 0, value: null };
  lastReachability = null;
}

/**
 * The last known receiver state, or a placeholder that says it was never
 * checked. **Never contacts the box** — this is what `/api/health` reports.
 *
 * The container healthcheck hits `/api/health` every 30 s and the dashboard
 * every 15 s; neither is a reason to wake a VU+. The receiver is checked when
 * the operator asks (Settings → Enigma2 → test connection) or when we actually
 * need it (a bouquet push), and the dashboard simply shows the outcome.
 */
export function cachedStatus() {
  const cfg = getConfig().enigma2;
  if (!cfg.host) return { configured: false, ok: false, checked: false, message: 'no receiver configured (Settings → Enigma2)' };
  if (statusCache.value) {
    return { ...statusCache.value, cached: true, checked: true, ageMs: Date.now() - statusCache.at };
  }
  return {
    configured: true, ok: null, checked: false, ageMs: null,
    message: 'not checked — press “test connection” in Settings → Enigma2',
  };
}

/**
 * Log the receiver state only when it *changes*.
 *
 * The old code logged `receiver reachable: <model>` at INFO on every poll, so
 * the log filled with identical lines every 15 s while the dashboard was open
 * and the one line worth reading (the receiver going away) drowned in them.
 */
function logReachability(result) {
  const state = result.ok
    ? `up|${result.model}|${result.version}`
    : `down|${result.status || result.message || 'unreachable'}`;
  const changed = state !== lastReachability;
  const previous = lastReachability;
  lastReachability = state;
  if (result.ok) {
    if (changed || !previous) {
      log.info('enigma2', `receiver reachable: ${result.model}`, {
        version: result.version, ...(previous ? { was: previous } : {}),
      });
    } else {
      log.debug('enigma2', `receiver still reachable (${result.model})`, { cached: true });
    }
    return;
  }
  if (changed || !previous) log.warn('enigma2', `receiver unreachable: ${result.message}`, { status: result.status || null });
  else log.debug('enigma2', 'receiver still unreachable', { cached: true, message: result.message });
}

async function requestStatus(cfg, timeoutMs) {
  if (!cfg.host) return { configured: false, ok: false, message: 'no receiver configured (Settings → Enigma2)' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(`${webifBase(cfg)}/web/about`, { headers: authHeader(cfg), signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      return { configured: true, ok: false, status: res.status, message: `WebIF HTTP ${res.status} (check user/password)` };
    }
    // OpenWebif's /web/about answers with <e2model>, <e2enigmaversion>,
    // <e2imageversion>, <e2webifversion>; plain <model>/<version> only turn
    // up on some images. Read both, otherwise `version` is silently "".
    const model = xmlTag(text, ['model', 'e2model']) || 'unknown';
    const version = xmlTag(text, ['e2enigmaversion', 'e2imageversion', 'e2distroversion', 'e2webifversion', 'image', 'version']);
    return { configured: true, ok: true, model, version, message: `WebIF ok (${model}${version ? `, ${version}` : ''})` };
  } catch (err) {
    const message = controller.signal.aborted
      ? `connection timed out after ${Math.ceil(timeoutMs / 1000)}s`
      : String(err?.message || err);
    return { configured: true, ok: false, message };
  } finally {
    clearTimeout(timer);
  }
}

/** Test the values currently entered in Settings without persisting them. */
export async function testConnection(overrides = {}, { timeoutMs = 6000 } = {}) {
  const saved = getConfig().enigma2;
  const cfg = { ...saved, ...overrides };
  // The UI deliberately leaves a stored password blank; blank means reuse the
  // saved credential for a test. Saving settings can still clear it explicitly.
  if (!overrides.password) cfg.password = saved.password;
  return requestStatus(cfg, timeoutMs);
}

export async function status({ timeoutMs = 6000, maxAgeMs = STATUS_TTL_MS, force = false } = {}) {
  const cfg = getConfig().enigma2;
  if (!cfg.host) return { configured: false, ok: false, message: 'no receiver configured (Settings → Enigma2)' };
  const age = Date.now() - statusCache.at;
  if (!force && statusCache.value && age < maxAgeMs) {
    return { ...statusCache.value, cached: true, ageMs: age };
  }
  const result = await requestStatus(cfg, timeoutMs);
  // Cache the outcome either way: a receiver that is down is polled just as
  // often as one that is up, and the healthcheck must not amplify that.
  statusCache = { at: Date.now(), value: result };
  logReachability(result);
  return result;
}

async function webifGet(urlPath) {
  const res = await fetch(`${webifBase()}${urlPath}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) throw new Error(`WebIF ${urlPath} → HTTP ${res.status}`);
  return text;
}

/**
 * Upload one file to the box.
 * Order of attempts: WebIF upload endpoint → curl/FTP → local mounted share.
 */
async function uploadFile(fileName, content) {
  const cfg = getConfig().enigma2;
  const attempts = [];

  // 1) OpenWebif file-manager upload (newer images expose /web/upload)
  for (const endpoint of [cfg.uploadEndpoint, '/web/upload', '/file?action=upload'].filter(Boolean)) {
    try {
      const form = new FormData();
      form.append('file', new Blob([content]), fileName);
      form.append('path', cfg.rootDir);
      form.append('filename', fileName);
      const res = await fetch(`${webifBase()}${endpoint}`, { method: 'POST', headers: authHeader(), body: form });
      const text = await res.text().catch(() => '');
      if (res.ok && !/error|not found/i.test(text.slice(0, 200))) {
        log.info('enigma2', `uploaded ${fileName} via WebIF ${endpoint}`, { bytes: content.length });
        return { ok: true, via: `webif:${endpoint}` };
      }
      attempts.push(`${endpoint} → HTTP ${res.status} ${truncate(text, 80)}`);
    } catch (err) {
      attempts.push(`${endpoint} → ${String(err?.message || err)}`);
    }
  }

  // 2) FTP via curl (works on boxes where the WebIF upload is disabled)
  if (cfg.ftpEnabled) {
    const tmp = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(tmp, content);
    const target = `ftp://${cfg.host}:${cfg.ftpPort}/${cfg.rootDir.replace(/^\//, '')}/${fileName}`;
    const res = spawnSync('curl', [
      '-sS', '--fail', '--ftp-create-dirs', '-u', `${cfg.username}:${cfg.password || ''}`,
      '-T', tmp, target,
    ], { encoding: 'utf8', timeout: 30000 });
    fs.rmSync(tmp, { force: true });
    if (!res.error && res.status === 0) {
      log.info('enigma2', `uploaded ${fileName} via FTP`, { target });
      return { ok: true, via: 'ftp' };
    }
    attempts.push(`ftp → ${res.error ? res.error.message : truncate(String(res.stderr || `exit ${res.status}`), 120)}`);
  }

  // 3) A mounted share (some people map /etc/enigma2 over NFS/SMB).
  //    `mountDir` was never a config key, so this path could never run; the
  //    directory to mount is the one bouquets live in on the box.
  if (cfg.rootDir && fs.existsSync(cfg.rootDir)) {
    try {
      fs.writeFileSync(path.join(cfg.rootDir, fileName), content);
      log.info('enigma2', `wrote ${fileName} into mounted share`, { dir: cfg.rootDir });
      return { ok: true, via: 'mount' };
    } catch (err) {
      attempts.push(`mount → ${String(err?.message || err)}`);
    }
  }

  log.error('enigma2', `could not upload ${fileName} by any transport`, { attempts });
  return { ok: false, attempts, error: attempts.join(' | ') };
}

/**
 * Push a bouquet for the given entries.
 * @param {object[]} entries [{ title, url, year, description, subtitle, season, series }]
 */
export async function pushBouquet(entries, { name = null, dryRun = false } = {}) {
  const cfg = getConfig().enigma2;
  const bouquetName = name || cfg.bouquetName;
  const bouquet = buildBouquet({ name: bouquetName, serviceType: cfg.serviceType, entries });
  log.info('enigma2', `preparing bouquet "${bouquetName}"`, { entries: bouquet.entries, file: bouquet.fileName, dryRun });

  if (bouquet.entries === 0) {
    return { ok: false, error: 'nothing to push — no streams selected', bouquet };
  }
  if (dryRun) {
    return { ok: true, dryRun: true, bouquet, bouquetsLine: bouquet.bouquetsLine };
  }

  // A push must not trust a cached "reachable": a box that went to standby
  // since the last check would fail halfway through the upload. This also
  // refreshes the state the dashboard shows.
  const reachable = await status({ force: true });
  if (!reachable.ok) {
    return { ok: false, error: `receiver not reachable: ${reachable.message}`, bouquet };
  }

  const upload = await uploadFile(bouquet.fileName, bouquet.text);
  if (!upload.ok) return { ok: false, error: `upload failed: ${upload.error}`, bouquet, transport: upload };

  // bouquets.tv: read → patch → upload (idempotent)
  let bouquetsTv = '';
  try {
    const res = await fetch(`${webifBase()}/file?action=get&path=${encodeURIComponent(`${cfg.rootDir}/bouquets.tv`)}`, { headers: authHeader() });
    if (res.ok) bouquetsTv = await res.text();
  } catch (err) {
    log.warn('enigma2', 'could not read bouquets.tv (will upload without patching)', { error: String(err?.message || err) });
  }
  const patched = patchBouquetsTv(bouquetsTv, bouquet.fileName);
  if (patched.changed) {
    const up2 = await uploadFile('bouquets.tv', patched.text);
    if (!up2.ok) {
      return { ok: false, error: `bouquet uploaded but bouquets.tv could not be patched: ${up2.error}`, bouquet };
    }
    log.info('enigma2', 'bouquets.tv patched with our entry');
  } else {
    log.info('enigma2', 'bouquets.tv already references our bouquet — left unchanged');
  }

  // Reload + verify
  let reloadOk = false;
  for (const mode of ['2', '0']) {
    try {
      await webifGet(`/web/servicelistreload?mode=${mode}`);
      reloadOk = true;
      log.info('enigma2', `servicelistreload mode=${mode} ok`);
    } catch (err) {
      log.warn('enigma2', `servicelistreload mode=${mode} failed`, { error: String(err?.message || err) });
    }
  }

  let verified = null;
  try {
    const services = await webifGet(`/web/getservices?sRef=${encodeURIComponent(bouquetsLineRef(bouquet.fileName))}`);
    const count = (services.match(/<e2service>/g) || []).length;
    verified = count;
    if (count < bouquet.entries) {
      log.warn('enigma2', `receiver reports ${count} of ${bouquet.entries} entries — duplicate service refs or a reload in progress`);
    } else {
      log.info('enigma2', `verified ${count} entries on the receiver`);
    }
  } catch (err) {
    log.warn('enigma2', 'could not verify the bouquet with getservices', { error: String(err?.message || err) });
  }

  await repo.saveBouquet({ name: bouquetName, entries: bouquet.entries, pushed_at: new Date().toISOString(), payload: { via: upload.via, verified } });

  return {
    ok: true,
    entries: bouquet.entries,
    verified,
    transport: upload.via,
    reloadOk,
    bouquet,
  };
}

function bouquetsLineRef(fileName) {
  return `1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "${fileName}" ORDER BY bouquet`;
}

/** Build a bouquet preview without touching the box (used by the UI). */
export function previewBouquet(entries, { name = null } = {}) {
  const cfg = getConfig().enigma2;
  const bouquet = buildBouquet({ name: name || cfg.bouquetName, serviceType: cfg.serviceType, entries });
  return {
    ...bouquet,
    bouquetsLine: bouquet.bouquetsLine,
    rootDir: cfg.rootDir,
  };
}

export default { buildBouquet, patchBouquetsTv, pushBouquet, previewBouquet, status, encodeE2Url, serviceRef };
