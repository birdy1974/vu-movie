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
 *   GET    /api/playlist/history      append-only title additions for recommendations
 *   PUT    /api/playlist              reorder (`streamIds`) and/or replace items
 *   POST   /api/playlist/items        add streams by id
 *   POST   /api/playlist/check        check upstreams and automatically refresh inactive ones
 *   GET    /api/playlist/check/schedule  scheduled availability-check status
 *   POST   /api/playlist/prepare      pre-warm items in the background so playback starts instantly
 *   POST   /api/playlist/items/:id/prepare  pre-warm one item (`{wait:true}` to block until ready)
 *   GET    /api/playlist/readiness    per-item "ready to play instantly?" state + keep-warm status
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
import { OUTPUT_LABELS, OUTPUT_TYPES, requestAbortSignal } from '../http/api.js';
import * as playlist from './index.js';
import { checkStreams, summariseCheck, BROKEN_STATES } from './check.js';
import { ensureStreamReady, prewarmStream, markStreamVerified } from '../streams/recovery.js';
import { getReadiness } from '../streams/readiness.js';
import { getPlaylistMaintenanceStatus, getPlaylistPrewarmStatus, kickPlaylistPrewarm } from './maintenance.js';

/**
 * How many upstreams are probed at once by POST /api/playlist/check when the
 * caller does not say. Two: a NAS has one uplink and each probe holds a
 * connection for its whole duration, so more workers queue on the wire while
 * the log becomes unreadable.
 */
const CHECK_CONCURRENCY = 2;

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
    player: `${root}/player`,
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
    width: Number(stream.upstream?.width) || Number(stream.upstream?.probe?.video?.width) || null,
    height: Number(stream.upstream?.height) || Number(stream.upstream?.probe?.video?.height) || null,
    resolution: store.resolutionFor(stream),
    season: stream.upstream?.season || null,
    episode: stream.upstream?.episode || null,
    expiresAt: store.tokenExpiresAt(stream),
    createdAt: stream.created_at,
    container: stream.profile?.container || null,
    profileTemplateId: stream.profile?.ffmpegTemplateId || '',
    profileTemplateName: stream.profile?.ffmpegTemplateName || '',
    hasTemplate: Boolean(stream.profile?.ffmpegTemplate),
    transcode: stream.profile?.transcode ?? null,
    subtitlePath: stream.profile?.subtitlePath || '',
    subtitleLanguageStored: stream.profile?.subtitleLanguage || '',
    // none | soft | burn | push — see playlist.SUBTITLE_MODES. The item owns the
    // choice; before the mode was editable the profile was the only record, so
    // fall back to it for items that predate this field.
    subtitleMode: entry.subtitleMode || stream.profile?.subtitles || 'none',
    probe: stream.upstream?.probe || null,
    upstream: { url: stream.upstream?.url || '', kind: stream.upstream?.kind || null, via: stream.upstream?.via || null },
    urls: store.urlsFor(stream, baseUrl),
    session: entry.session,
    // "Will this start the moment the box zaps to it?" — a trusted proof
    // (ready), a check/repair in flight (preparing), or neither yet.
    readiness: getReadiness(stream),
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
        resolution: stream.resolution || null,
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
    maintenance: getPlaylistMaintenanceStatus(),
    urls: outputUrls(baseUrl),
    ...storageMeta(),
  });
}));

router.get('/history', wrap(async (_req, res) => {
  const history = await playlist.additionHistory();
  res.json({ ok: true, count: history.length, history });
}));

