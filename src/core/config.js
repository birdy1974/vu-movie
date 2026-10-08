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
import { log, logError, errorText } from './log.js';

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
    // 0 = a stream's token never expires (the default). A positive value is a
    // lifetime in minutes after which the stream is treated as expired.
    tokenTtlMinutes: Number(process.env.TOKEN_TTL_MINUTES || 0),
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
    /**
     * How long a source's search page may take to render its result cards.
     *
     * The flixer clones (redflix, cinejoy, 1flex …) ship an empty shell and then
     * fetch the results over XHR, so a fixed "networkidle + 1.2 s" wait is a
     * coin flip: the log says "no usable result links" while the site is simply
     * still loading. We poll for result-shaped links for up to this long and
     * stop as soon as the count stops growing. Per-source overrides live in the
     * recipe (`search.waitMs` in builtin-sources.json / /config/sources/*.json).
     */
    searchWaitMs: Number(process.env.SEARCH_WAIT_MS || 12000),
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
    /**
     * Which MovieBox backend to use. `auto` (default) prefers the mobile BFF
     * (`api*.aoneroom.com`/wefeed-mobile-bff — what MovieBox-TUI speaks) and
     * falls back to the *web* BFF (`h5-api.aoneroom.com`/wefeed-h5api-bff, plus
     * the public site mirrors) when the mobile edge never answers at the HTTP
     * layer — the SNI/IP-filtered case. `h5` always tries the web BFF first,
     * `mobile` never uses it.
     */
    movieboxTransport: (process.env.MOVIEBOX_TRANSPORT || 'auto').toLowerCase(),
    /**
     * How long FlareSolverr may spend solving one page (`maxTimeout` in its
     * API). Its own default is 60 s; 30 s is enough for most challenges but
     * not on a slow NAS, so raise it with FLARESOLVERR_TIMEOUT_MS if searches
     * report "FlareSolverr timed out solving the challenge".
     */
    flaresolverrTimeoutMs: Number(process.env.FLARESOLVERR_TIMEOUT_MS) > 0
      ? Number(process.env.FLARESOLVERR_TIMEOUT_MS)
      : 30_000,
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
    videoBitrate: Number(process.env.DEFAULT_VIDEO_BITRATE || 8000),
    audioBitrate: Number(process.env.DEFAULT_AUDIO_BITRATE || 192),
    audioChannels: Number(process.env.DEFAULT_AUDIO_CHANNELS || 6),
    fps: process.env.DEFAULT_FPS || '25',
    /** mpegts is what VLC + Enigma2 want; matroska is available per your request. */
    container: process.env.DEFAULT_CONTAINER || 'mpegts',
    /** Named, reusable outgoing FFmpeg templates edited from the Stream page. */
    ffmpegTemplates: [],
    /**
     * Per-output default template id. An output is one of:
     *   vlcTs / vlcMkv / m3u8 / m3u / enigma2 / direct / download
     * Empty falls back to the guided profile builder (or to `defaultFfmpegTemplateId`
     * when that is set, so the old single-template default keeps behaving the same
     * way until the operator opts in to a per-output layout).
     */
    ffmpegDefaults: {},
    /** Empty means use the guided profile builder for newly-created streams. */
    defaultFfmpegTemplateId: '',
    encoderFallback: process.env.ENCODER_FALLBACK || 'libx264 -preset veryfast -crf 22',
    /** Seconds of "no clients" before an idle stream session is killed. */
    idleStopSeconds: Number(process.env.STREAM_IDLE_SECONDS || 45),
    /** Buffered TS parts kept per client before we drop the client (bytes). */
    maxClientBacklog: Number(process.env.MAX_CLIENT_BACKLOG || 12 * 1024 * 1024),
    /**
     * Pace live playback at the source's native rate (ffmpeg `-re`).
     *
     * The relay's clients are real-time players (VLC, a browser, the VU+), not
     * downloaders: they consume ~1-3 MB/s. Without `-re`, ffmpeg reads the
     * loopback upstream proxy as fast as it is served, so the relay pushes tens
     * of MB/s at a client that cannot possibly drain it — the socket backlog
     * passes `maxClientBacklog` within seconds and the client is dropped with
     * "cannot keep up" (then the receiver goes black). Pacing the input keeps
     * the encoder at 1x, which also stops the wasted CDN traffic while a
     * session is up. Set REALTIME_PLAYBACK=false to get the old behaviour.
     */
    realtime: String(process.env.REALTIME_PLAYBACK || 'true').toLowerCase() !== 'false',
    /**
     * How many times the relay may restart ffmpeg while clients are watching
     * (transient upstream failures / early-ended chunked transfers).
     */
    maxRestarts: Number(process.env.STREAM_MAX_RESTARTS || 3),
    /**
     * Chunked upstream proxy (the MovieBox-TUI fetching mechanism): pull the
     * source in small ranged requests instead of handing the CDN one long
     * connection. Stops CDNs from cutting a movie short after a few minutes.
     * Set UPSTREAM_PROXY=false to go back to direct ffmpeg fetching.
     */
    upstreamProxy: String(process.env.UPSTREAM_PROXY || 'true').toLowerCase() !== 'false',
    /**
     * Learn each movie's length once with ffprobe, so the relay can tell the
     * genuine end of a movie from an early cut and stops instead of repeating
     * the film. Set PROBE_DURATION=false to skip the probe.
     */
    probeDuration: String(process.env.PROBE_DURATION || 'true').toLowerCase() !== 'false',
    /** Range size for progressive files (1 MB keeps requests small and cheap). */
    upstreamChunkBytes: Number(process.env.UPSTREAM_CHUNK_BYTES || 1024 * 1024),
    /** Range size inside one DASH segment — 95 KB, exactly like the TUI. */
    upstreamSegmentChunkBytes: Number(process.env.UPSTREAM_SEGMENT_CHUNK_BYTES || 95 * 1024),
    /** Parallel ranged sub-requests while assembling a DASH segment. */
    upstreamParallel: Number(process.env.UPSTREAM_PARALLEL || 4),
    /** Per-session byte budget for the chunk/segment cache. */
    upstreamCacheMb: Number(process.env.UPSTREAM_CACHE_MB || 64),
    /** Per-request timeout for a single ranged CDN request. */
    upstreamRequestTimeoutMs: Number(process.env.UPSTREAM_REQUEST_TIMEOUT_MS || 30000),
  },
  subtitles: {
    /** Order matters: the first language with a good hit wins. */
    languages: (process.env.SUBTITLE_LANGUAGES || 'nl,en').split(',').map((s) => s.trim()).filter(Boolean),
    /**
     * Search (and attach) a subtitle automatically for every title the user
     * resolves — the behaviour requirements.md asks for. Set
     * SUBTITLE_AUTO_SEARCH=false to only search from the Subtitles page.
     */
    autoSearch: String(process.env.SUBTITLE_AUTO_SEARCH || 'true').toLowerCase() !== 'false',
    // (No convertToUtf8 option: decodeSubtitle() in subtitles/util.js always
    // detects UTF-8/UTF-16/CP1252 — the flag that existed was read by nothing.)
    /** Default for "also copy the .srt to the receiver" when a subtitle is downloaded. */
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
  metadata: {
    tmdbApiKey: process.env.TMDB_API_KEY || '',
    omdbApiKey: process.env.OMDB_API_KEY || '',
    language: process.env.METADATA_LANGUAGE || 'en-US',
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
    /** FTP file transport for bouquet/subtitle uploads; OpenWebif only reloads/queries. */
    ftpEnabled: String(process.env.ENIGMA2_FTP || 'true').toLowerCase() === 'true',
    ftpPort: Number(process.env.ENIGMA2_FTP_PORT || 21),
    /** Re-push the bouquet automatically after every scrape. */
    autoPush: String(process.env.ENIGMA2_AUTO_PUSH || 'false').toLowerCase() === 'true',
  },
  /**
   * The Playlist tab's ordered list of streams.
   *
   * `items` is the single source of truth for *what* the outputs of this box
   * contain — the VLC/M3U playlist, the Enigma2 bouquet, the Xtream catalogue
   * and the web player all read it in this order. Every entry is
   * `{ streamId, enabled, templateId, subtitleLanguage, addedAt }`; a stream
   * that exists but is not in the list is appended automatically the first time
   * the playlist is read (see src/playlist/index.js), so upgrading from a
   * version without a playlist keeps every stream visible.
   *
   * `token` is the unguessable handle in the public output URLs
   * (/pl/<token>/…) — those endpoints are deliberately outside the /api
   * password, exactly like the per-stream /s/<token>/ URLs, because VLC, the
   * VU+ and an IPTV app cannot authenticate comfortably.
   */
  playlist: {
    name: process.env.PLAYLIST_NAME || 'vu-movie',
    items: [],
    /** Streams deliberately removed stay out until explicitly added again. */
    removedStreamIds: [],
    /** Append-only title snapshots used for recommendations (never watch history). */
    additionHistory: [],
    /** Periodically probe every playlist item and refresh broken upstreams. */
    autoCheckEnabled: String(process.env.PLAYLIST_AUTO_CHECK || 'true').toLowerCase() !== 'false',
    autoCheckIntervalMinutes: Number(process.env.PLAYLIST_CHECK_INTERVAL_MINUTES || 360),
    autoRepairEnabled: String(process.env.PLAYLIST_AUTO_REPAIR || 'true').toLowerCase() !== 'false',
    token: '',
    /**
     * Username/password an Xtream Codes client sends (an empty password means
     * the playlist token doubles as the password, so a default install works
     * without typing anything). Editable in Settings → Xtream Codes;
     * XTREAM_USERNAME / XTREAM_PASSWORD still win over the saved file.
     */
    xtreamUsername: process.env.XTREAM_USERNAME || 'vumovie',
    xtreamPassword: process.env.XTREAM_PASSWORD || '',
  },
  /** Site recipes — extra/overriding files land here. */
  sources: {
    dir: process.env.SOURCES_DIR || path.join(path.dirname(CONFIG_FILE), 'sources'),
    enabled: [],
    disabled: [],
  },
};

