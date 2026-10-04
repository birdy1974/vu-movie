/**
 * vu-movie — the relay / transcode session manager.
 *
 * ── The core requirement ──────────────────────────────────────────────────────
 * "The video stream will probably consist of several chunks. The application
 *  needs to redirect these video streams in 1 final video stream that should be
 *  able to be played directly with VLC."
 *
 * How that is implemented: ffmpeg is fed the *manifest* (m3u8/mpd) or the direct
 * file URL and does the segment fetching, reconnection and muxing itself — that is
 * exactly what it is good at, and `-reconnect*`/`-rw_timeout` are already in the
 * command line for that reason. On the other side we fan one encoder/remuxer
 * process out to N clients (VLC on the couch, the VU+ Duo2, a browser tab), so the
 * upstream is contacted once and every client sees ONE continuous stream.
 *
 * Two session kinds:
 *   pipe  — mpegts/matroska on stdout, streamed to every attached client
 *   hls   — ffmpeg's HLS muxer writes segments into a temp dir, clients pull
 *           index.m3u8 + segments (seekable-live, works in browsers too)
 *
 * A session is started lazily on the first client and killed after
 * `transcode.idleStopSeconds` with no clients, because the DS918+ GPU can only
 * handle one 1080p encode at a time.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log, logError, errorText, truncate } from '../core/log.js';
import { getConfig } from '../core/config.js';
import {
  hardware, ffmpegPath, ffmpegEnv, buildFfmpegArgs, argsToCommand, parseProgressLine, normaliseProfile,
  validateFfmpegTemplate, buildFfmpegTemplateArgs,
} from '../core/media.js';

/**
 * Run an FFmpeg template (or built profile) for a short window against the
 * actual upstream of a saved stream. Used by the UI to verify a template
 * before saving it / binding it to an output slot.
 *
 *   `template`     — full FFmpeg command (with <url> / {{url}} / <output>).
 *                    The URL is replaced with the stream's upstream URL and
 *                    source headers + reconnect defaults are injected; the
 *                    final argument is forced to a temp file so the test never
 *                    blocks on a pipe.
 *   `stream`       — record from streams/store (carries upstream / probe).
 *   `container`    — 'mpegts' | 'matroska' | 'hls' (defaults to template -f).
 *   `durationMs`   — how long to run ffmpeg before sending SIGTERM (default 5 s,
 *                    max 30 s — longer just wastes time on a smoke test).
 *   `outputType`   — informational only (logged + included in the response).
 *
 * Returns: { ok, exitCode, signal, durationMs, bytesOut, stderr, progress,
 *            command, templateId, outputType, target }
 */
