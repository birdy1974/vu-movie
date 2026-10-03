/**
 * vu-movie — JSON API (everything the web UI talks to).
 *
 * Conventions
 *  - always JSON, always a `ok` boolean; errors carry a human readable `error`
 *  - long operations return a job id instead of blocking the request
 *  - every handler logs its inputs, so a bug report can be traced from the UI
 *    straight to the log page without guessing
 */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { log, logError, errorText, getRecentLogs, knownComponents, getLogLevel, setLogLevel, subscribeLogs } from '../core/log.js';
import { getConfig, publicConfig, saveConfig, cfg } from '../core/config.js';
import { dbState, isPostgres } from '../core/db.js';
import {
  hardware, hardwareStatus, hardwarePending, binariesStatus, checkBinaries,
  diagnoseFfmpeg, probe, buildFfmpegArgs, normaliseProfile, argsToCommand,
} from '../core/media.js';
import { jobs, transcodeQueue, jobEvents, findJob, listAllJobs, jobStats, cancelJob } from '../core/jobs.js';
import * as registry from '../scrapers/registry.js';
import * as moviebox from '../scrapers/moviebox.js';
import * as browser from '../scrapers/browser.js';
import * as external from '../scrapers/external.js';
import * as store from '../streams/store.js';
import * as relay from '../streams/relay.js';
import * as exporter from '../streams/export.js';
import * as subs from '../subtitles/index.js';
import * as enigma2 from '../enigma2/index.js';
import { fetchPosterImage, posterProxyUrl } from './poster-proxy.js';

const router = express.Router();
const startedAt = Date.now();

/* ---------- small helpers ---------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  if (req.aborted || res.destroyed) return;
  logError('api', `${req.method} ${req.originalUrl} failed`, err);
  res.status(err.status || 500).json({ ok: false, error: errorText(err) });
});

function requestAbortSignal(req, res) {
  const controller = new AbortController();
  const onRequestAborted = () => controller.abort();
  const onResponseClosed = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once('aborted', onRequestAborted);
  res.once('close', onResponseClosed);
  return {
    signal: controller.signal,
    dispose() {
      req.off('aborted', onRequestAborted);
      res.off('close', onResponseClosed);
    },
  };
}

const baseUrlFrom = (req) => {
  const configured = cfg('app.baseUrl');
  if (configured) return String(configured).replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
};

function parseStreamIds(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  return String(input).split(',').map((s) => s.trim()).filter(Boolean);
}

/* ---------- health / logs / config ---------- */

router.get('/health', wrap(async (req, res) => {
  // Make sure a detection run exists, but never *wait* for it: this endpoint is
  // the container healthcheck and a slow vaapi self-test must not time it out.
  // Callers get the `pending` placeholder until the result is in.
  hardware();
  const hw = hardwareStatus();
  const binaries = binariesStatus() || { ffmpeg: { ok: false, pending: true }, ffprobe: { ok: false, pending: true } };
  const enigma = cfg('enigma2.host') ? await enigma2.status({ timeoutMs: 3000 }).catch((e) => ({ ok: false, message: errorText(e) })) : { configured: false };
  res.json({
    ok: true,
    version: process.env.APP_VERSION || '1.0.0',
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    node: process.version,
    db: dbState(),
    postgres: isPostgres(),
    ffmpeg: binaries.ffmpeg,
    ffprobe: binaries.ffprobe,
    hwaccel: hw,
    hwaccelPending: hardwarePending(),
    browser: browser.browserInfo(),
    externalExtractor: external.isConfigured(),
    enigma2: enigma,
    streamSessions: relay.listSessions(),
    jobs: jobStats(),
    sources: registry.listSources().map((s) => ({ id: s.id, name: s.name, health: s.health })),
  });
}));

router.get('/logs', wrap(async (req, res) => {
  res.json({
    ok: true,
    level: getLogLevel(),
    components: knownComponents(),
    entries: getRecentLogs({
      level: req.query.level, component: req.query.component,
      search: req.query.search, limit: Number(req.query.limit || 300),
    }),
  });
}));

