/**
 * Plain HTTP helper used everywhere outside the browser.
 *
 * Deliberately built on Node's global fetch: no dependencies, HTTP/2 capable,
 * and it honours the per-site cookie jars we persist in CONFIG/sessions so that
 * Cloudflare/JS challenges solved once in Chromium can be reused by plain
 * requests (that is what makes the "3 layer" scraper workable).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../core/config.js';
import { errorText, log } from '../core/log.js';

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Lazy ProxyAgent cache — one entry per proxy URL. undici.ProxyAgent handles
 * http/https and respects the proxy's own NO_PROXY list, but we also filter
 * loopback hosts ourselves so a misconfigured proxy does not break healthchecks.
 */
let ProxyAgentCtor = null;
let proxyAgentCache = new Map(); // proxyUrl → ProxyAgent | null (null = tried and failed)
let proxyWarningLogged = false;

async function getProxyAgentCtor() {
  if (ProxyAgentCtor !== null) return ProxyAgentCtor;
  try {
    const undici = await import('undici');
    ProxyAgentCtor = undici.ProxyAgent || null;
  } catch {
    ProxyAgentCtor = null;
  }
  return ProxyAgentCtor;
}

function proxyUrlForRequest() {
  try {
    const cfg = getConfig?.();
    const fromCfg = cfg?.scraper?.proxyUrl;
    if (fromCfg) return String(fromCfg).trim();
  } catch { /* config not ready (build-time import) */ }
  return String(
    process.env.MOVIEBOX_PROXY
    || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy
    || '',
  ).trim();
}

function noProxyList() {
  try {
    const cfg = getConfig?.();
    if (cfg?.scraper?.noProxy) return String(cfg.scraper.noProxy);
  } catch { /* ignore */ }
  return String(process.env.NO_PROXY || process.env.no_proxy || 'localhost,127.0.0.1,::1');
}

export function shouldProxy(targetUrl) {
  const proxyUrl = proxyUrlForRequest();
  if (!proxyUrl) return false;
  let host = '';
  try { host = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  // Internal service names — Docker Compose (`flaresolverr`, `db`) and
  // Kubernetes (`flaresolverr.default.svc` aside, most are single-label) —
  // resolve through local cluster DNS only. A forward proxy cannot resolve
  // them, and the whole point of the proxy is *outbound* traffic, so they
  // bypass it even when NO_PROXY does not list them. Without this, setting
  // MOVIEBOX_PROXY / HTTP_PROXY (which this project recommends for the
  // MovieBox TLS block) silently breaks container-to-container calls such as
  // the FlareSolverr request.
  if (host && !host.includes('.')) return false;
  const noProxy = noProxyList().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const pattern of noProxy) {
    const p = pattern.replace(/^\./, '');
    if (host === p || host.endsWith(`.${p}`) || host.endsWith(p)) return false;
    if (pattern === '*') return false;
  }
  return true;
}

async function dispatcherFor(url) {
  if (!shouldProxy(url)) return undefined;
  const proxyUrl = proxyUrlForRequest();
  if (!proxyUrl) return undefined;
  if (proxyAgentCache.has(proxyUrl)) return proxyAgentCache.get(proxyUrl) || undefined;
  const Ctor = await getProxyAgentCtor();
  if (!Ctor) {
    if (!proxyWarningLogged) {
      proxyWarningLogged = true;
      log.warn('http', 'proxy configured but undici.ProxyAgent is unavailable — requests will go direct; install undici');
    }
    proxyAgentCache.set(proxyUrl, null);
    return undefined;
  }
  try {
    const agent = new Ctor(proxyUrl);
    proxyAgentCache.set(proxyUrl, agent);
    log.info('http', `using proxy for ${safeHost(url)}`, { proxy: proxyUrl.replace(/:\/\/[^@]*@/, '://***@') });
    return agent;
  } catch (err) {
    log.warn('http', `could not create proxy agent for ${proxyUrl}: ${err.message}`);
    proxyAgentCache.set(proxyUrl, null);
    return undefined;
  }
}

/** Test/ops helper: clear proxy cache so a config change takes effect immediately. */
export function resetProxyCache() {
  proxyAgentCache.clear();
  proxyWarningLogged = false;
}

/** In-memory cookie jar, one per host, optionally persisted to disk. */
export class CookieJar {
  constructor(name = 'default') {
    this.name = name;
    this.cookies = new Map(); // host → Map(name → {value, expires})
    this.file = path.join(getConfig().scraper.sessionDir || getConfig().storage.tmp, `${name}.cookies.json`);
    this.#load();
  }

