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
import { log, logError, errorText, getRecentLogs, knownComponents, getLogLevel, setLogLevel, subscribeLogs } from '../core/log.js';
import { getConfig, publicConfig, saveConfig, validateConfigPatch, cfg } from '../core/config.js';
import { dbState, isPostgres } from '../core/db.js';
import {
  hardware, hardwareStatus, hardwarePending, binariesStatus,
  diagnoseFfmpeg, probe, buildFfmpegArgs, normaliseProfile, argsToCommand, validateFfmpegTemplate,
  probeSubtitleList,
} from '../core/media.js';
import {
  buildTemplateCommand, parseTemplateCommand, renderTemplate, validateTemplateOptions,
  normaliseTemplateOptions, templateOptionsSchema, TEMPLATE_CONTAINERS,
} from '../core/ffmpeg-options.js';
import { jobEvents, findJob, listAllJobs, jobStats, cancelJob } from '../core/jobs.js';
import * as registry from '../scrapers/registry.js';
import * as moviebox from '../scrapers/moviebox.js';
import * as browser from '../scrapers/browser.js';
import * as external from '../scrapers/external.js';
import * as store from '../streams/store.js';
import * as relay from '../streams/relay.js';
import * as exporter from '../streams/export.js';
import * as subs from '../subtitles/index.js';
import * as enigma2 from '../enigma2/index.js';
import { fetchPosterImage, posterProxyUrl, posterSource, publicPosterUrl } from './poster-proxy.js';
import { pushSubtitleToReceiver } from '../subtitles/push.js';
import * as metadata from '../metadata/index.js';
import * as discovery from '../metadata/discovery.js';
import * as playlist from '../playlist/index.js';
import { reconfigurePlaylistMaintenance } from '../playlist/maintenance.js';
import { ensureStreamReady } from '../streams/recovery.js';

const router = express.Router();
const startedAt = Date.now();

/* ---------- small helpers ---------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  if (req.aborted || res.destroyed) return;
  logError('api', `${req.method} ${req.originalUrl} failed`, err);
  res.status(err.status || 500).json({ ok: false, error: errorText(err) });
});

export function requestAbortSignal(req, res) {
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

/** Return a fresh same-origin poster URL without mutating the stored record. */
function publicStreamRecord(stream) {
  if (!stream) return stream;
  const referer = stream.payload?.meta?.posterReferer || stream.posterReferer || '';
  const { posterReferer: _posterReferer, ...publicFields } = stream;
  return {
    ...publicFields,
    poster: stream.poster ? publicPosterUrl(stream.poster, referer) : '',
  };
}

function parseStreamIds(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  return String(input).split(',').map((s) => s.trim()).filter(Boolean);
}

function inputError(message) {
  const error = new Error(message);
  error.status = 422;
  return error;
}

/** A template is usable unless it was explicitly disabled in the editor. */
function templateUsable(item) {
  return Boolean(item) && item.enabled !== false;
}

function resolveTemplateProfile(input = {}) {
  const profile = { ...(input || {}) };
  if (profile.ffmpegTemplate || !profile.ffmpegTemplateId) return profile;
  const template = (getConfig().transcode.ffmpegTemplates || []).find((item) => item?.id === profile.ffmpegTemplateId);
  if (!template) throw inputError(`FFmpeg template "${profile.ffmpegTemplateId}" was not found`);
  if (!templateUsable(template)) {
    log.warn('api', `FFmpeg template "${profile.ffmpegTemplateId}" is disabled — falling back to the guided profile builder`);
    return { ...profile, ffmpegTemplateId: '' };
  }
  return {
    ...profile,
    container: template.container || profile.container,
    ffmpegTemplate: template.command,
    ffmpegTemplateName: template.name || '',
  };
}

/** Output types the per-output template picker knows about. */
const OUTPUT_TYPES = ['vlcTs', 'vlcMkv', 'm3u8', 'm3u', 'enigma2', 'direct', 'download'];
const OUTPUT_LABELS = {
  vlcTs: 'VLC / any player (.ts)',
  vlcMkv: 'VLC / any player (.mkv)',
  m3u8: 'Playlist (.m3u8)',
  m3u: 'Playlist (.m3u)',
  enigma2: 'Enigma2 / Duo2',
  direct: 'Direct upstream link',
  download: 'Download to NAS',
  // Not in OUTPUT_TYPES on purpose: the browser preview session is built by the
  // app (no subtitles, codecs from the browser's own report), never from an
  // operator template. The label only names it in the sessions list.
  web: 'Web preview (no subtitles)',
};
export { OUTPUT_TYPES, OUTPUT_LABELS };

function normaliseTemplateOutput(o) {
  const out = {};
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  for (const [key, value] of Object.entries(o)) {
    if (!OUTPUT_TYPES.includes(key)) continue;
    out[key] = String(value || '').trim();
  }
  return out;
}

/**
 * One template from the editor.
 *
 * `options` (the structured fields of the Transcode-templates tab) is
 * authoritative when present: the command is rendered from it, so the stored
 * command can never disagree with the fields the operator sees. A template
 * without `options` (the Stream tab's inline "save as template", or a library
 * saved by an older version) keeps its command verbatim.
 */
