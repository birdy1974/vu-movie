/**
 * Layer 2 of the scraper: a real Chromium that watches the network.
 *
 * Why this exists: the streaming sites in the requirements do not expose their
 * streams in the page HTML. A player script asks an API for a player URL, that
 * player asks another API for a manifest URL, and the manifest URL is signed and
 * short-lived. Anything you can parse from static HTML is a snapshot of someone
 * else's reverse engineering — and it breaks the day the site ships an update.
 *
 * What is stable: the *network traffic* the page produces. So we open the page in
 * Chromium, optionally click Play, and record every response that looks like a
 * video manifest/segment together with the request headers that made it work.
 * Those headers (Referer, Cookie, User-Agent, Origin) are then reused by ffmpeg.
 *
 * Resource cost on the DS918+: one Chromium ≈ 250-400 MB and ~1 CPU core while
 * navigating. The browser is kept warm between jobs and closed after
 * `scraper.browserIdleSeconds` of inactivity.
 */
import fs from 'node:fs';
import path from 'node:path';
import { log, logError, errorText, truncate } from '../core/log.js';
import { getConfig } from '../core/config.js';
import { sleep, safeHost, resolveUrl, request } from './http.js';
import { normalizeSearchMetadata } from './metadata.js';

let playwright = null;
let browser = null;
let launching = null;
let idleTimer = null;
let lastError = null;
let activePages = 0;
const contexts = new Map(); // session name → BrowserContext (one per site, keeps cookies)

