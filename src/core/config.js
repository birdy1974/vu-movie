/**
 * vu-movie — configuration.
 *
 * Precedence (low → high):
 *   1. DEFAULTS below
 *   2. /config/vumovie.json           (created on first run; edited from the UI)
 *   3. environment variables          (docker-compose friendly, see .env.example)
 *
 * Nothing here touches the network or the database — it must be safe to import
 * during `docker build` (a build-time import that dials Postgres is exactly the
 * failure mode this project avoids).
 */

import fs from 'node:fs';
import path from 'node:path';
import { log, logError } from './log.js';

const CONFIG_FILE = process.env.CONFIG_FILE || '/config/vumovie.json';
const CONFIG_DIR = path.dirname(CONFIG_FILE);

/** Deep-merge helper: objects merge, arrays and scalars are replaced. */
function merge(base, patch) {
  if (Array.isArray(patch) || typeof patch !== 'object' || patch === null) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && typeof base?.[k] === 'object')
      ? merge(base[k], v)
      : v;
  }
  return out;
}

export const DEFAULTS = {
  app: {
    /** Port the web UI + stream endpoints listen on. */
    port: Number(process.env.PORT || 8080),
    /** LAN URL VLC/Enigma2 use. Auto-guessed from the request when empty. */
    baseUrl: process.env.BASE_URL || '',
    host: process.env.HOST || '0.0.0.0',
    logLevel: process.env.LOG_LEVEL || 'info',
    /** Optional HTTP basic auth for the UI (empty = open on your LAN). */
    username: process.env.APP_USERNAME || '',
    password: process.env.APP_PASSWORD || '',
    /** How long a generated stream token stays valid (minutes). 0 = forever. */
    tokenTtlMinutes: Number(process.env.TOKEN_TTL_MINUTES || 4320),
  },
  db: {
    url: process.env.DATABASE_URL || '',
    /** Fail startup when Postgres is unreachable instead of degrading to memory. */
    required: String(process.env.REQUIRE_DB || 'false').toLowerCase() === 'true',
    waitForDbMs: Number(process.env.WAIT_FOR_DB_MS || 60000),
  },
  storage: {
    // Derived from CONFIG_FILE so a non-Docker run writes next to its config; the
    // Dockerfile/compose set DOWNLOADS_DIR explicitly to the mounted volume.
    downloads: process.env.DOWNLOADS_DIR || path.join(CONFIG_DIR, 'downloads'),
    tmp: process.env.TMP_DIR || (process.env.CONFIG_FILE ? path.join(CONFIG_DIR, 'tmp') : '/tmp/vumovie'),
    /** Keep HLS/segment caches under this budget (MB). */
    cacheBudgetMb: Number(process.env.CACHE_BUDGET_MB || 2048),
  },
  scraper: {
    /** Max concurrent headless pages — 1 is right for a J3455. */
    browserConcurrency: Number(process.env.BROWSER_CONCURRENCY || 1),
    /** Kill Chromium after this many idle seconds to give RAM back to the NAS. */
    browserIdleSeconds: Number(process.env.BROWSER_IDLE_SECONDS || 180),
    /** Page/network timeout for a resolve attempt. */
    resolveTimeoutMs: Number(process.env.RESOLVE_TIMEOUT_MS || 45000),
    /** Probe every candidate with ffprobe before offering it (recommended). */
    probeCandidates: String(process.env.PROBE_CANDIDATES || 'true').toLowerCase() !== 'false',
    maxCandidates: Number(process.env.MAX_CANDIDATES || 12),
    /** Optional FlareSolverr / external extractor (see docs). */
    flaresolverrUrl: process.env.FLARESOLVERR_URL || '',
    externalExtractorUrl: process.env.EXTERNAL_EXTRACTOR_URL || '',
    /**
     * When a resolve produces nothing, probe a control host and cross-check DNS
     * (system resolver vs these public ones) so the log/UI says whether the
     * container has no egress, filtered DNS, a TLS-intercepting proxy, or a
     * genuinely dead service. Costs ~4 s, once per minute (cached).
     */
    diagnoseOnFailure: String(process.env.DIAGNOSE_ON_FAILURE || 'true').toLowerCase() !== 'false',
    dnsCheckServers: (process.env.DNS_CHECK_SERVERS || '1.1.1.1,8.8.8.8,9.9.9.9')
      .split(',').map((s) => s.trim()).filter(Boolean),
    /**
     * Outbound proxy for scrapers (MovieBox, etc.). When the MovieBox API edge
     * closes the TLS handshake with `tls-or-ip-block` the usual fix is to route
     * the container through a proxy/VPN outside the blocking ISP. Any of these
     * vars is honoured (first non-empty wins): MOVIEBOX_PROXY, HTTPS_PROXY,
     * https_proxy, HTTP_PROXY, http_proxy, ALL_PROXY. The value is a normal
     * proxy URL: http://proxy:3128 or socks5://proxy:1080 — forwarded to Node's
     * fetch via undici.ProxyAgent (which also handles NO_PROXY/ no_proxy).
     * Leave empty for direct egress (default).
     */
    proxyUrl: (process.env.MOVIEBOX_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || '').trim(),
    noProxy: (process.env.NO_PROXY || process.env.no_proxy || 'localhost,127.0.0.1,::1').trim(),
    /**
     * Alternative MovieBox hosts the operator can add when the built-in pool is
     * blocked. Comma-separated list is appended to HOST_POOL. Useful for the
     * H5/web BFF mirrors (h5-api.aoneroom.com, h5.aoneroom.com) or a self-hosted
     * mirror/proxy.
     */
    movieboxExtraHosts: (process.env.MOVIEBOX_EXTRA_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean),
    /**
     * When Node's TLS stack is blocked (JA3/SNI filter) but the host is
     * reachable via a normal browser, retry MovieBox API calls through the
     * headless Chromium (its BoringSSL fingerprint is different). Enabled by
     * default; disable with MOVIEBOX_BROWSER_FALLBACK=false if you prefer to
     * fail fast instead of spending ~8s on the fallback.
     */
    movieboxBrowserFallback: String(process.env.MOVIEBOX_BROWSER_FALLBACK || 'true').toLowerCase() !== 'false',
    /** Persisted cookies/session per source (Cloudflare handshakes). */
    sessionDir: process.env.SESSION_DIR || path.join(path.dirname(CONFIG_FILE), 'sessions'),
    userAgent: process.env.USER_AGENT
      || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    /** Extra sites the user adds himself (URL template + optional recipe file). */
    customSources: [],
  },
  transcode: {
    /** auto | copy | vaapi | x264 */
    mode: process.env.TRANSCODE_MODE || 'auto',
    /** Force a transcode even when the source already matches the target. */
    alwaysTranscode: String(process.env.ALWAYS_TRANSCODE || 'false').toLowerCase() === 'true',
    /** Live streams must keep up with real time → 1 on a J3455. */
    maxConcurrent: Number(process.env.MAX_CONCURRENT_TRANSCODES || 1),
    hardware: String(process.env.HWACCEL || 'true').toLowerCase() !== 'false',
    device: process.env.VAAPI_DEVICE || '/dev/dri/renderD128',
    resolution: Number(process.env.DEFAULT_RESOLUTION || 1080),
    aspect: process.env.DEFAULT_ASPECT || 'source',
    videoBitrate: Number(process.env.DEFAULT_VIDEO_BITRATE || 2500),
    audioBitrate: Number(process.env.DEFAULT_AUDIO_BITRATE || 128),
    audioChannels: Number(process.env.DEFAULT_AUDIO_CHANNELS || 2),
    fps: process.env.DEFAULT_FPS || 'source',
    /** mpegts is what VLC + Enigma2 want; matroska is available per your request. */
    container: process.env.DEFAULT_CONTAINER || 'mpegts',
    encoderFallback: process.env.ENCODER_FALLBACK || 'libx264 -preset veryfast -crf 22',
    /** Seconds of "no clients" before an idle stream session is killed. */
    idleStopSeconds: Number(process.env.STREAM_IDLE_SECONDS || 45),
    /** Buffered TS parts kept per client before we drop the client (bytes). */
    maxClientBacklog: Number(process.env.MAX_CLIENT_BACKLOG || 12 * 1024 * 1024),
  },
  subtitles: {
    /** Order matters: the first language with a good hit wins. */
    languages: (process.env.SUBTITLE_LANGUAGES || 'nl,en').split(',').map((s) => s.trim()).filter(Boolean),
    autoSearch: String(process.env.SUBTITLE_AUTO_SEARCH || 'true').toLowerCase() !== 'false',
    convertToUtf8: true,
    pushToReceiver: String(process.env.SUBTITLE_PUSH || 'false').toLowerCase() === 'true',
    receiverDir: process.env.SUBTITLE_RECEIVER_DIR || '/media/hdd/movie/vumovie',
    /** API keys — set here or through the UI (stored in /config only). */
    keys: {
      opensubtitlesCom: process.env.OPENSUBTITLES_API_KEY || '',
      subdl: process.env.SUBDL_API_KEY || '',
    },
    credentials: {
      opensubtitlesOrgUser: process.env.OPENSUBTITLES_ORG_USER || '',
      opensubtitlesOrgPass: process.env.OPENSUBTITLES_ORG_PASS || '',
      addic7edUser: process.env.ADDIC7ED_USER || '',
      addic7edPass: process.env.ADDIC7ED_PASS || '',
    },
    /** User-defined providers (URL templates) added from the UI. */
    customProviders: [],
    disabledProviders: [],
  },
  enigma2: {
    host: process.env.ENIGMA2_HOST || '',
    port: Number(process.env.ENIGMA2_PORT || 80),
    username: process.env.ENIGMA2_USER || 'root',
    password: process.env.ENIGMA2_PASSWORD || '',
    /** Name of the bouquet folder on the box (no spaces!). */
    bouquetName: process.env.ENIGMA2_BOUQUET || 'vu-movie',
    rootDir: process.env.ENIGMA2_ROOT || '/etc/enigma2',
    /** 4097 = GStreamer/exteplayer3 (safest for IPTV on a Duo2). */
    serviceType: Number(process.env.ENIGMA2_SERVICE_TYPE || 4097),
    referer: process.env.STREAM_REFERER || '',
    /** FTP fallback when OpenWebif upload is unavailable. */
    ftpEnabled: String(process.env.ENIGMA2_FTP || 'false').toLowerCase() === 'true',
    ftpPort: Number(process.env.ENIGMA2_FTP_PORT || 21),
    /** Re-push the bouquet automatically after every scrape. */
    autoPush: String(process.env.ENIGMA2_AUTO_PUSH || 'false').toLowerCase() === 'true',
  },
  /** Site recipes — extra/overriding files land here. */
  sources: {
    dir: process.env.SOURCES_DIR || path.join(path.dirname(CONFIG_FILE), 'sources'),
    enabled: [],
    disabled: [],
  },
};