function validateTemplateItem(item, index, seen) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw inputError(`Template ${index + 1} must be an object`);
  const id = String(item.id || '').trim();
  const name = String(item.name || '').trim();
  const container = String(item.container || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw inputError(`Template ${index + 1} has an invalid id`);
  if (seen.has(id)) throw inputError(`Duplicate FFmpeg template id: ${id}`);
  seen.add(id);
  if (!name || name.length > 100) throw inputError(`Template ${name || index + 1} needs a name of 1–100 characters`);
  if (!TEMPLATE_CONTAINERS.includes(container)) throw inputError(`Template "${name}" has an unsupported container`);
  const enabled = item.enabled !== false;
  const description = String(item.description || '').trim().slice(0, 280);
  const output = normaliseTemplateOutput(item.output);

  const hasOptions = item.options && typeof item.options === 'object' && !Array.isArray(item.options);
  let options = null;
  let command = String(item.command || '').trim();
  if (hasOptions) {
    const errors = validateTemplateOptions(item.options, { container });
    if (errors.length) throw inputError(`Template "${name}": ${errors.join('; ')}`);
    options = normaliseTemplateOptions(item.options, { container });
    command = buildTemplateCommand(options, { container });
  }
  const result = validateFfmpegTemplate(command, { container });
  if (!result.ok) throw inputError(`Template "${name}": ${result.errors.join('; ')}`);
  return { id, name, container, command, output, description, enabled, options };
}

function validateTemplateLibrary(body = {}) {
  const input = body.templates;
  if (!Array.isArray(input)) throw inputError('templates must be an array');
  if (input.length > 50) throw inputError('You can save at most 50 FFmpeg templates');
  const seen = new Set();
  const templates = input.map((item, index) => validateTemplateItem(item, index, seen));
  const currentDefault = getConfig().transcode.defaultFfmpegTemplateId || '';
  const defaultFfmpegTemplateId = body.defaultFfmpegTemplateId === undefined
    ? currentDefault
    : String(body.defaultFfmpegTemplateId || '').trim();
  if (defaultFfmpegTemplateId && !seen.has(defaultFfmpegTemplateId)) {
    throw inputError('The default template must be one of the saved templates');
  }
  const ffmpegDefaults = normaliseTemplateOutput(body.ffmpegDefaults);
  for (const [output, tplId] of Object.entries(ffmpegDefaults)) {
    if (tplId && !seen.has(tplId)) throw inputError(`Default template for ${OUTPUT_LABELS[output] || output} must be one of the saved templates`);
  }
  return { templates, defaultFfmpegTemplateId, ffmpegDefaults };
}

function commandOutput(profile, stream) {
  if (profile.container === 'hls') {
    const hlsDir = path.join(getConfig().storage.tmp, 'hls-preview', String(stream.token || stream.id));
    return { container: 'hls', target: path.join(hlsDir, 'index.m3u8'), hlsDir, hlsTime: 2, hlsListSize: 10 };
  }
  return { container: profile.container, target: 'pipe:1' };
}

/* ---------- health / logs / config ---------- */

router.get('/health', wrap(async (req, res) => {
  // Make sure a detection run exists, but never *wait* for it: this endpoint is
  // the container healthcheck and a slow vaapi self-test must not time it out.
  // Callers get the `pending` placeholder until the result is in.
  hardware();
  const hw = hardwareStatus();
  const binaries = binariesStatus() || { ffmpeg: { ok: false, pending: true }, ffprobe: { ok: false, pending: true } };
  // Last known receiver state only — this endpoint answers the container
  // healthcheck every 30 s and the dashboard every 15 s, and neither is a
  // reason to send a request to the box. The receiver is checked on demand
  // (GET /api/enigma2/status) and when a bouquet is pushed.
  const enigma = enigma2.cachedStatus();
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
    // Cloudflare-protected sources silently degrade when this is missing, so
    // report it here rather than only in a scraper log line.
    flaresolverr: await browser.flaresolverrStatus({ probe: true, maxAgeMs: 300_000 }).catch((e) => ({ configured: false, error: errorText(e) })),
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
  // Values that end up inside an URL an IPTV app has to fetch (the Xtream
  // account) are rejected here, so the Settings tab reports them instead of
  // saving a password no player can request a stream with.
  const problems = validateConfigPatch(patch);
  if (problems.length) {
    log.warn('api', 'config update rejected', { problems: problems.join(' ') });
    return res.status(400).json({ ok: false, error: `Settings not saved. ${problems.join(' ')}` });
  }
  saveConfig(patch);
  if (patch.app?.logLevel) setLogLevel(patch.app.logLevel);
  if (patch.enigma2) enigma2.resetStatusCache();
  if (patch.playlist) reconfigurePlaylistMaintenance();
  res.json({ ok: true, config: publicConfig(), changed: Object.keys(patch) });
}));

router.get('/ffmpeg/templates', wrap(async (req, res) => {
  const transcode = getConfig().transcode;
  res.json({
    ok: true,
    templates: transcode.ffmpegTemplates || [],
    defaultFfmpegTemplateId: transcode.defaultFfmpegTemplateId || '',
    ffmpegDefaults: transcode.ffmpegDefaults || {},
    outputTypes: OUTPUT_TYPES,
    outputLabels: OUTPUT_LABELS,
    // The parameter form is drawn from this schema, so the browser never has
    // to keep a second copy of the field list in sync with the server.
    schema: templateOptionsSchema(),
  });
}));

/**
 * The structured FFmpeg parameters of the Transcode-templates tab.
 *
 * `POST /build`  turns fields into the command (what the editor previews and
 *                what the relay executes);
 * `POST /parse`  turns an existing command back into fields, so templates
 *                written by hand (or by an older version) become editable.
 *
 * Both are pure: they touch no stream, no ffmpeg process and no database, so
 * the editor can call them on every keystroke without side effects.
 */
