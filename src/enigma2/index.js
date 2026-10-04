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
 * File writes use the receiver's FTP server (OpenWebif has no portable upload
 * endpoint); OpenWebif handles servicelistreload and getservices verification.
 * Every file is staged under a temporary name and renamed in-place, and the
 * previous bouquets.tv is kept as one restore point.
 *
 * Service type 4097 (GStreamer/exteplayer3) is the safe default for IPTV on a
 * Duo2. The service reference numbers must be unique per entry or Enigma2 will
 * silently drop duplicates, which is why we generate them from the stream token.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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

  const webif = await requestStatus(cfg, timeoutMs);
  let upload = {
    configured: false,
    ok: false,
    message: 'FTP file upload is disabled and no mounted receiver share was found',
  };
  if (cfg.ftpEnabled) {
    try {
      const names = createFtpFileTransport(cfg).list();
      upload = {
        configured: true,
        ok: true,
        files: names.size,
        hasBouquetsTv: names.has('bouquets.tv'),
        message: `FTP ok (${names.size} files in ${cfg.rootDir || '/etc/enigma2'})`,
      };
    } catch (err) {
      upload = { configured: true, ok: false, message: String(err?.message || err) };
    }
  } else if (cfg.rootDir && fs.existsSync(cfg.rootDir)) {
    upload = { configured: false, ok: true, via: 'mount', message: `FTP disabled; mounted directory found at ${cfg.rootDir}` };
  }

  return {
    ...webif,
    ok: webif.ok && upload.ok !== false,
    upload,
    message: `${webif.message}; ${upload.message}`,
  };
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

/* ------------------------------------------------------------------ *
 * Receiver file transport
 *
 * OpenWebif can reload/query services, but it does not provide a portable
 * upload API for files under /etc/enigma2. In particular, /web/upload is not a
 * standard route, and POSTing multipart data to /file?action=upload produces
 * "Request did not return bytes" on OpenPLi. Use the receiver's FTP server for
 * file I/O; OpenWebif is retained for reload and verification only.
 *
 * Each FTP write is staged in the same directory and renamed into place. This
 * prevents Enigma2 from seeing a half-written bouquets.tv while it is reading
 * the service list. A one-file backup of bouquets.tv is kept before updates.
 * ------------------------------------------------------------------ */

const FTP_TIMEOUT_MS = 25_000;
const FTP_CONNECT_TIMEOUT_SECONDS = 8;
const FTP_MAX_BUFFER = 1024 * 1024;
const FTP_TEMP_PREFIX = '.spm-upload-';
const BOUQUETS_BACKUP = 'bouquets.tv.spm-backup';

function ftpHostPart(rawHost) {
  let host = String(rawHost || '').trim().replace(/^(?:https?|ftp):\/\//i, '').split('/')[0];
  if (host.startsWith('[')) host = host.slice(0, host.indexOf(']') >= 0 ? host.indexOf(']') + 1 : undefined);
  else if ((host.match(/:/g) || []).length > 1) host = `[${host}]`;
  else host = host.replace(/:\d+$/, '');
  if (!host) throw new Error('no Enigma2 FTP host configured');
  return host;
}

function remoteDirectorySegments(rootDir) {
  const segments = String(rootDir || '/etc/enigma2').replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`unsafe Enigma2 root directory: ${rootDir}`);
  }
  return segments;
}

function safeRemoteFileName(name) {
  const fileName = String(name || '');
  if (!/^[A-Za-z0-9._-]+$/.test(fileName) || fileName === '.' || fileName === '..') {
    throw new Error(`unsafe Enigma2 file name: ${fileName}`);
  }
  return fileName;
}

function ftpUrl(cfg, fileName = null) {
  const port = Number(cfg.ftpPort || 21);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid Enigma2 FTP port: ${cfg.ftpPort}`);
  const parts = remoteDirectorySegments(cfg.rootDir);
  if (fileName !== null) parts.push(safeRemoteFileName(fileName));
  const host = ftpHostPart(cfg.host);
  const suffix = parts.map((part) => encodeURIComponent(part)).join('/');
  return `ftp://${host}:${port}/${suffix}${fileName === null ? '/' : ''}`;
}

function ftpCommandPath(cfg, fileName) {
  return `/${[...remoteDirectorySegments(cfg.rootDir), safeRemoteFileName(fileName)].join('/')}`;
}

function outputText(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value ?? '');
}

/**
 * A small FTP adapter implemented with the system curl already shipped in the
 * runtime image. `runCommand` is injectable so tests can assert the FTP command
 * sequence without needing a receiver or a real FTP daemon.
 */