/** Assign `value` at a dotted path, creating the intermediate objects. */
function setPath(object, pathStr, value) {
  const parts = pathStr.split('.');
  let node = object;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== 'object' || Array.isArray(node[part])) node[part] = {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
  return object;
}

/** Every writable option, as a dotted path (e.g. "scraper.flaresolverrUrl"). */
export function knownOptionPaths() {
  const paths = [];
  const walk = (node, prefix = '') => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) walk(value, path);
      else paths.push(path);
    }
  };
  walk(DEFAULTS);
  return paths;
}

/**
 * JSON has no dotted paths — but `{"scraper.flaresolverrUrl": "…"}` keeps being
 * written by hand, because that is exactly the spelling of the matching
 * environment variable. Nothing in the app reads a flat `"a.b"` key: file
 * config is merged as nested objects and only `envOverrides()` below ever used
 * dotted paths internally.
 *
 * Two things made that trap expensive, so we now deal with it explicitly:
 *   1. the value was silently ignored, so the operator "fixed" the config and
 *      nothing changed (FlareSolverr stayed unused, and the boot log blamed a
 *      missing environment variable);
 *   2. `publicConfig()` masks secrets by nested path, so a flat `"db.url"` was
 *      printed verbatim — Postgres password included — in the log banner and
 *      returned by `GET /api/config`.
 *
 * Fold a dotted key into the nested shape when the nested spot is empty
 * (it applies, as intended), keep the nested object when both exist (it is what
 * the UI wrote) and report every key we dropped. Unknown dotted paths are
 * dropped too. Callers decide what to log; values are never returned to callers
 * that log, so secrets cannot end up in the log file by accident.
 */