router.post('/ffmpeg/templates/build', wrap(async (req, res) => {
  const options = req.body?.options;
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw inputError('options must be an object');
  const container = String(req.body?.container || options.output_format || '').trim() || null;
  const rendered = renderTemplate(options, { container });
  // `ok` means "the request was understood": a field that still needs fixing
  // comes back in `errors` *with* the rendered command, so the editor can show
  // what the parameters currently produce while the operator finishes typing.
  res.json({
    ok: true,
    ...rendered,
    options: normaliseTemplateOptions(options, { container }),
  });
}));

router.post('/ffmpeg/templates/parse', wrap(async (req, res) => {
  const command = String(req.body?.command || '').trim();
  if (!command) throw inputError('command is required');
  const container = String(req.body?.container || '').trim() || null;
  const base = req.body?.base && typeof req.body.base === 'object' && !Array.isArray(req.body.base) ? req.body.base : null;
  const parsed = parseTemplateCommand(command, { base, container });
  const errors = validateTemplateOptions(parsed.options, { container });
  res.json({ ok: true, options: parsed.options, warnings: parsed.warnings, errors });
}));

/** The parameter schema on its own (the editor fetches the library with it). */
router.get('/ffmpeg/templates/schema', wrap(async (req, res) => {
  res.json({ ok: true, schema: templateOptionsSchema() });
}));

router.put('/ffmpeg/templates', wrap(async (req, res) => {
  const { templates, defaultFfmpegTemplateId, ffmpegDefaults } = validateTemplateLibrary(req.body || {});
  saveConfig({
    transcode: {
      ffmpegTemplates: templates,
      defaultFfmpegTemplateId,
      ffmpegDefaults,
    },
  });
  log.info('api', 'FFmpeg template library saved', {
    templates: templates.length,
    hasDefault: Boolean(defaultFfmpegTemplateId),
    perOutputDefaults: Object.values(ffmpegDefaults || {}).filter(Boolean).length,
  });
  res.json({ ok: true, templates, defaultFfmpegTemplateId, ffmpegDefaults });
}));

/**
 * Run a saved or inline FFmpeg template against a real stream for a short
 * window so the operator can confirm it works before binding it to an output
 * slot. Three endpoints:
 *   POST /api/ffmpeg/templates/:id/test   — looks up a saved template by id
 *   POST /api/ffmpeg/test                 — accepts a raw template string
 *
 * Both share the same body shape:
 *   { streamId, durationMs?, outputType?, container? }
 *
 * When `streamId` is omitted but `url` / `headers` are present, an ephemeral
 * stream record is constructed so the test can run against an arbitrary URL
 * without needing a saved stream — useful for one-off probes.
 */
function parseTestBody(body = {}) {
  const streamId = String(body.streamId || '').trim();
  const url = String(body.url || '').trim();
  if (!streamId && !url) throw inputError('streamId or url is required');
  const durationMs = Number(body.durationMs);
  const outputType = String(body.outputType || '').trim();
  return { streamId, url, durationMs: Number.isFinite(durationMs) ? durationMs : 5000, outputType };
}

async function runTemplateTestForRequest(req, template, templateId = '') {
  const { streamId, url, durationMs, outputType } = parseTestBody(req.body || {});
  let stream = null;
  if (streamId) {
    stream = await store.getStream(streamId);
    if (!stream) throw inputError(`stream "${streamId}" not found`);
  } else {
    // Ephemeral: take a custom URL and headers from the body. The token is
    // synthesised so the result log can label it.
    const headers = (body => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
      const out = {};
      for (const [k, v] of Object.entries(body)) if (typeof v === 'string' && v) out[k] = v;
      return out;
    })(req.body?.headers || {});
    stream = {
      id: `probe-${Date.now().toString(36)}`,
      token: `probe-${Date.now().toString(36)}`,
      title: 'ad-hoc template test',
      upstream: { url, headers, kind: null, probe: null },
      profile: {},
    };
  }
  const result = await relay.runTemplateTest({
    template,
    container: String(req.body?.container || '').trim() || null,
    durationMs,
    outputType,
    stream,
    templateId,
  });
  log.info('api', 'template test finished', {
    templateId, streamId: stream.id, url: stream.upstream?.url, outputType, ok: result.ok,
    bytesOut: result.bytesOut, durationMs: result.durationMs, exitCode: result.exitCode, signal: result.signal,
  });
  return result;
}

router.post('/ffmpeg/templates/:id/test', wrap(async (req, res) => {
  const template = (getConfig().transcode.ffmpegTemplates || []).find((t) => t?.id === req.params.id);
  if (!template) return res.status(404).json({ ok: false, error: `FFmpeg template "${req.params.id}" not found` });
  const result = await runTemplateTestForRequest(req, template.command, template.id);
  res.json({
    ok: true,
    result,
    template: { id: template.id, name: template.name, container: template.container, output: template.output || {} },
  });
}));

router.post('/ffmpeg/test', wrap(async (req, res) => {
  const command = String(req.body?.command || '').trim();
  if (!command) throw inputError('command is required');
  const name = String(req.body?.name || 'inline').trim().slice(0, 100) || 'inline';
  const container = String(req.body?.container || '').trim() || null;
  const result = await runTemplateTestForRequest(req, command, '');
  res.json({
    ok: true,
    result,
    template: { id: '', name, container: container || null, output: {} },
  });
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
  registry.resetSourceHealth(sourceId);
  // detailed: true so a failing test carries *why* (how many links the page
  // exposed, whether a pop-under replaced the tab, how long we waited) instead
  // of an empty list the operator has to guess about.
  const outcome = await registry.searchSource(source, query || 'matrix', { detailed: true });
  res.json({
    ok: true,
    results: outcome.results,
    error: outcome.error || null,
    diagnostics: outcome.diagnostics || null,
    health: registry.healthOf(sourceId),
  });
}));