router.get('/check/schedule', wrap(async (_req, res) => {
  res.json({ ok: true, schedule: getPlaylistMaintenanceStatus() });
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

/* ---------- stream health ---------- */

/**
 * “Are the streams in the playlist still working?”
 *
 * Body: `{ streamIds?: string[], concurrency?: 1..4 }`. With no `streamIds`
 * every item is checked; the Playlist tab sends one id per request so each row
 * can be painted the moment its probe answers instead of waiting for the whole
 * list. Each item costs one ffprobe run (HLS masters are expanded and the
 * DNS/TCP preflight is shared with the search pipeline), so the answer carries
 * `summary.probing: false` when probing is switched off in Settings — the items
 * then come back `unverified` instead of being reported dead.
 *
 * Order contract: a request that names ids gets its answers **in that order**
 * (a batch lookup), a request without ids gets the playlist order. Without this
 * the order was whatever the playlist happened to hold — two streams created in
 * the same millisecond tie on `created_at` and can come back either way, which
 * a batch caller cannot use.
 */
router.post('/check', wrap(async (req, res) => {
  const body = req.body || {};
  const wanted = Array.isArray(body.streamIds) && body.streamIds.length
    ? body.streamIds.map((id) => String(id))
    : null;
  const requested = Number(body.concurrency);
  const concurrency = Number.isFinite(requested) ? Math.min(4, Math.max(1, Math.round(requested))) : CHECK_CONCURRENCY;
  const request = requestAbortSignal(req, res);
  try {
    const list = await playlist.entries();
    const chosen = wanted ? list.filter((entry) => wanted.includes(String(entry.stream.id))) : list;
    const targets = chosen.map((entry) => ({
      streamId: entry.stream.id,
      title: entry.stream.title,
      sourceId: entry.stream.source_id,
      enabled: entry.enabled,
      url: entry.stream.upstream?.url || '',
      headers: entry.stream.upstream?.headers || {},
      kind: entry.stream.upstream?.kind || entry.stream.kind || null,
      expiresAt: store.tokenExpiresAt(entry.stream),
    }));
    // Ids that are not in the playlist are named instead of silently ignored:
    // the UI can then say “that item is gone” rather than showing it as dead.
    const unknown = wanted
      ? wanted.filter((id) => !list.some((entry) => String(entry.stream.id) === id))
      : [];
    const checkStartedAt = Date.now();
    const checked = await checkStreams(targets, { signal: request.signal, concurrency });
    if (request.signal.aborted) return;
    let results = checked.results;
    const configAutoRepair = getConfig().playlist?.autoRepairEnabled !== false;
    const autoRepair = body.autoRepair === undefined ? configAutoRepair : body.autoRepair === true;
    if (autoRepair) {
      const entriesById = new Map(chosen.map((entry) => [String(entry.stream.id), entry]));
      const repairIndexes = results.map((result, index) => ({ result, index }))
        .filter(({ result }) => BROKEN_STATES.includes(result.state) || result.state === 'skipped');
      let nextRepair = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, repairIndexes.length) }, async () => {
        while (true) {
          const task = repairIndexes[nextRepair++];
          if (!task || request.signal.aborted) return;
          const entry = entriesById.get(String(task.result.streamId));
          if (!entry) continue;
          const outcome = await ensureStreamReady(entry.stream, {
            reason: 'manual-playlist-check',
            autoRepair: true,
            initialCheck: task.result,
            signal: request.signal,
          });
          if (request.signal.aborted) return;
          results[task.index] = outcome.result
            ? { ...outcome.result, streamId: task.result.streamId, title: task.result.title, repaired: outcome.repaired === true }
            : { ...task.result, repairError: outcome.error || 'automatic refresh failed' };
        }
      }));
      if (request.signal.aborted) return;
    }
    // A "working" answer here is a proof playback can trust, exactly like one
    // from ensureStreamReady — record it, so pressing ⚡ check streams (or
    // preparing from another client) also makes the next zap on the box
    // start without a re-probe. Repaired items were already recorded by
    // ensureStreamReady against their *new* upstream URL; re-recording them
    // here would store the proof against the dead URL being replaced.
    const streamsById = new Map(chosen.map((entry) => [String(entry.stream.id), entry.stream]));
    for (const result of results) {
      if (result.repaired) continue;
      if (!['working', 'unverified'].includes(result.state)) continue;
      const stream = streamsById.get(String(result.streamId));
      if (stream) markStreamVerified(stream, result);
    }
    const summary = summariseCheck(results, {
      ms: Date.now() - checkStartedAt,
      checkedAt: checked.summary.checkedAt,
      probing: checked.summary.probing,
    });
    res.json({
      ok: true,
      summary: { ...summary, concurrency, requested: wanted ? wanted.length : list.length, autoRepair },
      results: wanted
        ? [...results].sort((a, b) => wanted.indexOf(String(a.streamId)) - wanted.indexOf(String(b.streamId)))
        : results,
      ...(unknown.length ? { unknown } : {}),
    });
  } finally {
    request.dispose();
  }
}));