export async function runTemplateTest({ template, stream, container = null, durationMs = 5000, outputType = '', templateId = '' } = {}) {
  const cfg = getConfig();
  const startedAt = Date.now();
  const limitMs = Math.min(Math.max(Number(durationMs) || 5000, 500), 30000);
  if (!template || typeof template !== 'string' || !template.trim()) {
    return { ok: false, error: 'template is empty', exitCode: null, durationMs: 0, bytesOut: 0, stderr: '', progress: {}, command: '', outputType };
  }
  if (!stream?.upstream?.url) {
    return { ok: false, error: 'stream has no upstream URL', exitCode: null, durationMs: 0, bytesOut: 0, stderr: '', progress: {}, command: '', outputType };
  }
  // Validate first so a malformed command does not run at all. We throw so the
  // HTTP layer converts it to a 422 — operators want a hard failure when they
  // test a template that cannot possibly work, not a "result: ok:false" that
  // looks like a transient runtime error.
  const validation = validateFfmpegTemplate(template, { container: container || cfg.transcode.container });
  if (!validation.ok) {
    const err = new Error(`Template is not valid: ${validation.errors.join('; ')}`);
    err.status = 422;
    err.details = validation.errors;
    throw err;
  }

  // The test writes to a unique temp file (or HLS dir) so the run never blocks
  // on a pipe: we just sample what reaches disk and stop ffmpeg after the
  // window expires.
  const tmpRoot = path.join(cfg.storage.tmp, 'tpl-test');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const runId = `${stream.id}-${Date.now().toString(36)}`;
  const target = path.join(tmpRoot, `${runId}.ts`);
  const effectiveContainer = container || validation.container || 'mpegts';

  // Render the args exactly the way the relay would (so what they preview is
  // what runs). The probe is reused so VA-API availability + filters match.
  const hw = await hardware({ waitMs: 5000 }).catch(() => ({ available: false, reason: 'hardware probe unavailable', fpsVariant: null, encoder: null }));
  let args;
  let command;
  try {
    args = buildFfmpegTemplateArgs({
      template,
      source: { url: stream.upstream.url, headers: stream.upstream.headers || {}, kind: stream.upstream.kind || undefined },
      profile: { container: effectiveContainer },
      mode: 'file',
      output: { container: effectiveContainer, target },
    });
    command = argsToCommand(args);
  } catch (err) {
    return { ok: false, error: errorText(err), exitCode: null, durationMs: 0, bytesOut: 0, stderr: '', progress: {}, command: '', outputType };
  }

  log.info('relay', `template test start`, {
    templateId, outputType, stream: stream.id, container: effectiveContainer, durationMs: limitMs,
    command: truncate(command, 400),
  });

  return await new Promise((resolve) => {
    const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: ffmpegEnv(hw) });
    let bytesOut = 0;
    let stderrTail = [];
    const progress = {};
    let stderrBuffer = '';
    let lastProgressAt = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
    }, limitMs);

    child.stdout.on('data', (chunk) => { bytesOut += chunk.length; });
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() || '';
      for (const line of lines) {
        if (/^[a-z_]+=/.test(line)) {
          const parsed = parseProgressLine(line, progress);
          Object.assign(progress, parsed);
          lastProgressAt = Date.now();
          continue;
        }
        if (!line.trim()) continue;
        stderrTail.push(line);
        if (stderrTail.length > 60) stderrTail.shift();
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
      resolve({
        ok: false, error: errorText(err), exitCode: null,
        durationMs: Date.now() - startedAt, bytesOut, stderr: stderrTail.join('\n'),
        progress, command, templateId, outputType, target: null, timedOut: false,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      // Cleanup the test output file — we only need the bytesOut / progress
      // stats for the verdict, not the file itself.
      try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
      // "ok" = ffmpeg produced bytes within the test window without an error
      // pattern in the stderr. exitCode 0 is a clean finish, SIGTERM is the
      // timer firing (still a positive signal — the pipeline ran).
      const sawError = stderrTail.some((l) => /\b(error|failed|invalid|unable|cannot|denied|not found|impossible|could not|invalid data|broken pipe)\b/i.test(l));
      const ok = bytesOut > 0 && !sawError && (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT');
      log.info('relay', `template test done`, {
        templateId, outputType, stream: stream.id, ok, bytesOut, exitCode: code, signal,
        elapsedMs: durationMs, timedOut,
      });
      resolve({
        ok,
        exitCode: code, signal, durationMs, bytesOut,
        stderr: stderrTail.join('\n'),
        progress: { ...progress, lastProgressAt: lastProgressAt || null },
        command, templateId, outputType, target, timedOut,
      });
    });
  });
}

/* ---------- end of test-runner block ---------- */

/** streamId → session */
const sessions = new Map();

export function listSessions() {
  return [...sessions.values()].map((s) => publicSession(s));
}

export function getSession(streamId) {
  return sessions.get(streamId) || null;
}

/**
 * Resolve the FFmpeg template that should drive this session. The lookup
 * mirrors `resolveOutputTemplate` in src/http/api.js but keeps it local to the
 * relay so the playback hot path never has to walk through the API router.
 *
 *   1. stream profile outputTemplates[outputType]
 *   2. stream profile.ffmpegTemplate / ffmpegTemplateId (legacy single default)
 *   3. global ffmpegDefaults[outputType]
 *   4. global defaultFfmpegTemplateId
 *
 * Returns null when nothing matches — that means the guided profile builder is
 * authoritative and the resulting session will use stream copy or a transcode
 * profile as configured by the operator.
 */