/** Populated by loadConfig(); exported as a live binding via getConfig(). */
let current = structuredClone(DEFAULTS);

function envOverrides() {
  const o = {};
  const set = (p, v) => { if (v !== undefined && v !== '') o[p] = v; };
  if (process.env.PORT) set('app.port', Number(process.env.PORT));
  if (process.env.BASE_URL) set('app.baseUrl', process.env.BASE_URL);
  if (process.env.LOG_LEVEL) set('app.logLevel', process.env.LOG_LEVEL);
  if (process.env.APP_USERNAME) set('app.username', process.env.APP_USERNAME);
  if (process.env.APP_PASSWORD) set('app.password', process.env.APP_PASSWORD);
  if (process.env.DATABASE_URL) set('db.url', process.env.DATABASE_URL);
  if (process.env.DOWNLOADS_DIR) set('storage.downloads', process.env.DOWNLOADS_DIR);
  if (process.env.TMP_DIR) set('storage.tmp', process.env.TMP_DIR);
  if (process.env.TRANSCODE_MODE) set('transcode.mode', process.env.TRANSCODE_MODE);
  if (process.env.VAAPI_DEVICE) set('transcode.device', process.env.VAAPI_DEVICE);
  if (process.env.DEFAULT_RESOLUTION) set('transcode.resolution', Number(process.env.DEFAULT_RESOLUTION));
  if (process.env.DEFAULT_VIDEO_BITRATE) set('transcode.videoBitrate', Number(process.env.DEFAULT_VIDEO_BITRATE));
  if (process.env.DEFAULT_AUDIO_BITRATE) set('transcode.audioBitrate', Number(process.env.DEFAULT_AUDIO_BITRATE));
  if (process.env.DEFAULT_CONTAINER) set('transcode.container', process.env.DEFAULT_CONTAINER);
  if (process.env.ENIGMA2_HOST) set('enigma2.host', process.env.ENIGMA2_HOST);
  if (process.env.ENIGMA2_USER) set('enigma2.username', process.env.ENIGMA2_USER);
  if (process.env.ENIGMA2_PASSWORD) set('enigma2.password', process.env.ENIGMA2_PASSWORD);
  if (process.env.ENIGMA2_BOUQUET) set('enigma2.bouquetName', process.env.ENIGMA2_BOUQUET);
  if (process.env.OPENSUBTITLES_API_KEY) set('subtitles.keys.opensubtitlesCom', process.env.OPENSUBTITLES_API_KEY);
  if (process.env.SUBDL_API_KEY) set('subtitles.keys.subdl', process.env.SUBDL_API_KEY);
  if (process.env.FLARESOLVERR_URL) set('scraper.flaresolverrUrl', process.env.FLARESOLVERR_URL);
  if (process.env.MOVIEBOX_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY) set('scraper.proxyUrl', (process.env.MOVIEBOX_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || '').trim());
  if (process.env.MOVIEBOX_EXTRA_HOSTS) set('scraper.movieboxExtraHosts', process.env.MOVIEBOX_EXTRA_HOSTS.split(',').map((s) => s.trim()).filter(Boolean));
  if (process.env.MOVIEBOX_BROWSER_FALLBACK) set('scraper.movieboxBrowserFallback', String(process.env.MOVIEBOX_BROWSER_FALLBACK).toLowerCase() !== 'false');
  return o;
}

