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
import { log, logError } from '../core/log.js';
import { getConfig } from '../core/config.js';
import { sleep, safeHost, resolveUrl } from './http.js';
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
  'application/octet-stream',
];
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
  const ctx = await b.newContext({
    userAgent,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'Europe/Amsterdam',
    ignoreHTTPSErrors: true,
    bypassCSP: true,
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9,nl;q=0.8' },
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

function looksLikeMedia(url, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (MEDIA_CONTENT_TYPES.some((t) => ct.includes(t.toLowerCase()))) return true;
  return MEDIA_PATTERNS.some((p) => p.re.test(url));
}

function kindOf(url, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (/mpegurl/.test(ct) || /\.m3u8/i.test(url)) return 'hls';
  if (/dash\+xml/.test(ct) || /\.mpd/i.test(url)) return 'dash';
  if (/mp2t/.test(ct) || /\.ts(\?|#|$)/i.test(url)) return 'segment';
  return 'file';
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
  const consoleErrors = [];
  const failedDocumentRequests = [];

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
        if (!request.isNavigationRequest() || request.frame() !== p.mainFrame()) return;
        const failure = request.failure() || 'document request failed';
        failedDocumentRequests.push({ host: safeHost(request.url()), error: String(failure).slice(0, 180) });
      } catch { /* a closed popup may no longer have a frame */ }
    });
    p.on('response', async (res) => {
      const u = res.url();
      const ct = res.headers()['content-type'] || '';
      if (looksLikeMedia(u, ct)) {
        if (!media.has(u)) {
          const req = res.request();
          let reqHeaders;
          try { reqHeaders = await req.allHeaders(); } catch { reqHeaders = req.headers(); }
          const kind = kindOf(u, ct);
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
      } else if (captureJson && /application\/json|text\/json/i.test(ct) && media.size === 0) {
        const len = Number(res.headers()['content-length'] || 0);
        if (len && len < 600_000) {
          apis.set(u, { url: u, status: res.status(), at: new Date().toISOString() });
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
    let lastCount = 0;
    let lastChange = Date.now();
    let aggressivePlayRetried = false;
    while (Date.now() - started < timeoutMs) {
      if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const count = media.size + apis.size;
      if (count !== lastCount) { lastCount = count; lastChange = Date.now(); }
      if (media.size > 0 && Date.now() - lastChange > quietMs) break;
      if (!aggressivePlayRetried && media.size === 0 && Date.now() - started > Math.min(timeoutMs, 12_000)) {
        aggressivePlayRetried = true;
        await nudgePlay(page, true);
      }
      await sleep(250);
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
      result.note = navigationError
        ? `page navigation did not complete: ${navigationError}`
        : 'no media response observed — the page may need a click, a login, or a different player URL';
      log.warn('browser', `no media found on ${safeHost(url)} after ${Date.now() - started} ms`, {
        finalUrl: result.finalUrl.slice(0, 200),
        title: result.title,
        navigationError,
        failedRequests: result.networkErrors,
        consoleErrors: consoleErrors.slice(0, 3),
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

const SEARCH_RESULT_ROUTE = /(?:^|\/)(?:movies?|films?|tv|series?|serie|shows?|watch|titles?|details?|play)(?:\/|\.html|$)/i;
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
    const textForMatch = normalizeForSearch(`${title} ${row.text || ''} ${cardText} ${target.pathname}`);
    const queryMatch = terms.some((word) => textForMatch.includes(word));
    const routeMatch = SEARCH_RESULT_ROUTE.test(target.pathname)
      || Boolean(target.searchParams.get('type') && (target.searchParams.get('id') || target.searchParams.get('tmdb')));
    const explicitMatch = configuredPattern
      ? configuredPattern.test(href) || configuredPattern.test(`${target.pathname}${target.search}`) || configuredPattern.test(target.href)
      : routeMatch;
    const classSignal = Boolean(row.cardLike)
      || /(?:movie|film|title|poster|result|card|catalog|media|entry|tile|item)/i.test(String(row.classes || ''));
    const hasImage = Boolean(row.hasImage || row.poster);
    // Search results should mention at least one query term. Explicit recipe
    // matches can still be accepted for sites that rewrite titles in the URL.
    if (!explicitMatch && !(queryMatch && (routeMatch || classSignal || hasImage))) continue;
    if (!explicitMatch && !queryMatch) continue;

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

  try {
    log.info('browser', `searching ${site.name} for "${query}"`, { url: url.slice(0, 200) });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    if (opts.signal?.aborted) throw abortError(opts.signal);
    status = response?.status?.() ?? null;
    // Client-rendered catalogues need a moment after networkidle to hydrate cards.
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    if (opts.signal?.aborted) throw abortError(opts.signal);
    await sleep(1200);
    if (opts.signal?.aborted) throw abortError(opts.signal);

    const rows = await collectRows();
    if (opts.signal?.aborted) throw abortError(opts.signal);
    rawLinkCount = rows.length;
    results.push(...normalizeSearchRows(rows, {
      pageUrl: page.url(),
      baseUrl: opts.baseUrl || url,
      query,
      resultPattern: site.resultPattern,
      siteId: site.id,
      siteName: site.name,
      limit: 40,
    }));
    pageTitle = await page.title().catch(() => null);

    if (results.length) {
      log.info('browser', `${site.name}: ${results.length} result(s) for "${query}"`, {
        status, links: rawLinkCount, finalUrl: page.url().slice(0, 180),
      });
    } else {
      const bodyText = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
      const pageLooksUnavailable = status >= 400
        || /\b404\b|page not found|does not exist|bad gateway|just a moment|verify you are human|access denied|captcha/i.test(`${pageTitle || ''} ${bodyText.slice(0, 500)}`);
      if (pageLooksUnavailable) {
        error = `search page unavailable${status ? ` (HTTP ${status})` : ''}${pageTitle ? `: ${pageTitle}` : ''}`;
      }
      log.warn('browser', `${site.name}: no usable result links for "${query}"`, {
        status, title: pageTitle, links: rawLinkCount, finalUrl: page.url().slice(0, 180),
        preview: bodyText.slice(0, 180).replace(/\s+/g, ' '),
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
export function sessionFile(siteId) {
  return path.join(getConfig().scraper.sessionDir || getConfig().storage.tmp, `${siteId}.state.json`);
}

export function hasSession(siteId) {
  return fs.existsSync(sessionFile(siteId));
}

export default {
  getBrowser, sniff, searchSite, browserInfo, closeBrowser, closeContexts,
  sessionFile, hasSession,
};
