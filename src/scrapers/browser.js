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

  const ctx = await getContext(opts.session);
  const page = await ctx.newPage();
  activePages += 1;

  const media = new Map(); // url → record
  const apis = new Map();
  const consoleErrors = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err.message).slice(0, 200)));

  // Catch pop-ups: many players open the stream in a new tab.
  ctx.on('page', (popup) => {
    attach(popup);
  });

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

  function attach(p) {
    p.on('response', (res) => {
      const u = res.url();
      const ct = res.headers()['content-type'] || '';
      if (looksLikeMedia(u, ct)) {
        if (!media.has(u)) {
          const req = res.request();
          const reqHeaders = { ...req.headers() };
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
    consoleErrors, ms: 0, note: null,
  };

  try {
    log.info('browser', `sniffing ${safeHost(url)}`, { url: url.slice(0, 200), session: opts.session || 'default' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 30_000) })
      .catch((err) => log.warn('browser', `navigation issue for ${safeHost(url)}: ${err.message}`));

    if (opts.click !== false) await nudgePlay(page);

    // Wait until we have media AND the page has been quiet for `quietMs`.
    let lastCount = 0;
    let lastChange = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const count = media.size + apis.size;
      if (count !== lastCount) { lastCount = count; lastChange = Date.now(); }
      if (media.size > 0 && Date.now() - lastChange > quietMs) break;
      if (media.size === 0 && Date.now() - started > Math.min(timeoutMs, 12_000)) {
        // one more attempt: click every play control we can find
        await nudgePlay(page, true);
      }
      await sleep(250);
    }

    result.finalUrl = page.url();
    result.title = await page.title().catch(() => null);
    result.media = [...media.values()];
    result.apis = [...apis.values()];
    result.hls = result.media.filter((m) => m.kind === 'hls');
    result.html = opts.withHtml ? await page.content().catch(() => '') : null;
    result.ok = result.media.length > 0;
    if (!result.ok) {
      result.note = 'no media response observed — the page may need a click, a login, or a different player URL';
      log.warn('browser', `no media found on ${safeHost(url)} after ${Date.now() - started} ms`,
        { consoleErrors: consoleErrors.slice(0, 3) });
    }
  } catch (err) {
    result.error = err.message;
    log.error('browser', `sniffer failed on ${safeHost(url)}: ${err.message}`);
  } finally {
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
      if (!visible && !aggressive) continue;
      await el.click({ timeout: 1200, force: true });
      log.debug('browser', `clicked play control: ${sel}`);
      await sleep(aggressive ? 400 : 900);
      if (!aggressive) return;
    } catch { /* selector not clickable — try the next one */ }
  }
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

  const ctx = await getContext(site.id);
  const page = await ctx.newPage();
  activePages += 1;
  const results = [];
  let error = null;
  try {
    log.info('browser', `searching ${site.name} for "${query}"`, { url: url.slice(0, 200) });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    // Client-side rendered catalogues need a moment; wait for links to appear.
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await sleep(1200);

    const pattern = site.resultPattern ? new RegExp(site.resultPattern, 'i') : /\/(movie|film|watch|tv|series?|title)\//i;
    const selector = opts.linkSelector || 'a[href]';
    const rows = await page.$$eval(selector, (anchors, patternSource) => {
      const re = new RegExp(patternSource, 'i');
      const out = [];
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
        if (!re.test(href)) continue;
        const img = a.querySelector('img');
        out.push({
          href, text,
          poster: img?.getAttribute('src') || img?.getAttribute('data-src') || null,
          year: (text.match(/\b(19|20)\d{2}\b/) || [null])[0],
        });
      }
      return out.slice(0, 120);
    }, pattern.source).catch(() => []);

    const seen = new Set();
    for (const row of rows) {
      const abs = resolveUrl(page.url(), row.href);
      if (seen.has(abs)) continue;
      seen.add(abs);
      const title = (row.text || abs.split('/').filter(Boolean).pop() || '')
        .replace(/\s*\(\d{4}\)\s*$/, '').replace(/\.(html?|php)$/i, '').replace(/[-_]+/g, ' ').trim();
      if (!title || title.length < 2) continue;
      results.push({
        siteId: site.id, site: site.name,
        title: title.slice(0, 140),
        year: row.year ? Number(row.year) : null,
        poster: row.poster ? resolveUrl(page.url(), row.poster) : null,
        kind: /\/(tv|series|serie|show)/i.test(abs) ? 'series' : 'movie',
        url: abs,
      });
      if (results.length >= 40) break;
    }
    log.info('browser', `${site.name}: ${results.length} result(s) for "${query}"`);
  } catch (err) {
    error = err.message;
    log.error('browser', `search failed on ${site.name}: ${err.message}`);
  } finally {
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