/** Response patterns that mean "this is the stream". */
const MEDIA_PATTERNS = [
  { re: /\.m3u8(\?|#|$)/i, kind: 'hls' },
  { re: /\.mpd(\?|#|$)/i, kind: 'dash' },
  { re: /\.(mp4|m4v|mov|webm|mkv)(\?|#|$)/i, kind: 'file' },
  { re: /\.ts(\?|#|$)/i, kind: 'segment' },
  { re: /\/(manifest|master|playlist)(\.|\/|\?)/i, kind: 'manifest?' },
  { re: /videoplayback|video\/mp4|googlevideo|akamaihd|cloudfront.*\.(mp4|m3u8)/i, kind: 'cdn' },
];
const MEDIA_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl',
  'application/dash+xml', 'video/mp4', 'video/webm', 'video/MP2T', 'video/mp2t',
];
const FONT_FILE_PATTERN = /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i;
/** Pages that are obviously advertising or analytics — never load them. */
const BLOCK_PATTERNS = [
  'doubleclick.net', 'googlesyndication.com', 'google-analytics.com', 'googletagmanager.com',
  'adservice.google', 'popads.net', 'popcash.net', 'propellerads.com', 'adsterra.com',
  'exoclick.com', 'juicyads.com', 'hilltopads.net', 'onclickalgo.com', 'onclickmega.com',
  'profitableratecpm.com', 'clickadu.com', 'mgid.com', 'taboola.com', 'outbrain.com',
  'push-notification', 'notification.js', 'onesignal.com',
];

const PLAY_SELECTORS = [
  'button[aria-label*="play" i]', 'button[title*="play" i]', '[class*="play-button" i]',
  '[class*="playbtn" i]', '[class*="play-btn" i]', '.vjs-big-play-button', '.jw-display-icon-container',
  '[class*="player" i] button', 'button[class*="play" i]', 'a[class*="play" i]', '.play', '#play',
  'video',
];

function chromiumPath() {
  return process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || null;
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error('browser request aborted'), { name: 'AbortError' });
}

export function isNetworkNavigationError(error) {
  const message = typeof error === 'string' ? error : String(error?.message || error || '');
  return /ERR_(?:CONNECTION_(?:REFUSED|RESET|CLOSED|ABORTED|TIMED_OUT)|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NETWORK_CHANGED|NETWORK_ACCESS_DENIED|PROXY_CONNECTION_FAILED)/i.test(message);
}

export function browserInfo() {
  return {
    available: Boolean(browser?.isConnected?.()),
    launching: Boolean(launching),
    executable: chromiumPath() || '(playwright bundled)',
    concurrency: getConfig().scraper.browserConcurrency,
    activePages,
    lastError,
  };
}

/**
 * Launch (once) and return the Chromium instance.
 */
export async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (launching) return launching;
  const exe = chromiumPath();
  launching = (async () => {
    if (!playwright) {
      try {
        ({ chromium: playwright } = await import('playwright-core'));
      } catch (err) {
        throw new Error(`playwright-core is not installed (${err.message}) — run: npm install`);
      }
    }
    const args = [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-software-rasterizer', '--disable-extensions',
      '--mute-audio', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-sync', '--disable-translate',
      '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter',
      '--js-flags=--max-old-space-size=384',
      '--window-size=1280,800',
    ];
    // When a proxy is configured for SNI-bypass, Chromium must also use it so
    // page loads + the browser-TLS fallback share the same egress.
    const proxyForBrowser = (() => {
      try { return getConfig()?.scraper?.proxyUrl || ''; } catch { return ''; }
    })() || process.env.MOVIEBOX_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
    if (proxyForBrowser) {
      try {
        const u = new URL(proxyForBrowser);
        const proxyArg = `${u.protocol}//${u.host}`;
        args.push(`--proxy-server=${proxyArg}`);
        if (u.username || u.password) log.info('browser', 'Chromium will use proxy with authentication', { proxy: proxyForBrowser.replace(/:\/\/[^@]*@/, '://***@') });
        else log.info('browser', `Chromium will use proxy ${proxyArg}`);
      } catch { /* malformed proxy: ignore */ }
    }
    log.info('browser', `launching Chromium${exe ? ` (${exe})` : ' (playwright build)'}`);
    browser = await playwright.launch({
      headless: true,
      executablePath: exe || undefined,
      args,
      timeout: 45_000,
    });
    browser.on('disconnected', () => {
      log.warn('browser', 'Chromium disconnected — will be launched again on the next job');
      browser = null;
      contexts.clear();
    });
    lastError = null;
    return browser;
  })().catch((err) => {
    lastError = err.message;
    logError('browser', `Chromium could not be started: ${err.message}`, err);
    launching = null;
    throw err;
  });
  const b = await launching;
  launching = null;
  return b;
}

/** One persistent context per site so a Cloudflare cookie survives across jobs. */
async function getContext(name) {
  const b = await getBrowser();
  const key = name || 'default';
  const existing = contexts.get(key);
  if (existing) return existing;
  const userAgent = getConfig().scraper.userAgent;
  const proxyForContext = (() => {
    try { return getConfig()?.scraper?.proxyUrl || ''; } catch { return ''; }
  })() || process.env.MOVIEBOX_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  let proxyOpt = undefined;
  if (proxyForContext) {
    try {
      const u = new URL(proxyForContext);
      proxyOpt = { server: `${u.protocol}//${u.host}` };
      if (u.username) proxyOpt.username = decodeURIComponent(u.username);
      if (u.password) proxyOpt.password = decodeURIComponent(u.password);
    } catch { /* ignore malformed proxy */ }
  }
  const ctx = await b.newContext({
    userAgent,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'Europe/Amsterdam',
    ignoreHTTPSErrors: true,
    bypassCSP: true,
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9,nl;q=0.8' },
    ...(proxyOpt ? { proxy: proxyOpt } : {}),
  });
  contexts.set(key, ctx);
  return ctx;
}

export async function closeContexts() {
  for (const [name, ctx] of contexts) {
    try { await ctx.close(); } catch { /* ignore */ }
    contexts.delete(name);
  }
}

/** Accepts compiled `{re, kind}` entries as well as raw recipe strings. */
function asMatcher(pattern) {
  if (!pattern) return null;
  if (pattern instanceof RegExp) return { re: pattern, kind: null };
  if (typeof pattern === 'string') {
    try { return { re: new RegExp(pattern, 'i'), kind: null }; } catch { return null; }
  }
  if (pattern.re instanceof RegExp) return { re: pattern.re, kind: pattern.kind || null };
  if (typeof pattern.re === 'string') {
    try { return { re: new RegExp(pattern.re, pattern.flags || 'i'), kind: pattern.kind || null }; } catch { return null; }
  }
  return null;
}

export function looksLikeMedia(url, contentType, resourceType = '', extraPatterns = []) {
  const target = String(url || '');
  const ct = String(contentType || '').toLowerCase();
  const extras = extraPatterns.map(asMatcher).filter(Boolean);
  // Some CDNs mislabel fonts as application/octet-stream; they are not video
  // candidates even though their MIME type otherwise looks like binary media.
  if (resourceType === 'font' || FONT_FILE_PATTERN.test(target)) return false;
  if (MEDIA_CONTENT_TYPES.some((t) => ct.includes(t.toLowerCase()))) return true;
  if (/^application\/octet-stream(?:\s*;|$)/i.test(ct)) {
    return resourceType === 'media'
      || MEDIA_PATTERNS.some((pattern) => pattern.re.test(target))
      || extras.some((pattern) => pattern.re.test(target));
  }
  return MEDIA_PATTERNS.some((pattern) => pattern.re.test(target))
    // Per-site patterns from the recipe (some sites serve manifests behind a
    // route with no extension, e.g. /api/stream?id=…). A match here also tells
    // us the kind, so the candidate is not recorded as a generic 'file'.
    || extras.some((pattern) => pattern.re.test(target));
}

function kindOf(url, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (/mpegurl/.test(ct) || /\.m3u8/i.test(url)) return 'hls';
  if (/dash\+xml/.test(ct) || /\.mpd/i.test(url)) return 'dash';
  if (/mp2t/.test(ct) || /\.ts(\?|#|$)/i.test(url)) return 'segment';
  if (/video\/mp4|video\/webm/i.test(ct)) return 'file';
  return 'file';
}

/**
 * Bumped whenever the regexes a stored recipe carries may be out of date.
 * Recipes downloaded by an earlier version (or hand-written ones for a site
 * that changed its player) keep working because `upgradeRecipe` folds the
 * current built-in regexes back in — see registry.loadSources().
 */
export const RECIPE_SCHEMA_VERSION = 2;

/** A sane default pattern for a media kind, used when a recipe has none. */
export function defaultMediaPattern(kind) {
  const found = MEDIA_PATTERNS.find((pattern) => pattern.kind === kind);
  return found ? found.re.source : null;
}

/** Cache of compiled recipe patterns (site id → [{re, kind}]). */
const recipeMediaPatterns = new Map();

/**
 * The site registry lives in registry.js, which imports *this* module — so we
 * cannot import it back without a cycle. Instead the registry hands us its
 * loader once, and a bare `sniff()` call (or a unit test) simply falls back to
 * the built-in patterns.
 *
 * Before this existed, compiledPatternsFor() called an undefined `loadSources()`
 * and its catch swallowed the ReferenceError, so every per-site recipe pattern
 * (the whole point of the v2 media-detection upgrade: manifests behind URLs with
 * no extension) was silently ignored.
 */
let sourceLookup = null;

export function registerSourceLookup(fn) {
  sourceLookup = typeof fn === 'function' ? fn : null;
  clearRecipeMediaPatternCache();
}

/** Called when sources are reloaded, so edited patterns take effect at once. */
export function clearRecipeMediaPatternCache() {
  recipeMediaPatterns.clear();
}

/**
 * Compiled media patterns for a site: the ones the caller passed (the registry
 * already has the recipe in hand) or, failing that, whatever the registry can
 * look up.
 */
export function compiledPatternsFor(siteId, recipePatterns = null) {
  const provided = Array.isArray(recipePatterns) && recipePatterns.length ? recipePatterns : null;
  const key = `${siteId ?? ''}\u0000${provided ? JSON.stringify(provided) : ''}`;
  const cached = recipeMediaPatterns.get(key);
  if (cached) return cached;

  let patterns = provided || [];
  if (!patterns.length && siteId && sourceLookup) {
    try {
      const source = sourceLookup()?.find((s) => s.id === siteId);
      patterns = Array.isArray(source?.mediaPatterns) ? source.mediaPatterns : [];
    } catch (err) {
      // A failing lookup must never break sniffing — but say so in the log
      // instead of hiding a coding error behind a bare catch (that is how this
      // function spent its life returning [] and nobody noticed).
      log.debug('browser', `could not resolve media patterns for ${siteId}`, { error: errorText(err) });
      patterns = [];
    }
  }
  const compiled = patterns.map(asMatcher).filter(Boolean);
  recipeMediaPatterns.set(key, compiled);
  if (compiled.length) log.debug('browser', `using ${compiled.length} recipe media pattern(s) for ${siteId || 'default'}`);
  return compiled;
}

/**
 * Fold the *current* media-detection patterns into a possibly stale site
 * recipe. Sites stored in /config/sources predate DASH/HLS detection and carry
 * no patterns at all, which is how a `.mpd`-only site ends up "no media found".
 */
export function upgradeRecipe(site = {}) {
  const version = Number(site.mediaPatternsVersion || 0);
  if (version >= RECIPE_SCHEMA_VERSION && Array.isArray(site.mediaPatterns)) {
    return { site, upgraded: false };
  }
  return {
    site: {
      ...site,
      mediaPatterns: MEDIA_PATTERNS.map((pattern) => pattern.re.source),
      mediaPatternsVersion: RECIPE_SCHEMA_VERSION,
    },
    upgraded: true,
  };
}

/**
 * Open a page and record the media/API traffic it produces.
 *
 * @param {string} url                 page (or player) URL to open
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]    hard limit for the whole sniffer run
 * @param {number} [opts.quietMs]      stop after this long without new media
 * @param {boolean} [opts.click]       click a play button (default true)
 * @param {string} [opts.session]      cookie/session bucket (usually the site id)
 * @param {string[]} [opts.mediaPatterns] recipe patterns for that site (skip the lookup)
 * @param {boolean} [opts.captureJson] collect JSON API responses for inspection
 * @param {AbortSignal} [opts.signal]
 */
export async function sniff(urlOrOpts, maybeOpts = {}) {
  // Two call styles are supported on purpose:
  //   sniff(url, opts)                    — explicit
  //   sniff({ url, timeoutMs, click })    — option bag (used by the registry)
  const opts = typeof urlOrOpts === 'string' ? { ...maybeOpts, url: urlOrOpts } : { ...urlOrOpts };
  const url = opts.url;
  if (!url) throw new Error('browser.sniff() needs a url');
  const cfg = getConfig();
  const timeoutMs = opts.timeoutMs || cfg.scraper.resolveTimeoutMs || 45_000;
  const quietMs = opts.quietMs ?? 2500;
  const captureJson = opts.captureJson !== false;
  const started = Date.now();
  if (opts.signal?.aborted) throw abortError(opts.signal);

  const ctx = await getContext(opts.session);
  if (opts.signal?.aborted) throw abortError(opts.signal);
  const page = await ctx.newPage();
  activePages += 1;
  const closeOnAbort = () => { page.close().catch(() => {}); };
  opts.signal?.addEventListener('abort', closeOnAbort, { once: true });
  if (opts.signal?.aborted) closeOnAbort();

  const media = new Map(); // url → record
  const apis = new Map();
  const pendingJsonSettles = []; // promises mining JSON bodies for m3u8 URLs (awaited at end)
  const consoleErrors = [];
  const failedDocumentRequests = [];
  /**
   * Main-frame navigations we abort ourselves (pop-unders → about:blank/ads).
   * Tracked so our own block is not reported as a network error of the site.
   */
  const blockedNavigations = new Set();

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err.message).slice(0, 200)));

  // Catch pop-ups: many players open the stream in a new tab. Remove this
  // listener after each run so it does not accumulate in the persistent context.
  const popupPages = new Set();
  const onPopup = (popup) => {
    popupPages.add(popup);
    attach(popup);
  };
  ctx.on('page', onPopup);

  function attach(p) {
    p.on('requestfailed', (request) => {
      if (failedDocumentRequests.length >= 12) return;
      try {
        if (blockedNavigations.has(request.url())) return;
        const failure = String(request.failure() || 'request failed');
        const isFrameDocument = request.isNavigationRequest() || request.resourceType() === 'subdocument';
        // Sub-frame failures matter as much as the main frame: when the movie
        // page loads but its embedded player is refused, the *only* evidence is
        // the refused iframe. Naming that host turns "no media found" into an
        // actionable "embed host X is unreachable".
        if (!isFrameDocument && !isNetworkNavigationError(failure)) return;
        const frame = request.frame();
        const isMainFrame = frame === p.mainFrame();
        failedDocumentRequests.push({
          host: safeHost(request.url()),
          url: String(request.url()).slice(0, 160),
          kind: isMainFrame ? 'main-frame' : 'embed',
          error: failure.slice(0, 180),
        });
      } catch { /* a closed popup may no longer have a frame */ }
    });
    p.on('response', async (res) => {
      const u = res.url();
      const ct = res.headers()['content-type'] || '';
      const req = res.request();
      const sitePatterns = req.resourceType() === 'media' ? [] : compiledPatternsFor(opts.session, opts.mediaPatterns);
      if (looksLikeMedia(u, ct, req.resourceType()) || looksLikeMedia(u, ct, req.resourceType(), sitePatterns)) {
        if (!media.has(u)) {
          let reqHeaders;
          try { reqHeaders = await req.allHeaders(); } catch { reqHeaders = req.headers(); }
          const kind = sitePatterns.find((pattern) => pattern.re.test(u))?.kind || kindOf(u, ct);
          media.set(u, {
            url: u,
            kind,
            // `via`/`referer` are what the relay needs to replay the request in ffmpeg
            via: kind,
            referer: reqHeaders.referer || reqHeaders.Referer || p.url() || url,
            contentType: ct,
            status: res.status(),
            headers: reqHeaders,
            foundAt: new Date().toISOString(),
          });
          log.debug('browser', `media found (${kind}): ${u.slice(0, 160)}`);
        }
      } else if (captureJson && /application\/json|text\/json/i.test(ct)) {
        const len = Number(res.headers()['content-length'] || 0);
        if ((len === 0 || len < 600_000) && media.size < 12) {
          // Some players (RabbitStream, UpCloud, VidCloud, the flixer clones'
          // /ajax/player endpoints) don't set the video src directly; instead
          // they POST to a JSON API that returns { sources: [{ file: "...m3u8" }] }.
          // Mine those payloads for m3u8/dash URLs so we don't miss them just
          // because they arrived over XHR rather than as a media request.
          if (media.size === 0) apis.set(u, { url: u, status: res.status(), at: new Date().toISOString() });
          const settle = (async () => {
            try {
              const body = await res.text().catch(() => '');
              const matches = String(body || '').match(/https?:\/\/[^\s"']+?\.(?:m3u8|mpd)(?:\?[^\s"']*)?/gi) || [];
              if (!matches.length) return;
              let reqHeaders;
              try { reqHeaders = await req.allHeaders(); } catch { reqHeaders = req.headers(); }
              for (const raw of matches.slice(0, 5)) {
                const found = raw.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
                if (media.has(found)) continue;
                const isDash = /\.mpd(?:\?|#|$)/i.test(found);
                media.set(found, {
                  url: found,
                  kind: isDash ? 'dash' : 'hls',
                  via: 'json-api',
                  referer: reqHeaders.referer || reqHeaders.Referer || p.url() || url,
                  contentType: isDash ? 'application/dash+xml' : 'application/vnd.apple.mpegurl',
                  status: res.status(),
                  headers: reqHeaders,
                  foundAt: new Date().toISOString(),
                  sourceApi: u,
                });
                log.info('browser', `mined ${isDash ? 'DASH' : 'HLS'} URL from JSON API response (${safeHost(u)})`, { url: found.slice(0, 160) });
              }
            } catch { /* ignore */ }
          })();
          pendingJsonSettles.push(settle);
        }
      }
    });
  }
  attach(page);

  const result = {
    ok: false, url, finalUrl: url, title: null, media: [], apis: [], candidates: [],
    consoleErrors, networkErrors: [], ms: 0, note: null,
  };
  let navigationError = null;

  // Flixer-clone pages (Overlook, 1flex, cinezo, redflix …) fire ad pop-unders
  // that navigate the *main frame* to `about:blank` or to a random lander a few
  // hundred ms after load. The player then never starts, the DOM we are watching
  // disappears, and the sniff times out reporting `finalUrl: about:blank` — with
  // no hint that the page was hijacked. We block those navigations instead (the
  // search path already does exactly this) and remember the destination.
  let hijackedTo = null;
  try {
    await page.route('**/*', async (route) => {
      const req = route.request();
      const u = req.url();
      if (BLOCK_PATTERNS.some((p) => u.includes(p))) return route.abort();
      const type = req.resourceType();
      if (type === 'image' || type === 'font' || type === 'media') {
        // We do not need the pixels; 'media' is aborted so the site cannot pull
        // gigabytes through the NAS — we only want the manifest URL.
        if (type === 'media') return route.abort();
        return route.continue();
      }
      try {
        if (req.isNavigationRequest() && req.frame() === page.mainFrame()
            && (u === 'about:blank' || !isSameSiteNavigation(u, url))) {
          hijackedTo ||= u;
          blockedNavigations.add(u);
          log.warn('browser', `blocked an off-site / blank main-frame navigation on ${safeHost(url)} (pop-under?)`, {
            destination: safeHost(u),
          });
          return route.abort('blockedbyclient');
        }
      } catch { /* frame may be detached while the pop-under fires */ }
      return route.continue();
    });

    log.info('browser', `sniffing ${safeHost(url)}`, { url: url.slice(0, 200), session: opts.session || 'default' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 30_000) })
      .catch((err) => {
        navigationError = err.message;
        log.warn('browser', `navigation issue for ${safeHost(url)}: ${err.message}`);
      });
    if (opts.signal?.aborted) throw abortError(opts.signal);
    result.networkErrors = failedDocumentRequests.slice(0, 8);
    if (navigationError && isNetworkNavigationError(navigationError)) {
      result.finalUrl = page.url();
      result.title = await page.title().catch(() => null);
      result.error = `cannot connect to ${safeHost(url)}: ${navigationError}`;
      result.note = 'The page could not be reached from the app container; check outbound internet, DNS, firewall/proxy settings, or whether the site is available.';
      log.warn('browser', `target page is unreachable on ${safeHost(url)}`, {
        finalUrl: result.finalUrl,
        navigationError,
        failedRequests: result.networkErrors,
      });
      return result;
    }

    let followedPlayAction = false;
    if (opts.click !== false) followedPlayAction = await nudgePlay(page);

    // A few sites expose an explicit detail → player route but hide the CTA
    // until client-side metadata finishes loading. Recipes can supply that
    // prefix as a fallback when no visible Play/Watch action was found.
    if (!followedPlayAction && media.size === 0 && opts.playerPathPrefix) {
      const playerUrl = playerUrlWithPrefix(url, opts.playerPathPrefix);
      if (playerUrl && playerUrl !== page.url()) {
        log.info('browser', 'no visible play action found; trying recipe player route', {
          sourceUrl: page.url().slice(0, 160), playerUrl: playerUrl.slice(0, 160),
        });
        await page.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
          .catch((err) => log.warn('browser', `player-route navigation issue: ${err.message}`));
        if (opts.click !== false) await nudgePlay(page);
      }
    }

    // Wait until we have media AND the page has been quiet for `quietMs`.
    // The aggressive click is a single retry; repeating it every 250 ms can
    // continually reload the player before it has time to initialize.
    const waitForMedia = async (nudgeAtMs) => {
      let lastCount = 0;
      let lastChange = Date.now();
      let aggressivePlayRetried = false;
      while (Date.now() - started < timeoutMs) {
        if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const count = media.size + apis.size;
        if (count !== lastCount) { lastCount = count; lastChange = Date.now(); }
        if (media.size > 0 && Date.now() - lastChange > quietMs) break;
        if (!aggressivePlayRetried && media.size === 0 && Date.now() - started > nudgeAtMs) {
          aggressivePlayRetried = true;
          await nudgePlay(page, true);
        }
        await sleep(250);
      }
    };
    await waitForMedia(Math.min(timeoutMs, 12_000));

    // If the tab was replaced anyway (a same-site rewrite to about:blank, a
    // renderer crash, `window.close()`), the page is gone and nothing further
    // can be observed. Reload once: ad pop-unders here fire on the first load of
    // a fresh tab, which is also what the search path relies on.
    const pageWasReplaced = () => {
      const current = page.url();
      return !current || current.startsWith('about:') || !isSameSiteNavigation(current, url);
    };
    if (media.size === 0 && pageWasReplaced()) {
      log.warn('browser', `${safeHost(url)} replaced the tab (now ${String(page.url()).slice(0, 120)}) — reloading it once`, {
        blockedRedirect: hijackedTo ? safeHost(hijackedTo) : null,
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 20_000) })
        .catch((err) => log.warn('browser', `reload after tab replacement failed: ${err.message}`));
      if (opts.click !== false) await nudgePlay(page);
      await waitForMedia(Date.now() - started + 4_000);
    }

    // Give in-flight JSON API response bodies a moment to settle so the
    // m3u8-mining above catches manifests that arrived via XHR just as the
    // wait loop was exiting. Cap it at 2 s so we don't extend the sniff.
    if (pendingJsonSettles.length) {
      await Promise.race([
        Promise.allSettled(pendingJsonSettles),
        sleep(2000),
      ]);
    }

    result.finalUrl = page.url();
    result.title = await page.title().catch(() => null);
    result.media = [...media.values()];
    result.apis = [...apis.values()];
    result.networkErrors = failedDocumentRequests.slice(0, 8);
    result.hls = result.media.filter((m) => m.kind === 'hls');
    result.html = opts.withHtml ? await page.content().catch(() => '') : null;
    result.ok = result.media.length > 0;
    if (!result.ok) {
      result.error = navigationError ? `navigation issue: ${navigationError}` : undefined;
      // Diagnose the most common failure modes from what we observed, so the
      // log / UI can give the operator an actionable hint instead of the
      // generic "may need a click".
      const consoleJoin = consoleErrors.slice(0, 5).join(' | ').toLowerCase();
      const netJoin = result.networkErrors.map((e) => `${e.host}:${e.error}`).join(' | ').toLowerCase();
      const allSignals = `${consoleJoin} ${netJoin}`;
      if (/err_connection_refused|err_failed|err_connection_reset/.test(allSignals) && !navigationError) {
        // Page loaded but the player iframe / API host refused connections —
        // almost always means the source's CDN/embed is dead, geo-blocked,
        // or blocked by the container's network (DNS/proxy/firewall).
        // Name the actual hosts: with several embeds per page the operator
        // otherwise cannot tell which one is dead.
        const refused = [...new Set(result.networkErrors
          .filter((e) => /ERR_(CONNECTION|NAME|ADDRESS|INTERNET|PROXY)/i.test(String(e.error)))
          .map((e) => e.host))]
          .filter(Boolean);
        result.note = refused.length
          ? `page loaded but its embedded player/CDN is unreachable — refused host(s): ${refused.join(', ')} (dead, geo-blocked, or blocked by DNS/firewall/proxy)`
          : 'page loaded but the embedded player is unreachable (connection refused / failed) — the CDN/embed host may be dead, geo-blocked, or blocked by DNS';
        result.refusedHosts = refused;
      } else if (hijackedTo) {
        result.note = `the page was replaced by an off-site/ad redirect to ${safeHost(hijackedTo)} — the site is likely parked, ad-hijacked, or requires a captcha`;
      } else if (navigationError) {
        result.note = `page navigation did not complete: ${navigationError}`;
      } else {
        result.note = 'no media response observed — the page may need a click, a login, or a different player URL';
      }
      log.warn('browser', `no media found on ${safeHost(url)} after ${Date.now() - started} ms`, {
        finalUrl: result.finalUrl.slice(0, 200),
        title: result.title,
        navigationError,
        failedRequests: result.networkErrors,
        consoleErrors: consoleErrors.slice(0, 3),
        diagnosedNote: result.note,
      });
    }
  } catch (err) {
    if (opts.signal?.aborted || err?.name === 'AbortError') throw abortError(opts.signal);
    result.error = err.message;
    log.error('browser', `sniffer failed on ${safeHost(url)}: ${err.message}`);
  } finally {
    opts.signal?.removeEventListener('abort', closeOnAbort);
    ctx.off('page', onPopup);
    for (const popup of popupPages) await popup.close().catch(() => {});
    activePages -= 1;
    result.ms = Date.now() - started;
    await page.close().catch(() => {});
    scheduleIdleClose();
  }
  return result;
}

/** Click something that looks like a play button; ignore all failures. */
async function nudgePlay(page, aggressive = false) {
  try {
    await page.evaluate(() => {
      // Unmute + play the first <video>, and make sure it is not hidden.
      const v = document.querySelector('video');
      if (v) {
        v.muted = true;
        v.play?.().catch(() => {});
      }
    }).catch(() => {});
  } catch { /* ignore */ }

  for (const sel of PLAY_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      await el.click({ timeout: 1200, force: aggressive });
      log.debug('browser', `clicked play control: ${sel}`);
      await sleep(aggressive ? 400 : 900);
      return true;
    } catch { /* selector not clickable — try the next one */ }
  }

  // Search results frequently open a title-details page first. On these pages
  // the primary action is a normal “Play”/“Watch now” link, not a player button;
  // follow it so the sniffer reaches the actual episode/player route.
  const labels = [/^watch now$/i, /^watch$/i, /^play now$/i, /^play$/i, /^start watching$/i, /^stream now$/i];
  const exactLabels = ['Watch Now', 'Watch', 'Play Now', 'Play', 'Start Watching', 'Stream Now'];
  for (const [index, name] of labels.entries()) {
    for (const role of ['link', 'button']) {
      try {
        const control = page.getByRole(role, { name }).first();
        if (!await control.isVisible().catch(() => false)) continue;
        const href = await control.getAttribute('href').catch(() => null);
        const currentUrl = page.url();
        const targetUrl = href && !/^(?:#|javascript:)/i.test(href) ? resolveUrl(currentUrl, href) : currentUrl;
        if (targetUrl !== currentUrl) {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
            .catch(() => control.click({ timeout: 1200, force: aggressive }).catch(() => {}));
        } else {
          await control.click({ timeout: 1200, force: aggressive });
        }
        log.debug('browser', `followed ${role} action “${exactLabels[index]}” to ${page.url().slice(0, 160)}`);
        await sleep(aggressive ? 400 : 900);
        return true;
      } catch { /* try the next exact action label */ }
    }

    // Some templates render a clickable div/span instead of an accessible link
    // or button. Clicking its exact visible text still bubbles to that handler.
    try {
      const control = page.getByText(exactLabels[index], { exact: true }).first();
      if (!await control.isVisible().catch(() => false)) continue;
      const href = await control.evaluate((el) => el.closest('a[href]')?.getAttribute('href') || null).catch(() => null);
      const currentUrl = page.url();
      const targetUrl = href && !/^(?:#|javascript:)/i.test(href) ? resolveUrl(currentUrl, href) : currentUrl;
      if (targetUrl !== currentUrl) {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
          .catch(() => control.click({ timeout: 1200, force: aggressive }).catch(() => {}));
      } else {
        await control.click({ timeout: 1200, force: aggressive });
      }
      log.debug('browser', `followed text action “${exactLabels[index]}” to ${page.url().slice(0, 160)}`);
      await sleep(aggressive ? 400 : 900);
      return true;
    } catch { /* try the next exact action label */ }
  }
  return false;
}

export function playerUrlWithPrefix(url, prefix) {
  try {
    const target = new URL(url);
    const segments = String(prefix || '').split('/').filter(Boolean);
    if (!segments.length) return null;
    const normalizedPrefix = `/${segments.join('/')}`;
    const originalPath = target.pathname.startsWith('/') ? target.pathname : `/${target.pathname}`;
    if (originalPath === normalizedPrefix || originalPath.startsWith(`${normalizedPrefix}/`)) return null;
    target.pathname = `${normalizedPrefix}${originalPath}`;
    return target.toString();
  } catch { return null; }
}

const SEARCH_RESULT_ROUTE = /(?:^|\/)(?:movies?|films?|tv|series?|serie|shows?|watch|titles?|details?|play)(?:\/|\.html|[?#]|$)/i;
const DETAIL_ID_PARAMS = ['id', 'tmdb', 'tmdb_id', 'imdb', 'imdb_id', 'movie_id', 'movieId', 'subjectId', 'subject_id', 'media_id', 'slug'];

function hasDetailIdentifier(url) {
  return DETAIL_ID_PARAMS.some((name) => Boolean(String(url.searchParams.get(name) || '').trim()));
}
const GENERIC_RESULT_TITLES = /^(?:home|movies?|films?|tv|series?|shows?|search|browse|login|log in|register|sign up|watch|watch now|play|view details|details|more|next|previous)$/i;
const QUERY_STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'the', 'to']);

function plainText(value) {
  return String(value || '').replace(/[\s\u00a0]+/g, ' ').trim();
}

function normalizeForSearch(value) {
  return plainText(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function titleFromPath(url) {
  try {
    let slug = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    slug = slug.replace(/\.(?:html?|php)$/i, '')
      .replace(/^(?:tt)?\d{3,}[-_]/i, '')
      .replace(/[-_]\d{3,}$/i, '')
      .replace(/[-_]+/g, ' ');
    return plainText(slug);
  } catch { return ''; }
}

function cleanResultTitle(value) {
  let title = plainText(value)
    .replace(/\s*(?:poster|cover|thumbnail)\s*$/i, '')
    .replace(/^(?:watch|play|open)\s+(?:now\s+)?/i, '')
    .replace(/\s*[★⭐]\s*\d+(?:[.,]\d+)?/g, ' ')
    .replace(/\s+(?:HD|4K|1080p|720p|Movie|Series|TV|Anime)\s*$/i, '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .trim();
  if (!/^\d{4}$/.test(title)) title = title.replace(/\s+(?:19|20)\d{2}$/, '').trim();
  return title;
}

function sameSiteHost(host, baseHost) {
  return host === baseHost
    || host.endsWith(`.${baseHost}`)
    || (host.includes('.') && baseHost.endsWith(`.${host}`));
}

/** Whether a URL stays on the search site's host (including www/subdomains). */
export function isSameSiteNavigation(url, baseUrl) {
  try {
    const target = new URL(url);
    const base = new URL(baseUrl);
    return ['http:', 'https:'].includes(target.protocol)
      && sameSiteHost(target.hostname.toLowerCase(), base.hostname.toLowerCase());
  } catch { return false; }
}

/**
 * Clean a configured URL before parsing it.
 *
 * The value comes from three places — the config file, Settings → Scraper and
 * `FLARESOLVERR_URL` in `.env` — and the `.env` one is a trap: docker compose
 * only strips an inline `# comment` in *some* versions (and `docker run
 * --env-file` and DSM's Container Manager are no better), so a verbatim copy
 * of `.env.example` can hand us
 * `http://flaresolverr:8192   # container-to-container address`.
 * `new URL()` throws on that, and a thrown parse used to be indistinguishable
 * from "not configured": the operator sets the variable and the log says it is
 * not set. Neither whitespace nor a bare `#` comment is legal in a URL anyway,
 * so cut the value at the first whitespace and drop surrounding quotes.
 */
export function sanitizeSolverUrl(value) {
  let text = String(value ?? '').trim().replace(/^["']+|["']+$/g, '');
  if (!text) return '';
  const cut = text.search(/\s/);
  if (cut > 0) text = text.slice(0, cut);
  return text;
}

/**
 * Why the solver cannot be used, or `null` when it is configured fine.
 * "empty" and "set but unusable" are different problems with different fixes,
 * and reporting the second as the first is what made this hard to diagnose.
 */
export function flaresolverrConfigIssue(value = getConfig().scraper.flaresolverrUrl) {
  const raw = String(value || '').trim();
  if (!raw) {
    return {
      kind: 'empty',
      message: 'FLARESOLVERR_URL is empty — set it to http://flaresolverr:8192 (the compose project starts the flaresolverr service) and recreate the container',
    };
  }
  if (flaresolverrEndpoint(raw)) return null;
  // A value that *is* a comment means someone copied a line from the example —
  // the fix is in the config file, so say that instead of blaming .env.
  if (/^(#|\/\/)/.test(raw)) {
    return {
      kind: 'unusable',
      raw,
      message: `the configured FlareSolverr URL is a comment, not a URL (${truncate(raw, 60)}) — set the nested "scraper": { "flaresolverrUrl": "http://flaresolverr:8192" } in /config/vumovie.json (a flat "scraper.flaresolverrUrl" key is ignored) or set FLARESOLVERR_URL, then recreate the container`,
    };
  }
  return {
    kind: 'unusable',
    raw,
    message: `FLARESOLVERR_URL is set but is not a usable URL (${truncate(raw, 60)}) — if it came from .env, remove the trailing "# …" comment (docker compose only strips it in some versions), then recreate the container`,
  };
}

/** Normalize the optional FlareSolverr URL to its v1 API endpoint. */
export function flaresolverrEndpoint(value = getConfig().scraper.flaresolverrUrl) {
  const configured = sanitizeSolverUrl(value);
  if (!configured) return null;
  try {
    const endpoint = new URL(configured);
    if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname) return null;
    const pathname = endpoint.pathname.replace(/\/+$/, '');
    endpoint.pathname = /\/v1$/i.test(pathname) ? pathname : `${pathname}/v1`;
    endpoint.search = '';
    endpoint.hash = '';
    return endpoint.toString();
  } catch { return null; }
}

/** Validate and normalize the FlareSolverr `request.get` response. */
export function parseFlareSolverrResult(payload, requestedUrl) {
  const solution = payload?.solution;
  if (payload?.status !== 'ok' || typeof solution?.response !== 'string' || !solution.response) {
    throw new Error(String(payload?.message || 'FlareSolverr returned no page content'));
  }
  const finalUrl = String(solution.url || requestedUrl);
  if (!isSameSiteNavigation(finalUrl, requestedUrl)) {
    throw new Error(`FlareSolverr redirected the search off-site to ${safeHost(finalUrl)}`);
  }
  const status = Number(solution.status);
  return {
    html: solution.response,
    url: finalUrl,
    status: Number.isFinite(status) && status > 0 ? status : null,
    cookies: Array.isArray(solution.cookies) ? solution.cookies : [],
  };
}

/**
 * Turn a FlareSolverr failure into a hint an operator can act on.
 *
 * From out here every solver failure used to look the same ("FlareSolverr
 * could not recover <site> search"), even though the underlying causes are
 * completely different and have completely different fixes:
 *
 *   - Chromium inside the solver never started. FlareSolverr tests its browser
 *     on boot (`test_browser_installation()`), and when that test fails it
 *     *exits* — so the container restart-loops and every `request.get` fails.
 *     The log says "Error getting browser User-Agent …". In Docker the cause is
 *     nearly always the 64 MB `/dev/shm` default (Chrome hangs or dies in it)
 *     or a memory limit below ~1 GB.
 *   - The challenge page timed out (slow NAS, starved container, real
 *     challenge) — nothing is broken, it just needs more time/CPU.
 *   - A plain HTTP status — wrong URL/port, or the solver really is down.
 */
export function describeFlareSolverrError(error, { endpoint = null } = {}) {
  const message = String(error?.message ?? error ?? '').replace(/\s+/g, ' ').trim();
  if (!message) return 'FlareSolverr failed without returning a reason';
  const where = endpoint ? ` at ${endpoint}` : '';
  const short = (limit = 160) => message.slice(0, limit);

  if (/error getting browser user-agent|test_browser_installation|can not connect to the service|session not created|unexpectedly exited|chrome(?:driver)? (?:failed|is not reachable)|unable to (?:start|open) (?:the )?browser/i.test(message)) {
    return `FlareSolverr's own Chromium did not start${where} — its container is crash-looping (${short()}). `
      + 'Run `docker compose logs flaresolverr`; in Docker this is almost always /dev/shm still at the 64 MB default '
      + '(add `shm_size: 512m` to the flaresolverr service) or a memory limit below ~1 GB';
  }
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket hang up|fetch failed|terminated/i.test(message)) {
    return `FlareSolverr is not reachable${where} (${short(120)}) — start the flaresolverr container (\`docker compose up -d flaresolverr\`) or fix FLARESOLVERR_URL`;
  }
  if (/timed out|timeout|maxtimeout|readtimeout/i.test(message)) {
    return `FlareSolverr timed out solving the challenge${where} (${short(120)}) — the solver container is slow or starved of CPU/RAM; see \`docker compose logs flaresolverr\``;
  }
  const httpStatus = message.match(/HTTP\s+(\d{3})/i)?.[1];
  if (httpStatus) {
    if (Number(httpStatus) >= 500) {
      return `FlareSolverr answered HTTP ${httpStatus}${where} — its browser or API is failing internally (${short(120)}); check \`docker compose logs flaresolverr\``;
    }
    return `FlareSolverr answered HTTP ${httpStatus}${where} — check FLARESOLVERR_URL (container-to-container, e.g. http://flaresolverr:8192) and the published port`;
  }
  return `FlareSolverr failed${where}: ${short(200)}`;
}

/** The address the compose project's flaresolverr service listens on. */
export const DEFAULT_FLARESOLVERR_URL = 'http://flaresolverr:8192';

/**
 * Quick liveness probe for FlareSolverr so we can tell the operator
 * "FlareSolverr is reachable (vX)" or "nothing is listening" instead of showing
 * a generic message against a Cloudflare interstitial.
 *
 * When nothing is configured we also probe the compose default, because "not
 * configured" is two very different situations: the service was never started,
 * or it *is* running (compose starts it with the project) and FLARESOLVERR_URL
 * simply does not point at it.
 */
export async function probeFlareSolverrHealth({ timeoutMs = 3000, signal = null } = {}) {
  const endpoint = flaresolverrEndpoint();
  if (!endpoint) {
    const defaultUrl = DEFAULT_FLARESOLVERR_URL;
    try {
      const probe = await request(`${defaultUrl}/health`, {
        method: 'GET', timeoutMs: Math.min(timeoutMs, 2000), retries: 0, json: true, allowFailure: true, signal,
      });
      if (probe.ok) {
        return { configured: false, issue: flaresolverrConfigIssue(), defaultReachable: true, defaultUrl, version: probe.data?.version || null };
      }
    } catch { /* nothing listening on the compose default either */ }
    return { configured: false, issue: flaresolverrConfigIssue(), defaultReachable: false, defaultUrl };
  }
  try {
    const healthUrl = endpoint.replace(/\/v1$/, '/health');
    const probe = await request(healthUrl, { method: 'GET', timeoutMs, retries: 0, json: true, allowFailure: true, signal });
    if (probe.ok) return { configured: true, ok: true, version: probe.data?.version || probe.data?.message || 'ok', url: healthUrl };
    if (probe.status === 404) return { configured: true, ok: true, version: 'unknown (no /health endpoint)', url: healthUrl };
    return { configured: true, ok: false, error: describeFlareSolverrError(probe.data?.message || `HTTP ${probe.status}`, { endpoint: healthUrl }) };
  } catch (err) {
    return { configured: true, ok: false, error: describeFlareSolverrError(errorText(err), { endpoint }) };
  }
}

let solverStatusCache = { at: 0, value: null };
const SOLVER_STATUS_TTL_MS = 30_000;

/**
 * Solver state for the API and the UI. Cached: `/api/health` is the container
 * healthcheck and runs every 30 s, so a fresh probe on every call would be a
 * permanent tax on the box.
 */
export async function flaresolverrStatus({ probe = true, maxAgeMs = SOLVER_STATUS_TTL_MS } = {}) {
  const endpoint = flaresolverrEndpoint();
  const issue = flaresolverrConfigIssue();
  const base = {
    configured: Boolean(endpoint),
    url: endpoint ? endpoint.replace(/\/v1$/, '') : null,
    issue: issue ? { kind: issue.kind, message: issue.message } : null,
  };
  if (!probe) return { ...base, checkedAt: null };
  const freshEnough = solverStatusCache.value
    && Date.now() - solverStatusCache.at < maxAgeMs
    && solverStatusCache.value.configured === base.configured
    && solverStatusCache.value.url === base.url;
  if (freshEnough) return solverStatusCache.value;
  const probed = await probeFlareSolverrHealth({ timeoutMs: 2000 });
  const value = {
    ...base,
    reachable: probed.configured ? probed.ok === true : probed.defaultReachable === true,
    ok: probed.ok === true,
    version: probed.version || null,
    error: probed.ok === false ? (probed.error || null) : null,
    defaultReachable: probed.defaultReachable === true,
    // The address the probe found when the operator has nothing configured —
    // the boot log and the UI hint name it so the fix is copy-pasteable.
    defaultUrl: probed.defaultUrl || null,
    hint: probed.configured
      ? (probed.ok ? null : probed.error)
      : describeSolverNotUsable(probed, null),
    checkedAt: new Date().toISOString(),
  };
  solverStatusCache = { at: Date.now(), value };
  return value;
}

/**
 * Turn "the solver is not usable" into one sentence that says which of the
 * three situations this is — because the fix differs for each:
 *   - the variable is wrong/unparseable (fix the value),
 *   - the container is up but the variable is empty (set it),
 *   - nothing is running at all (start the service).
 *
 * Order matters: when the value is broken *and* a solver answers at the default
 * address, the actionable fact is the broken value (the operator clearly tried
 * to configure it). Checking `defaultReachable` first made that message
 * unreachable and sent everyone looking in .env instead of at their config file,
 * so the "set but unusable" case is handled first and the reachable instance is
 * mentioned as an extra sentence rather than replacing the diagnosis.
 */
export function describeSolverNotUsable(probe = null, host = null) {
  const challenge = host ? `${host} is showing a Cloudflare / bot challenge, but ` : '';
  const answering = probe?.defaultReachable
    ? ` A FlareSolverr instance is already answering at ${probe.defaultUrl || DEFAULT_FLARESOLVERR_URL} — point the value above at it.`
    : '';
  if (probe?.issue?.kind === 'unusable') {
    return `${challenge}${probe.issue.message}${answering}`;
  }
  if (probe?.defaultReachable) {
    return `${challenge}FLARESOLVERR_URL is empty while a FlareSolverr instance is already answering at ${probe.defaultUrl} — set FLARESOLVERR_URL=${probe.defaultUrl} in .env (or Settings → Scraper) and recreate the vu-movie container`;
  }
  return `${challenge}FLARESOLVERR_URL is not configured — start the flaresolverr service (docker compose up -d flaresolverr) and set FLARESOLVERR_URL=${DEFAULT_FLARESOLVERR_URL}; without it, sources behind Cloudflare are skipped (or visit the site once in a browser to get a clearance cookie)`;
}

/**
 * One line for the boot log, and the level it deserves.
 *
 * Extracted from src/index.js so the branch order can be unit-tested: the
 * `defaultReachable` branch used to be checked before `issue.kind === 'unusable'`,
 * which hid the accurate "the value is a comment / not a URL" message exactly
 * when an operator had *tried* to configure the solver (and, in the reported
 * case, when the sidecar was running fine next to it).
 */
export function describeSolverBootState(status = {}) {
  if (status.configured && status.ok) {
    return { level: 'info', message: `FlareSolverr ready at ${status.url}`, fields: { version: status.version } };
  }
  if (status.configured) {
    return {
      level: 'warn',
      message: `FlareSolverr is configured at ${status.url} but not answering — Cloudflare-protected sources will be skipped`,
      fields: { error: status.error || null },
    };
  }
  if (status.issue?.kind === 'unusable') {
    return {
      level: 'warn',
      message: `FlareSolverr misconfigured: ${status.issue.message}`,
      fields: status.defaultReachable ? { answeringAt: status.defaultUrl || DEFAULT_FLARESOLVERR_URL } : undefined,
    };
  }
  if (status.defaultReachable) {
    return {
      level: 'warn',
      message: `a FlareSolverr instance is answering at ${status.defaultUrl || 'the default address'} but FLARESOLVERR_URL is not set — set it and recreate the container`,
      fields: undefined,
    };
  }
  return {
    level: 'info',
    message: 'FlareSolverr is not configured — sources behind Cloudflare will be skipped (set FLARESOLVERR_URL to enable them)',
    fields: undefined,
  };
}

function flareSolverrCookies(cookies, pageUrl) {
  const out = [];
  for (const cookie of cookies || []) {
    if (!cookie?.name) continue;
    const normalized = {
      name: String(cookie.name),
      value: String(cookie.value ?? ''),
      path: String(cookie.path || '/'),
      ...(cookie.domain ? { domain: String(cookie.domain) } : { url: pageUrl }),
      ...(cookie.secure != null ? { secure: Boolean(cookie.secure) } : {}),
      ...(cookie.httpOnly != null ? { httpOnly: Boolean(cookie.httpOnly) } : {}),
    };
    const expires = Number(cookie.expires ?? cookie.expiry);
    if (Number.isFinite(expires) && expires > 0) normalized.expires = expires;
    const sameSite = ({ strict: 'Strict', lax: 'Lax', none: 'None', no_restriction: 'None' })[
      String(cookie.sameSite || '').toLowerCase().replace(/[ -]/g, '_')
    ];
    if (sameSite) normalized.sameSite = sameSite;
    out.push(normalized);
  }
  return out;
}

/** How long the solver may spend on one page (FLARESOLVERR_TIMEOUT_MS, default 30 s). */
function solverTimeoutMs() {
  const configured = (() => { try { return Number(getConfig?.()?.scraper?.flaresolverrTimeoutMs); } catch { return 0; } })();
  return Number.isFinite(configured) && configured > 0 ? configured : 30_000;
}

async function requestFlareSolverr(url, { signal = null } = {}) {
  const endpoint = flaresolverrEndpoint();
  if (!endpoint) return null;
  const maxTimeout = solverTimeoutMs();
  const response = await request(endpoint, {
    method: 'POST',
    body: { cmd: 'request.get', url, maxTimeout },
    json: true,
    allowFailure: true,
    // Leave the solver a little more room than its own budget, otherwise the
    // transport cuts the connection first and the error says "timed out"
    // instead of whatever FlareSolverr would have reported.
    timeoutMs: maxTimeout + 5_000,
    retries: 0,
    signal,
  });
  if (!response.ok) {
    // Prefer FlareSolverr's own `message` (it explains *why* it failed) but
    // always fall back to the transport error, then translate both into a
    // cause+named fix instead of a bare "FlareSolverr HTTP 500".
    const reason = response.data?.message || response.error || `HTTP ${response.status}`;
    throw new Error(describeFlareSolverrError(reason, { endpoint }));
  }
  return parseFlareSolverrResult(response.data, url);
}

/**
 * Turn the small set of DOM fields captured from each card into stable result
 * rows. A configured linkPattern remains the preferred route filter, but it is
 * not a hard gate: current sites often change `/movie/...` into routes such as
 * `/watch.html?id=...`, `/play?id=...`, or `/series/...` without changing their
 * search page.
 */
export function normalizeSearchRows(rows, {
  pageUrl,
  baseUrl = pageUrl,
  query = '',
  resultPattern = null,
  siteId = '',
  siteName = siteId,
  limit = 40,
} = {}) {
  const terms = normalizeForSearch(query).split(/[^a-z0-9]+/).filter((word) => word.length > 1 && !QUERY_STOP_WORDS.has(word));
  let configuredPattern = null;
  if (resultPattern) {
    try { configuredPattern = new RegExp(resultPattern, 'i'); } catch { /* bad custom recipe: use generic route detection */ }
  }
  let baseHost = '';
  try { baseHost = new URL(baseUrl || pageUrl).hostname; } catch { /* bad base URL */ }

  const found = new Map();
  for (const row of rows || []) {
    const href = String(row.href || row.url || '').trim();
    if (!href || href.startsWith('#') || /^(?:javascript|mailto|tel|data):/i.test(href)) continue;

    let target;
    try { target = new URL(href, pageUrl); } catch { continue; }
    if (!/^https?:$/.test(target.protocol) || (baseHost && !sameSiteHost(target.hostname, baseHost))) continue;
    if (/\.(?:jpe?g|png|gif|webp|svg|css|js|woff2?|mp4|m3u8)(?:$|[?#])/i.test(target.href)) continue;
    target.hash = '';

    const title = cleanResultTitle(row.title || row.cardTitle || row.text || row.cardText || titleFromPath(target.href));
    if (!title || title.length < 2 || GENERIC_RESULT_TITLES.test(title)) continue;
    const cardText = plainText(row.cardText || '');
    const contentForMatch = normalizeForSearch(`${title} ${row.text || ''} ${cardText}`);
    const pathForMatch = normalizeForSearch(`${target.pathname} ${target.search}`);
    const contentMatch = terms.some((word) => contentForMatch.includes(word));
    const queryMatch = contentMatch || terms.some((word) => pathForMatch.includes(word));
    const routeMatch = SEARCH_RESULT_ROUTE.test(`${target.pathname}${target.search}`)
      || hasDetailIdentifier(target)
      || Boolean(target.searchParams.get('type') && (target.searchParams.get('id') || target.searchParams.get('tmdb')));
    const explicitMatch = configuredPattern
      ? configuredPattern.test(href) || configuredPattern.test(`${target.pathname}${target.search}`) || configuredPattern.test(target.href)
      : routeMatch;
    const classSignal = Boolean(row.cardLike)
      || /(?:movie|film|title|poster|result|card|catalog|media|entry|tile|item)/i.test(String(row.classes || ''));
    const hasImage = Boolean(row.hasImage || row.poster);
    const searchLanding = !hasDetailIdentifier(target)
      && /(?:^|\/)(?:search|browse)(?:\/|[?#]|$)/i.test(`${target.pathname}${target.search}`);
    // A matching title is a useful signal even on sites with opaque detail
    // routes and plain text links. Never mistake a repeated search/browse link
    // for an item, though; result links there normally carry an explicit id.
    if (searchLanding) continue;
    const resultSignal = routeMatch || classSignal || hasImage || contentMatch;
    if (!explicitMatch && (!queryMatch || !resultSignal)) continue;

    const metadata = normalizeSearchMetadata(row, `${row.text || ''} ${cardText}`);
    const yearText = `${row.year || ''} ${metadata.releaseDate || ''} ${row.title || ''} ${row.cardTitle || ''} ${title} ${row.text || ''} ${cardText}`;
    const yearMatch = /\b((?:19|20)\d{2})\b/.exec(yearText);
    const typeText = `${target.pathname} ${target.searchParams.get('type') || ''} ${row.kind || ''} ${cardText}`;
    const kind = /(?:^|[\s\/_-])(?:tv|series?|serie|shows?|anime)(?:[\s\/_-]|$)/i.test(typeText) ? 'series' : 'movie';
    const posterValue = String(row.poster || '').trim();
    const poster = posterValue && !/^data:/i.test(posterValue) ? resolveUrl(pageUrl, posterValue) : null;
    const result = {
      siteId,
      site: siteName,
      title: title.slice(0, 140),
      year: Number(row.year || yearMatch?.[1]) || null,
      poster,
      kind,
      url: target.toString(),
      ...metadata,
    };
    const score = (Number(row.titleRank) || 0) + (queryMatch ? 2 : 0) + (hasImage ? 1 : 0) + (classSignal ? 1 : 0);
    const previous = found.get(result.url);
    if (!previous) {
      found.set(result.url, { result, score });
    } else {
      const preferred = score > previous.score ? result : previous.result;
      const other = preferred === result ? previous.result : result;
      found.set(result.url, {
        result: {
          ...other,
          ...preferred,
          title: preferred.title || other.title,
          poster: preferred.poster || other.poster,
          year: preferred.year || other.year,
          kind: preferred.kind || other.kind,
          rating: preferred.rating ?? other.rating,
          genres: preferred.genres?.length ? preferred.genres : (other.genres || []),
          runtime: preferred.runtime ?? other.runtime,
          description: preferred.description || other.description,
          releaseDate: preferred.releaseDate || other.releaseDate,
          language: preferred.language || other.language,
        },
        score: Math.max(previous.score, score),
      });
    }
  }
  return [...found.values()].slice(0, limit).map((entry) => entry.result);
}

/**
 * Search a site for a title.
 *
 * Two call styles:
 *   searchSite(site, query)                                  → { results, error }
 *   searchSite({ baseUrl, searchUrl, query, linkPattern })    → { results, error }  (registry style)
 *
 * `searchUrl` may contain {query}/{q}; when it does not, the query is appended.
 * Returns normalised rows {title, url, year, kind, poster, site}.
 */
export async function searchSite(siteOrOpts, maybeQuery) {
  const opts = typeof siteOrOpts === 'string'
    ? { searchUrl: siteOrOpts, query: maybeQuery }
    : { ...siteOrOpts };
  const site = {
    id: opts.id || opts.siteId || safeHost(opts.baseUrl || opts.searchUrl || 'search'),
    name: opts.name || opts.siteName || safeHost(opts.baseUrl || opts.searchUrl || 'site'),
    searchUrl: opts.searchUrl || `${String(opts.baseUrl || '').replace(/\/$/, '')}/search?q={query}`,
    resultPattern: opts.linkPattern || opts.resultPattern || null,
  };
  const query = String(opts.query ?? '').trim();
  if (!query) return { results: [], error: 'empty query' };

  const template = String(site.searchUrl);
  const url = /\{(query|q)\}/.test(template)
    ? template.replace(/\{(query|q)\}/g, encodeURIComponent(query))
    : `${template}${template.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`;

  if (opts.signal?.aborted) throw abortError(opts.signal);
  const ctx = await getContext(site.id);
  if (opts.signal?.aborted) throw abortError(opts.signal);
  const page = await ctx.newPage();
  activePages += 1;
  const closeOnAbort = () => { page.close().catch(() => {}); };
  opts.signal?.addEventListener('abort', closeOnAbort, { once: true });
  if (opts.signal?.aborted) closeOnAbort();
  const results = [];
  let error = null;
  let status = null;
  let pageTitle = null;
  let rawLinkCount = 0;
  let searchPageUrl = url;
  let blockedOffsiteNavigation = null;
  let flareSolverrError = null;
  let usedFlareSolverr = false;
  const selector = opts.linkSelector || 'a[href], [data-href], [data-url], [data-link]';
  const collectRows = async () => page.$$eval(selector, (elements) => {
    const clean = (value) => String(value || '').replace(/[\s\u00a0]+/g, ' ').trim();
    const cardSelector = 'article, [data-movie-id], [class*="movie-card" i], [class*="film-card" i], [class*="result" i], [class*="poster" i], [class*="tile" i], [class*="card" i]';
    const out = [];
    for (const element of elements) {
      const link = element.closest('a[href]');
      const nestedLink = element.querySelector('a[href]');
      const href = element.getAttribute('href')
        || element.getAttribute('data-href')
        || element.getAttribute('data-url')
        || element.getAttribute('data-link')
        || link?.getAttribute('href')
        || nestedLink?.getAttribute('href')
        || '';
      if (!href || href.startsWith('#') || /^(?:javascript|mailto|tel|data):/i.test(href)) continue;

      const card = element.closest(cardSelector) || link || element;
      const image = element.tagName === 'IMG' ? element : element.querySelector('img') || card.querySelector('img');
      const heading = card.querySelector('h1, h2, h3, h4, h5, h6, [data-title], [class*="title" i], strong, b');
      const text = clean(element.innerText || element.textContent || '');
      const cardText = clean(card.innerText || card.textContent || '').slice(0, 700);
      const dataValue = (names) => {
        for (const node of [element, card]) {
          for (const name of names) {
            const value = node?.getAttribute(name);
            if (value) return value;
          }
        }
        return null;
      };
      const ratingNode = card.querySelector('[data-rating], [class*="rating" i], [aria-label*="rating" i], [class*="score" i]');
      const rating = dataValue(['data-rating', 'data-vote-average', 'data-imdb-rating'])
        || ratingNode?.getAttribute('data-rating')
        || ratingNode?.getAttribute('aria-label')
        || ratingNode?.innerText
        || null;
      const genreNodes = [...card.querySelectorAll('[data-genre], [data-genres], [data-category], [class*="genre" i]')].slice(0, 8);
      const genres = genreNodes.map((node) => node.getAttribute('data-genres')
        || node.getAttribute('data-genre')
        || node.getAttribute('data-category')
        || node.innerText
        || node.textContent
        || '').filter(Boolean);
      const descriptionNode = card.querySelector('[data-overview], [data-description], [data-synopsis], [class*="overview" i], [class*="synopsis" i], [class*="description" i]');
      const description = dataValue(['data-overview', 'data-description', 'data-synopsis'])
        || descriptionNode?.getAttribute('data-overview')
        || descriptionNode?.getAttribute('data-description')
        || descriptionNode?.getAttribute('data-synopsis')
        || descriptionNode?.innerText
        || null;
      const runtimeNode = card.querySelector('[data-runtime], [data-duration], [class*="runtime" i], [class*="duration" i]');
      const runtime = dataValue(['data-runtime', 'data-duration'])
        || runtimeNode?.getAttribute('data-runtime')
        || runtimeNode?.getAttribute('data-duration')
        || runtimeNode?.innerText
        || null;
      const releaseNode = card.querySelector('time[datetime], [data-release-date], [data-air-date]');
      const releaseDate = dataValue(['data-release-date', 'data-air-date'])
        || releaseNode?.getAttribute('datetime')
        || releaseNode?.getAttribute('data-release-date')
        || releaseNode?.getAttribute('data-air-date')
        || null;
      const language = dataValue(['data-language', 'data-original-language']);
      const titleCandidates = [
        [element.getAttribute('data-title'), 5],
        [card.getAttribute('data-title'), 5],
        [heading?.innerText || heading?.textContent, 4],
        [element.getAttribute('title'), 3],
        [image?.getAttribute('alt') || image?.getAttribute('title'), 2],
        [element.getAttribute('aria-label'), 1],
        [text, 0],
        [cardText, 0],
      ];
      const plausibleTitles = titleCandidates
        .map(([value, rank]) => [clean(value), rank])
        .filter(([candidate]) => candidate.length >= 2
          && !/^(?:home|movies?|films?|tv|series?|shows?|search|browse|login|register|watch|watch now|play|details|more)$/i.test(candidate));
      const titleQuality = ([candidate, rank]) => {
        const words = candidate.toLowerCase().match(/[a-z0-9]+/g) || [];
        const duplicatedWords = words.length - new Set(words).size;
        const years = candidate.match(/\b(?:19|20)\d{2}\b/g)?.length || 0;
        const ratings = candidate.match(/\b\d{1,2}\.\d\b/g)?.length || 0;
        const badges = candidate.match(/\b(?:HD|4K|1080p|720p|NEW|SOON)\b/gi)?.length || 0;
        return rank * 100 - candidate.length * 1.4 - years * 60 - ratings * 35 - badges * 20 - duplicatedWords * 30;
      };
      plausibleTitles.sort((a, b) => titleQuality(b) - titleQuality(a));
      const [title, titleRank] = plausibleTitles[0] || ['', 0];
      const classes = [element, element.parentElement, element.parentElement?.parentElement]
        .map((node) => typeof node?.className === 'string' ? node.className : '')
        .join(' ')
        .slice(0, 400);
      const explicitPoster = [element, card]
        .flatMap((node) => ['data-poster', 'data-image', 'data-thumbnail', 'data-thumb', 'data-src', 'data-lazy-src']
          .map((name) => node?.getAttribute(name)))
        .find((value) => value && !/^(?:data|blob):/i.test(value));
      const imageUrls = [
        image?.getAttribute('data-src'),
        image?.getAttribute('data-lazy-src'),
        image?.getAttribute('data-original'),
        image?.getAttribute('src'),
        image?.currentSrc,
        image?.getAttribute('srcset')?.split(',')[0]?.trim().split(/\s+/)[0],
      ].filter((value) => value && !/^(?:data|blob):/i.test(value));
      const backgroundNode = [image, element, card].find((node) => {
        if (!node) return false;
        return /url\(/i.test(getComputedStyle(node).backgroundImage);
      });
      const backgroundImage = backgroundNode
        ? [...getComputedStyle(backgroundNode).backgroundImage.matchAll(/url\((?:["']?)(.*?)["']?\)/gi)][0]?.[1]
        : null;
      const poster = explicitPoster || imageUrls[0] || backgroundImage || null;
      const year = (cardText.match(/\b((?:19|20)\d{2})\b/) || [])[1] || null;
      const kind = element.getAttribute('data-type')
        || element.getAttribute('data-media-type')
        || card.getAttribute('data-type')
        || card.getAttribute('data-media-type')
        || '';
      out.push({
        href,
        title: clean(title),
        titleRank,
        text: text.slice(0, 500),
        cardText,
        classes,
        cardLike: card !== element || /(?:movie|film|title|poster|result|card|tile|item)/i.test(classes),
        hasImage: Boolean(image),
        poster,
        year,
        kind,
        rating,
        genres,
        runtime,
        description: description ? clean(description).slice(0, 700) : null,
        releaseDate,
        language,
      });
      if (out.length >= 1500) break;
    }
    return out;
  }).catch(() => []);

  // Flixer-clone sites (1flex, cinezo, …) routinely fire ad pop-under scripts
  // that replace the page with youtube.com / random ad landers within a few
  // hundred ms of load. We intercept that navigation, but Chromium then shows
  // an ERR_BLOCKED_BY_CLIENT error page and the original DOM is gone. To avoid
  // losing results we snapshot links as soon as domcontentloaded fires, and we
  // retry the navigation once after an intercepted off-site redirect (the pop
  // script usually only fires on the first load of a fresh tab).
  let earlyRows = [];
  let earlyRowsCaptured = false;
  const captureEarlyRows = async () => {
    if (earlyRowsCaptured) return;
    earlyRowsCaptured = true;
    const snapshot = await collectRows().catch(() => []);
    if (snapshot.length > 0) {
      earlyRows = snapshot;
      log.debug('browser', `${site.name}: captured ${snapshot.length} link(s) at domcontentloaded (pre-hydration)`);
    }
  };
  page.on('domcontentloaded', () => { captureEarlyRows().catch(() => {}); });

  /**
   * Quick liveness probe for FlareSolverr so we can tell the operator
   * "FlareSolverr is not reachable at http://…" instead of showing the generic
   * "no usable result links" message against a Cloudflare interstitial.
   */
  const probeFlareSolverr = () => probeFlareSolverrHealth({ timeoutMs: 3000, signal: opts.signal });

  const performSearchNavigation = async (navUrl, { attempt = 1 } = {}) => page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch((err) => {
    if (opts.signal?.aborted) throw abortError(opts.signal);
    if (blockedOffsiteNavigation) {
      log.warn('browser', `${site.name} search navigation hit an off-site redirect (attempt ${attempt})`, {
        destination: safeHost(blockedOffsiteNavigation), error: err.message,
      });
      return null;
    }
    throw err;
  });

  try {
    log.info('browser', `searching ${site.name} for "${query}"`, { url: url.slice(0, 200) });
    await page.route('**/*', async (route) => {
      const pageRequest = route.request();
      if (pageRequest.isNavigationRequest()) {
        try {
          if (pageRequest.frame() === page.mainFrame() && !isSameSiteNavigation(pageRequest.url(), url)) {
            blockedOffsiteNavigation ||= pageRequest.url();
            log.warn('browser', `blocked off-site redirect during ${site.name} search`, {
              destination: safeHost(pageRequest.url()),
            });
            await route.abort('blockedbyclient');
            return;
          }
        } catch { /* the navigation frame may already have been detached */ }
      }
      await route.continue().catch(() => {});
    });

    let response = await performSearchNavigation(url);
    if (opts.signal?.aborted) throw abortError(opts.signal);

    // If the first navigation was torpedoed by a pop-under *before* our
    // domcontentloaded snapshot had a chance to run, blank the tab and try once
    // more — ad scripts usually only fire on the first page load of a tab.
    if (blockedOffsiteNavigation && earlyRows.length === 0) {
      log.info('browser', `${site.name}: reloading search page once after blocked off-site redirect`);
      earlyRowsCaptured = false;
      blockedOffsiteNavigation = null;
      await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
      response = await performSearchNavigation(url, { attempt: 2 });
      if (opts.signal?.aborted) throw abortError(opts.signal);
    }

    status = response?.status?.() ?? null;
    if (isSameSiteNavigation(page.url(), url)) searchPageUrl = page.url();

    pageTitle = await page.title().catch(() => null);
    let initialBodyText = '';
    const challengePage = () => /cloudflare|just a moment|security verification|verify you are human|checking your browser|captcha/i
      .test(`${pageTitle || ''} ${initialBodyText.slice(0, 500)}`);
    if (status === 403 || status === 429 || challengePage()) {
      initialBodyText = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
      if (challengePage()) {
        const solverProbe = await probeFlareSolverr();
        if (solverProbe.configured && !solverProbe.ok) {
          // solverProbe.error is already a full "cause + what to do" sentence
          // (see describeFlareSolverrError) — don't wrap it in a second guess.
          flareSolverrError = solverProbe.error;
          log.warn('browser', `FlareSolverr liveness probe failed for ${site.name}`, { error: flareSolverrError });
        } else if (solverProbe.configured && solverProbe.ok) {
          try {
            log.info('browser', `trying FlareSolverr for ${site.name} search`, { host: safeHost(url), status, solver: solverProbe.version });
            const solution = await requestFlareSolverr(url, { signal: opts.signal });
            if (opts.signal?.aborted) throw abortError(opts.signal);
            const cookies = flareSolverrCookies(solution.cookies, solution.url);
            if (cookies.length) {
              await ctx.addCookies(cookies).catch((cErr) => {
                log.warn('browser', `could not import FlareSolverr cookies for ${site.name}`, { error: cErr.message });
              });
            }
            // Search only needs the rendered DOM. Strip scripts so the returned
            // third-party HTML cannot navigate or run twice in our context.
            const staticHtml = solution.html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
            await page.setContent(staticHtml, { waitUntil: 'domcontentloaded', timeout: 20_000 });
            searchPageUrl = solution.url;
            status = solution.status ?? status;
            pageTitle = await page.title().catch(() => null);
            initialBodyText = '';
            usedFlareSolverr = true;
            log.info('browser', `FlareSolverr returned ${site.name} search page`, {
              status, cookies: cookies.length, url: searchPageUrl.slice(0, 180),
            });
          } catch (err) {
            if (opts.signal?.aborted || err?.name === 'AbortError') throw abortError(opts.signal);
            flareSolverrError = String(err?.message || err);
            log.warn('browser', `FlareSolverr could not recover ${site.name} search`, { error: flareSolverrError });
          }
        } else {
          flareSolverrError = describeSolverNotUsable(solverProbe, safeHost(url));
          log.warn('browser', `${site.name} blocked by bot protection and FlareSolverr is not usable`, {
            flaresolverr: flareSolverrError,
          });
        }
      }
    }

    if (!usedFlareSolverr) {
      // Client-rendered catalogues need a moment after networkidle to hydrate cards.
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
      if (opts.signal?.aborted) throw abortError(opts.signal);
      await sleep(1200);
      if (opts.signal?.aborted) throw abortError(opts.signal);
    }

    const currentPageUrl = page.url();
    if (!usedFlareSolverr && isSameSiteNavigation(currentPageUrl, url)) searchPageUrl = currentPageUrl;
    else if (!usedFlareSolverr && currentPageUrl !== 'about:blank' && !isSameSiteNavigation(currentPageUrl, url)) {
      blockedOffsiteNavigation ||= currentPageUrl;
    }
    const rows = await collectRows();
    if (opts.signal?.aborted) throw abortError(opts.signal);
    rawLinkCount = rows.length;
    // Merge in the pre-hydration snapshot. If the live DOM was torn down by an
    // intercepted ad-redirect, rows may be empty while earlyRows still has the
    // real results. De-dupe happens by URL inside normalizeSearchRows (Map),
    // but we also seed with the later/hydrated rows first because they have
    // richer metadata (lazy posters, year, rating).
    const mergedRows = [...rows];
    if (earlyRows.length && earlyRows.length > rows.length) {
      log.debug('browser', `${site.name}: using pre-hydration snapshot to supplement results`, {
        liveRows: rows.length, earlyRows: earlyRows.length,
      });
      for (const row of earlyRows) mergedRows.push(row);
    }
    results.push(...normalizeSearchRows(mergedRows, {
      pageUrl: searchPageUrl,
      baseUrl: opts.baseUrl || url,
      query,
      resultPattern: site.resultPattern,
      siteId: site.id,
      siteName: site.name,
      limit: 40,
    }));
    pageTitle = await page.title().catch(() => pageTitle);

    if (results.length) {
      log.info('browser', `${site.name}: ${results.length} result(s) for "${query}"`, {
        status, links: rawLinkCount, finalUrl: searchPageUrl.slice(0, 180),
        ...(blockedOffsiteNavigation ? { blockedRedirect: safeHost(blockedOffsiteNavigation) } : {}),
      });
    } else {
      const bodyText = await page.locator('body').innerText({ timeout: 1500 }).catch(() => initialBodyText);
      const pageLooksUnavailable = status >= 400
        || /\b404\b|page not found|does not exist|bad gateway|just a moment|security verification|verify you are human|access denied|captcha/i.test(`${pageTitle || ''} ${bodyText.slice(0, 500)}`);
      if (blockedOffsiteNavigation) {
        error = `search page redirected off-site to ${safeHost(blockedOffsiteNavigation)} (likely a pop-under/ad script); the site may be parked, dead, or behind a captcha`;
      } else if (pageLooksUnavailable) {
        error = `search page unavailable${status ? ` (HTTP ${status})` : ''}${pageTitle ? `: ${pageTitle}` : ''}`;
      } else if (rawLinkCount > 0) {
        error = `search page exposed ${rawLinkCount} candidate link(s), but none matched the result filters`;
      }
      if (flareSolverrError) {
        // The FlareSolverr message is the most actionable hint we have — make
        // sure it surfaces even when no other error branch fired (e.g. the page
        // rendered an empty body after a bot challenge we couldn't solve).
        error = error ? `${error}; ${flareSolverrError}` : flareSolverrError;
      }
      log.warn('browser', `${site.name}: no usable result links for "${query}"`, {
        status, title: pageTitle, links: rawLinkCount,
        finalUrl: searchPageUrl.slice(0, 180),
        ...(blockedOffsiteNavigation ? { blockedRedirect: safeHost(blockedOffsiteNavigation) } : {}),
        preview: bodyText.slice(0, 180).replace(/\s+/g, ' '),
        ...(flareSolverrError ? { flareSolverrError } : {}),
      });
    }
  } catch (err) {
    if (opts.signal?.aborted || err?.name === 'AbortError') throw abortError(opts.signal);
    error = err.message;
    log.error('browser', `search failed on ${site.name}: ${err.message}`);
  } finally {
    opts.signal?.removeEventListener('abort', closeOnAbort);
    activePages -= 1;
    await page.close().catch(() => {});
    scheduleIdleClose();
  }
  return { results, error, site: { id: site.id, name: site.name }, url };
}

function scheduleIdleClose() {
  const idleSeconds = Number(getConfig().scraper.browserIdleSeconds) || 180;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (activePages > 0) { scheduleIdleClose(); return; }
    log.info('browser', `closing Chromium after ${idleSeconds}s of inactivity (frees ~300 MB)`);
    closeBrowser('idle timeout').catch(() => {});
  }, idleSeconds * 1000);
}

export async function closeBrowser(reason = 'shutdown') {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!browser) return;
  log.info('browser', `closing Chromium (${reason})`);
  try { await browser.close(); } catch (err) { log.warn('browser', `close failed: ${err.message}`); }
  browser = null;
  contexts.clear();
}

/** Path of a per-site storage-state file (used by the recipes that need login). */
/**
 * Lightweight API fetch via Chromium's network stack (BoringSSL).
 *
 * When the container's Node TLS stack is fingerprinted/blocked but the
 * host is reachable from a browser, this reissues the same signed request
 * through Chromium. It uses a dedicated browser context with
 * ignoreHTTPSErrors so a forced HTTP proxy CA can be used, and it avoids
 * polluting the per-site cookie jars.
 *
 * Returns a shape compatible with `request()` from http.js: {ok,status,headers,data,error}
 * or throws on transport failure. Uses Playwright's APIRequestContext when
 * available, otherwise falls back to page.evaluate(fetch).
 */
export async function fetchViaBrowser(url, { method = 'GET', headers = {}, body = null, timeoutMs = 12000 } = {}) {
  const started = Date.now();
  let context = null;
  let page = null;
  try {
    const b = await getBrowser();
    const proxyUrl = (() => {
      try { return getConfig()?.scraper?.proxyUrl || ''; } catch { return ''; }
    })() || process.env.MOVIEBOX_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
    const contextOpts = {
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    };
    if (proxyUrl) {
      try {
        const u = new URL(proxyUrl);
        // Chromium expects --proxy-server already, but context-level proxy is more reliable.
        contextOpts.proxy = { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username || ''), password: decodeURIComponent(u.password || '') };
        // strip empty creds
        if (!contextOpts.proxy.username) delete contextOpts.proxy.username;
        if (!contextOpts.proxy.password) delete contextOpts.proxy.password;
      } catch { /* ignore malformed proxy */ }
    }
    // Try APIRequestContext first (no page, lighter)
    if (b.request?.newContext) {
      try {
        const api = await b.request.newContext({ ...contextOpts, extraHTTPHeaders: headers });
        const res = await api.fetch(url, { method, headers, data: body || undefined, timeout: timeoutMs });
        const status = res.status();
        const rawHeaders = await res.headersArray();
        const headerMap = Object.fromEntries(rawHeaders.map((h) => [h.name.toLowerCase(), h.value]));
        const text = await res.text().catch(() => '');
        let data = null;
        let error = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        if (!res.ok()) error = String(data?.error || data?.message || text || `HTTP ${status}`).slice(0, 240);
        if (status >= 200 && status < 300 && data == null && text && text.trim().startsWith('<')) {
          // WAF HTML page that slipped through as 2xx
          return { ok: false, status, headers: headerMap, data: null, error: `HTTP 200 from ${safeHost(url)} but the body was not JSON (browser)` };
        }
        log.debug('browser', `API via browser ${method} ${safeHost(url)} → ${status} (${Date.now() - started}ms)`);
        await api.dispose().catch(() => {});
        return { ok: res.ok(), status, headers: headerMap, data, text, error: error || (res.ok() ? null : `HTTP ${status}`) };
      } catch (err) {
        log.debug('browser', `APIRequestContext path failed for ${safeHost(url)}: ${err.message} — falling back to page.evaluate`);
        // fall through to page method
      }
    }
    // Fallback: dedicated context + page.evaluate(fetch)
    context = await b.newContext({ ...contextOpts, viewport: { width: 800, height: 600 } });
    page = await context.newPage();
    const result = await page.evaluate(async ({ url: u, method: m, headers: h, body: bdy, timeoutMs: tm }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), tm);
      try {
        const res = await fetch(u, { method: m, headers: h, body: bdy || undefined, signal: controller.signal });
        const text = await res.text();
        const headersObj = {};
        res.headers.forEach((v, k) => { headersObj[k.toLowerCase()] = v; });
        return { ok: res.ok, status: res.status, statusText: res.statusText, headers: headersObj, text };
      } finally { clearTimeout(timer); }
    }, { url, method, headers, body, timeoutMs });
    const text = result.text || '';
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    let error = null;
    if (!result.ok) error = String(data?.error || data?.message || text || `HTTP ${result.status}`).slice(0, 240);
    if (result.ok && data == null && text && text.trim().startsWith('<')) {
      return { ok: false, status: result.status, headers: result.headers, data: null, error: `HTTP 200 from ${new URL(url).hostname} but the body was not JSON (browser)` };
    }
    log.debug('browser', `API via page.evaluate ${method} ${safeHost(url)} → ${result.status} (${Date.now() - started}ms)`);
    return { ok: result.ok, status: result.status, headers: result.headers, data, text, error: error || (result.ok ? null : `HTTP ${result.status}`) };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

export function sessionFile(siteId) {
  return path.join(getConfig().scraper.sessionDir || getConfig().storage.tmp, `${siteId}.state.json`);
}

export function hasSession(siteId) {
  return fs.existsSync(sessionFile(siteId));
}

export default {
  getBrowser, sniff, searchSite, browserInfo, closeBrowser, closeContexts,
  flaresolverrStatus, describeSolverBootState,
  sessionFile, hasSession,
};