  #load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [host, cookies] of Object.entries(data)) {
        this.cookies.set(host, new Map(Object.entries(cookies)));
      }
      log.debug('http', `loaded ${this.cookies.size} cookie host(s) from ${this.file}`);
    } catch (err) {
      log.warn('http', `could not read cookie jar ${this.file}: ${err.message}`);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const out = {};
      for (const [host, cookies] of this.cookies) out[host] = Object.fromEntries(cookies);
      fs.writeFileSync(this.file, JSON.stringify(out));
    } catch (err) {
      log.warn('http', `could not save cookie jar ${this.file}: ${err.message}`);
    }
  }

  set(host, name, value, expires = null) {
    if (!this.cookies.has(host)) this.cookies.set(host, new Map());
    this.cookies.get(host).set(name, { value, expires });
  }

  /** Cookie header for a URL, dropping expired cookies. */
  header(url) {
    let host;
    try { host = new URL(url).hostname; } catch { return ''; }
    const now = Date.now() / 1000;
    const out = [];
    for (const [h, cookies] of this.cookies) {
      if (!(host === h || host.endsWith(`.${h}`) || h.endsWith(`.${host}`))) continue;
      for (const [name, c] of cookies) {
        if (c.expires && c.expires < now) { cookies.delete(name); continue; }
        out.push(`${name}=${c.value}`);
      }
    }
    return out.join('; ');
  }

  absorb(url, setCookieHeaders = []) {
    let host;
    try { host = new URL(url).hostname; } catch { return; }
    for (const raw of setCookieHeaders) {
      const [pair, ...attrs] = String(raw).split(';');
      const idx = pair.indexOf('=');
      if (idx < 1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      const maxAge = attrs.map((a) => a.trim()).find((a) => /^max-age=/i.test(a));
      const expires = maxAge ? Date.now() / 1000 + Number(maxAge.split('=')[1]) : null;
      this.set(host, name, value, Number.isFinite(expires) ? expires : null);
    }
  }

  clear(host) {
    if (host) this.cookies.delete(host);
    else this.cookies.clear();
    this.save();
  }
}

/** Strip protocol/port for logging and comparison. */
export function safeHost(url) {
  try { return new URL(url).hostname; } catch { return '(invalid url)'; }
}

export function resolveUrl(base, maybeRelative) {
  try { return new URL(maybeRelative, base).toString(); } catch { return maybeRelative; }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch with retries, timeouts, cookie support and size limits.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method]
 * @param {object} [opts.headers]
 * @param {string|Buffer} [opts.body]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retries=2]
 * @param {CookieJar} [opts.jar]
 * @param {'text'|'json'|'buffer'|'none'} [opts.as='text']
 * @param {boolean} [opts.json] Compatibility alias for `as: 'json'`; object bodies are JSON encoded.
 * @param {boolean} [opts.binary] Compatibility alias for `as: 'buffer'`.
 * @param {boolean} [opts.allowFailure] Return a structured HTTP error for non-2xx responses.
 * @param {AbortSignal} [opts.signal]
 */