function resolveOutputTemplateForSession(profile = {}, outputType = '') {
  const cfgTrans = getConfig().transcode || {};
  const templates = Array.isArray(cfgTrans.ffmpegTemplates) ? cfgTrans.ffmpegTemplates : [];
  const defaults = cfgTrans.ffmpegDefaults && typeof cfgTrans.ffmpegDefaults === 'object' ? cfgTrans.ffmpegDefaults : {};
  const streamOutputTemplates = profile.outputTemplates && typeof profile.outputTemplates === 'object' && !Array.isArray(profile.outputTemplates)
    ? profile.outputTemplates : {};

  const findById = (id) => templates.find((item) => item?.id === id && typeof item.command === 'string' && item.command.trim());

  let picked = null;
  let source = 'guided';

  // Per-output bindings first, then global per-output defaults, then the
  // stream's legacy single-template fallback, then the global default. The
  // same precedence is mirrored in `resolveOutputTemplate` in the API
  // (preview / command render). Do not change one without the other.
  if (outputType && streamOutputTemplates[outputType]) {
    picked = findById(streamOutputTemplates[outputType]);
    if (picked) source = 'stream-output';
  }
  if (!picked && outputType && defaults[outputType]) {
    picked = findById(defaults[outputType]);
    if (picked) source = 'global-output';
  }
  if (!picked && profile.ffmpegTemplateId) {
    picked = findById(profile.ffmpegTemplateId);
    if (picked) source = 'stream';
  }
  if (!picked && cfgTrans.defaultFfmpegTemplateId) {
    picked = findById(cfgTrans.defaultFfmpegTemplateId);
    if (picked) source = 'global';
  }
  if (!picked && profile.ffmpegTemplate && typeof profile.ffmpegTemplate === 'string' && profile.ffmpegTemplate.trim()) {
    return {
      templateId: '',
      name: profile.ffmpegTemplateName || 'Custom template',
      container: profile.container || '',
      command: profile.ffmpegTemplate,
      source: 'stream-custom',
    };
  }
  if (!picked) return null;
  return {
    templateId: picked.id,
    name: picked.name || '',
    container: picked.container || '',
    command: picked.command,
    source,
  };
}

export function stopSession(streamId, reason = 'requested') {
  const session = sessions.get(streamId);
  if (!session) return false;
  log.info('relay', `stopping session ${session.id} (${reason})`, {
    clients: session.clients.size, uptimeSec: Math.round((Date.now() - session.startedAt) / 1000),
    bytesOut: session.bytesOut,
  });
  clearIdleTimer(session);
  try { session.child?.kill('SIGTERM'); } catch (err) { logError('relay', 'could not kill ffmpeg', err); }
  setTimeout(() => { try { session.child?.kill('SIGKILL'); } catch { /* gone */ } }, 5000).unref?.();
  sessions.delete(streamId);
  cleanupHlsDir(session);
  return true;
}

function clearIdleTimer(session) {
  if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null; }
}

function scheduleIdleStop(session) {
  clearIdleTimer(session);
  const seconds = Math.max(5, getConfig().transcode.idleStopSeconds);
  session.idleTimer = setTimeout(() => {
    if (session.clients.size === 0) stopSession(session.streamId, `idle for ${seconds}s`);
  }, seconds * 1000);
  session.idleTimer.unref?.();
}

function cleanupHlsDir(session) {
  if (session.cleanupTimer) { clearTimeout(session.cleanupTimer); session.cleanupTimer = null; }
  if (!session.hlsDir) return;
  try {
    fs.rmSync(session.hlsDir, { recursive: true, force: true });
    log.debug('relay', `removed HLS directory ${session.hlsDir}`);
  } catch (err) {
    log.warn('relay', 'could not remove HLS directory', { dir: session.hlsDir, error: String(err?.message || err) });
  }
}

/**
 * Build (or reuse) a session for a stream.
 * @param {object} stream  record from streams/store
 * @param {object} [opts]  { profile: overrides, container }
 */
