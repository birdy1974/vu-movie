/**
 * vu-movie — JSON API for the Playlist tab.
 *
 * Mounted at `/api/playlist` (before the main API router) so the whole playlist
 * surface lives in one file instead of growing src/http/api.js. Everything the
 * playlist needs already exists in the core: this router only wires the ordered
 * list (see src/playlist/index.js) to the stream store, the FFmpeg template
 * library and the subtitle providers.
 *
 *   GET    /api/playlist              items (stream + urls) + every output URL
 *   PUT    /api/playlist              reorder (`streamIds`) and/or replace items
 *   POST   /api/playlist/items        add streams by id
 *   PATCH  /api/playlist/items/:id    enable/disable, assign template, language
 *   DELETE /api/playlist/items/:id    remove from the playlist
 *   POST   /api/playlist/items/:id/template   assign a saved FFmpeg template
 *   POST   /api/playlist/items/:id/subtitle   attach a search result or an .srt
 *   DELETE /api/playlist/items/:id/subtitle   detach the subtitle
 *   POST   /api/playlist/enigma2              preview/push the bouquet
 *   GET    /api/playlist/m3u                  the playlist as .m3u text
 */

import express from 'express';
import { errorText, log, logError } from '../core/log.js';
import { getConfig } from '../core/config.js';
import { findJob } from '../core/jobs.js';
import * as store from '../streams/store.js';
import * as exporter from '../streams/export.js';
import * as relay from '../streams/relay.js';
import * as enigma2 from '../enigma2/index.js';
import { publicPosterUrl } from '../http/poster-proxy.js';
import { OUTPUT_LABELS, OUTPUT_TYPES } from '../http/api.js';
import * as playlist from './index.js';

const router = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  if (req.aborted || res.destroyed) return;
  logError('playlist', `${req.method} ${req.originalUrl} failed`, err);
  res.status(err.status || 500).json({ ok: false, error: errorText(err) });
});