export async function request(url, opts = {}) {
  const {
    method = 'GET', headers = {}, body: inputBody = undefined, timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 2, jar = null, as: requestedAs = null, json = false, binary = false,
    allowFailure = false, signal = null, redirect = 'follow',
  } = opts;
  // The original helper API used `as`; older providers in this app use `json`
  // and `binary`. Support both so a caller asking for JSON actually receives
  // parsed data instead of silently treating the response as text.
  const as = requestedAs || (binary ? 'buffer' : json ? 'json' : 'text');
  let body = inputBody;

  const finalHeaders = { ...headers };
  const hasHeader = (name) => Object.keys(finalHeaders).some((key) => key.toLowerCase() === name.toLowerCase());
  if (!finalHeaders['User-Agent'] && !finalHeaders['user-agent']) {
    finalHeaders['User-Agent'] = getConfig().scraper.userAgent;
  }
  if (as === 'json') {
    if (!hasHeader('Accept')) finalHeaders.Accept = 'application/json';
    if (body !== undefined && body !== null && typeof body === 'object' && !Buffer.isBuffer(body)
        && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body) && !(body instanceof URLSearchParams)) {
      body = JSON.stringify(body);
    }
    if (body !== undefined && body !== null && !hasHeader('Content-Type')) {
      finalHeaders['Content-Type'] = 'application/json';
    }
  }
  if (jar) {
    const cookie = jar.header(url);
    if (cookie) finalHeaders.Cookie = finalHeaders.Cookie ? `${finalHeaders.Cookie}; ${cookie}` : cookie;
  }

  /**
   * Our *own* timeout, named as such.
   *
   * `AbortController.abort()` (the timer below) makes fetch reject with an
   * AbortError, which is indistinguishable from "the caller cancelled" unless
   * we say so. That confusion is not academic: FlareSolverr's transport timeout
   * travelled up as an AbortError, every caller's `err.name === 'AbortError'`
   * check rethrew it, and the source reported "browser request aborted" /
   * "search failed" instead of "the solver did not answer within 35 s".
   */
  const timeoutError = () => Object.assign(
    new Error(`${method} ${safeHost(url)} timed out after ${timeoutMs}ms`),
    { name: 'TimeoutError', code: 'ETIMEDOUT', timedOut: true },
  );

  let lastErr = null;
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error('request aborted'), { name: 'AbortError' });
  }
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('request aborted'), { name: 'AbortError' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      // Avoid an extra microtask when no proxy is configured (preserves the
      // abort-timing contract the tests rely on: fetch must be called before
      // the outer signal's abort microtask).
      let dispatcher;
      if (shouldProxy(url)) dispatcher = await dispatcherFor(url);
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('request aborted'), { name: 'AbortError' });
      if (controller.signal.aborted) {
        // The timer fired while the dispatcher was resolving — same story as
        // the catch below, just without an err to look at.
        lastErr = timeoutError();
        if (attempt < retries) { await sleep(500 * (attempt + 1)); continue; }
        throw lastErr;
      }
      const res = await fetch(url, {
        method, headers: finalHeaders, body, redirect,
        signal: controller.signal,
        // @ts-ignore node-specific option: keep cookies manual for clarity
        compress: true,
        ...(dispatcher ? { dispatcher } : {}),
      });
      if (!res.ok && res.status >= 500 && attempt < retries) {
        lastErr = new Error(`HTTP ${res.status} from ${safeHost(url)}`);
        log.warn('http', `retrying ${method} ${safeHost(url)} after HTTP ${res.status} (attempt ${attempt + 1}/${retries + 1})`);
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (jar) jar.absorb(res.url || url, res.headers.getSetCookie ? res.headers.getSetCookie() : []);

      let payload = null;
      let textBody = null;
      let parseError = null;
      if (as !== 'none') {
        if (as === 'buffer') payload = Buffer.from(await res.arrayBuffer());
        else {
          textBody = await res.text();
          payload = textBody.length > MAX_BYTES ? textBody.slice(0, MAX_BYTES) : textBody;
          if (as === 'json') {
            try {
              payload = JSON.parse(textBody);
            } catch (err) {
              parseError = `expected JSON from ${safeHost(url)} but got ${textBody.slice(0, 120)}`;
              // A non-JSON error page is common for rate limits and proxy
              // failures. When the caller opted into allowFailure, preserve the
              // HTTP status/error rather than obscuring it with a parse error.
              if (res.ok || !allowFailure) {
                throw Object.assign(new Error(parseError), { status: res.status, cause: err });
              }
              payload = null;
            }
          }
        }
      }
      const statusError = !res.ok
        ? String(payload?.error || payload?.message || (as === 'text' ? payload : '')
          || `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`).slice(0, 240)
        : null;
      const error = statusError || parseError || null;
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries(res.headers),
        url: res.url || url,
        text: as === 'text' ? payload : null,
        json: as === 'json' ? payload : null,
        data: as === 'json' ? payload : null,
        buffer: as === 'buffer' ? payload : null,
        payload,
        error,
      };
    } catch (err) {
      if (signal?.aborted) throw err;
      // Distinguish "we ran out of time" from "the caller cancelled": only the
      // former is a TimeoutError, and only the former may consume a retry.
      lastErr = (controller.signal.aborted && err?.name === 'AbortError' && !err?.timedOut)
        ? Object.assign(timeoutError(), { cause: err })
        : err;
      const isLast = attempt >= retries;
      if (!isLast) {
        log.warn('http', `${method} ${safeHost(url)} failed — retry ${attempt + 1}/${retries}`, { error: errorText(lastErr) });
        await sleep(500 * (attempt + 1));
        continue;
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  log.error('http', `${method} ${safeHost(url)} failed permanently`, { error: errorText(lastErr) });
  throw lastErr || new Error(`request failed: ${url}`);
}

/**
 * JSON overrides for the hosts that misbehave in `fetch` (Cloudflare, HTTP/1.0),
 * built by removing the plain headers and using a browser-like set instead.
 */
export function browserLikeHeaders(url, extra = {}) {
  let origin = '';
  try { origin = new URL(url).origin; } catch { /* ignore */ }
  return {
    'User-Agent': getConfig().scraper.userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,nl;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    Referer: origin ? `${origin}/` : '',
    ...extra,
  };
}