export async function ensureSession(stream, opts = {}) {
  const existing = sessions.get(stream.id);
  if (existing && existing.alive) {
    log.debug('relay', `reusing session for stream ${stream.id}`, { clients: existing.clients.size, outputType: existing.outputType });
    return existing;
  }

  const cfg = getConfig();
  const outputType = opts.outputType || '';
  const container = opts.container || opts.profile?.container || stream.profile?.container || cfg.transcode.container;
  let profileInput = { ...(stream.profile || {}), ...(opts.profile || {}), container };

  // Apply the per-output FFmpeg template selection: stream output override →
  // stream default → global output default → global default. An empty result
  // falls through to the guided profile builder (i.e. no template is used).
  const template = resolveOutputTemplateForSession(profileInput, outputType);
  if (template) {
    profileInput = {
      ...profileInput,
      container: template.container || profileInput.container,
      ffmpegTemplate: template.command,
      ffmpegTemplateId: template.templateId || '',
      ffmpegTemplateName: template.name || '',
    };
    log.debug('relay', `using template for output "${outputType || 'default'}"`, {
      templateId: template.templateId, name: template.name, source: template.source,
    });
  }

  const profile = normaliseProfile(profileInput, stream.upstream?.probe || null);
  // Bounded wait: a slow GPU self-test must not stall playback forever. The
  // placeholder reports available:false, so we fall back to software encoding
  // for this session and use the (soon to be known) VAAPI result on the next one.
  const hw = await hardware({ waitMs: 15000 });
  if (hw.pending) {
    log.warn('relay', 'hardware detection is still running — starting this session with software encoding', {
      reason: hw.reason,
    });
  }

  const wantsHls = container === 'hls';
  // Segment length: 2 s keeps the VU+ zapping latency low, browsers happy and the
  // muxer overhead reasonable on a Celeron. Tunable through CONFIG.
  const hlsTime = Number(cfg.transcode.hlsSegmentSeconds) || 2;
  const hlsDir = wantsHls ? hlsDirFor(stream) : null;
  if (hlsDir) enforceHlsBudget(hlsDir);
  const effectiveProfile = { ...profile, container: wantsHls ? 'hls' : profile.container };

  const args = buildFfmpegArgs({
    source: {
      url: stream.upstream?.url,
      headers: stream.upstream?.headers || {},
      kind: stream.upstream?.kind || undefined,
      container: stream.upstream?.probe?.container || null,
    },
    profile: effectiveProfile,
    hw,
    mode: 'live',
    output: wantsHls
      ? { container: 'hls', target: path.join(hlsDir, 'index.m3u8'), hlsDir, hlsTime, hlsListSize: 10 }
      : { container: profile.container, target: 'pipe:1' },
  });

  const command = argsToCommand(args);
  const session = {
    id: `${stream.id}-${Date.now().toString(36)}`,
    streamId: stream.id,
    stream,
    kind: wantsHls ? 'hls' : 'pipe',
    container: wantsHls ? 'hls' : profile.container,
    mode: profile.ffmpegTemplate ? 'template' : profile.transcode ? 'transcode' : 'copy',
    encoder: profile.ffmpegTemplate ? 'custom template' : profile.transcode ? (hw.available && profile.encoder === 'vaapi' ? 'h264_vaapi' : profile.encoder || 'libx264') : 'copy',
    outputType,
    templateId: profile.ffmpegTemplateId || '',
    templateSource: template?.source || '',
    profile: effectiveProfile,
    hlsDir,
    command,
    args,
    clients: new Set(),
    stats: {},
    bytesOut: 0,
    stderrTail: [],
    startedAt: Date.now(),
    lastActivity: Date.now(),
    alive: true,
    restarts: 0,
    child: null,
    hw,
  };

  sessions.set(stream.id, session);
  spawnFfmpeg(session);
  log.info('relay', `session ${session.id} started`, {
    mode: session.mode, encoder: session.encoder, container: session.container,
    outputType: session.outputType || '',
    templateId: session.templateId || '',
    templateSource: session.templateSource || '',
    reasons: profile.reasons?.join('; '), hw: hw.available ? 'vaapi' : 'software',
  });
  log.debug('relay', 'ffmpeg command', { command: truncate(command, 900) });
  return session;
}

function hlsDirFor(stream) {
  const dir = path.join(getConfig().storage.tmp, 'hls', stream.token);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * storage.cacheBudgetMb bounds the on-disk HLS cache. Every session removes its
 * own directory on stop, but a crash or a SIGKILL can leave orphaned segments
 * behind; this sweep runs right before a new HLS session starts and deletes the
 * oldest *inactive* directories until the cache fits the budget. Directories of
 * live sessions (and the one about to start) are never touched.
 */
export function enforceHlsBudget(keepDir = null) {
  const cfg = getConfig();
  const budgetMb = Math.max(64, Number(cfg.storage.cacheBudgetMb) || 2048);
  const root = path.join(cfg.storage.tmp, 'hls');
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  const active = new Set([...sessions.values()].map((s) => s.hlsDir).filter(Boolean));
  if (keepDir) active.add(keepDir);

  const dirs = [];
  let total = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const { size, mtimeMs } = dirSize(dir);
    total += size;
    dirs.push({ dir, size, mtimeMs });
  }
  const budget = budgetMb * 1024 * 1024;
  if (total <= budget) return;

  dirs.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const { dir, size } of dirs) {
    if (total <= budget) break;
    if (active.has(dir)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      total -= size;
      log.warn('relay', `removed stale HLS cache ${path.basename(dir)} (${Math.round(size / 1048576)} MB) to stay within the ${budgetMb} MB budget`);
    } catch (err) {
      log.debug('relay', 'could not remove a stale HLS cache directory', { dir, error: String(err?.message || err) });
    }
  }
}