export function foldDottedKeys(parsed) {
  const empty = { config: {}, applied: [], ignored: [], unknown: [] };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...empty, config: parsed || {} };

  const knownList = knownOptionPaths();
  const known = new Set(knownList);
  const config = {};
  const flat = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key.includes('.')) flat.push([key, value]);
    else config[key] = value;
  }

  const applied = [];  // folded: nothing was set at that path before
  const ignored = [];  // the nested object already has a value — it wins
  const unknown = [];  // no such option in DEFAULTS: dropped

  for (const [key, value] of flat) {
    const isLeaf = known.has(key);
    const isBranch = !isLeaf && knownList.some((path) => path.startsWith(`${key}.`));
    if (!isLeaf && !isBranch) { unknown.push(key); continue; }
    const parts = key.split('.');
    let node = config;
    let blocked = false;
    for (const part of parts.slice(0, -1)) {
      if (node[part] === undefined) node[part] = {};
      if (typeof node[part] !== 'object' || node[part] === null || Array.isArray(node[part])) { blocked = true; break; }
      node = node[part];
    }
    const leaf = parts.at(-1);
    if (blocked) { ignored.push(key); continue; }
    if (isBranch) {
      // `"subtitles.keys": { … }` — only meaningful as an object, and the
      // nested keys already present win over the dotted copy.
      if (!value || typeof value !== 'object' || Array.isArray(value)) { ignored.push(key); continue; }
      if (node[leaf] === undefined) node[leaf] = value;
      else if (node[leaf] && typeof node[leaf] === 'object' && !Array.isArray(node[leaf])) node[leaf] = merge(value, node[leaf]);
      else { ignored.push(key); continue; }
      applied.push(key);
      continue;
    }
    if (node[leaf] !== undefined) { ignored.push(key); continue; }
    node[leaf] = value;
    applied.push(key);
  }

  return { config, applied, ignored, unknown };
}