/* ---------- pre-warm: be ready before play is pressed ---------- */

/**
 * "Get working links now, so playback starts the moment I zap to it."
 *
 * Body: `{ streamIds?: string[], force?: boolean }`. Without `streamIds`
 * every enabled item that is due is warmed; with ids exactly those. The
 * response is immediate (202) — proving a link can take seconds and
 * repairing a dead one minutes, so the work runs in the background and the
 * caller watches GET /readiness (or the `readiness` field of GET /) until
 * nothing is `preparing` any more. `force` re-proves even items whose
 * proof is still trusted.
 */
router.post('/prepare', wrap(async (req, res) => {
  const body = req.body || {};
  const wanted = Array.isArray(body.streamIds) && body.streamIds.length
    ? body.streamIds.map((id) => String(id))
    : null;
  const force = body.force === true;
  if (wanted) {
    const outcomes = {};
    for (const id of wanted) {
      const stream = await store.getStream(id);
      if (!stream) { outcomes[id] = { started: false, error: 'stream not found' }; continue; }
      const outcome = await prewarmStream(stream, { reason: 'manual-prepare', force });
      outcomes[id] = {
        started: outcome.started,
        alreadyReady: outcome.alreadyReady === true,
        alreadyPreparing: outcome.alreadyPreparing === true,
        readiness: outcome.readiness,
      };
    }
    return res.status(202).json({ ok: true, preparing: outcomes, prewarm: getPlaylistPrewarmStatus() });
  }
  const kicked = kickPlaylistPrewarm({ reason: 'manual-prepare', force });
  log.info('playlist', 'manual prepare requested for the playlist', { force, started: kicked.started });
  return res.status(202).json({ ok: true, ...kicked, prewarm: getPlaylistPrewarmStatus() });
}));

/** Per-item readiness + keep-warm status — the light poll behind the Prepare button. */
router.get('/readiness', wrap(async (_req, res) => {
  const entries = await playlist.entries();
  const items = {};
  for (const entry of entries) items[String(entry.stream.id)] = getReadiness(entry.stream);
  res.json({
    ok: true,
    prewarm: getPlaylistPrewarmStatus(),
    items,
    results: Object.values(items),
  });
}));

/**
 * Pre-warm one playlist item. Default: background, 202 at once. With
 * `{ "wait": true }` the request blocks until the link is proved (or the
 * repair fails) — for scripts that want to know, not guess.
 */
router.post('/items/:id/prepare', wrap(async (req, res) => {
  const stream = await store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
  const force = req.body?.force === true;
  if (req.body?.wait === true) {
    const ready = await ensureStreamReady(stream, { reason: 'manual-prepare', forceCheck: force });
    return res.status(ready.ok ? 200 : 503).json({
      ok: ready.ok,
      repaired: ready.repaired === true,
      ...(ready.ok ? {} : { error: ready.error || ready.result?.error || 'upstream is not available' }),
      check: ready.result,
      readiness: getReadiness(ready.stream || stream),
    });
  }
  const outcome = await prewarmStream(stream, { reason: 'manual-prepare', force });
  return res.status(202).json({ ok: true, ...outcome });
}));

