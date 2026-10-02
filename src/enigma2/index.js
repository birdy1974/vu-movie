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
import { log, logError, truncate } from '../core/log.js';
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

function webifBase() {
  const cfg = getConfig().enigma2;
  return `http://${cfg.host}:${cfg.port}`;
}

function authHeader() {
  const cfg = getConfig().enigma2;
  if (!cfg.username) return {};
  const token = Buffer.from(`${cfg.username}:${cfg.password || ''}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

export async function status({ timeoutMs = 6000 } = {}) {
  const cfg = getConfig().enigma2;
  if (!cfg.host) return { configured: false, ok: false, message: 'no receiver configured (Settings → Enigma2)' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${webifBase()}/web/about`, { headers: authHeader(), signal: controller.signal });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) {
      log.warn('enigma2', 'WebIF reachable but refused the request', { status: res.status });
      return { configured: true, ok: false, status: res.status, message: `WebIF HTTP ${res.status} (check user/password)` };
    }
    const model = (/<model>([^<]+)<\/model>/.exec(text) || [])[1]
      || (/<e2model>([^<]+)<\/e2model>/.exec(text) || [])[1] || 'unknown';
    const version = (/<image>([^<]+)<\/image>/.exec(text) || [])[1] || (/<version>([^<]+)<\/version>/.exec(text) || [])[1] || '';
    log.info('enigma2', `receiver reachable: ${model}`, { version });
    return { configured: true, ok: true, model, version, message: `WebIF ok (${model}${version ? `, ${version}` : ''})` };
  } catch (err) {
    logError('enigma2', `cannot reach the receiver at ${cfg.host}:${cfg.port}`, err);
    return { configured: true, ok: false, message: String(err?.message || err) };
  }
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

  // 3) A mounted share (some people map /etc/enigma2 over NFS/SMB)
  if (cfg.mountDir && fs.existsSync(cfg.mountDir)) {
    try {
      fs.writeFileSync(path.join(cfg.mountDir, fileName), content);
      log.info('enigma2', `wrote ${fileName} into mounted share`, { dir: cfg.mountDir });
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

  const reachable = await status();
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