router.post('/logs/level', wrap(async (req, res) => {
  setLogLevel(req.body?.level || 'info');
  res.json({ ok: true, level: getLogLevel() });
}));

/** Server-sent events: live logs + job/session updates (used by the UI). */
router.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  const send = (event, payload) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ }
  };
  const unsubscribe = subscribeLogs((entry) => send('log', entry));
  const onJob = (job) => send('job', job);
  jobEvents.on('job', onJob);

  const keepAlive = setInterval(() => send('ping', { t: Date.now() }), 25000);
  const sessionTimer = setInterval(() => send('sessions', relay.listSessions()), 4000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clearInterval(sessionTimer);
    unsubscribe();
    jobEvents.off('job', onJob);
    log.debug('api', 'SSE client disconnected from /api/events');
  });
});

router.get('/config', wrap(async (req, res) => res.json({ ok: true, config: publicConfig() })));

router.put('/config', wrap(async (req, res) => {
  const patch = req.body || {};
  log.info('api', 'config update requested', { sections: Object.keys(patch).join(',') });
  const next = saveConfig(patch);
  if (patch.app?.logLevel) setLogLevel(patch.app.logLevel);
  res.json({ ok: true, config: publicConfig(), changed: Object.keys(patch) });
}));

router.post('/config/hwaccel/test', wrap(async (req, res) => {
  const hw = await hardware({ force: true });
  log.info('api', 'hardware self-test requested from the UI', {
    available: hw.available, driver: hw.libvaDriver, fpsVariant: hw.fpsVariant, reason: hw.reason,
  });
  res.json({ ok: true, hwaccel: hw });
}));

/**
 * "Why is ffmpeg not working?" — one request that answers it with timings and
 * no guessing: which binary answered, how long it took, what the container can
 * see, and which VA-API driver encodes. The same report is produced by
 * `GET /api/diagnostics/ffmpeg` and by scripts/doctor.sh on the NAS.
 */
router.get('/diagnostics/ffmpeg', wrap(async (req, res) => {
  const report = await diagnoseFfmpeg({ device: req.query.device ? String(req.query.device) : null });
  log.info('api', 'ffmpeg diagnostics requested', {
    ok: report.ok, hardwareOk: report.hardwareOk, devicePresent: report.devicePresent, elapsedMs: report.elapsedMs,
  });
  res.json({ ok: true, report });
}));

/* ---------- sources ---------- */

router.get('/sources', wrap(async (req, res) => {
  res.json({ ok: true, sources: registry.listSources() });
}));

router.post('/sources', wrap(async (req, res) => {
  const source = req.body || {};
  if (!source.id || !source.home) return res.status(400).json({ ok: false, error: 'id and home are required' });
  const current = getConfig().scraper.customSources || [];
  const next = [...current.filter((s) => s.id !== source.id), source];
  saveConfig({ scraper: { customSources: next } });
  registry.loadSources({ force: true });
  log.info('api', `custom source saved: ${source.id}`, { home: source.home });
  res.json({ ok: true, sources: registry.listSources() });
}));

router.post('/sources/test', wrap(async (req, res) => {
  const { sourceId, query } = req.body || {};
  const source = registry.getSource(sourceId);
  if (!source) return res.status(404).json({ ok: false, error: `unknown source ${sourceId}` });
  const results = await registry.searchSource(source, query || 'matrix');
  res.json({ ok: true, results, health: registry.healthOf(sourceId) });
}));

/* ---------- find / resolve ---------- */

router.get('/poster', wrap(async (req, res) => {
  const image = await fetchPosterImage({
    url: req.query.url,
    referer: req.query.ref,
    signature: req.query.sig,
  });
  res.status(image.status);
  if (image.status !== 200) {
    res.set('Cache-Control', 'no-store').end();
    return;
  }
  res.set({
    'Content-Type': image.contentType,
    'Content-Length': String(image.body.length),
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  }).end(image.body);
}));

