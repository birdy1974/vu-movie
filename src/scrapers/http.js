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
import { log } from '../core/log.js';

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_BYTES = 25 * 1024 * 1024;

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
 * @param {AbortSignal} [opts.signal]
 */
export async function request(url, opts = {}) {
  const {
    method = 'GET', headers = {}, body = undefined, timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 2, jar = null, as = 'text', signal = null, redirect = 'follow',
  } = opts;

  const finalHeaders = { ...headers };
  if (!finalHeaders['User-Agent'] && !finalHeaders['user-agent']) {
    finalHeaders['User-Agent'] = getConfig().scraper.userAgent;
  }
  if (jar) {
    const cookie = jar.header(url);
    if (cookie) finalHeaders.Cookie = finalHeaders.Cookie ? `${finalHeaders.Cookie}; ${cookie}` : cookie;
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, {
        method, headers: finalHeaders, body, redirect,
        signal: controller.signal,
        // @ts-ignore node-specific option: keep cookies manual for clarity
        compress: true,
      });
      if (!res.ok && res.status >= 500 && attempt < retries) {
        lastErr = new Error(`HTTP ${res.status} from ${safeHost(url)}`);
        log.warn('http', `retrying ${method} ${safeHost(url)} after HTTP ${res.status} (attempt ${attempt + 1}/${retries + 1})`);
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (jar) jar.absorb(res.url || url, res.headers.getSetCookie ? res.headers.getSetCookie() : []);

      let payload = null;
      if (as !== 'none') {
        if (as === 'buffer') payload = Buffer.from(await res.arrayBuffer());
        else {
          const text = await res.text();
          payload = text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
          if (as === 'json') {
            try { payload = JSON.parse(text); } catch {
              throw Object.assign(new Error(`expected JSON from ${safeHost(url)} but got ${text.slice(0, 120)}`), { status: res.status });
            }
          }
        }
      }
      return {
        ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers),
        url: res.url || url, text: as === 'text' ? payload : null,
        json: as === 'json' ? payload : null, buffer: as === 'buffer' ? payload : null,
        payload,
      };
    } catch (err) {
      lastErr = err;
      const isLast = attempt >= retries;
      if (!isLast) {
        log.warn('http', `${method} ${safeHost(url)} failed (${err.message}) — retry ${attempt + 1}/${retries}`);
        await sleep(500 * (attempt + 1));
        continue;
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  log.error('http', `${method} ${safeHost(url)} failed permanently: ${lastErr?.message}`);
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