/** Bytes + newest mtime under a directory (best effort; missing files count 0). */
function dirSize(dir) {
  let size = 0;
  let mtimeMs = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { size, mtimeMs }; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirSize(p);
      size += sub.size;
      mtimeMs = Math.max(mtimeMs, sub.mtimeMs);
    } else {
      try {
        const st = fs.statSync(p);
        size += st.size;
        mtimeMs = Math.max(mtimeMs, st.mtimeMs);
      } catch { /* vanished while sweeping */ }
    }
  }
  return { size, mtimeMs };
}

function spawnFfmpeg(session) {
  // ffmpegEnv() pins LIBVA_DRIVER_NAME to the driver the self-test proved to
  // work (iHD on some NAS, i965 on the DS918+) — without it ffmpeg would retry
  // the driver that failed on every session.
  const child = spawn(ffmpegPath(), session.args, { stdio: ['ignore', 'pipe', 'pipe'], env: ffmpegEnv(session.hw) });
  session.child = child;
  session.alive = true;

  child.stdout.on('data', (chunk) => {
    session.bytesOut += chunk.length;
    session.lastActivity = Date.now();
    for (const client of session.clients) writeToClient(session, client, chunk);
  });

  let stderrBuffer = '';
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() || '';
    for (const line of lines) {
      if (/^[a-z_]+=/.test(line)) {
        session.stats = parseProgressLine(line, session.stats);
        continue;
      }
      if (!line.trim()) continue;
      session.stderrTail.push(line);
      if (session.stderrTail.length > 40) session.stderrTail.shift();
      if (/error|failed|invalid|unable|cannot|denied|not found/i.test(line)) {
        log.warn('relay', `ffmpeg: ${truncate(line, 200)}`, { session: session.id });
      } else {
        log.debug('relay', `ffmpeg: ${truncate(line, 200)}`, { session: session.id });
      }
    }
  });

  child.on('error', (err) => {
    session.alive = false;
    logError('relay', `ffmpeg could not be started for session ${session.id}`, err, { command: truncate(session.command, 300) });
    endClients(session, 'ffmpeg could not be started');
  });

  child.on('close', (code, signal) => {
    session.alive = false;
    const running = Math.round((Date.now() - session.startedAt) / 1000);
    const level = code === 0 || signal === 'SIGTERM' ? 'info' : 'error';
    log[level]('relay', `ffmpeg exited for session ${session.id}`, {
      code, signal, ranSec: running, clients: session.clients.size,
      stderr: truncate(session.stderrTail.slice(-4).join(' | '), 400),
    });

    if (sessions.get(session.streamId) !== session) return; // replaced deliberately

    // Restart once if clients are still attached — many upstream URLs drop after a
    // while and a single retry rescues the playback instead of showing a black screen.
    if (session.clients.size > 0 && session.restarts < 1 && code !== 0 && signal !== 'SIGTERM') {
      session.restarts += 1;
      log.warn('relay', `restarting ffmpeg for session ${session.id} (attempt ${session.restarts})`, {
        reason: session.stderrTail.slice(-2).join(' | '),
      });
      setTimeout(() => {
        if (sessions.get(session.streamId) === session && session.clients.size > 0) spawnFfmpeg(session);
      }, 1500).unref?.();
      return;
    }

    endClients(session, code === 0 ? 'stream finished' : `ffmpeg exited with code ${code}`);
    sessions.delete(session.streamId);

    if (session.hlsDir) {
      // The source was finite (a progressive file, or a VOD playlist): the muxer
      // has written everything. Close the playlist so players stop polling, and
      // keep the segments for a while — otherwise a client that opens the URL a
      // few seconds later gets a 404 for the whole stream.
      closeHlsPlaylist(session);
      scheduleHlsCleanup(session);
      return;
    }
    cleanupHlsDir(session);
  });
}