router.get('/find/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'q is required' });
  const request = requestAbortSignal(req, res);
  try {
    const outcome = await registry.searchAll(q, {
      type: req.query.type || null,
      sources: req.query.sources === undefined ? null : String(req.query.sources).split(',').filter(Boolean),
      includeMoviebox: req.query.moviebox === undefined || String(req.query.moviebox).toLowerCase() !== 'false',
      signal: request.signal,
      detailed: true,
    });
    if (request.signal.aborted) return;
    const withProxiedPosters = outcome.results.map((result) => ({
      ...result,
      // Never expose an untrusted remote poster directly to the browser.
      poster: result.poster ? (posterProxyUrl(result.poster, result.url) || '') : '',
    }));
    res.json({ ok: true, query: q, results: withProxiedPosters, providerErrors: outcome.providerErrors });
  } finally {
    request.dispose();
  }
}));

router.get('/find/details', wrap(async (req, res) => {
  const subjectId = String(req.query.subjectId || '').trim();
  if (!subjectId) return res.status(400).json({ ok: false, error: 'subjectId is required' });
  const request = requestAbortSignal(req, res);
  try {
    const details = await moviebox.detail(subjectId, { signal: request.signal });
    let seasons = null;
    let seasonError = null;
    if (String(req.query.kind || '').toLowerCase() === 'series') {
      try {
        seasons = await moviebox.seasonInfo(subjectId, { signal: request.signal });
      } catch (err) {
        if (request.signal.aborted || err?.name === 'AbortError') throw err;
        seasonError = errorText(err);
      }
    }
    if (request.signal.aborted) return;
    res.json({ ok: true, subjectId, details, seasons, seasonError });
  } finally {
    request.dispose();
  }
}));

router.post('/find/resolve', wrap(async (req, res) => {
  const { url, sourceId, title, year, kind, season, episode, probe: doProbe = true, useBrowser = true } = req.body || {};
  if (!url && !title) return res.status(400).json({ ok: false, error: 'url or title is required' });
  const request = requestAbortSignal(req, res);
  try {
    const resolved = await registry.resolveTarget({
      url, sourceId, title, year, kind,
      season: Number(season) || 0,
      episode: Number(episode) || 0,
      useBrowser,
      signal: request.signal,
    });
    const candidates = doProbe
      ? await registry.probeCandidates(resolved.candidates, { limit: cfg('scraper.maxCandidates'), signal: request.signal })
      : resolved.candidates;
    if (request.signal.aborted) return;
    log.info('api', 'resolve finished', {
      title: title || url, candidates: candidates.length, playable: candidates.filter((c) => c.ok).length,
    });
    res.json({
      ok: candidates.length > 0,
      candidates: candidates.map((c, i) => ({
        index: i,
        url: c.url,
        quality: c.quality,
        label: c.label,
        sourceId: c.sourceId,
        kind: c.kind,
        ok: c.ok,
        error: c.error || null,
        probe: c.probe ? {
          container: c.probe.container, durationSec: c.probe.durationSec, bitrate: c.probe.bitrate,
          video: c.probe.video, audio: c.probe.audio, subtitles: c.probe.subtitles,
        } : null,
        headers: Object.keys(c.headers || {}),
        variants: c.variants || null,
      })),
      timeline: resolved.timeline,
      error: resolved.error
        || (candidates.length ? null : 'no playable stream found — open the page in a browser, copy the final player/embed URL, or enable the external extractor'),
    });
  } finally {
    request.dispose();
  }
}));

/* ---------- streams ---------- */

router.get('/streams', wrap(async (req, res) => {
  const streams = await store.listStreams();
  res.json({
    ok: true,
    streams: streams.map((s) => ({ ...s, urls: store.urlsFor({ ...s, token: s.token }, baseUrlFrom(req)) })),
    sessions: relay.listSessions(),
  });
}));