/** Reset the circuit breaker for a source (or all sources when id="*"). */
router.post('/sources/reset-health', wrap(async (req, res) => {
  const sourceId = (req.body?.sourceId || req.query.sourceId || '').trim();
  if (sourceId === '*' || !sourceId) {
    registry.resetSourceHealth();
    try { moviebox.resetBackoff?.(); } catch { /* moviebox may not be loaded */ }
    log.info('api', 'source health reset (all sources)');
  } else {
    registry.resetSourceHealth(sourceId);
    if (sourceId === 'moviebox') {
      try { moviebox.resetBackoff?.(); } catch { /* ignore */ }
    }
    log.info('api', `source health reset: ${sourceId}`);
  }
  res.json({ ok: true, sources: registry.listSources(), moviebox: moviebox.status() });
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
    res.json({
      ok: true, subjectId, details, seasons, seasonError,
      // Normalized copy for the series picker (same shape as /find/series).
      normalizedSeasons: seasons ? moviebox.normalizeSeasonInfo(seasons) : [],
    });
  } finally {
    request.dispose();
  }
}));

/**
 * Series season/episode discovery for the Selected-title picker.
 *
 * Auto chain (see src/scrapers/series.js): MovieBox season-info when a
 * subjectId is known (or findable by title) → TMDB season list → none (the
 * UI falls back to manual season/episode numbers).
 */