function baseUrlFrom(req) {
  const configured = getConfig().app.baseUrl;
  if (configured) return String(configured).replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

/**
 * Whether a playlist change really reached the config file. A read-only
 * /config mount (or a sandbox without one) still applies every change to the
 * running process, it just does not survive a restart — the UI says so instead
 * of pretending the save worked.
 */
const storageMeta = () => {
  const writable = playlist.configWritableNow();
  return { persisted: writable, storage: { writable } };
};

/**
 * Every URL the Stream tab hands out. The public ones carry the playlist token
 * and sit outside the /api password (VLC, the VU+ and IPTV apps cannot log in);
 * the /api ones are for the browser UI itself.
 */
export function outputUrls(baseUrl) {
  const token = playlist.token();
  const root = `${String(baseUrl || '').replace(/\/$/, '')}/pl/${token}`;
  const xtream = `${String(baseUrl || '').replace(/\/$/, '')}/xtream/${token}`;
  const xtreamUser = getConfig().playlist.xtreamUsername || 'vumovie';
  const xtreamPass = getConfig().playlist.xtreamPassword || token;
  return {
    token,
    page: `${root}/`,
    m3u: `${root}/playlist.m3u`,
    m3uPlus: `${root}/playlist.m3u8`,
    vlc: `${root}/vlc.m3u`,
    bouquet: `${root}/userbouquet.tv`,
    bouquetName: `userbouquet.${playlist.name().replace(/[^A-Za-z0-9._-]/g, '')}.tv`,
    kodi: `${root}/kodi.m3u`,
    json: `${root}/playlist.json`,
    xtream: {
      base: xtream,
      playerApi: `${xtream}/player_api.php`,
      get: `${xtream}/get.php?username=${encodeURIComponent(xtreamUser)}&password=${encodeURIComponent(xtreamPass)}&type=m3u_plus`,
      xmltv: `${xtream}/xmltv.php`,
      username: xtreamUser,
      password: xtreamPass,
    },
  };
}

/** The item shape the UI renders: flags + stream + urls, never the raw token. */
function publicItem(entry, baseUrl) {
  const stream = entry.stream;
  return {
    streamId: stream.id,
    enabled: entry.enabled,
    templateId: entry.templateId,
    subtitleLanguage: entry.subtitleLanguage,
    addedAt: entry.addedAt,
    order: entry.order,
    title: stream.title,
    year: stream.year,
    kind: stream.kind,
    sourceId: stream.source_id,
    poster: stream.poster ? publicPosterUrl(stream.poster, stream.payload?.meta?.posterReferer || '') : '',
    description: stream.description,
    quality: stream.upstream?.quality || null,
    season: stream.upstream?.season || null,
    episode: stream.upstream?.episode || null,
    expiresAt: stream.expires_at,
    createdAt: stream.created_at,
    container: stream.profile?.container || null,
    profileTemplateId: stream.profile?.ffmpegTemplateId || '',
    profileTemplateName: stream.profile?.ffmpegTemplateName || '',
    hasTemplate: Boolean(stream.profile?.ffmpegTemplate),
    transcode: stream.profile?.transcode ?? null,
    subtitlePath: stream.profile?.subtitlePath || '',
    subtitleLanguageStored: stream.profile?.subtitleLanguage || '',
    probe: stream.upstream?.probe || null,
    upstream: { url: stream.upstream?.url || '', kind: stream.upstream?.kind || null, via: stream.upstream?.via || null },
    urls: store.urlsFor(stream, baseUrl),
    session: entry.session,
  };
}

router.get('/', wrap(async (req, res) => {
  const baseUrl = baseUrlFrom(req);
  const items = (await playlist.entries({ baseUrl })).map((entry) => publicItem(entry, baseUrl));
  const streams = await store.listStreams();
  const inPlaylist = new Set(items.map((item) => item.streamId));
  res.json({
    ok: true,
    name: playlist.name(),
    summary: {
      total: items.length,
      enabled: items.filter((item) => item.enabled).length,
      withTemplate: items.filter((item) => item.hasTemplate).length,
      withSubtitle: items.filter((item) => item.subtitlePath).length,
    },
    items,
    // Streams that exist but are not in the playlist — the "add to playlist"
    // picker on the Playlist tab offers them, so nothing gets lost.
    available: streams
      .filter((stream) => !inPlaylist.has(stream.id))
      .map((stream) => ({
        streamId: stream.id,
        title: stream.title,
        year: stream.year,
        quality: stream.quality,
        sourceId: stream.sourceId,
        createdAt: stream.createdAt,
      })),
    templates: (getConfig().transcode.ffmpegTemplates || []).map((item) => ({
      id: item.id, name: item.name, container: item.container, enabled: item.enabled !== false,
      isDefault: getConfig().transcode.defaultFfmpegTemplateId === item.id,
    })),
    defaultTemplateId: getConfig().transcode.defaultFfmpegTemplateId || '',
    outputTypes: OUTPUT_TYPES,
    outputLabels: OUTPUT_LABELS,
    urls: outputUrls(baseUrl),
    ...storageMeta(),
  });
}));

/** Reorder and/or replace the list. `streamIds` alone is the drag-and-drop case. */
router.put('/', wrap(async (req, res) => {
  const body = req.body || {};
  if (Array.isArray(body.streamIds)) {
    await playlist.reorder(body.streamIds);
    log.info('playlist', `reordered the playlist`, { items: body.streamIds.length });
  }
  if (Array.isArray(body.items)) {
    await playlist.saveItems(body.items);
    log.info('playlist', `playlist items saved`, { items: body.items.length });
  }
  const baseUrl = baseUrlFrom(req);
  res.json({ ok: true, items: (await playlist.entries({ baseUrl })).map((entry) => publicItem(entry, baseUrl)), ...storageMeta() });
}));

router.post('/items', wrap(async (req, res) => {
  const streamIds = req.body?.streamIds || req.body?.streamId;
  const { added } = await playlist.addItems(streamIds, { enabled: req.body?.enabled !== false });
  log.info('playlist', `added ${added} stream(s) to the playlist`);
  const baseUrl = baseUrlFrom(req);
  res.json({ ok: true, added, items: (await playlist.entries({ baseUrl })).map((entry) => publicItem(entry, baseUrl)), ...storageMeta() });
}));

router.patch('/items/:id', wrap(async (req, res) => {
  const patch = req.body || {};
  if (patch.enabled !== undefined) log.info('playlist', `item ${req.params.id} ${patch.enabled === false ? 'disabled' : 'enabled'}`);
  if (patch.templateId !== undefined) log.info('playlist', `item ${req.params.id} template set to "${patch.templateId}"`);
  const item = await playlist.updateItem(req.params.id, patch);
  const baseUrl = baseUrlFrom(req);
  const all = (await playlist.entries({ baseUrl })).map((entry) => publicItem(entry, baseUrl));
  const updated = all.find((entry) => entry.streamId === item.streamId) || null;
  res.json({ ok: true, item: updated, items: all, ...storageMeta() });
}));

router.delete('/items/:id', wrap(async (req, res) => {
  const result = await playlist.removeItem(req.params.id);
  log.info('playlist', `item ${req.params.id} removed from the playlist`);
  const baseUrl = baseUrlFrom(req);
  res.json({ ok: true, removed: result.removed, items: (await playlist.entries({ baseUrl })).map((entry) => publicItem(entry, baseUrl)), ...storageMeta() });
}));

/** Assign one of the saved FFmpeg templates (empty id = guided profile builder). */
router.post('/items/:id/template', wrap(async (req, res) => {
  const stream = await playlist.assignTemplate(req.params.id, req.body?.templateId, { outputType: req.body?.outputType || '' });
  const baseUrl = baseUrlFrom(req);
  const all = (await playlist.entries({ baseUrl })).map((entry) => publicItem(entry, baseUrl));
  res.json({ ok: true, streamId: stream.id, items: all, ...storageMeta() });
}));

/** Attach a subtitle: a provider result, or the contents of a local .srt file. */
router.post('/items/:id/subtitle', wrap(async (req, res) => {
  const attached = await playlist.attachSubtitle(req.params.id, {
    result: req.body?.result || null,
    srt: req.body?.srt || null,
    language: req.body?.language || '',
    offsetMs: req.body?.offsetMs,
  });
  res.json({
    ok: true,
    language: attached.language,
    provider: attached.provider,
    cues: attached.cues,
    filename: attached.filename || null,
  });
}));

router.delete('/items/:id/subtitle', wrap(async (req, res) => {
  const stream = await playlist.detachSubtitle(req.params.id);
  res.json({ ok: true, streamId: stream.id });
}));

/* ---------------- playback / outputs ---------------- */

/** Start (or keep) the relay session so the web player has something to fetch. */
router.post('/items/:id/session', wrap(async (req, res) => {
  const stream = await store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
  const session = await relay.ensureSession(stream, { profile: {}, container: req.body?.container });
  res.json({ ok: true, session: relay.publicSession(session) });
}));

router.delete('/items/:id/session', wrap(async (req, res) => {
  res.json({ ok: true, stopped: relay.stopSession(req.params.id, 'playlist stop') });
}));

/** Queue a download of one item (the same job queue the Stream tab used). */
router.post('/items/:id/download', wrap(async (req, res) => {
  const stream = await store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
  const job = exporter.startDownload(stream, {
    profile: req.body?.profile || {},
    container: req.body?.container,
    filename: req.body?.filename || null,
  });
  const full = findJob(job.id) || job;
  res.json({ ok: true, job: full });
}));

/** The playlist as a plain .m3u file (download button in the UI). */
router.get('/m3u', wrap(async (req, res) => {
  const built = await playlist.playlistText(baseUrlFrom(req), { hls: String(req.query.hls || '') === 'true' });
  res.setHeader('Content-Type', 'audio/x-mpegurl');
  res.setHeader('Content-Disposition', `attachment; filename="${playlist.name()}.m3u"`);
  res.send(built.text);
}));

/** Enigma2 bouquet preview or push for the playlist (enabled items, in order). */
router.post('/enigma2', wrap(async (req, res) => {
  const baseUrl = baseUrlFrom(req);
  const built = await playlist.bouquet(baseUrl, { serviceType: Number(req.body?.serviceType) || null });
  if (req.body?.action !== 'push') {
    return res.json({ ok: true, mode: 'preview', bouquet: built, ...enigma2.previewBouquet(await bouquetEntries(baseUrl), { name: playlist.name() }) });
  }
  const result = await enigma2.pushBouquet(await bouquetEntries(baseUrl), { name: playlist.name(), dryRun: Boolean(req.body?.dryRun) });
  log.info('playlist', `bouquet ${result.ok ? 'pushed' : 'push failed'} from the playlist`, {
    entries: built.count, dryRun: Boolean(req.body?.dryRun), via: result.transport?.via || result.transport || null,
  });
  res.status(result.ok ? 200 : 502).json({ ok: result.ok, mode: 'push', bouquet: built, ...result });
}));

/** The bouquet entries of the enabled playlist items (shared by preview and push). */
async function bouquetEntries(baseUrl) {
  return (await playlist.enabledStreams()).map((stream) => ({
    title: stream.title,
    year: stream.year,
    url: store.urlsFor(stream, baseUrl).forBox,
    description: `${stream.title}${stream.year ? ` (${stream.year})` : ''} — ${stream.upstream?.quality || 'source'}`,
    subtitle: stream.profile?.subtitlePath ? (stream.profile.subtitleLanguage || '').slice(0, 3) : null,
    season: stream.upstream?.season || null,
    series: stream.title,
  }));
}

export default router;