/** Append #EXT-X-ENDLIST so browsers/VLC know the playlist is complete. */
function closeHlsPlaylist(session) {
  try {
    const playlist = path.join(session.hlsDir, 'index.m3u8');
    if (!fs.existsSync(playlist)) return;
    const text = fs.readFileSync(playlist, 'utf8');
    if (!text.includes('#EXT-X-ENDLIST')) {
      fs.writeFileSync(playlist, `${text.trimEnd()}\n#EXT-X-ENDLIST\n`);
      log.info('relay', `closed the HLS playlist of ${session.id} with #EXT-X-ENDLIST`);
    }
  } catch (err) {
    log.warn('relay', `could not finalise the HLS playlist: ${err.message}`, { session: session.id });
  }
}

/** Remove the segment directory after the idle window, unless it is reused. */
function scheduleHlsCleanup(session) {
  const seconds = Number(getConfig().transcode.idleStopSeconds) || 45;
  const timer = setTimeout(() => {
    if (sessions.get(session.streamId) === session && session.alive) return;
    cleanupHlsDir(session);
  }, seconds * 1000);
  timer.unref?.();
  session.cleanupTimer = timer;
  log.debug('relay', `HLS segments of ${session.id} kept for ${seconds}s`);
}

/** Attach an HTTP response (VLC, the Duo2, a browser) to a session. */
export function attachClient(session, req, res, { onFinish } = {}) {
  const client = {
    id: `c${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
    ip: req.ip || req.socket?.remoteAddress || 'unknown',
    userAgent: req.headers['user-agent'] || '',
    pending: 0,
    bytes: 0,
    startedAt: Date.now(),
    res,
  };
  session.clients.add(client);
  session.lastActivity = Date.now();
  clearIdleTimer(session);

  log.info('relay', `client attached to ${session.id}`, {
    clients: session.clients.size, ip: client.ip, ua: truncate(client.userAgent, 70), mode: session.mode,
  });

  const finish = (reason) => {
    if (!session.clients.has(client)) return;
    session.clients.delete(client);
    log.info('relay', `client detached from ${session.id}`, {
      reason, bytes: client.bytes, sec: Math.round((Date.now() - client.startedAt) / 1000), clients: session.clients.size,
    });
    if (session.clients.size === 0) scheduleIdleStop(session);
    onFinish?.(client);
  };

  req.on('close', () => finish('client closed'));
  req.on('aborted', () => finish('client aborted'));
  res.on('error', () => finish('response error'));
  return { client, finish };
}

function writeToClient(session, client, chunk) {
  const cfg = getConfig();
  try {
    const flushed = client.res.write(chunk);
    client.bytes += chunk.length;
    if (!flushed) {
      client.pending += chunk.length;
      if (client.pending > cfg.transcode.maxClientBacklog) {
        log.warn('relay', 'dropping a client that cannot keep up (protecting the encoder)', {
          session: session.id, ip: client.ip, pendingBytes: client.pending,
        });
        session.clients.delete(client);
        try { client.res.end(); } catch { /* ignore */ }
        if (session.clients.size === 0) scheduleIdleStop(session);
      } else {
        client.res.once('drain', () => { client.pending = 0; });
      }
    }
  } catch (err) {
    log.warn('relay', 'write to client failed — dropping it', { error: String(err?.message || err), ip: client.ip });
    session.clients.delete(client);
  }
}

function endClients(session, reason) {
  for (const client of [...session.clients]) {
    try { client.res.end(); } catch { /* ignore */ }
    session.clients.delete(client);
  }
  if (reason) log.info('relay', `all clients ended for ${session.id}`, { reason });
}

export function publicSession(session) {
  return {
    id: session.id,
    streamId: session.streamId,
    kind: session.kind,
    container: session.container,
    mode: session.mode,
    encoder: session.encoder,
    outputType: session.outputType || '',
    templateId: session.templateId || '',
    templateSource: session.templateSource || '',
    clients: session.clients.size,
    startedAt: new Date(session.startedAt).toISOString(),
    uptimeSec: Math.round((Date.now() - session.startedAt) / 1000),
    bytesOut: session.bytesOut,
    stats: session.stats,
    restarts: session.restarts,
    alive: session.alive,
    command: session.command,
    hls: Boolean(session.hlsDir),
    progressUrl: session.hlsDir ? `/hls/${session.stream.token}/index.m3u8` : null,
  };
}

export function stopAll(reason = 'shutdown') {
  for (const streamId of [...sessions.keys()]) stopSession(streamId, reason);
}

export default { ensureSession, attachClient, stopSession, listSessions, getSession, stopAll, publicSession, runTemplateTest };
