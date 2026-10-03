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
import { log, logError, errorText } from '../core/log.js';
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

export function looksLikeMedia(url, contentType, resourceType = '') {
  const target = String(url || '');
  const ct = String(contentType || '').toLowerCase();
  // Some CDNs mislabel fonts as application/octet-stream; they are not video
  // candidates even though their MIME type otherwise looks like binary media.
  if (resourceType === 'font' || FONT_FILE_PATTERN.test(target)) return false;
  if (MEDIA_CONTENT_TYPES.some((t) => ct.includes(t.toLowerCase()))) return true;
  if (/^application\/octet-stream(?:\s*;|$)/i.test(ct)) {
    return resourceType === 'media' || MEDIA_PATTERNS.some((pattern) => pattern.re.test(target));
  }
  return MEDIA_PATTERNS.some((pattern) => pattern.re.test(target));
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
      if (looksLikeMedia(u, ct, req.resourceType())) {
        if (!media.has(u)) {
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

/** Normalize the optional FlareSolverr URL to its v1 API endpoint. */
export function flaresolverrEndpoint(value = getConfig().scraper.flaresolverrUrl) {
  const configured = String(value || '').trim();
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

async function requestFlareSolverr(url, { signal = null } = {}) {
  const endpoint = flaresolverrEndpoint();
  if (!endpoint) return null;
  const response = await request(endpoint, {
    method: 'POST',
    body: { cmd: 'request.get', url, maxTimeout: 30_000 },
    json: true,
    allowFailure: true,
    timeoutMs: 35_000,
    retries: 0,
    signal,
  });
  if (!response.ok) throw new Error(response.error || `FlareSolverr HTTP ${response.status}`);
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
  async function probeFlareSolverr() {
    const endpoint = flaresolverrEndpoint();
    if (!endpoint) return { configured: false };
    try {
      const healthUrl = endpoint.replace(/\/v1$/, '/health');
      const probe = await request(healthUrl, { method: 'GET', timeoutMs: 3000, retries: 0, json: true, allowFailure: true });
      if (probe.ok) return { configured: true, ok: true, version: probe.data?.version || probe.data?.message || 'ok' };
      if (probe.status === 404) return { configured: true, ok: true, version: 'unknown (no /health endpoint)' };
      return { configured: true, ok: false, error: `HTTP ${probe.status}` };
    } catch (err) {
      return { configured: true, ok: false, error: errorText(err) };
    }
  }

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
          flareSolverrError = `FlareSolverr is configured at ${flaresolverrEndpoint()} but unreachable (${solverProbe.error}) — start the flaresolverr container or fix FLARESOLVERR_URL`;
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
          flareSolverrError = `${safeHost(url)} is showing a Cloudflare / bot challenge, but FLARESOLVERR_URL is not configured — set it (see docker-compose.yml) or visit the site manually once to get a clearance cookie`;
          log.warn('browser', `${site.name} blocked by bot protection and FlareSolverr is not configured`);
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
