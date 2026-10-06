/**
 * vu-movie — stream registry.
 *
 * A "stream" is a scraped title that has been resolved to a concrete upstream
 * source and a transcoding profile. It gets a short id plus an unguessable token;
 * every URL handed to VLC or the VU+ Duo2 contains the token, never the upstream
 * URL (which expires within minutes and often needs Referer/Cookie headers).
 */

import crypto from 'node:crypto';
import { log } from '../core/log.js';
import { getConfig } from '../core/config.js';
import { repo } from '../core/db.js';
import { normaliseProfile } from '../core/media.js';

const shortId = () => crypto.randomBytes(5).toString('hex');
const token = () => crypto.randomBytes(12).toString('base64url');

/** Create (and persist) a stream record from a resolved candidate. */
export async function createStream({
  id: existingId = null, token: existingToken = null,
  created_at: existingCreatedAt = null, expires_at: existingExpiresAt,
  playlist_name: existingPlaylistName = null, subtitle_id: existingSubtitleId = null,
  payload: existingPayload = null, source_id: existingSourceId = null,
  title, year = null, kind = 'movie', poster = null, posterReferer = '', description = null, sourceId = null,
  candidate, profile = {}, subtitleId = null, season = null, episode = null,
}) {
  const cfg = getConfig();
  const now = new Date();
  const expires = existingExpiresAt !== undefined
    ? existingExpiresAt
    : cfg.app.tokenTtlMinutes > 0 ? new Date(now.getTime() + cfg.app.tokenTtlMinutes * 60000) : null;

  let profileInput = { ...(profile || {}) };
  if (!existingId && !Object.hasOwn(profileInput, 'ffmpegTemplate') && !Object.hasOwn(profileInput, 'ffmpegTemplateId')) {
    // Apply the per-output default template map. The `vlcTs` slot is what the
    // Stream tab used to set automatically (the legacy single default). When
    // nothing is configured we leave the profile empty so the guided builder
    // applies on first render.
    const defaults = cfg.transcode.ffmpegDefaults && typeof cfg.transcode.ffmpegDefaults === 'object'
      ? cfg.transcode.ffmpegDefaults : {};
    const desiredTemplateId = defaults.vlcTs || cfg.transcode.defaultFfmpegTemplateId || '';
    // A disabled template is never picked automatically (it stays in the
    // library so the operator can switch it back on from the editor).
    const defaultTemplate = (cfg.transcode.ffmpegTemplates || []).find((item) =>
      item?.enabled !== false && item?.id === desiredTemplateId
      && typeof item.command === 'string' && item.command.trim());
    if (defaultTemplate) {
      profileInput = {
        ...profileInput,
        container: defaultTemplate.container || profileInput.container,
        ffmpegTemplate: defaultTemplate.command,
        ffmpegTemplateId: defaultTemplate.id,
        ffmpegTemplateName: defaultTemplate.name || '',
      };
    }
  }
  const normalised = normaliseProfile(profileInput, candidate?.probe || null);
  const record = {
    id: existingId || shortId(),
    token: existingToken || token(),
    title: title || candidate?.meta?.title || 'Untitled',
    year,
    kind,
    poster,
    description,
    source_id: candidate?.sourceId || sourceId || existingSourceId || null,
    upstream: {
      url: candidate?.url,
      kind: candidate?.kind || null,
      headers: candidate?.headers || {},
      quality: candidate?.quality || null,
      label: candidate?.label || null,
      probe: candidate?.probe || null,
      variants: candidate?.variants || null,
      season,
      episode,
      via: candidate?.via || null,
    },
    profile: normalised,
    subtitle_id: subtitleId ?? existingSubtitleId ?? null,
    playlist_name: existingPlaylistName || `${title || 'vu-movie'}${year ? ` (${year})` : ''}`,
    created_at: existingCreatedAt || now.toISOString(),
    expires_at: expires ? (expires instanceof Date ? expires.toISOString() : expires) : null,
    payload: existingPayload || {
      sourceId: candidate?.sourceId || null,
      meta: {
        ...(candidate?.meta || {}),
        ...(posterReferer ? { posterReferer } : {}),
      },
    },
    updated_at: now.toISOString(),
  };

  const saved = await repo.saveStream(record);
  log.info('streams', `created stream ${record.id}`, {
    title: record.title, quality: record.upstream.quality, mode: normalised.transcode ? 'transcode' : 'copy',
    reasons: normalised.reasons?.join('; '),
  });
  return saved;
}

export async function getStream(idOrToken) {
  const rec = await repo.getStream(idOrToken);
  if (!rec) return null;
  if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) {
    log.warn('streams', `stream ${rec.id} has expired (token TTL) — still serving, re-resolve for a fresh upstream URL`);
    rec.expired = true;
  }
  return rec;
}

export async function listStreams() {
  const rows = await repo.listStreams(200);
  return rows.map((r) => ({
    id: r.id,
    token: r.token,
    title: r.title,
    year: r.year,
    kind: r.kind,
    poster: r.poster,
    posterReferer: r.payload?.meta?.posterReferer || '',
    description: r.description,
    sourceId: r.source_id,
    quality: r.upstream?.quality || null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    subtitleId: r.subtitle_id,
    season: r.upstream?.season || null,
    episode: r.upstream?.episode || null,
    transcode: r.profile?.transcode ?? null,
    container: r.profile?.container || getConfig().transcode.container,
  }));
}

export async function removeStream(id) {
  await repo.deleteStream(id);
  log.info('streams', `deleted stream ${id}`);
}

/**
 * Build every client-facing URL for a stream.
 * `baseUrl` normally comes from the request (so it works behind any LAN name).
 *
 * `outputType` is one of the OUTPUT_TYPES values: `vlcTs`, `vlcMkv`, `m3u8`, `m3u`,
 * `enigma2`, `direct`, `download`. When the caller passes one, the chosen
 * container and extension are derived from the FFmpeg template assigned to that
 * output (stream → global default → guided builder).
 */
