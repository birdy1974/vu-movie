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
  title, year = null, kind = 'movie', poster = null, description = null, sourceId = null,
  candidate, profile = {}, subtitleId = null, season = null, episode = null,
}) {
  const cfg = getConfig();
  const now = new Date();
  const expires = cfg.app.tokenTtlMinutes > 0
    ? new Date(now.getTime() + cfg.app.tokenTtlMinutes * 60000)
    : null;

  const normalised = normaliseProfile(profile, candidate?.probe || null);
  const record = {
    id: shortId(),
    token: token(),
    title: title || candidate?.meta?.title || 'Untitled',
    year,
    kind,
    poster,
    description,
    source_id: candidate?.sourceId || sourceId || null,
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
    subtitle_id: subtitleId,
    playlist_name: `${title || 'vu-movie'}${year ? ` (${year})` : ''}`,
    created_at: now.toISOString(),
    expires_at: expires ? expires.toISOString() : null,
    payload: { sourceId: candidate?.sourceId || null, meta: candidate?.meta || {} },
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
 */
export function urlsFor(stream, baseUrl, { container = null } = {}) {
  const cfg = getConfig();
  const base = String(baseUrl || cfg.app.baseUrl || `http://localhost:${cfg.app.port}`).replace(/\/$/, '');
  const slug = slugify(`${stream.title || 'stream'}${stream.year ? `-${stream.year}` : ''}`);
  const c = container || stream.profile?.container || cfg.transcode.container;
  const ext = c === 'matroska' ? 'mkv' : 'ts';
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
  return {
    raw: `${base}/s/${stream.token}/${slug}.${ext}`,
    ts: `${base}/s/${stream.token}/${slug}.ts`,
    mkv: `${base}/s/${stream.token}/${slug}.mkv`,
    hls: `${base}/s/${stream.token}/${slug}.m3u8`,
    playlist: `${base}/s/${stream.token}/${slug}.m3u`,
    direct: directUsable ? `${base}/s/${stream.token}/direct` : null,
    directNote: directUsable
      ? null
      : 'not offered: this source needs request headers (signed cookie / referer), which a 302 redirect cannot replay — use the .ts relay URL, which does',
    download: `${base}/dl/${stream.token}/${slug}.${ext}`,
    watch: `${base}/watch/${stream.token}`,
    forBox: `${base}/s/${stream.token}/${slug}.ts`,
  };
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