router.post('/streams', wrap(async (req, res) => {
  const body = req.body || {};
  if (!body.candidate?.url) return res.status(400).json({ ok: false, error: 'candidate is required' });
  const stream = await store.createStream({
    title: body.title, year: body.year, kind: body.kind || 'movie', poster: body.poster,
    description: body.description, sourceId: body.sourceId, candidate: body.candidate,
    profile: body.profile || {}, subtitleId: body.subtitleId || null,
    season: body.season || null, episode: body.episode || null,
  });
  res.json({ ok: true, stream, urls: store.urlsFor(stream, baseUrlFrom(req)) });
}));

router.get('/streams/:id', wrap(async (req, res) => {
  const stream = await store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
  const session = relay.getSession(stream.id);
  res.json({
    ok: true,
    stream,
    urls: store.urlsFor(stream, baseUrlFrom(req)),
    session: session ? relay.publicSession(session) : null,
  });
}));

router.delete('/streams/:id', wrap(async (req, res) => {
  relay.stopSession(req.params.id, 'stream deleted');
  await store.removeStream(req.params.id);
  res.json({ ok: true });
}));

router.post('/streams/:id/profile', wrap(async (req, res) => {
  const stream = await store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
  const profile = normaliseProfile({ ...(stream.profile || {}), ...(req.body?.profile || {}) }, stream.upstream?.probe || null);
  stream.profile = profile;
  await store.createStream({ ...stream, candidate: { url: stream.upstream.url, headers: stream.upstream.headers, probe: stream.upstream.probe, sourceId: stream.source_id }, profile, title: stream.title, year: stream.year, kind: stream.kind });
  relay.stopSession(stream.id, 'profile changed');
  log.info('api', `profile updated for stream ${stream.id}`, { mode: profile.transcode ? 'transcode' : 'copy', resolution: profile.resolution, container: profile.container });
  res.json({ ok: true, profile, urls: store.urlsFor(stream, baseUrlFrom(req)) });
}));

/** The exact ffmpeg command for the current profile — shown in the UI and copy-pasteable. */
router.get('/streams/:id/command', wrap(async (req, res) => {
  const stream = await store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
  // Bounded wait: the command preview must render even while the GPU self-test
  // is still running (it falls back to the software shape with a clear note).
  const hw = await hardware({ waitMs: 15000 });
  const overrides = req.query.resolution || req.query.container || req.query.container === undefined
    ? {
      ...(req.query.resolution ? { resolution: Number(req.query.resolution) } : {}),
      ...(req.query.aspect ? { aspect: String(req.query.aspect) } : {}),
      ...(req.query.container ? { container: String(req.query.container) } : {}),
      ...(req.query.videoBitrate ? { videoBitrate: Number(req.query.videoBitrate) } : {}),
      ...(req.query.audioBitrate ? { audioBitrate: Number(req.query.audioBitrate) } : {}),
      ...(req.query.fps ? { fps: String(req.query.fps) } : {}),
      ...(req.query.subtitles ? { subtitles: String(req.query.subtitles) } : {}),
      ...(req.query.alwaysTranscode !== undefined ? { alwaysTranscode: req.query.alwaysTranscode === 'true' } : {}),
      ...(req.query.mode ? { mode: String(req.query.mode) } : {}),
    }
    : {};
  const profile = normaliseProfile({ ...(stream.profile || {}), ...overrides }, stream.upstream?.probe || null);
  const args = buildFfmpegArgs({
    source: { url: stream.upstream?.url, headers: stream.upstream?.headers || {}, kind: stream.upstream?.kind || undefined, container: stream.upstream?.probe?.container || null },
    profile, hw, mode: 'live', output: { container: profile.container, target: 'pipe:1' },
  });
  res.json({ ok: true, profile, hw: { available: hw.available, reason: hw.reason, fpsVariant: hw.fpsVariant, encoder: hw.encoder }, command: argsToCommand(args) });
}));

router.get('/streams/:id/session', wrap(async (req, res) => {
  const session = relay.getSession(req.params.id);
  res.json({ ok: true, session: session ? relay.publicSession(session) : null });
}));