export function createFtpFileTransport(cfg = getConfig().enigma2, { runCommand = null } = {}) {
  const username = cfg.username || 'root';
  const password = cfg.password || '';
  const baseArgs = [
    '--silent', '--show-error', '--fail', '--ftp-pasv',
    '--connect-timeout', String(FTP_CONNECT_TIMEOUT_SECONDS),
    '--max-time', String(Math.ceil(FTP_TIMEOUT_MS / 1000)),
    '--user', `${username}:${password}`,
  ];
  const run = runCommand || ((args, options) => spawnSync('curl', args, options));

  function invoke(label, args) {
    let result;
    try {
      result = run(args, { timeout: FTP_TIMEOUT_MS + 5000, maxBuffer: FTP_MAX_BUFFER });
    } catch (err) {
      throw new Error(`FTP ${label} failed: ${String(err?.message || err)}`);
    }
    if (result?.error || result?.status !== 0) {
      let detail = outputText(result?.stderr).trim() || result?.error?.message || `curl exited ${result?.status ?? 'without a status'}`;
      if (password) detail = detail.split(password).join('[redacted]');
      throw new Error(`FTP ${label} failed: ${truncate(detail, 220)}`);
    }
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(outputText(result.stdout), 'utf8');
  }

  function quote(commands, label) {
    const args = [...baseArgs];
    for (const command of commands) args.push('--quote', command);
    // Use absolute command paths below instead of relying on curl's ordering
    // of --quote commands versus the URL's own CWD/transfer commands.
    args.push(ftpUrl(cfg));
    return invoke(label, args);
  }

  function list() {
    const bytes = invoke(`listing ${cfg.rootDir || '/etc/enigma2'}`, [...baseArgs, '--list-only', ftpUrl(cfg)]);
    const names = outputText(bytes).split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
    return new Set(names.map((name) => name.replace(/\/+$/, '').split('/').at(-1)));
  }

  function read(name, knownNames = null) {
    const fileName = safeRemoteFileName(name);
    const existing = knownNames ? new Set(knownNames) : list();
    if (!existing.has(fileName)) return null;
    return outputText(invoke(`reading ${fileName}`, [...baseArgs, ftpUrl(cfg, fileName)]));
  }

  function writeAtomic(name, content) {
    const fileName = safeRemoteFileName(name);
    const temporary = `${FTP_TEMP_PREFIX}${fileName}-${randomUUID()}`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-ftp-'));
    const localFile = path.join(tempDir, 'payload');
    try {
      fs.writeFileSync(localFile, Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'), { mode: 0o600 });
      invoke(`uploading ${fileName}`, [...baseArgs, '--upload-file', localFile, ftpUrl(cfg, temporary)]);
      const temporaryPath = ftpCommandPath(cfg, temporary);
      const targetPath = ftpCommandPath(cfg, fileName);
      try {
        quote([`RNFR ${temporaryPath}`, `RNTO ${targetPath}`], `renaming ${fileName}`);
      } catch (renameError) {
        // Some FTP servers refuse RNTO over an existing file. Match the
        // receiver-safe fallback used by stalker-proxy-manager: remove the old
        // target only after the complete new file is staged, then rename.
        try {
          quote([`DELE ${targetPath}`], `replacing ${fileName}`);
          quote([`RNFR ${temporaryPath}`, `RNTO ${targetPath}`], `renaming ${fileName}`);
        } catch (replaceError) {
          try { quote([`DELE ${temporaryPath}`], `cleaning temporary ${fileName}`); } catch { /* best effort */ }
          throw new Error(`${renameError.message}; FTP replacement failed: ${replaceError.message}`);
        }
      }
    } catch (err) {
      // A failed STOR or rename should not leave a partial/temporary bouquet on
      // the receiver. The final file remains untouched unless the server only
      // supports delete-then-rename (the fallback above).
      try { quote([`DELE ${ftpCommandPath(cfg, temporary)}`], `cleaning temporary ${fileName}`); } catch { /* best effort */ }
      throw err;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  return { via: 'ftp', list, read, writeAtomic };
}

function createMountedFileTransport(rootDir) {
  const directory = path.resolve(rootDir);
  return {
    via: 'mount',
    list() { return new Set(fs.readdirSync(directory)); },
    read(name, knownNames = null) {
      const fileName = safeRemoteFileName(name);
      const existing = knownNames ? new Set(knownNames) : this.list();
      return existing.has(fileName) ? fs.readFileSync(path.join(directory, fileName), 'utf8') : null;
    },
    writeAtomic(name, content) {
      const fileName = safeRemoteFileName(name);
      const temporary = path.join(directory, `.${fileName}.${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, content, { mode: 0o644 });
        fs.renameSync(temporary, path.join(directory, fileName));
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    },
  };
}

/** Select FTP (the normal Enigma2 file transport) or an explicitly mounted share. */
function openReceiverFileTransport(cfg, injected = null) {
  if (injected) return { transport: injected, names: injected.list() };
  let ftpError = null;
  if (cfg.ftpEnabled) {
    const ftp = createFtpFileTransport(cfg);
    try { return { transport: ftp, names: ftp.list() }; }
    catch (err) { ftpError = err; }
  }
  if (cfg.rootDir && fs.existsSync(cfg.rootDir)) {
    const mount = createMountedFileTransport(cfg.rootDir);
    try { return { transport: mount, names: mount.list() }; }
    catch (err) {
      if (!ftpError) ftpError = err;
    }
  }
  if (ftpError) throw ftpError;
  throw new Error('FTP uploads are disabled and no mounted /etc/enigma2 share is available. Enable FTP in Settings → Enigma2; OpenWebif can reload bouquets but cannot upload these files.');
}


/**
 * Push a bouquet for the given entries.
 * @param {object[]} entries [{ title, url, year, description, subtitle, season, series }]
 */
export async function pushBouquet(entries, { name = null, dryRun = false } = {}, { fileTransport = null } = {}) {
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

  // OpenWebif is not a file-upload service. FTP (or an explicitly mounted
  // share) must be reachable before we touch anything on the receiver. In
  // particular, never treat an unreadable bouquets.tv as empty: that could
  // silently replace a user's satellite/favourites bouquet index.
  let transport = null;
  let transportName = null;
  let bouquetUploaded = false;
  try {
    const opened = openReceiverFileTransport(cfg, fileTransport);
    transport = opened.transport;
    transportName = transport.via || 'receiver-file-transport';
    const reachable = await status({ force: true });
    if (!reachable.ok) {
      // OpenWebif is only needed for reload/verification. Do not discard a
      // successful FTP path just because an image has WebIF disabled/misrouted.
      log.warn('enigma2', 'OpenWebif is unreachable; FTP upload will continue, but automatic reload may fail', { error: reachable.message });
    }
    const bouquetsTv = transport.read('bouquets.tv', opened.names);

    if (bouquetsTv !== null) {
      transport.writeAtomic(BOUQUETS_BACKUP, bouquetsTv);
      log.info('enigma2', 'saved bouquets.tv restore point', { via: transportName, backup: BOUQUETS_BACKUP });
    } else {
      log.warn('enigma2', 'receiver has no bouquets.tv; creating it without a backup');
    }

    // The index never points to a bouquet file that has not been fully staged.
    transport.writeAtomic(bouquet.fileName, bouquet.text);
    bouquetUploaded = true;
    log.info('enigma2', `uploaded ${bouquet.fileName}`, { via: transportName, bytes: Buffer.byteLength(bouquet.text) });

    const patched = patchBouquetsTv(bouquetsTv || '', bouquet.fileName);
    if (patched.changed) {
      transport.writeAtomic('bouquets.tv', patched.text);
      log.info('enigma2', 'bouquets.tv patched with our entry; existing bouquets preserved', { via: transportName });
    } else {
      log.info('enigma2', 'bouquets.tv already references our bouquet — left unchanged');
    }
  } catch (err) {
    const detail = String(err?.message || err);
    const message = bouquetUploaded
      ? `bouquet uploaded but bouquets.tv could not be updated: ${detail}`
      : `upload failed: ${detail}`;
    log.error('enigma2', message, { via: transportName });
    return { ok: false, error: message, bouquet, ...(transportName ? { transport: transportName } : {}), partial: bouquetUploaded };
  }

  // OpenWebif is control-plane only. Mode 2 reloads bouquets without needlessly
  // re-reading lamedb; endpoint aliases vary between images, so try both.
  let reloadOk = false;
  for (const endpoint of ['/api/servicelistreload?mode=2', '/web/servicelistreload?mode=2']) {
    try {
      await webifGet(endpoint);
      reloadOk = true;
      log.info('enigma2', `service list reloaded via ${endpoint}`);
      break;
    } catch (err) {
      log.warn('enigma2', `servicelistreload failed via ${endpoint}`, { error: String(err?.message || err) });
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

  await repo.saveBouquet({ name: bouquetName, entries: bouquet.entries, pushed_at: new Date().toISOString(), payload: { via: transportName, verified } });

  return {
    ok: true,
    entries: bouquet.entries,
    verified,
    transport: transportName,
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