/**
 * Values that arrive from a hand-edited file as strings still have to match the
 * type their default has: `"port": "8080"` would otherwise compare and add as a
 * string ("8080" + 1 = "80801"). Only numbers and booleans are coerced, and
 * only when the default says which type the option is. Anything else (including
 * arrays and unknown keys) is passed through untouched.
 */
export function coerceConfigValues(node, defaults = DEFAULTS) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const out = { ...node };
  for (const [key, value] of Object.entries(node)) {
    const fallback = defaults?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
      out[key] = coerceConfigValues(value, fallback);
      continue;
    }
    if (typeof fallback === 'number' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value.trim()))) {
      out[key] = Number(value.trim());
    } else if (typeof fallback === 'boolean' && typeof value !== 'boolean') {
      const text = String(value).trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(text)) out[key] = true;
      else if (['false', '0', 'no', 'off'].includes(text)) out[key] = false;
    }
  }
  return out;
}

/** True once a config write failed, so the repeats are logged at debug level. */
let saveFailureLogged = false;

/** Populated by loadConfig(); exported as a live binding via getConfig(). */
let current = structuredClone(DEFAULTS);

function envOverrides() {
  const o = {};
  // setPath(), not o[p] = v: assigning the *flat* "scraper.flaresolverrUrl" key
  // does not change the nested option the app reads (merge() copies keys
  // verbatim), so an environment variable silently failed to override a value
  // that came from /config/vumovie.json — the opposite of the documented
  // precedence. Worse, those flat keys lived on in `current`, so the next
  // Settings save wrote them into the config file, where a later boot had to
  // ignore them (that is how the reported file ended up full of "app.logLevel",
  // "db.url", … while the nested value stayed stale).
  const set = (p, v) => { if (v !== undefined && v !== '') setPath(o, p, v); };
  if (process.env.PORT) set('app.port', Number(process.env.PORT));
  if (process.env.BASE_URL) set('app.baseUrl', process.env.BASE_URL);
  if (process.env.LOG_LEVEL) set('app.logLevel', process.env.LOG_LEVEL);
  if (process.env.APP_USERNAME) set('app.username', process.env.APP_USERNAME);
  if (process.env.APP_PASSWORD) set('app.password', process.env.APP_PASSWORD);
  if (process.env.PLAYLIST_AUTO_CHECK !== undefined) set('playlist.autoCheckEnabled', String(process.env.PLAYLIST_AUTO_CHECK).toLowerCase() !== 'false');
  if (process.env.PLAYLIST_CHECK_INTERVAL_MINUTES !== undefined) set('playlist.autoCheckIntervalMinutes', Number(process.env.PLAYLIST_CHECK_INTERVAL_MINUTES));
  if (process.env.PLAYLIST_AUTO_REPAIR !== undefined) set('playlist.autoRepairEnabled', String(process.env.PLAYLIST_AUTO_REPAIR).toLowerCase() !== 'false');
  // Environment wins over a value saved from Settings, like PORT. Blank and
  // non-numeric values are ignored rather than read as 0 (= never expires).
  const ttlEnv = process.env.TOKEN_TTL_MINUTES;
  if (ttlEnv !== undefined && ttlEnv.trim() !== '' && Number.isFinite(Number(ttlEnv))) set('app.tokenTtlMinutes', Number(ttlEnv));
  if (process.env.PROBE_DURATION !== undefined) set('transcode.probeDuration', String(process.env.PROBE_DURATION).toLowerCase() !== 'false');
  // Read in DEFAULTS too, but that only applies when the file says nothing:
  // without these two lines a value saved from Settings → Xtream Codes would
  // silently outrank the documented XTREAM_USERNAME / XTREAM_PASSWORD.
  if (process.env.XTREAM_USERNAME) set('playlist.xtreamUsername', process.env.XTREAM_USERNAME);
  if (process.env.XTREAM_PASSWORD) set('playlist.xtreamPassword', process.env.XTREAM_PASSWORD);
  if (process.env.DATABASE_URL) set('db.url', process.env.DATABASE_URL);
  if (process.env.DOWNLOADS_DIR) set('storage.downloads', process.env.DOWNLOADS_DIR);
  if (process.env.TMP_DIR) set('storage.tmp', process.env.TMP_DIR);
  if (process.env.TRANSCODE_MODE) set('transcode.mode', process.env.TRANSCODE_MODE);
  if (process.env.VAAPI_DEVICE) set('transcode.device', process.env.VAAPI_DEVICE);
  if (process.env.DEFAULT_RESOLUTION) set('transcode.resolution', Number(process.env.DEFAULT_RESOLUTION));
  if (process.env.DEFAULT_VIDEO_BITRATE) set('transcode.videoBitrate', Number(process.env.DEFAULT_VIDEO_BITRATE));
  if (process.env.DEFAULT_AUDIO_BITRATE) set('transcode.audioBitrate', Number(process.env.DEFAULT_AUDIO_BITRATE));
  if (process.env.DEFAULT_AUDIO_CHANNELS) set('transcode.audioChannels', Number(process.env.DEFAULT_AUDIO_CHANNELS));
  if (process.env.DEFAULT_FPS) set('transcode.fps', process.env.DEFAULT_FPS);
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
  if (process.env.MOVIEBOX_TRANSPORT) set('scraper.movieboxTransport', String(process.env.MOVIEBOX_TRANSPORT).toLowerCase());
  if (Number(process.env.FLARESOLVERR_TIMEOUT_MS) > 0) set('scraper.flaresolverrTimeoutMs', Number(process.env.FLARESOLVERR_TIMEOUT_MS));
  if (Number(process.env.SEARCH_WAIT_MS) > 0) set('scraper.searchWaitMs', Number(process.env.SEARCH_WAIT_MS));
  return o;
}