function readFileConfig() {
  try {
    if (!CONFIG_FILE || !fs.existsSync(CONFIG_FILE)) {
      log.debug('config', `no config file at ${CONFIG_FILE} — using defaults + environment`);
      return {};
    }
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    log.info('config', `loaded ${CONFIG_FILE}`, { bytes: raw.length });
    return parsed;
  } catch (err) {
    // A broken config file must not stop the container: log loudly, keep defaults.
    logError('config', `could not read ${CONFIG_FILE} — continuing with defaults + env`, err);
    return {};
  }
}

/** Load (or reload) configuration. Safe to call again after a UI save. */
export function loadConfig() {
  current = merge(merge(structuredClone(DEFAULTS), readFileConfig()), envOverrides());
  if (process.env.LOG_LEVEL) current.app.logLevel = process.env.LOG_LEVEL;
  return current;
}

export function getConfig() { return current; }

/** Convenience accessor: cfg('enigma2.host'). */
export function cfg(pathStr, fallback) {
  const value = pathStr.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), current);
  return value === undefined ? fallback : value;
}

/** Write the config file atomically (used by PUT /api/config). */
export function saveConfig(patch) {
  const next = merge(current, patch || {});
  current = next;
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    const tmp = `${CONFIG_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stripSecretsForDisk(next), null, 2));
    fs.renameSync(tmp, CONFIG_FILE);
    log.info('config', `saved ${CONFIG_FILE}`, { bytes: fs.statSync(CONFIG_FILE).size });
  } catch (err) {
    logError('config', `could not save ${CONFIG_FILE}`, err);
    throw err;
  }
  return next;
}

/**
 * Secrets stay in the file (so restarts keep working) — this exists so the
 * /api/config response never leaks them to the browser.
 */
function stripSecretsForDisk(cfgObject) { return cfgObject; }

/** Returns a copy with passwords/keys masked, for the UI. */
export function publicConfig() {
  const clone = structuredClone(current);
  const mask = (v) => (v ? '••••••••' : '');
  clone.app.password = mask(clone.app.password);
  clone.db.url = clone.db.url ? clone.db.url.replace(/:[^:@/]*@/, ':***@') : '';
  clone.enigma2.password = mask(clone.enigma2.password);
  clone.subtitles.keys.opensubtitlesCom = mask(clone.subtitles.keys.opensubtitlesCom);
  clone.subtitles.keys.subdl = mask(clone.subtitles.keys.subdl);
  clone.subtitles.credentials.opensubtitlesOrgPass = mask(clone.subtitles.credentials.opensubtitlesOrgPass);
  clone.subtitles.credentials.addic7edPass = mask(clone.subtitles.credentials.addic7edPass);
  return clone;
}

/** Ensure the writable directories exist before anything tries to use them. */
export function ensureDirs() {
  const dirs = [
    current.storage.downloads,
    current.storage.tmp,
    current.scraper.sessionDir,
    path.dirname(CONFIG_FILE),
    current.sources.dir,
  ];
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      log.debug('config', `directory ready: ${dir}`);
    } catch (err) {
      // /downloads and /config are usually volumes; a failure here is worth an error
      // but not a crash — the app can still serve already-known streams.
      logError('config', `could not create directory ${dir}`, err);
    }
  }
}

// Load once on import so every module can `cfg(...)` immediately.
loadConfig();