router.post('/streams/:id/session', wrap(async (req, res) => {
  const stream = await store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
  const session = await relay.ensureSession(stream, { profile: req.body?.profile || {}, container: req.body?.container });
  res.json({ ok: true, session: relay.publicSession(session) });
}));

router.delete('/streams/:id/session', wrap(async (req, res) => {
  const stopped = relay.stopSession(req.params.id, 'user request');
  res.json({ ok: true, stopped });
}));

router.post('/streams/:id/playlist', wrap(async (req, res) => {
  const stream = await store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
  const urls = store.urlsFor(stream, baseUrlFrom(req));
  const items = parseStreamIds(req.body?.streamIds);
  let list = [stream];
  if (items.length > 1) {
    list = (await Promise.all(items.map((id) => store.getStream(id)))).filter(Boolean);
  }
  const m3u = exporter.buildM3U(list.map((s) => {
    const u = store.urlsFor(s, baseUrlFrom(req));
    return {
      title: `${s.title}${s.year ? ` (${s.year})` : ''}`,
      url: u.ts,
      logo: s.poster,
      quality: s.upstream?.quality,
      group: 'vu-movie',
      subtitle: req.body?.subtitlePath || undefined,
    };
  }), { name: 'vu-movie' });
  if (req.body?.save) {
    const file = exporter.writePlaylistFile(m3u, req.body?.filename || `vu-movie-${list.length}`);
    return res.json({ ok: true, playlist: m3u, file });
  }
  res.setHeader('Content-Type', 'audio/x-mpegurl');
  res.setHeader('Content-Disposition', `attachment; filename="vu-movie.m3u"`);
  log.info('api', `playlist generated for ${list.length} stream(s)`);
  res.send(m3u);
}));

router.post('/streams/:id/download', wrap(async (req, res) => {
  const stream = await store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
  const job = exporter.startDownload(stream, {
    profile: req.body?.profile || {},
    container: req.body?.container,
    filename: req.body?.filename || null,
    baseUrl: baseUrlFrom(req),
  });
  res.json({ ok: true, job: findJob(job.id) || { id: job.id } });
}));

router.get('/downloads', wrap(async (req, res) => {
  res.json({ ok: true, files: exporter.listDownloads() });
}));

/* ---------- probe ---------- */

router.get('/probe', wrap(async (req, res) => {
  const url = String(req.query.url || '');
  if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
  const headers = {};
  if (req.query.referer) headers.Referer = String(req.query.referer);
  if (req.query.cookie) headers.Cookie = String(req.query.cookie);
  const info = await probe(url, { headers });
  res.json({ ok: Boolean(info), probe: info });
}));

/* ---------- subtitles ---------- */

router.get('/subtitles/providers', wrap(async (req, res) => {
  res.json({ ok: true, providers: subs.listProviders() });
}));

router.post('/subtitles/search', wrap(async (req, res) => {
  const body = req.body || {};
  const stream = body.streamId ? await store.getStream(body.streamId) : null;
  const target = {
    title: body.title || stream?.title,
    year: body.year || stream?.year,
    kind: body.kind || stream?.kind || 'movie',
    season: body.season || stream?.upstream?.season || null,
    episode: body.episode || stream?.upstream?.episode || null,
    imdb: body.imdb || null,
    tmdb: body.tmdb || null,
    release: body.release || stream?.upstream?.label || null,
    languages: body.languages || cfg('subtitles.languages'),
  };
  if (!target.title) return res.status(400).json({ ok: false, error: 'title or streamId is required' });
  const results = await subs.searchSubtitles(target);
  res.json({ ok: true, target, results: results.slice(0, 80), providers: subs.listProviders() });
}));

