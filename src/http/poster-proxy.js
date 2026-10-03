/** Same-origin image proxy for posters returned by search providers. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getConfig } from '../core/config.js';

const signingKey = randomBytes(32);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const IMAGE_TYPES = new Set([
  'image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp',
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function httpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    if (url.port && !['80', '443'].includes(url.port)) return null;
    return url;
  } catch { return null; }
}

function privateIPv4(address) {
  const [a, b, c] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

function privateIPv6(address) {
  const ip = address.toLowerCase().split('%')[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return privateIPv4(mapped[1]);
  if (ip === '::' || ip === '::1') return true;
  const first = Number.parseInt(ip.split(':')[0] || '0', 16);
  // Only global-unicast IPv6 is allowed; also block documentation addresses.
  return (first & 0xe000) !== 0x2000 || ip.startsWith('2001:db8:');
}

function privateAddress(address) {
  const family = isIP(address);
  if (family === 4) return privateIPv4(address);
  if (family === 6) return privateIPv6(address);
  return true;
}

async function checkedRemoteUrl(value) {
  const url = httpUrl(value);
  if (!url) throw Object.assign(new Error('invalid poster URL'), { status: 403 });
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (/(^|\.)(?:localhost|local|internal|test|invalid)$/.test(hostname)) {
    throw Object.assign(new Error('local poster hosts are not allowed'), { status: 403 });
  }
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw Object.assign(new Error('poster host did not resolve to a public address'), { status: 403 });
  }
  return url;
}

function signatureFor(url, referer) {
  return createHmac('sha256', signingKey).update(`${url}\n${referer}`).digest('base64url');
}

/** Build a signed relative URL; callers cannot turn this endpoint into an open proxy. */
export function posterProxyUrl(poster, referer = '') {
  const refererUrl = httpUrl(referer);
  let imageUrl = httpUrl(poster);
  if (!imageUrl && refererUrl) {
    try { imageUrl = httpUrl(new URL(String(poster), refererUrl).href); } catch { /* invalid relative URL */ }
  }
  if (!imageUrl) return null;
  const ref = refererUrl?.href || '';
  const url = imageUrl.href;
  const signature = signatureFor(url, ref);
  const params = new URLSearchParams({ url, ref, sig: signature });
  return `/api/poster?${params.toString()}`;
}

function signatureIsValid(url, referer, signature) {
  const expected = signatureFor(url, referer);
  const receivedBytes = Buffer.from(String(signature || ''));
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

/** Fetch one signed remote image with redirect, IP, MIME type, and size checks. */
export async function fetchPosterImage({ url, referer = '', signature = '' }) {
  const initialUrl = httpUrl(url);
  const referrerUrl = referer ? httpUrl(referer) : null;
  const ref = referrerUrl?.href || '';
  if (!initialUrl || !signatureIsValid(initialUrl.href, ref, signature)) {
    return { status: 403, body: Buffer.alloc(0) };
  }

  let target = initialUrl.href;
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const checkedUrl = await checkedRemoteUrl(target);
      const headers = {
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'User-Agent': getConfig().scraper.userAgent,
      };
      if (ref) headers.Referer = ref;
      const response = await fetch(checkedUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(12000),
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location || redirect === MAX_REDIRECTS) return { status: 502, body: Buffer.alloc(0) };
        target = new URL(location, checkedUrl).href;
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        return { status: 502, body: Buffer.alloc(0) };
      }

      const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!IMAGE_TYPES.has(contentType)) {
        await response.body.cancel().catch(() => {});
        return { status: 415, body: Buffer.alloc(0) };
      }
      const declaredSize = Number(response.headers.get('content-length') || 0);
      if (declaredSize > MAX_IMAGE_BYTES) {
        await response.body.cancel().catch(() => {});
        return { status: 413, body: Buffer.alloc(0) };
      }

      const chunks = [];
      let totalBytes = 0;
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        totalBytes += bytes.length;
        if (totalBytes > MAX_IMAGE_BYTES) {
          await response.body.cancel().catch(() => {});
          return { status: 413, body: Buffer.alloc(0) };
        }
        chunks.push(bytes);
      }
      if (!totalBytes) return { status: 502, body: Buffer.alloc(0) };
      return { status: 200, contentType, body: Buffer.concat(chunks, totalBytes) };
    }
  } catch (error) {
    return { status: Number(error?.status) || 502, body: Buffer.alloc(0) };
  }
  return { status: 502, body: Buffer.alloc(0) };
}