function readFileConfig() {
  let parsed;
  try {
    if (!CONFIG_FILE || !fs.existsSync(CONFIG_FILE)) {
      log.debug('config', `no config file at ${CONFIG_FILE} — using defaults + environment`);
      return {};
    }
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    parsed = JSON.parse(raw);
    log.info('config', `loaded ${CONFIG_FILE}`, { bytes: raw.length });
  } catch (err) {
    // A broken config file must not stop the container: log loudly, keep defaults.
    logError('config', `could not read ${CONFIG_FILE} — continuing with defaults + env`, err);
    return {};
  }

  // Only file I/O and JSON.parse are guarded above: a bug in our own folding
  // must not masquerade as "your config file is broken" (which silently
  // discards every setting in it — that is how this trap started).
  const { config, applied, ignored, unknown } = foldDottedKeys(parsed);
  if (applied.length) {
    log.warn('config', `${CONFIG_FILE} uses flat dotted key(s) — JSON has no dotted paths, so they were folded into the nested objects`,
      { keys: applied.join(', ') });
  }
  if (ignored.length) {
    log.warn('config', 'ignoring flat key(s) because the nested object already sets them — the nested value wins',
      { keys: ignored.join(', ') });
  }
  if (unknown.length) {
    log.warn('config', `unknown option(s) in ${CONFIG_FILE} were ignored — check the spelling (options are nested objects, e.g. "scraper": { "flaresolverrUrl": … })`,
      { keys: unknown.join(', ') });
  }
  return config;
}