router.post('/subtitles/download', wrap(async (req, res) => {
  const { result, offsetMs = 0, streamId = null, push = null, language = null } = req.body || {};
  if (!result?.providerId) return res.status(400).json({ ok: false, error: 'result is required' });
  const fetched = await subs.fetchSubtitle(result, { offsetMs: Number(offsetMs) || 0 });
  let stored = null;
  let stream = null;
  if (streamId) {
    stream = await store.getStream(streamId);
    if (stream) {
      stored = subs.storeSubtitle(fetched.srt, { slug: store.slugify(`${stream.title}-${stream.year || ''}`), language: fetched.language });
      stream.subtitle_id = path.basename(stored);
      stream.profile = { ...(stream.profile || {}), subtitlePath: stored, subtitleLanguage: fetched.language === 'nl' ? 'nld' : 'eng', subtitles: (stream.profile?.subtitles && stream.profile.subtitles !== 'none') ? stream.profile.subtitles : 'soft' };
      await store.createStream({ ...stream, candidate: { url: stream.upstream.url, headers: stream.upstream.headers, probe: stream.upstream.probe, sourceId: stream.source_id }, profile: stream.profile, title: stream.title, year: stream.year, kind: stream.kind });
      relay.stopSession(stream.id, 'subtitle changed');
    }
  }
  let pushResult = null;
  if (push) pushResult = await pushSubtitleToReceiver({ stream, language: language || fetched.language });
  res.json({ ok: true, ...fetched, stored, pushed: pushResult });
}));

router.post('/subtitles/push', wrap(async (req, res) => {
  const { streamId, language = null } = req.body || {};
  const stream = await store.getStream(streamId);
  if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
  const result = await pushSubtitleToReceiver({ stream, language });
  res.json({ ok: result.ok, ...result });
}));

router.post('/subtitles/providers/test', wrap(async (req, res) => {
  const id = req.body?.id;
  if (!id) return res.status(400).json({ ok: false, error: 'id is required' });
  res.json({ ok: true, result: await subs.testProvider(id) });
}));

router.post('/subtitles/providers', wrap(async (req, res) => {
  const provider = req.body || {};
  if (!provider.id || !provider.searchUrl) return res.status(400).json({ ok: false, error: 'id and searchUrl are required' });
  const current = (getConfig().subtitles.customProviders || []).filter((p) => p.id !== provider.id);
  saveConfig({ subtitles: { customProviders: [...current, provider] } });
  log.info('api', `custom subtitle provider saved: ${provider.id}`);
  res.json({ ok: true, providers: subs.listProviders() });
}));

router.delete('/subtitles/providers/:id', wrap(async (req, res) => {
  const current = (getConfig().subtitles.customProviders || []).filter((p) => p.id !== req.params.id);
  saveConfig({ subtitles: { customProviders: current } });
  res.json({ ok: true, providers: subs.listProviders() });
}));

async function pushSubtitleToReceiver({ stream, language }) {
  const cfgObject = getConfig().enigma2;
  if (!stream) return { ok: false, error: 'no stream' };
  const file = stream.profile?.subtitlePath;
  if (!file || !fs.existsSync(file)) return { ok: false, error: 'no subtitle file stored for this stream yet' };
  const name = `${store.slugify(`${stream.title}${stream.year ? `-${stream.year}` : ''}`)}.${language || 'sub'}.srt`;
  log.info('subtitles', 'pushing subtitle to the receiver', { file, name, dir: cfgObject.receiverDir || '/' });
  // Reuse the Enigma2 uploader: write the .srt next to the recordings.
  const target = cfgObject.receiverDir || '/media/hdd/movie';
  try {
    const result = spawnUpload(file, name, target);
    return result;
  } catch (err) {
    logError('subtitles', 'subtitle push failed', err);
    return { ok: false, error: errorText(err) };
  }
}

