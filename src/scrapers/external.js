/**
 * vu-movie — external extractor hook (layer 4, optional).
 *
 * Sometimes somebody already solved the hard part. If you run (or know of) an
 * external resolver you prefer, point vu-movie at it and it will be consulted in
 * addition to the built-in layers:
 *
 *   EXTERNAL_EXTRACTOR_URL=http://192.168.1.20:7000/extract
 *
 * The contract is deliberately forgiving; both shapes below are accepted:
 *
 *   { "streams": [ { "url": "https://…/master.m3u8", "quality": "1080p",
 *                    "headers": { "Referer": "…" }, "title": "…" } ] }
 *
 *   // Stremio addon style
 *   { "streams": [ { "url": "…", "name": "1080p", "title": "…", "behaviorHints": {…} } ] }
 *
 * FlareSolverr (Cloudflare) is a separate, narrower integration and lives in http.js.
 */

import { log, logError } from '../core/log.js';
import { getConfig } from '../core/config.js';
import { request } from './http.js';

export function extractorEndpoint(value = getConfig().scraper.externalExtractorUrl) {
  const endpoint = String(value || '').trim();
  if (!endpoint || endpoint.startsWith('#')) return null;
  try {
    const parsed = new URL(endpoint);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null;
    return parsed.toString();
  } catch { return null; }
}

export function isConfigured() {
  return Boolean(extractorEndpoint());
}

export async function extract({ url, title, year, kind, season = 0, episode = 0 }) {
  const endpoint = extractorEndpoint();
  if (!endpoint) return { ok: false, providers: [], error: 'no valid HTTP(S) external extractor URL configured' };

  log.info('external', 'asking external extractor', { endpoint, url, title });
  try {
    const res = await request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { url, title, year, type: kind, season, episode },
      timeoutMs: 60000,
      retries: 1,
      json: true,
      allowFailure: true,
    });
    if (!res.ok) {
      log.warn('external', 'external extractor failed', { status: res.status, error: res.error });
      return { ok: false, providers: [], error: res.error || `HTTP ${res.status}` };
    }
    const raw = Array.isArray(res.data?.streams) ? res.data.streams : [];
    const providers = raw
      .map((s) => ({
        url: s.url || s.link || s.file,
        quality: s.quality || s.name || guessQuality(s.url || ''),
        headers: s.headers || {},
        label: s.title || s.name || 'external',
        sourceId: 'external',
        kind: /\.mpd(\?|$)/i.test(s.url || '') ? 'dash' : /\.m3u8/i.test(s.url || '') ? 'hls' : 'file',
        meta: { external: true, size: s.size || null },
      }))
      .filter((s) => s.url);
    log.info('external', `external extractor returned ${providers.length} streams`);
    return { ok: providers.length > 0, providers };
  } catch (err) {
    logError('external', 'external extractor threw', err);
    return { ok: false, providers: [], error: String(err?.message || err) };
  }
}

function guessQuality(url = '') {
  const m = /(\d{3,4})p/.exec(url);
  return m ? `${m[1]}p` : 'unknown';
}

export default { isConfigured, extract };