/** Load (or reload) configuration. Safe to call again after a UI save. */
export function loadConfig() {
  // coerceConfigValues() keeps hand-edited strings ("720", "true") from leaking
  // into arithmetic and comparisons as strings.
  current = coerceConfigValues(merge(merge(structuredClone(DEFAULTS), readFileConfig()), envOverrides()));
  if (process.env.LOG_LEVEL) current.app.logLevel = process.env.LOG_LEVEL;
  return current;
}

export function getConfig() { return current; }

/** Convenience accessor: cfg('enigma2.host'). */
export function cfg(pathStr, fallback) {
  const value = pathStr.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), current);
  return value === undefined ? fallback : value;
}

/** Options whose value must never reach the browser (or a log line). */
const SECRET_PATHS = [
  'app.password',
  'enigma2.password',
  'playlist.xtreamPassword',
  'subtitles.keys.opensubtitlesCom',
  'subtitles.keys.subdl',
  'subtitles.credentials.opensubtitlesOrgPass',
  'subtitles.credentials.addic7edPass',
];

/** What publicConfig() puts in place of a secret, and the UI shows in its field. */
const SECRET_MASK = '••••••••';
const isMaskedSecret = (value) => typeof value === 'string' && /^•+$/.test(value);

/** Reads `patch.playlist.xtreamPassword` (and any other dotted path) if present. */
function readPath(node, pathStr) {
  return pathStr.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), node);
}

/** Deletes a nested path, leaving empty parents behind (harmless in a patch). */
function deletePath(node, pathStr) {
  const parts = pathStr.split('.');
  const parent = parts.slice(0, -1).reduce((acc, key) => (acc == null ? undefined : acc[key]), node);
  if (parent && typeof parent === 'object') delete parent[parts.at(-1)];
}

/**
 * A Settings save posts the whole form back, including the masked fields it
 * could not show. Writing `••••••••` over a real password would lock everybody
 * out with a password nobody knows, so masked values mean "keep what is
 * stored" — the same rule the browser form applies before it sends.
 */