router.get('/find/series', wrap(async (req, res) => {
  const request = requestAbortSignal(req, res);
  try {
    const { getSeriesSeasons } = await import('../scrapers/series.js');
    const outcome = await getSeriesSeasons({
      subjectId: req.query.subjectId ? String(req.query.subjectId) : null,
      title: req.query.title ? String(req.query.title) : '',
      year: req.query.year ? Number(req.query.year) : null,
      tmdbId: req.query.tmdbId ? String(req.query.tmdbId) : null,
      imdbId: req.query.imdbId ? String(req.query.imdbId) : null,
      signal: request.signal,
    });
    if (request.signal.aborted) return;
    res.json({ ok: true, ...outcome });
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
      season: Number(req.body?.season) || 0,
      episode: Number(req.body?.episode) || 0,
      candidates: candidates.map((c, i) => ({
        index: i,
        url: c.url,
        quality: c.quality,
        label: c.label,
        sourceId: c.sourceId,
        kind: c.kind,
        ok: c.ok,
        error: c.error || null,
        // The requested S/E, echoed so the series picker can group candidates
        // per episode without guessing which resolve they came from.
        season: Number(c.season ?? c.meta?.season ?? req.body?.season) || null,
        episode: Number(c.episode ?? c.meta?.episode ?? req.body?.episode) || null,
        probe: c.probe ? {
          container: c.probe.container, durationSec: c.probe.durationSec, bitrate: c.probe.bitrate,
          video: c.probe.video, audio: c.probe.audio, subtitles: c.probe.subtitles,
        } : null,
        // Full values, not just the names: the UI posts this candidate back to
        // POST /api/streams, and the relay has to replay the Cookie/Referer the
        // resolver captured. Sending names alone made every stored stream carry
        // `['Referer','User-Agent']`, which reached ffmpeg as `0: Referer`.
        headers: c.headers || {},
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
    streams: streams.map((s) => ({ ...publicStreamRecord(s), urls: store.urlsFor({ ...s, token: s.token }, baseUrlFrom(req)) })),
    sessions: relay.listSessions(),
  });
}));

router.post('/streams', wrap(async (req, res) => {
  const body = req.body || {};
  if (!body.candidate?.url) return res.status(400).json({ ok: false, error: 'candidate is required' });
  // Search results carry a short-lived signed /api/poster URL. Persist its
  // durable remote source instead, then issue a new proxy URL when reading.
  const artwork = posterSource(body.poster);
  // `ephemeral` backs the ▶ preview button on search results: a playable
  // stream that is never listed (no playlist row, no .m3u, no bouquet) and is
  // deleted when the preview closes, so it gets no subtitle or bouquet chores.
  const ephemeral = body.ephemeral === true;
  const stream = await store.createStream({
    title: body.title, year: body.year, kind: body.kind || 'movie', poster: artwork?.url || null,
    posterReferer: artwork?.referer || '',
    description: body.description, sourceId: body.sourceId, candidate: body.candidate,
    profile: body.profile || {}, subtitleId: body.subtitleId || null,
    season: body.season || null, episode: body.episode || null, ephemeral,
  });
  const subtitleResult = !ephemeral && body.subtitleResult && typeof body.subtitleResult === 'object' ? body.subtitleResult : null;
  let subtitleError = null;
  if (subtitleResult) {
    try {
      const fetched = await subs.fetchSubtitle(subtitleResult);
      await attachSubtitleToStream(stream, fetched);
      log.info('subtitles', `selected subtitle attached to "${stream.title}"`, { provider: fetched.provider, language: fetched.language });
      if (getConfig().subtitles.pushToReceiver) {
        const pushed = await pushSubtitleToReceiver({ stream, language: fetched.language });
        if (!pushed.ok) log.warn('subtitles', 'could not push the selected subtitle to the receiver', { error: pushed.error });
      }
    } catch (err) {
      subtitleError = errorText(err);
      logError('subtitles', `selected subtitle could not be attached to "${stream.title}"`, err, { stream: stream.id });
    }
  }
  res.json({ ok: true, stream: publicStreamRecord(stream), urls: store.urlsFor(stream, baseUrlFrom(req)), ...(subtitleError ? { subtitleError } : {}) });
  if (!ephemeral) afterStreamCreated(stream, baseUrlFrom(req), { skipSubtitleSearch: Boolean(subtitleResult) });
}));

/**
 * The chores the settings promise for every new stream, without ever failing
 * the request that created it: the subtitle search requested in
 * requirements.md (`subtitles.autoSearch`, default on) and the automatic
 * bouquet re-push (`enigma2.autoPush`, default off).
 *
 * Both ran nowhere before — autoFetch() existed but was called by nothing, so
 * the toggles were decoration and a resolved title never got a subtitle unless
 * the user searched manually. An explicitly selected subtitle takes priority
 * and suppresses the automatic search for that stream.
 */
function afterStreamCreated(stream, baseUrl, { skipSubtitleSearch = false } = {}) {
  const cfgObject = getConfig();
  if (cfgObject.subtitles.autoSearch && !skipSubtitleSearch) {
    autoAttachSubtitle(stream).catch((err) => {
      logError('subtitles', 'automatic subtitle search failed', err, { stream: stream.id, title: stream.title });
    });
  }
  if (cfgObject.enigma2.autoPush) {
    (async () => {
      const entries = bouquetEntries(await store.listStreams(), baseUrl);
      const result = await enigma2.pushBouquet(entries, { name: cfgObject.enigma2.bouquetName });
      if (result.ok) log.info('enigma2', `bouquet auto-pushed after "${stream.title}"`, { entries: entries.length, via: result.transport?.via });
      else log.warn('enigma2', 'automatic bouquet push failed — check the receiver settings', { error: result.error });
    })().catch((err) => logError('enigma2', 'automatic bouquet push failed', err, { stream: stream.id }));
  }
}

/** Search + attach the best subtitle for a stream that was just created. */
async function autoAttachSubtitle(stream) {
  const cfgObject = getConfig();
  const target = {
    title: stream.title, year: stream.year, kind: stream.kind,
    season: stream.upstream?.season || null, episode: stream.upstream?.episode || null,
    languages: cfgObject.subtitles.languages,
  };
  const fetched = await subs.autoFetch(target);
  if (!fetched) return;
  await attachSubtitleToStream(stream, fetched);
  log.info('subtitles', `subtitle attached automatically to "${stream.title}"`, { language: fetched.language });
  if (cfgObject.subtitles.pushToReceiver) {
    const pushed = await pushSubtitleToReceiver({ stream, language: fetched.language });
    if (!pushed.ok) log.warn('subtitles', 'could not push the subtitle to the receiver', { error: pushed.error });
  }
}

/** Store a fetched subtitle next to the stream and re-create it with the soft mux. */
async function attachSubtitleToStream(stream, fetched) {
  const stored = subs.storeSubtitle(fetched.srt, { slug: store.slugify(`${stream.title}-${stream.year || ''}`), language: fetched.language });
  stream.subtitle_id = path.basename(stored);
  stream.profile = {
    ...(stream.profile || {}),
    subtitlePath: stored,
    subtitleLanguage: fetched.language === 'nl' ? 'nld' : 'eng',
    subtitles: (stream.profile?.subtitles && stream.profile.subtitles !== 'none') ? stream.profile.subtitles : 'soft',
  };
  await store.createStream({
    ...stream,
    candidate: { url: stream.upstream.url, headers: stream.upstream.headers, probe: stream.upstream.probe, sourceId: stream.source_id },
    profile: stream.profile, title: stream.title, year: stream.year, kind: stream.kind,
  });
  relay.stopSession(stream.id, 'subtitle changed');
  return stored;
}

/** The bouquet entry shape shared by preview, push and auto-push. */
function bouquetEntries(streams, baseUrl) {
  return streams.map((s) => {
    // `urlsFor().forBox` already returns a `.ts.enigma2` URL — that suffix
    // survives `encodeE2Url` in the Enigma2 service-ref builder, so the
    // receiver request lands on the `enigma2` template slot instead of the
    // generic VLC/.ts slot.
    const url = store.urlsFor(s, baseUrl).forBox;
    return {
      title: s.title, year: s.year, url,
      description: `${s.title}${s.year ? ` (${s.year})` : ''} — ${s.upstream?.quality || s.quality || 'source'}`,
      subtitle: s.profile?.subtitles && s.profile.subtitles !== 'none' ? (s.profile.subtitleLanguage || '').slice(0, 3) : null,
      season: s.upstream?.season || null,
      series: s.title,
    };
  });
}

router.get('/streams/:id', wrap(async (req, res) => {
  const stream = await store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
  const session = relay.getSession(stream.id);
  res.json({
    ok: true,
    stream: publicStreamRecord(stream),
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
  const incoming = req.body?.profile || {};
  // Preserve the per-output template map when present, otherwise the legacy
  // single-template fields would erase it on save (and every output but the one
  // typed into the form would suddenly fall back to the global default).
  const merged = { ...(stream.profile || {}), ...incoming };
  if (incoming.outputTemplates === null) delete merged.outputTemplates;
  const input = resolveTemplateProfile(merged);
  if (input.ffmpegTemplate) {
    const result = validateFfmpegTemplate(input.ffmpegTemplate, { container: input.container || getConfig().transcode.container });
    if (!result.ok) throw inputError(result.errors.join('; '));
  }
  const profile = normaliseProfile(input, stream.upstream?.probe || null);
  // Validate every per-output template id the user is saving — a stale id from
  // a deleted template would silently bind to nothing.
  if (profile.outputTemplates && typeof profile.outputTemplates === 'object') {
    const libraryIds = new Set((getConfig().transcode.ffmpegTemplates || []).map((t) => t.id));
    for (const [output, tplId] of Object.entries(profile.outputTemplates)) {
      if (!tplId) { delete profile.outputTemplates[output]; continue; }
      if (!libraryIds.has(tplId)) throw inputError(`Output template for ${output} no longer exists`);
    }
  }
  stream.profile = profile;
  await store.createStream({
    ...stream,
    candidate: { url: stream.upstream.url, headers: stream.upstream.headers, probe: stream.upstream.probe, sourceId: stream.source_id },
    profile, title: stream.title, year: stream.year, kind: stream.kind,
  });
  relay.stopSession(stream.id, 'profile changed');
  log.info('api', `profile updated for stream ${stream.id}`, {
    mode: profile.ffmpegTemplate ? 'template' : profile.transcode ? 'transcode' : 'copy',
    resolution: profile.resolution, container: profile.container,
    perOutputTemplates: Object.values(profile.outputTemplates || {}).filter(Boolean).length,
  });
  res.json({ ok: true, profile, urls: store.urlsFor(stream, baseUrlFrom(req)) });
}));

/**
 * Resolve the FFmpeg template that should be used for the given output type.
 *
 * Precedence (highest first):
 *   1. an explicit `outputTemplates[outputType]` set on the stream profile
 *   2. an explicit `ffmpegTemplate` / `ffmpegTemplateId` set on the stream profile
 *   3. the global `ffmpegDefaults[outputType]`
 *   4. the global `defaultFfmpegTemplateId`
 *   5. nothing — guided profile builder
 *
 * Returns an object with at least `templateId` (or empty string), `command`,
 * `container`, `name`. `source` is one of "stream-output", "stream", "global-output",
 * "global", "guided" so the UI can show *why* a given template is in use.
 */
function resolveOutputTemplate(profile = {}, outputType = '') {
  const cfgTrans = getConfig().transcode || {};
  const templates = Array.isArray(cfgTrans.ffmpegTemplates) ? cfgTrans.ffmpegTemplates : [];
  const defaults = cfgTrans.ffmpegDefaults && typeof cfgTrans.ffmpegDefaults === 'object' ? cfgTrans.ffmpegDefaults : {};
  const streamOutputTemplates = profile.outputTemplates && typeof profile.outputTemplates === 'object' && !Array.isArray(profile.outputTemplates)
    ? profile.outputTemplates : {};

  // A disabled template is not a candidate: the output falls through to the
  // next binding (or to the guided profile builder) instead of failing.
  const pickFromLibrary = (id) => templates.find((item) => templateUsable(item) && item?.id === id && typeof item.command === 'string');

  let picked = null;
  let source = 'guided';
  let templateId = '';
  let perOutputKey = '';

  // Per-output bindings always win: a stream that explicitly assigns
  // `enigma2` to a 720p template expects exactly that, regardless of which
  // template the stream was created with.
  if (outputType && streamOutputTemplates[outputType]) {
    picked = pickFromLibrary(streamOutputTemplates[outputType]);
    if (picked) { templateId = picked.id; source = 'stream-output'; perOutputKey = outputType; }
  }
  // Global per-output defaults come next: every stream that did not override
  // its own Enigma2 template still uses the operator's chosen 720p command.
  if (!picked && outputType && defaults[outputType]) {
    picked = pickFromLibrary(defaults[outputType]);
    if (picked) { templateId = picked.id; source = 'global-output'; perOutputKey = outputType; }
  }
  // The stream's legacy single-template id is the fallback: it applied to
  // every output when no per-output binding existed. New streams that come in
  // with a per-output default get the global one only if they did not
  // override it; existing streams with a single ffmpegTemplateId keep that
  // behaviour unless the operator edits their per-output map.
  if (!picked && profile.ffmpegTemplateId) {
    picked = pickFromLibrary(profile.ffmpegTemplateId);
    if (picked) { templateId = picked.id; source = 'stream'; }
  }
  if (!picked && cfgTrans.defaultFfmpegTemplateId) {
    picked = pickFromLibrary(cfgTrans.defaultFfmpegTemplateId);
    if (picked) { templateId = picked.id; source = 'global'; }
  }
  if (!picked && profile.ffmpegTemplate && typeof profile.ffmpegTemplate === 'string' && profile.ffmpegTemplate.trim()) {
    // An inline custom command — used as is. No template id, but a command.
    return {
      templateId: '',
      name: profile.ffmpegTemplateName || 'Custom template',
      container: profile.container || '',
      command: profile.ffmpegTemplate,
      source: 'stream-custom',
      perOutputKey,
    };
  }
  if (!picked) return { templateId: '', name: '', container: '', command: '', source: 'guided', perOutputKey: '' };
  return {
    templateId: picked.id,
    name: picked.name || '',
    container: picked.container || '',
    command: picked.command,
    source,
    perOutputKey,
  };
}

function applyOutputTemplateToProfile(profileInput, template) {
  if (!template || !template.command) return profileInput;
  return {
    ...profileInput,
    container: template.container || profileInput.container,
    ffmpegTemplate: template.command,
    ffmpegTemplateId: template.templateId || '',
    ffmpegTemplateName: template.name || '',
  };
}

async function renderStreamCommand(stream, profileInput, { outputType = '' } = {}) {
  const baseProfile = { ...(stream.profile || {}), ...(profileInput || {}) };
  const template = resolveOutputTemplate(baseProfile, outputType);
  const resolved = applyOutputTemplateToProfile(baseProfile, template);
  const profile = normaliseProfile(resolved, stream.upstream?.probe || null);
  if (profile.ffmpegTemplate) {
    const result = validateFfmpegTemplate(profile.ffmpegTemplate, { container: profile.container });
    if (!result.ok) throw inputError(result.errors.join('; '));
  }
  // Custom templates own all codec/muxer options, so they do not need to wait
  // for the VAAPI self-test just to render a command preview.
  const hw = profile.ffmpegTemplate
    ? { available: null, reason: 'custom FFmpeg template is authoritative', fpsVariant: null, encoder: null }
    : await hardware({ waitMs: 15000 });
  const args = buildFfmpegArgs({
    source: {
      url: stream.upstream?.url, headers: stream.upstream?.headers || {},
      kind: stream.upstream?.kind || undefined,
      container: stream.upstream?.probe?.container || null,
      subtitles: probeSubtitleList(stream.upstream?.probe),
    },
    profile, hw, mode: 'live', output: commandOutput(profile, stream),
  });
  return {
    profile,
    hw: { available: hw.available, reason: hw.reason, fpsVariant: hw.fpsVariant, encoder: hw.encoder },
    command: argsToCommand(args),
    template: { ...template, outputType },
  };
}

/** The exact ffmpeg command for the current profile or selected template. */
router.get('/streams/:id/command', wrap(async (req, res) => {
  const stream = await store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
  const overrides = {
    ...(req.query.resolution ? { resolution: Number(req.query.resolution) } : {}),
    ...(req.query.aspect ? { aspect: String(req.query.aspect) } : {}),
    ...(req.query.container ? { container: String(req.query.container) } : {}),
    ...(req.query.videoBitrate ? { videoBitrate: Number(req.query.videoBitrate) } : {}),
    ...(req.query.audioBitrate ? { audioBitrate: Number(req.query.audioBitrate) } : {}),
    ...(req.query.audioChannels ? { audioChannels: Number(req.query.audioChannels) } : {}),
    ...(req.query.fps ? { fps: String(req.query.fps) } : {}),
    ...(req.query.subtitles ? { subtitles: String(req.query.subtitles) } : {}),
    ...(req.query.alwaysTranscode !== undefined ? { alwaysTranscode: req.query.alwaysTranscode === 'true' } : {}),
    ...(req.query.mode ? { mode: String(req.query.mode) } : {}),
    ...(req.query.outputType ? { _outputType: String(req.query.outputType) } : {}),
  };
  const { _outputType, ...restOverrides } = overrides;
  const rendered = await renderStreamCommand(
    stream,
    { ...(stream.profile || {}), ...restOverrides },
    { outputType: _outputType || '' },
  );
  res.json({ ok: true, ...rendered });
}));

router.post('/streams/:id/command', wrap(async (req, res) => {
  const stream = await store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
  const { outputType = '', ...profileOverrides } = req.body?.profile || {};
  const rendered = await renderStreamCommand(
    stream,
    { ...(stream.profile || {}), ...profileOverrides },
    { outputType: outputType || '' },
  );
  res.json({ ok: true, ...rendered });
}));

router.get('/streams/:id/session', wrap(async (req, res) => {
  const session = relay.getSession(req.params.id);
  res.json({ ok: true, session: session ? relay.publicSession(session) : null });
}));

router.post('/streams/:id/session', wrap(async (req, res) => {
  const stream = await store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
  const ready = await ensureStreamReady(stream, { reason: 'stream-api-session' });
  if (!ready.ok) return res.status(503).json({ ok: false, error: ready.error || ready.result?.error || 'upstream is not available', check: ready.result });
  const session = await relay.ensureSession(ready.stream, { profile: req.body?.profile || {}, container: req.body?.container });
  res.json({ ok: true, session: relay.publicSession(session), ...(ready.repaired ? { repaired: true, sourceId: ready.stream.source_id } : {}) });
}));

router.delete('/streams/:id/session', wrap(async (req, res) => {
  const stopped = relay.stopSession(req.params.id, 'user request');
  res.json({ ok: true, stopped });
}));

// The Mobile tab's "stop all sessions": every running relay session, web previews
// included. A deliberate stop, so nothing is kept: the next play of each movie
// starts from the beginning.
router.post('/sessions/stop-all', wrap(async (req, res) => {
  const stopped = relay.stopAll('stop all sessions');
  res.json({ ok: true, stopped });
}));

router.post('/streams/:id/playlist', wrap(async (req, res) => {
  const stream = await store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
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
  const ready = await ensureStreamReady(stream, { reason: 'download-start' });
  if (!ready.ok) return res.status(503).json({ ok: false, error: ready.error || ready.result?.error || 'upstream is not available', check: ready.result });
  const job = exporter.startDownload(ready.stream, {
    profile: req.body?.profile || {},
    container: req.body?.container,
    filename: req.body?.filename || null,
  });
  res.json({ ok: true, job: findJob(job.id) || { id: job.id }, ...(ready.repaired ? { repaired: true, sourceId: ready.stream.source_id } : {}) });
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
    if (!stream) return res.status(404).json({ ok: false, error: 'stream not found' });
    stored = await attachSubtitleToStream(stream, fetched);
  }
  // `push` wins when the caller says so explicitly; otherwise the setting is the
  // default ("setting to push subtitle file to satellite receiver" in
  // requirements.md) — it used to be read by nothing at all.
  const shouldPush = push == null ? Boolean(getConfig().subtitles.pushToReceiver) : Boolean(push);
  let pushResult = null;
  if (shouldPush) pushResult = await pushSubtitleToReceiver({ stream, language: language || fetched.language });
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

/* ---------- enigma2 ---------- */

router.post('/enigma2/test', wrap(async (req, res) => {
  const body = req.body || {};
  const connection = {};
  if (typeof body.host === 'string') connection.host = body.host.trim();
  if (body.port !== undefined) connection.port = Number(body.port) || 80;
  if (typeof body.username === 'string') connection.username = body.username.trim();
  if (typeof body.password === 'string' && body.password) connection.password = body.password;
  if (typeof body.ftpEnabled === 'boolean') connection.ftpEnabled = body.ftpEnabled;
  // Test the form values directly; this does not save them or expose secrets.
  res.json({ ok: true, status: await enigma2.testConnection(connection) });
}));

router.get('/enigma2/status', wrap(async (req, res) => {
  // Explicit "is the box there?" from the UI: always ask the receiver for real,
  // never serve the cached answer.
  res.json({ ok: true, status: await enigma2.status({ force: true }) });
}));

router.post('/enigma2/preview', wrap(async (req, res) => {
  const ids = parseStreamIds(req.body?.streamIds);
  const streams = ids.length ? (await Promise.all(ids.map((id) => store.getStream(id)))).filter(Boolean)
    : (await store.listStreams()).slice(0, 25);
  const entries = bouquetEntries(streams, baseUrlFrom(req));
  res.json({ ok: true, ...enigma2.previewBouquet(entries, { name: req.body?.name }) });
}));

router.post('/enigma2/push', wrap(async (req, res) => {
  const ids = parseStreamIds(req.body?.streamIds);
  const streams = ids.length ? (await Promise.all(ids.map((id) => store.getStream(id)))).filter(Boolean)
    : await store.listStreams();
  if (!streams.length) return res.status(400).json({ ok: false, error: 'no streams selected' });
  const entries = bouquetEntries(streams, baseUrlFrom(req));
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

/* ---------- metadata (TMDB / OMDB) ---------- */

router.get('/metadata/status', wrap(async (req, res) => {
  const cfg = getConfig();
  res.json({
    ok: true,
    tmdb: { configured: Boolean(cfg.metadata?.tmdbApiKey), language: cfg.metadata?.language || 'en-US' },
    omdb: { configured: Boolean(cfg.metadata?.omdbApiKey) },
    any: metadata.isAnyConfigured(),
  });
}));

router.get('/discovery/:list', wrap(async (req, res) => {
  const list = String(req.params.list || '').trim().toLowerCase();
  if (!['trending', 'top10', 'for-you'].includes(list)) {
    return res.status(404).json({ ok: false, error: 'discovery list must be trending, top10, or for-you' });
  }
  const requestedType = String(req.query.type || 'all').trim().toLowerCase();
  const type = requestedType === 'tv' ? 'series' : requestedType;
  if (!['all', 'movie', 'series'].includes(type)) {
    return res.status(422).json({ ok: false, error: 'type must be all, movie, or series' });
  }
  const parsedLimit = Number(req.query.limit);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(50, Math.floor(parsedLimit)) : (list === 'top10' ? 10 : 20);
  const window = req.query.window === 'day' ? 'day' : 'week';
  let history = null;
  if (list === 'for-you') {
    history = await playlist.additionHistory();
    // The empty state does not need a TMDB key; it explains where the signal
    // comes from before the user has added any titles.
    const relevantHistory = history.some((event) => event?.title
      && (type === 'all' || (/series|tv|show/i.test(String(event.kind || '')) ? 'series' : 'movie') === type));
    if (!relevantHistory) {
      return res.json({ ok: true, list, ...(await discovery.playlistRecommendations(history, { type, limit })) });
    }
  }
  if (!metadata.tmdb.isConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'TMDB API key is not configured. Add it in Settings → Metadata to load trending, Top 10, and personalized recommendations.',
    });
  }
  let result;
  if (list === 'trending') result = await discovery.trendingTitles({ type, window, limit });
  else if (list === 'top10') result = await discovery.topTenTitles({ type, limit });
  else result = await discovery.playlistRecommendations(history, { type, limit });
  res.json({ ok: true, list, ...result });
}));

router.get('/metadata/tmdb', wrap(async (req, res) => {
  const { title, year, type, imdbId, tmdbId } = req.query;
  if (!title && !imdbId && !tmdbId) return res.status(400).json({ ok: false, error: 'title, imdbId or tmdbId required' });
  const data = await metadata.enrichMetadata({
    title: title ? String(title) : '',
    year: year ? Number(year) : null,
    type: type ? String(type) : 'movie',
    imdbId: imdbId ? String(imdbId) : null,
    tmdbId: tmdbId ? String(tmdbId) : null,
  });
  res.json({ ok: true, ...data });
}));

router.post('/metadata/enrich', wrap(async (req, res) => {
  const { title, year, type, imdbId, tmdbId } = req.body || {};
  if (!title && !imdbId && !tmdbId) return res.status(400).json({ ok: false, error: 'title, imdbId or tmdbId required' });
  const data = await metadata.enrichMetadata({
    title: title ? String(title) : '',
    year: year ? Number(year) : null,
    type: type ? String(type) : 'movie',
    imdbId: imdbId ? String(imdbId) : null,
    tmdbId: tmdbId ? String(tmdbId) : null,
  });
  res.json({ ok: true, ...data });
}));

export default router;