router.post('/items', wrap(async (req, res) => {
  const streamIds = req.body?.streamIds || req.body?.streamId;
  const { added } = await playlist.addItems(streamIds, { enabled: req.body?.enabled !== false });
  log.info('playlist', `added ${added} stream(s) to the playlist`);
  // A title that was just put on the playlist is a title somebody is about
  // to watch: prove its link now (a no-op for a just-resolved candidate,
  // whose proof was recorded at creation) instead of at zap time.
  if (added > 0 && req.body?.enabled !== false) {
    const ids = (Array.isArray(streamIds) ? streamIds : [streamIds]).filter(Boolean).map(String);
    if (ids.length) kickPlaylistPrewarm({ reason: 'playlist-add', streamIds: ids });
  }
  const baseUrl = baseUrlFrom(req);
  res.json({ ok: true, added, items: (await playlist.entries({ baseUrl })).map((entry) => publicItem(entry, baseUrl)), ...storageMeta() });
}));

router.patch('/items/:id', wrap(async (req, res) => {
  const patch = req.body || {};
  if (patch.enabled !== undefined) log.info('playlist', `item ${req.params.id} ${patch.enabled === false ? 'disabled' : 'enabled'}`);
  if (patch.templateId !== undefined) log.info('playlist', `item ${req.params.id} template set to "${patch.templateId}"`);
  if (patch.subtitleMode !== undefined) log.info('playlist', `item ${req.params.id} subtitle mode set to "${patch.subtitleMode}"`);
  const item = await playlist.updateItem(req.params.id, patch);
  const baseUrl = baseUrlFrom(req);
  const all = (await playlist.entries({ baseUrl })).map((entry) => publicItem(entry, baseUrl));
  const updated = all.find((entry) => entry.streamId === item.streamId) || null;
  // The subtitle-copy result is per request (where the file went), not state to
  // store — the UI shows it in the confirmation toast.
  if (updated && item.pushed) updated.pushedSubtitle = item.pushed;
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
  const ready = await ensureStreamReady(stream, { reason: 'playlist-session-start' });
  if (!ready.ok) return res.status(503).json({ ok: false, error: ready.error || ready.result?.error || 'upstream is not available', check: ready.result });
  const session = await relay.ensureSession(ready.stream, { profile: {}, container: req.body?.container });
  res.json({ ok: true, session: relay.publicSession(session), ...(ready.repaired ? { repaired: true, sourceId: ready.stream.source_id } : {}) });
}));

router.delete('/items/:id/session', wrap(async (req, res) => {
  res.json({ ok: true, stopped: relay.stopSession(req.params.id, 'playlist stop') });
}));

/** Queue a download of one item (the same job queue the Stream tab used). */
router.post('/items/:id/download', wrap(async (req, res) => {
  const stream = await store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
  const ready = await ensureStreamReady(stream, { reason: 'playlist-download-start' });
  if (!ready.ok) return res.status(503).json({ ok: false, error: ready.error || ready.result?.error || 'upstream is not available', check: ready.result });
  const job = exporter.startDownload(ready.stream, {
    profile: req.body?.profile || {},
    container: req.body?.container,
    filename: req.body?.filename || null,
  });
  const full = findJob(job.id) || job;
  res.json({ ok: true, job: full, ...(ready.repaired ? { repaired: true, sourceId: ready.stream.source_id } : {}) });
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
  // The bouquet just landed on the box — the viewer is about to zap. Prove
  // (and if needed repair) the enabled links now, in the background.
  if (result.ok && !req.body?.dryRun) kickPlaylistPrewarm({ reason: 'bouquet-push' });
  res.status(result.ok ? 200 : 502).json({ ok: result.ok, mode: 'push', bouquet: built, ...result });
}));

/** The bouquet entries of the enabled playlist items (shared by preview and push). */
async function bouquetEntries(baseUrl) {
  return (await playlist.enabledStreams()).map((stream) => ({
    title: stream.title,
    year: stream.year,
    url: store.urlsFor(stream, baseUrl).forBox,
    description: `${stream.title}${stream.year ? ` (${stream.year})` : ''}`,
    subtitle: stream.profile?.subtitlePath ? (stream.profile.subtitleLanguage || '').slice(0, 3) : null,
    season: stream.upstream?.season || null,
    series: stream.title,
  }));
}

export default router;