function dropMaskedSecrets(node) {
  if (!node || typeof node !== 'object') return node;
  for (const pathStr of SECRET_PATHS) {
    if (isMaskedSecret(readPath(node, pathStr))) deletePath(node, pathStr);
    if (isMaskedSecret(node[pathStr])) delete node[pathStr];  // a flat "a.b" key, just in case
  }
  return node;
}

/**
 * The Xtream account is the one setting that is both typed into a third-party
 * app *and* carried inside a URL: the catalogue hands out
 * `/xtream/<token>/live/<username>/<password>/<id>.ts` and `get.php` takes the
 * same pair as query parameters. A password with a slash, a space or a `%` in
 * it yields links the player cannot fetch (or that stop at the wrong path
 * segment), and that only becomes visible hours later on the TV — so the
 * Settings save rejects it up front instead of accepting it silently.
 *
 * Returns a list of human-readable problems; an empty list means the patch is
 * acceptable. Only the keys the patch actually sets are looked at.
 */
const XTREAM_ACCOUNT_MAX = 64;
const XTREAM_ACCOUNT_FORBIDDEN = /[/\\?#%&"'<>|]/;

export function validateConfigPatch(patch) {
  // Folded first, so the flat "playlist.xtreamPassword" spelling is checked too.
  const { config } = foldDottedKeys(patch || {});
  const account = (config.playlist && typeof config.playlist === 'object') ? config.playlist : {};
  const problems = [];
  for (const key of ['xtreamUsername', 'xtreamPassword']) {
    const value = account[key];
    // Empty keeps the documented fallback (the playlist token doubles as the
    // password), and a mask is dropped by saveConfig() as "unchanged".
    if (value === undefined || value === null || value === '' || isMaskedSecret(value)) continue;
    const label = key === 'xtreamUsername' ? 'Xtream username' : 'Xtream password';
    if (typeof value !== 'string') { problems.push(`${label}: enter text.`); continue; }
    if (value.length > XTREAM_ACCOUNT_MAX) { problems.push(`${label}: ${XTREAM_ACCOUNT_MAX} characters maximum.`); continue; }
    if (/\s/.test(value)) { problems.push(`${label}: cannot contain spaces — IPTV apps put the account in a URL.`); continue; }
    const forbidden = value.match(XTREAM_ACCOUNT_FORBIDDEN);
    if (forbidden) {
      problems.push(`${label}: “${forbidden[0]}” cannot be used — IPTV apps put the account in a URL. Letters, digits and . _ - ~ ! $ * + , ; : @ are safe.`);
    }
  }
  return problems;
}

/** Write the config file atomically (used by PUT /api/config). */
export function saveConfig(patch) {
  // A Settings save posts the whole form back, including the masked password
  // fields it could not display. Those mean "keep the stored value", not "set
  // the password to ••••••••" — which would lock everybody out with a password
  // nobody knows. Cloned first so the caller's object is never edited.
  const incoming = dropMaskedSecrets(structuredClone(patch || {}));
  // Fold dotted keys coming from an API client / older UI the same way the file
  // reader does, so a patch can never create an ignored flat key on disk.
  const { config: folded, ignored, unknown } = foldDottedKeys(incoming);
  if (ignored.length || unknown.length) {
    log.warn('config', 'ignoring unusable option(s) in the config update', { ignored: ignored.join(', '), unknown: unknown.join(', ') });
  }
  // Flat "a.b" keys must not reach the file either — writing them there is what
  // poisoned the operator's config in the first place. In normal operation this
  // is a no-op; it exists so the file can never be written in a shape that the
  // next boot has to interpret.
  const merged = merge(current, folded);
  const { config: next, applied: flattened, ignored: dropped } = foldDottedKeys(merged);
  if (flattened.length || dropped.length) {
    log.warn('config', 'removed flat dotted key(s) from the saved configuration — options are nested objects',
      { folded: flattened.join(', '), dropped: dropped.join(', ') });
  }
  current = next;
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    const tmp = `${CONFIG_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stripSecretsForDisk(next), null, 2));
    fs.renameSync(tmp, CONFIG_FILE);
    log.info('config', `saved ${CONFIG_FILE}`, { bytes: fs.statSync(CONFIG_FILE).size });
    saveFailureLogged = false;
  } catch (err) {
    // A config file that cannot be written fails on *every* write — a read-only
    // volume, or a container started without one. The first failure is worth an
    // error (with the stack, so the mount shows up in a report); the repeats are
    // noise, and every caller already reports the consequence itself.
    if (saveFailureLogged) log.debug('config', `could not save ${CONFIG_FILE} (the file is still not writable)`, { error: errorText(err) });
    else { saveFailureLogged = true; logError('config', `could not save ${CONFIG_FILE}`, err); }
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
  // These playlist internals are intentionally exposed only by the dedicated
  // playlist APIs: additionHistory can grow without bound and removed ids are
  // implementation state, neither belongs in Settings responses or boot logs.
  const { additionHistory: _additionHistory, removedStreamIds: _removedStreamIds, ...publicPlaylist } = current.playlist || {};
  const clone = structuredClone({ ...current, playlist: publicPlaylist });
  // Custom commands can contain credentials or private origin details. They are
  // served only by /api/ffmpeg/templates to the template editor, never the
  // general settings/health config response.
  delete clone.transcode.ffmpegTemplates;
  const mask = (v) => (v ? SECRET_MASK : '');
  clone.app.password = mask(clone.app.password);
  clone.db.url = clone.db.url ? clone.db.url.replace(/:[^:@/]*@/, ':***@') : '';
  clone.enigma2.password = mask(clone.enigma2.password);
  // The Xtream password is a real credential (it guards the /xtream/<token>/…
  // playback URLs), so Settings shows the same mask as every other password.
  // The Stream tab keeps showing it in clear text: that panel exists so the
  // account can be typed into TiviMate.
  clone.playlist.xtreamPassword = mask(clone.playlist.xtreamPassword);
  clone.subtitles.keys.opensubtitlesCom = mask(clone.subtitles.keys.opensubtitlesCom);
  clone.subtitles.keys.subdl = mask(clone.subtitles.keys.subdl);
  clone.subtitles.credentials.opensubtitlesOrgPass = mask(clone.subtitles.credentials.opensubtitlesOrgPass);
  clone.subtitles.credentials.addic7edPass = mask(clone.subtitles.credentials.addic7edPass);
  // Defence in depth: foldDottedKeys() now keeps flat "a.b" keys out of the
  // effective config, but if one ever arrives through another door it must not
  // be served — this is exactly how the Postgres password used to end up in the
  // DEBUG banner and in GET /api/config.
  for (const key of Object.keys(clone)) {
    if (key.includes('.') && SECRET_PATHS.includes(key)) {
      clone[key] = key === 'db.url' ? String(clone[key] || '').replace(/:[^:@/]*@/, ':***@') : mask(clone[key]);
    }
  }
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
  const failed = [];
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      log.debug('config', `directory ready: ${dir}`);
    } catch (err) {
      // /downloads and /config are usually volumes; a failure here is worth an error
      // but not a crash — the app can still serve already-known streams.
      logError('config', `could not create directory ${dir}`, err);
      failed.push({ dir, err });
    }
  }
  // One summary line, because five stacked EACCES errors at boot hide what they
  // actually mean: the mounted volume is missing or read-only, so settings, the
  // playlist and the hardware cache will not survive a restart. Everything else
  // (searching, the UI, streaming) keeps working.
  if (failed.length) {
    log.warn('config', `${failed.length} director${failed.length === 1 ? 'y' : 'ies'} could not be created — the app keeps running, but settings and the playlist are memory-only for this run`,
      { dirs: failed.map((entry) => entry.dir).join(', '), cause: errorText(failed[0].err) });
  }
}

// Load once on import so every module can `cfg(...)` immediately.
loadConfig();