function spawnUpload(localFile, remoteName, remoteDir) {
  const enigma = getConfig().enigma2;
  if (!enigma.ftpEnabled) {
    // Without FTP we copy into the mounted share, if one is configured.
    const dir = enigma.mountDir || null;
    if (dir && fs.existsSync(dir)) {
      fs.copyFileSync(localFile, path.join(dir, remoteName));
      log.info('subtitles', 'subtitle copied into the mounted share', { dir, remoteName });
      return { ok: true, via: 'mount', path: path.join(dir, remoteName) };
    }
    return { ok: false, error: 'enable Enigma2 FTP or configure a mounted share to push subtitles' };
  }
  const target = `ftp://${enigma.host}:${enigma.ftpPort}/${String(remoteDir).replace(/^\//, '')}/${remoteName}`;
  const res = spawnSync('curl', ['-sS', '--fail', '--ftp-create-dirs', '-u', `${enigma.username}:${enigma.password || ''}`, '-T', localFile, target], { encoding: 'utf8', timeout: 30000 });
  if (res.error || res.status !== 0) {
    return { ok: false, error: res.error ? res.error.message : String(res.stderr || `exit ${res.status}`) };
  }
  log.info('subtitles', 'subtitle pushed over FTP', { target });
  return { ok: true, via: 'ftp', path: target };
}

/* ---------- enigma2 ---------- */

router.get('/enigma2/status', wrap(async (req, res) => {
  res.json({ ok: true, status: await enigma2.status() });
}));

router.post('/enigma2/preview', wrap(async (req, res) => {
  const ids = parseStreamIds(req.body?.streamIds);
  const streams = ids.length ? (await Promise.all(ids.map((id) => store.getStream(id)))).filter(Boolean)
    : (await store.listStreams()).slice(0, 25).map((s) => ({ ...s, token: s.token }));
  const entries = streams.map((s) => ({
    title: s.title, year: s.year, url: store.urlsFor(s, baseUrlFrom(req)).ts,
    description: `${s.title}${s.year ? ` (${s.year})` : ''} — ${s.upstream?.quality || s.quality || 'source'}${s.profile?.subtitles && s.profile.subtitles !== 'none' ? ` · ${(s.profile.subtitleLanguage || 'sub').toUpperCase()} subs` : ''}`,
    subtitle: s.profile?.subtitles && s.profile.subtitles !== 'none' ? (s.profile.subtitleLanguage || '').slice(0, 3) : null,
    season: s.upstream?.season || null,
    series: s.title,
  }));
  res.json({ ok: true, ...enigma2.previewBouquet(entries, { name: req.body?.name }) });
}));

router.post('/enigma2/push', wrap(async (req, res) => {
  const ids = parseStreamIds(req.body?.streamIds);
  const streams = ids.length ? (await Promise.all(ids.map((id) => store.getStream(id)))).filter(Boolean)
    : await store.listStreams();
  if (!streams.length) return res.status(400).json({ ok: false, error: 'no streams selected' });
  const entries = streams.map((s) => ({
    title: s.title, year: s.year, url: store.urlsFor(s, baseUrlFrom(req)).ts,
    description: `${s.title}${s.year ? ` (${s.year})` : ''} — ${s.upstream?.quality || s.quality || 'source'}`,
    subtitle: s.profile?.subtitles && s.profile.subtitles !== 'none' ? (s.profile.subtitleLanguage || '').slice(0, 3) : null,
    season: s.upstream?.season || null,
    series: s.title,
  }));
  const result = await enigma2.pushBouquet(entries, { name: req.body?.name, dryRun: Boolean(req.body?.dryRun) });
  res.status(result.ok ? 200 : 502).json(result);
}));

/* ---------- jobs ---------- */

router.get('/jobs', wrap(async (req, res) => {
  res.json({
    ok: true,
    jobs: listAllJobs(Number(req.query.limit || 50)),
    stats: jobStats(),
  });
}));

router.get('/jobs/:id', wrap(async (req, res) => {
  const job = findJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'job not found' });
  res.json({ ok: true, job });
}));

router.post('/jobs/:id/cancel', wrap(async (req, res) => {
  const result = cancelJob(req.params.id);
  log.info('api', `cancel requested for job ${req.params.id}`, { ok: result.ok, status: result.status || result.error });
  res.json({ ok: result.ok, result });
}));

/* ---------- moviebox helper (search is part of /find/search) ---------- */

router.get('/moviebox/status', wrap(async (req, res) => res.json({ ok: true, status: moviebox.status() })));

export default router;