export function urlsFor(stream, baseUrl, { container = null, outputType = null } = {}) {
  const cfg = getConfig();
  const base = String(baseUrl || cfg.app.baseUrl || `http://localhost:${cfg.app.port}`).replace(/\/$/, '');
  const slug = slugify(`${stream.title || 'stream'}${stream.year ? `-${stream.year}` : ''}`);
  const c = container || stream.profile?.container || cfg.transcode.container;
  const ext = c === 'matroska' ? 'mkv' : c === 'hls' ? 'm3u8' : 'ts';
  /**
   * The `direct` endpoint 302s to the upstream URL, which only works when the
   * CDN accepts an anonymous fetch. MovieBox (and every signed-cookie source)
   * needs `Cookie: Edge-Cache-Cookie=…` / `Referer` on *every* request, so a
   * plain redirect produces a 403 in VLC. The reference client never hands a
   * raw CDN URL to a player for exactly this reason — it fetches through a
   * header-injecting proxy. We mirror that: no direct URL is advertised when the
   * candidate carries credentials, and the relay (which replays the headers) is
   * the only offer.
   */
  const directUsable = directPlaybackAvailable(stream);
  const token = stream.token;
  return {
    raw: `${base}/s/${token}/${slug}.${ext}`,
    ts: `${base}/s/${token}/${slug}.ts`,
    mkv: `${base}/s/${token}/${slug}.mkv`,
    hls: `${base}/s/${token}/${slug}.m3u8`,
    playlist: `${base}/s/${token}/${slug}.m3u`,
    direct: directUsable ? `${base}/s/${token}/direct` : null,
    directNote: directUsable
      ? null
      : 'not offered: this source needs request headers (signed cookie / referer), which a 302 redirect cannot replay — use the .ts relay URL, which does',
    download: `${base}/dl/${token}/${slug}.${ext}`,
    watch: `${base}/watch/${token}`,
    // The URL that tells the relay "this is the browser preview": subtitle-free,
    // no item template, codecs picked from what the browser can play (see
    // streams/web-preview.js). Kept as a path suffix instead of a query because
    // the mpegts.js fallback (a plain <video src>) and the mini-player both
    // pass it around unchanged.
    web: `${base}/s/${token}/${slug}.ts.web`,
    // The bouquet service-ref encodes the URL with `encodeE2Url`, which
    // strips query strings — the receiver cannot reach a URL with
    // `?enigma2=1`. We use a `.ts.enigma2` path suffix that survives the
    // service-ref encoding and lets the relay bind the receiver request to
    // the `enigma2` template slot. The plain `.ts` URL stays for desktop
    // VLC and other clients.
    forBox: `${base}/s/${token}/${slug}.ts.enigma2`,
    outputType: outputType || '',
  };
}

/**
 * Resolve which output type an HTTP path corresponds to. Used by the stream
 * endpoints to pick the right FFmpeg template. The Enigma2/Duo2 endpoint is
 * separate from the generic VLC .ts slot, so the operator can assign a tighter
 * template (e.g. a 4:3-only, low-bitrate one) that does not also bind the
 * desktop player.
 */
export function outputTypeForPath(reqPath) {
  const name = String(reqPath || '').split('?')[0].toLowerCase();
  // Enigma2 receivers cannot carry query strings through their service-ref
  // encoding (the bouquet builder strips them). The bouquet entry therefore
  // uses a `.ts.enigma2` path segment that the relay maps to the `enigma2`
  // output slot. The `?enigma2=1` query parameter is also accepted for callers
  // that do pass headers/queries through (e.g. direct test calls).
  if (name.endsWith('/direct')) return 'direct';
  if (name.endsWith('.ts.enigma2') || name.endsWith('/enigma2.ts')) return 'enigma2';
  // Browser preview (mpegts.js / MSE). Like the Enigma2 suffix, this is a path
  // segment so the URL survives clients that drop query strings; the browser
  // player therefore cannot accidentally be served the VLC template's output.
  if (name.endsWith('.ts.web') || name.endsWith('/web.ts')) return 'web';
  if (name.endsWith('.m3u8')) return 'm3u8';
  if (name.endsWith('.m3u')) return 'm3u';
  if (name.endsWith('.mkv')) return 'vlcMkv';
  if (name.endsWith('.ts')) return 'vlcTs';
  return '';
}

/**
 * True when the request URL is one an Enigma2 receiver would fetch (the
 * user-bouquet `forBox` slot). The path uses the .ts extension today, so the
 * caller must look at the special `enigma2=1` query parameter that the bouquet
 * builder appends, or fall back to the `vlcTs` output type.
 */
export function outputTypeForEnigma2Request(req) {
  const flag = String(req?.query?.enigma2 || req?.headers?.['x-vu-enigma'] || '');
  if (flag === '1' || flag === 'true') return 'enigma2';
  return '';
}

/**
 * True when the upstream URL can be played by a client that sends no headers
 * of its own (VLC following a 302): no Cookie/Authorization and not a
 * manifest that is itself signed.
 */
export function directPlaybackAvailable(stream) {
  const url = stream?.upstream?.url || '';
  const headers = stream?.upstream?.headers || {};
  const sensitive = Object.keys(headers).some((name) => /^(cookie|authorization|x-)/i.test(name));
  if (sensitive) return false;
  if (/\.mpd(\?|#|$)/i.test(String(url).split('#')[0])) return false;
  return true;
}

export function slugify(text) {
  return String(text || 'stream')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'stream';
}

export default { createStream, getStream, listStreams, removeStream, urlsFor, slugify };
