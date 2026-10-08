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
 * A session is started lazily. While no player is attached, or a player has
 * stopped reading, the source is held: ffmpeg waits on a full pipe, so the movie
 * stays exactly where it was and a paused player picks it up from there. The
 * session is stopped after `transcode.pauseKeepSeconds` without a player
 * (`idleStopSeconds` when nobody ever attached), because the DS918+ GPU can only
 * handle one 1080p encode at a time. An unchosen stop leaves its play head for
 * `transcode.resumeHours`, so the next play of the movie resumes there. Sessions
 * started by a preflight/HEAD request or the session API get an idle lease
 * immediately; HLS HTTP requests renew it while being polled.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log, logError, errorText, truncate } from '../core/log.js';
import { getConfig } from '../core/config.js';
import {
  hardware, ffmpegPath, ffmpegEnv, buildFfmpegArgs, argsToCommand, parseProgressLine, normaliseProfile,
  validateFfmpegTemplate, buildFfmpegTemplateArgs, outputFormatOf, subtitleSessionNotes, probeSubtitleList,
  probe as probeMedia,
} from '../core/media.js';
import * as store from './store.js';
import {
  maybeCreateUpstreamProxy, closeUpstreamProxy, proxyStats, pinUpstreamProxy,
} from './upstream.js';
import { decideWebProfile, describeWebDecisions } from './web-preview.js';

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
      source: {
        url: stream.upstream.url, headers: stream.upstream.headers || {},
        kind: stream.upstream.kind || undefined,
        container: stream.upstream.probe?.container || null,
        subtitles: probeSubtitleList(stream.upstream.probe),
      },
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
    // stdout is only part of the story: the test normally writes to `target`
    // (see the verdict below), so count both.
    let stdoutBytes = 0;
    let stderrTail = [];
    const progress = {};
    let stderrBuffer = '';
    let lastProgressAt = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
    }, limitMs);

    child.stdout.on('data', (chunk) => { stdoutBytes += chunk.length; });
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
        durationMs: Date.now() - startedAt, bytesOut: stdoutBytes, stdoutBytes, fileBytes: 0, stderr: stderrTail.join('\n'),
        progress, command, templateId, outputType, target: null, timedOut: false,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      // What did the command actually produce? The test writes to a *file*
      // (never a pipe), so measuring stdout alone answered "no output
      // produced" for every template that writes <output> — which is the form
      // the editor recommends. Stat the file before cleaning it up.
      let fileBytes = 0;
      try { fileBytes = fs.statSync(target).size; } catch { /* nothing reached disk */ }
      try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
      const bytesOut = stdoutBytes + fileBytes;
      // "ok" = ffmpeg produced bytes within the test window without an error
      // pattern in the stderr. exitCode 0 is a clean finish, SIGTERM is the
      // timer firing (still a positive signal — the pipeline ran).
      const sawError = stderrTail.some((l) => /\b(error|failed|invalid|unable|cannot|denied|not found|impossible|could not|invalid data|broken pipe)\b/i.test(l));
      const ok = bytesOut > 0 && !sawError && (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT');
      log.info('relay', `template test done`, {
        templateId, outputType, stream: stream.id, ok, bytesOut, fileBytes, stdoutBytes, exitCode: code, signal,
        elapsedMs: durationMs, timedOut,
      });
      resolve({
        ok,
        exitCode: code, signal, durationMs, bytesOut, fileBytes, stdoutBytes,
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
 * Keep an HLS relay alive while a player is polling its playlist/segments.
 * HLS clients make short HTTP requests rather than holding a pipe response open,
 * so they cannot use attachClient()'s disconnect lifecycle. The token identifies
 * the HLS output directory; this only renews the idle lease for a live HLS
 * session, never for an unrelated pipe session.
 */
export function touchSessionByToken(token) {
  const wanted = String(token || '');
  if (!wanted) return false;
  const session = [...sessions.values()].find((candidate) => candidate.stream?.token === wanted);
  if (!session || session.kind !== 'hls' || !session.alive) return false;
  session.lastActivity = Date.now();
  if (session.clients.size === 0) scheduleIdleStop(session);
  return true;
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

  // Disabled templates are skipped here too, so a session never starts on a
  // template the operator switched off (see resolveOutputTemplate in api.js).
  const findById = (id) => templates.find((item) => item?.enabled !== false && item?.id === id && typeof item.command === 'string' && item.command.trim());

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

/**
 * Close the upstream proxy only once ffmpeg has really stopped reading it.
 *
 * Tearing the proxy down in the same tick as the SIGTERM used to abort the
 * in-flight ranged transfer under ffmpeg's feet: its HTTP reader saw a
 * truncated stream, reconnected (as it is told to do), got 404 from the
 * already-closed proxy session, and exited with an I/O error. A deliberate
 * idle stop therefore looked like a crash in the log and threw away the last
 * chunk of the movie. Waiting for the child to exit makes the stop clean; the
 * grace timer is the safety net for a child that ignores SIGTERM/SIGKILL.
 */
export function releaseUpstreamProxy(session, reason = 'stopped', { graceMs = 3000 } = {}) {
  if (!session?.upProxy || session.upProxyReleased) return;
  session.upProxyReleased = true;
  const close = () => {
    clearTimeout(timer);
    closeUpstreamProxy(session.upProxy, reason);
  };
  const timer = setTimeout(close, Math.max(0, Number(graceMs) || 0));
  timer.unref?.();
  const child = session.child;
  const running = child && typeof child.once === 'function' && child.exitCode == null && child.signalCode == null;
  if (!running) close();
  else {
    // 'close' (not 'exit') — it fires after ffmpeg's stdio is fully drained, so
    // no read can still be in flight when the proxy disappears.
    child.once('close', close);
  }
}

/**
 * Stop a session. `remember` is set only by the idle stop: nobody chose it, so
 * the play head is kept for the next play (see rememberResumePoint).
 */
export function stopSession(streamId, reason = 'requested', { remember = false } = {}) {
  const session = sessions.get(streamId);
  if (!session) return false;
  const keptAt = remember ? rememberResumePoint(session) : 0;
  log.info('relay', `stopping session ${session.id} (${reason})`, {
    clients: session.clients.size, uptimeSec: Math.round((Date.now() - session.startedAt) / 1000),
    bytesOut: session.bytesOut, ...(keptAt ? { keptAtSec: keptAt } : {}),
  });
  clearIdleTimer(session);
  endClients(session, `session stopped (${reason})`);
  const child = session.child;
  try { child?.kill('SIGTERM'); } catch (err) { logError('relay', 'could not kill ffmpeg', err); }
  // ffmpeg may be blocked in a write to a pipe nobody reads, and SIGTERM does
  // not wake a blocked write. Closing the read end makes that write fail, so
  // ffmpeg exits now rather than at the SIGKILL below.
  if (child?.stdout) { try { child.stdout.destroy(); } catch { /* gone */ } }
  setTimeout(() => { try { session.child?.kill('SIGKILL'); } catch { /* gone */ } }, 5000).unref?.();
  sessions.delete(streamId);
  releaseUpstreamProxy(session, reason);
  cleanupHlsDir(session);
  return true;
}

/**
 * Pure: should ffmpeg be restarted after it exited?
 *
 *  - nobody is watching → no (the idle stop owns that case);
 *  - SIGTERM → no (a deliberate stop);
 *  - a non-zero exit while clients watch → yes (transient upstream failure);
 *  - a CLEAN exit (code 0) while clients watch → yes, unless the play head was
 *    already at the known duration — because for these CDNs a "clean" EOF two
 *    hours before the end of the movie is the chunked transfer being ended by
 *    the server, not the movie finishing. This is the restart half of the
 *    anti-cut safety net (the fetch half lives in streams/upstream.js).
 */
export function decideRestart({ clients = 0, restarts = 0, code = null, signal = null, outTimeMs = null, durationSec = null, maxRestarts = 3 }) {
  if (clients <= 0) return { restart: false, reason: 'no clients' };
  if (signal === 'SIGTERM' || signal === 'SIGKILL') return { restart: false, reason: 'stopped deliberately' };
  if (restarts >= maxRestarts) return { restart: false, reason: `restart budget exhausted (${maxRestarts})` };
  if (code !== 0) return { restart: true, reason: `ffmpeg exited with code ${code}` };
  const playedSec = Number.isFinite(outTimeMs) ? outTimeMs / 1000 : null;
  if (Number.isFinite(durationSec) && durationSec > 0 && playedSec !== null && playedSec >= durationSec * 0.99) {
    return { restart: false, reason: 'the movie reached its known duration — genuine end of stream' };
  }
  return { restart: true, reason: 'clean EOF while clients are watching — upstream likely ended the transfer early (chunked CDN), resuming' };
}

/** How long learning a movie's length may take (one ffprobe run). */
const DURATION_PROBE_TIMEOUT_MS = 20000;

/** The movie's length when it is known — learned by the relay or from the
 *  candidate probe — or null. */
export function knownDurationSec(stream) {
  for (const value of [stream?.upstream?.durationSec, stream?.upstream?.probe?.durationSec]) {
    const sec = Number(value);
    if (Number.isFinite(sec) && sec > 0) return sec;
  }
  return null;
}

/**
 * Where the movie is, counted from its start. ffmpeg reports time from its own
 * start, and a resumed run starts again at zero, so the resume offset of the
 * running process is added back before the end of the movie is compared.
 */
export function playheadSeconds(session) {
  const outSec = Number.isFinite(session?.stats?.outTimeMs) ? session.stats.outTimeMs / 1000 : 0;
  return (Number(session?.resumeSeconds) || 0) + outSec;
}

/**
 * Only a clean end while someone is watching is ambiguous, and only an unknown
 * length needs a probe. Nothing is probed when no restart could follow anyway.
 */
export function shouldLearnDuration(session, { code = null, signal = null } = {}) {
  if (code !== 0 || signal) return false;
  if (!session?.clients || session.clients.size <= 0) return false;
  if (knownDurationSec(session.stream)) return false;
  const cfg = getConfig().transcode;
  if (cfg.probeDuration === false) return false;
  return session.restarts < Math.max(1, Number(cfg.maxRestarts) || 3);
}

/**
 * Learn the movie's length with ffprobe and keep it on the stream, so the next
 * clean end can be recognised as the real end instead of restarting. Probes the
 * proxied input (it serves the complete object, from cache or from the capture
 * file) or, without a proxy, the upstream URL with its headers. Returns the
 * length in seconds, or null when it could not be learned.
 */
export async function learnMovieDuration(session, { probe = probeMedia } = {}) {
  const stream = session?.stream;
  if (!stream?.id) return null;
  const viaProxy = Boolean(session.upProxy);
  const url = viaProxy ? session.upProxy.inputUrl : stream.upstream?.url;
  if (!url) return null;
  const headers = viaProxy ? {} : (stream.upstream?.headers || {});
  const info = await probe(url, { headers, timeoutMs: DURATION_PROBE_TIMEOUT_MS }).catch(() => null);
  const durationSec = Math.round(Number(info?.durationSec) * 100) / 100;
  if (!(durationSec > 0)) {
    log.warn('relay', 'could not learn the movie length — a clean end will restart and may repeat the film', {
      session: session.id, stream: stream.id, via: viaProxy ? 'proxy' : 'upstream',
    });
    return null;
  }
  stream.upstream = { ...(stream.upstream || {}), durationSec };
  try {
    await store.setUpstreamDuration(stream.id, durationSec);
  } catch (err) {
    log.warn('relay', 'could not save the movie length', { stream: stream.id, error: errorText(err) });
  }
  log.info('relay', `learned the movie length (${Math.round(durationSec)} s) — playback now stops at the real end`, {
    session: session.id, stream: stream.id,
  });
  return durationSec;
}

/**
 * Startup failures that no restart can fix. The restart budget exists for
 * upstreams that drop mid-movie; a command ffmpeg rejects before writing a
 * single byte fails identically on every attempt. Retrying used to burn all
 * three attempts (~20 s of dead air) before the client was told anything.
 * Each entry carries the operator-facing hint for the log line.
 */
const FATAL_FFMPEG_PATTERNS = [
  {
    pattern: /subtitle codec \d+ is not supported|could not write header for output file|error initializing output stream/i,
    hint: 'the output muxer cannot carry one of the mapped streams — typically an MP4 mov_text subtitle track copied into Matroska; re-resolve the stream so the probe can fix the subtitle handling, or pick a template that re-encodes subtitles',
  },
  {
    pattern: /subtitle encoding currently only possible from text to text or bitmap to bitmap/i,
    hint: 'a text subtitle track was mapped into a bitmap subtitle codec (or the other way round)',
  },
  {
    pattern: /failed to initialise vaapi connection|device creation failed|failed to set value 'vaapi=/i,
    hint: 'the VAAPI device is not usable in this container — pass /dev/dri through (docker-compose devices:) and check LIBVA_DRIVER_NAME',
  },
];

/**
 * Pure: does this exit describe a failure a restart cannot fix?
 * Returns `{ hint }` for a fatal startup failure, otherwise null.
 *
 * A pipe session that already produced bytes failed mid-stream (an upstream
 * drop) — exactly the case the restart budget exists for, so bytesOut > 0 is
 * never fatal. HLS sessions write to disk, so bytesOut says nothing there;
 * the patterns only fire at startup, which keeps that case safe too.
 */
export function fatalFfmpegFailure(stderrTail = [], { bytesOut = 0, code = 0, kind = 'pipe' } = {}) {
  if (code === 0) return null;
  if (kind !== 'hls' && bytesOut > 0) return null;
  const text = Array.isArray(stderrTail) ? stderrTail.join('\n') : String(stderrTail || '');
  for (const { pattern, hint } of FATAL_FFMPEG_PATTERNS) {
    if (pattern.test(text)) return { hint };
  }
  return null;
}

/** Splice an input-side `-ss` in front of the first `-i` so a restart resumes. */
export function argsWithResume(args, seconds) {
  const at = Number(seconds);
  if (!Number.isFinite(at) || at < 3) return args;
  const index = args.indexOf('-i');
  if (index < 0) return args;
  return [...args.slice(0, index), '-ss', String(Math.floor(at)), ...args.slice(index)];
}

function clearIdleTimer(session) {
  if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null; }
}

/** The lease for a session that no player has attached to (API pre-start, HEAD). */
function leaseSeconds() {
  return Math.max(5, Number(getConfig().transcode.idleStopSeconds) || 45);
}

/** How long a session is kept once its last player has left. */
export function pauseKeepSeconds() {
  const keep = Number(getConfig().transcode.pauseKeepSeconds);
  return Math.max(5, Number.isFinite(keep) && keep > 0 ? keep : leaseSeconds());
}

function scheduleIdleStop(session, seconds = leaseSeconds()) {
  clearIdleTimer(session);
  const wait = Math.max(5, Number(seconds) || leaseSeconds());
  session.idleTimer = setTimeout(() => {
    // Only the session that is still registered may stop itself: a timer armed
    // by a detaching client of a *replaced* session must never kill its
    // successor (the stream can be restarted within the idle window).
    if (sessions.get(session.streamId) !== session) return;
    // Nobody chose this stop, so the play head is kept for the next play.
    if (session.clients.size === 0) stopSession(session.streamId, `idle for ${wait}s`, { remember: true });
  }, wait * 1000);
  session.idleTimer.unref?.();
}

/* ------------------------------------------------------------------ *
 * The play head of an unfinished movie
 *
 * A session that ends without anyone choosing it (the idle stop after the last
 * player left, or ffmpeg giving up while nobody is attached) leaves its play
 * head here. The next session for the same stream starts there, within
 * transcode.resumeHours. Like the sessions, this lives in memory, and a play
 * consumes it. A deliberate stop (a user request, a changed profile or subtitle)
 * leaves nothing, so the next play starts from the beginning.
 * ------------------------------------------------------------------ */

/** streamId → { seconds, at } */
const resumePoints = new Map();

/**
 * Seconds given back when a play head is remembered. Without it the resume can
 * start mid-GOP, and the player would show a few seconds of smeared frames.
 */
const RESUME_REWIND_SECONDS = 2;

/** Less than this played is not worth resuming (start-up noise). */
const RESUME_MIN_PLAYHEAD_SECONDS = 10;

/**
 * The relay sends a player the film at the source's pace, and the player shows
 * it a little later: the TCP buffers and the player's own cache hold the rest.
 * When the player closes, that part is lost with the connection. Measured at
 * ~5.5 MB of socket buffers for a 4 Mbps film (about 10 s). The next player to
 * come back starts this many seconds earlier, so the lost part is sent again
 * rather than skipped. The relay cannot see how much the player had shown.
 */
const RECONNECT_REWIND_SECONDS = 10;

function resumeHoursLimit() {
  return Math.max(0, Number(getConfig().transcode.resumeHours) || 0);
}

/**
 * Remember where a session had got to. Returns the seconds kept, or 0 when
 * nothing is kept: the memory is off, the session is HLS, the play was short, or
 * the movie was played to its end (the memory of that stream is cleared).
 */
export function rememberResumePoint(session, { now = Date.now() } = {}) {
  if (!session || session.kind !== 'pipe' || !session.streamId) return 0;
  if (resumeHoursLimit() <= 0) return 0;
  const playhead = playheadSeconds(session);
  const duration = knownDurationSec(session.stream);
  if (duration && playhead >= duration * 0.99) {
    resumePoints.delete(session.streamId);
    return 0;
  }
  if (!(playhead >= RESUME_MIN_PLAYHEAD_SECONDS)) return 0;
  const seconds = Math.floor(playhead) - RESUME_REWIND_SECONDS - (session.pendingRewind || 0);
  resumePoints.set(session.streamId, { seconds, at: now });
  log.info('relay', `kept the play head of "${session.stream?.title || session.streamId}" at ${seconds}s`, {
    session: session.id, resumeHours: resumeHoursLimit(),
  });
  return seconds;
}

/**
 * The play head kept for a stream, or 0. Taking it consumes it, and a memory
 * older than transcode.resumeHours is ignored.
 */
export function takeResumePoint(streamId, { now = Date.now() } = {}) {
  const entry = resumePoints.get(streamId);
  if (!entry) return 0;
  resumePoints.delete(streamId);
  const hours = resumeHoursLimit();
  if (hours <= 0 || now - entry.at > hours * 3600e3) return 0;
  return entry.seconds >= 3 ? entry.seconds : 0;
}

/* ------------------------------------------------------------------ *
 * Holding the source
 *
 * ffmpeg writes the movie into a pipe. While nothing reads that pipe, ffmpeg
 * blocks and stops reading its own input, so the source is held exactly where
 * it is. The source is held when no attached player can take data:
 *   - nobody is attached: the movie waits for its player (a paused VLC, a tab
 *     that comes back) instead of running to the end unwatched;
 *   - every attached player has stopped reading (its socket is full). A paused
 *     player is not dropped for that. The source waits for it, and a player that
 *     stays stuck for transcode.clientStallSeconds is dropped (see blockClient).
 * When another player is still reading, the source keeps flowing. A stuck
 * player queues what it is sent, up to BLOCKED_QUEUE_LIMIT, and is dropped past
 * that: one slow viewer must not stop the others.
 * Only pipe sessions have a source to hold. An HLS session writes files.
 * ------------------------------------------------------------------ */

/** Bytes a stuck player may queue while others keep the source flowing. */
const BLOCKED_QUEUE_LIMIT = 64 * 1024 * 1024;

/** Whether ffmpeg should be writing now. Pure. */
export function sourceFlowsFor(session) {
  if (!session?.clients || session.clients.size === 0) return false;
  for (const client of session.clients) if (!client.blocked) return true;
  return false;
}

/**
 * Pause or resume ffmpeg's output to match sourceFlowsFor(). This runs on every
 * full socket and every drain, so it is kept silent: the state is visible as
 * `held` in the session's status instead.
 */
function applySourceFlow(session) {
  const stdout = session?.kind === 'pipe' ? session.child?.stdout : null;
  if (!stdout) return;
  const flows = sourceFlowsFor(session);
  if (flows && session.held) {
    session.held = false;
    stdout.resume();
  } else if (!flows && !session.held) {
    session.held = true;
    stdout.pause();
  }
}

/**
 * Start ffmpeg again `seconds` before the play head, for a player that came
 * back after another one left (see RECONNECT_REWIND_SECONDS). The old ffmpeg is
 * stopped quietly: its exit is expected, so its handlers ignore it.
 */
function restartBack(session, seconds) {
  const at = Math.max(0, Math.floor(playheadSeconds(session) - seconds));
  log.info('relay', `session ${session.id} starts ${seconds}s back, at ${at}s, so what the last player had not shown is sent again`, {});
  const old = session.child;
  session.resumeSeconds = at;
  session.stats = {};
  session.command = argsToCommand(argsWithResume(session.args, at));
  if (old) {
    try { old.kill('SIGTERM'); } catch { /* already gone */ }
    try { old.stdout?.destroy(); } catch { /* already gone */ }
  }
  spawnFfmpeg(session);
}

/**
 * A player whose socket is full. The source is held unless another player is
 * still reading (sourceFlowsFor); a stall timer drops a player that never reads
 * again.
 */
function blockClient(session, client) {
  client.blocked = true;
  client.blockedAt = Date.now();
  const seconds = Math.max(5, Number(getConfig().transcode.clientStallSeconds) || 1800);
  client.stallTimer = setTimeout(() => {
    client.stallTimer = null;
    if (!session.clients.has(client)) return;
    log.warn('relay', 'dropping a player that has not read for too long (the source was held for it)', {
      session: session.id, ip: client.ip, stalledSec: seconds,
      clientSec: Math.round((Date.now() - client.startedAt) / 1000),
    });
    dropClient(session, client, 'stalled');
  }, seconds * 1000);
  client.stallTimer.unref?.();
  client.res.once('drain', () => releaseClient(session, client));
  applySourceFlow(session);
}

function releaseClient(session, client) {
  if (!client.blocked) return;
  client.blocked = false;
  clearTimeout(client.stallTimer);
  client.stallTimer = null;
  if (session.clients.has(client)) applySourceFlow(session);
}

/** A client that leaves, or is dropped, must not keep a stall timer or a hold. */
function forgetClient(client) {
  clearTimeout(client.stallTimer);
  client.stallTimer = null;
  client.blocked = false;
}

/**
 * End one player's response. The attach lifecycle does the bookkeeping (idle
 * lease, flow). `res.end()` sends what the player already has, then the end, so
 * a player that is still reading loses nothing.
 */
function dropClient(session, client, reason) {
  if (client.detach) client.detach(reason);
  else session.clients.delete(client);
  try { client.res.end(); } catch { /* already gone */ }
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
 * @param {object} [opts]  { profile: overrides, container, outputType, web: { videoCodecs, audioCodecs } }
 *
 * The `web` opt (set by the HTTP layer when the request came from the browser
 * preview) makes this a **preview session**: its own `outputType: 'web'`, no
 * subtitles, no item template, and a container/codec choice derived from what
 * the browser said it can play (see streams/web-preview.js).
 *
 * A session is a pipe that is already running, so it cannot be re-encoded for a
 * different client: a preview asked for while a VLC session is alive gets its
 * own session. That is the price of "the preview must never show subtitles",
 * and the idle stop closes both again when nobody is watching.
 */
export async function ensureSession(stream, opts = {}) {
  const web = opts.web ? { ...opts.web } : null;
  const existing = sessions.get(stream.id);
  if (existing && existing.alive) {
    if (existing.web === Boolean(web)) {
      log.debug('relay', `reusing session for stream ${stream.id}`, { clients: existing.clients.size, outputType: existing.outputType });
      return existing;
    }
    log.info('relay', `starting a separate ${web ? 'web preview' : 'player'} session for stream ${stream.id} (the running ${existing.outputType || 'default'} session cannot change its output)`, {
      existingOutput: existing.outputType || '', existingClients: existing.clients.size,
    });
    stopSession(stream.id, web ? 'replaced by web preview' : 'replaced by a non-preview output');
  }

  const cfg = getConfig();
  const outputType = web ? 'web' : (opts.outputType || '');
  const container = opts.container || opts.profile?.container || stream.profile?.container || cfg.transcode.container;
  let profileInput = { ...(stream.profile || {}), ...(opts.profile || {}), container };

  // The browser preview is not the receiver: the item's template is dropped and
  // the guided builder decides, because the template was written for VLC/the
  // VU+ (DVB subtitles, HEVC, AC-3 — none of which the MSE player can take).
  // What the browser CAN take comes from its own codec report; without a probe
  // the safe path is H.264 + AAC.
  let webDecisions = null;
  let template = null;
  if (web) {
    const decision = decideWebProfile({
      probe: stream.upstream?.probe || null,
      videoCodecs: web.videoCodecs || [],
      audioCodecs: web.audioCodecs || [],
      reported: web.reported !== false,
    });
    webDecisions = decision.decisions;
    profileInput = { ...profileInput, ...decision.profile };
    log.info('relay', `web preview profile for stream ${stream.id}: ${describeWebDecisions(webDecisions)}`, {
      reasons: webDecisions.reasons, video: webDecisions.video, audio: webDecisions.audio,
    });
  } else {
    // Apply the per-output FFmpeg template selection: stream output override →
    // stream default → global output default → global default. An empty result
    // falls through to the guided profile builder (i.e. no template is used).
    template = resolveOutputTemplateForSession(profileInput, outputType);
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

  // Chunked-fetch upstream proxy (the MovieBox-TUI mechanism): many of these
  // CDNs end a chunked transfer after a few minutes of footage, which is what
  // used to cut playback short. Instead of handing the CDN URL to ffmpeg, we
  // pull the media ourselves in small ranged requests (per-request headers,
  // per-request retries) and serve ffmpeg from a loopback endpoint. HLS stays
  // direct — ffmpeg's HLS demuxer already fetches small segments.
  const upProxy = await maybeCreateUpstreamProxy({ streamId: stream.id, upstream: stream.upstream });
  // The session owns its proxy: a paused, frozen session makes no fetches for
  // minutes, and the proxy's idle sweep must not close it under the session.
  if (upProxy) pinUpstreamProxy(upProxy, true);

  const args = buildFfmpegArgs({
    source: {
      url: upProxy ? upProxy.inputUrl : stream.upstream?.url,
      headers: upProxy ? {} : (stream.upstream?.headers || {}),
      kind: stream.upstream?.kind || undefined,
      container: stream.upstream?.probe?.container || null,
      subtitles: probeSubtitleList(stream.upstream?.probe),
    },
    profile: effectiveProfile,
    hw,
    mode: 'live',
    output: wantsHls
      ? { container: 'hls', target: path.join(hlsDir, 'index.m3u8'), hlsDir, hlsTime, hlsListSize: 10 }
      : { container: profile.container, target: 'pipe:1' },
  });

  // A template can write a container the URL did not promise (e.g. a Matroska
  // template bound to the `enigma2` slot: the bouquet serves `.ts.enigma2`, the
  // HTTP layer says `video/mp2t`, and the Duo2 gets an MKV). Worth one line in
  // the log — the receiver's mis-detection is otherwise blamed on the relay.
  const actualFormat = outputFormatOf(args);
  const expectedFormat = wantsHls ? 'hls' : (container === 'matroska' ? 'matroska' : 'mpegts');
  if (actualFormat && actualFormat !== expectedFormat) {
    log.warn('relay', `the ffmpeg command writes ${actualFormat} but the ${outputType || container} URL asked for ${expectedFormat} — players can mis-detect the stream`, {
      stream: stream.id, templateId: template?.templateId || '', template: template?.name || '',
    });
  }

  // "Subtitles never show on the box" is otherwise indistinguishable from "the
  // receiver ignores them": say up front whether this session muxes the
  // attached subtitle at all, and if not, why. The notes must describe the
  // container ffmpeg REALLY writes (a Matroska template bound to the .ts slot
  // still muxes the text sidecar) — not the container the URL promised.
  // A web preview is the one case where dropping subtitles is deliberate, not a
  // surprise: the decision line above already states it.
  for (const note of subtitleSessionNotes(effectiveProfile, actualFormat || (wantsHls ? 'hls' : container), args)) {
    if (web) { log.debug('relay', note, { stream: stream.id, output: 'web' }); continue; }
    log.warn('relay', note, { stream: stream.id, output: outputType || container, title: stream.title });
  }

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
    // A preview session: subtitle-free, template-free, codecs chosen from the
    // browser's own report. Marked so a player session can never be reused for
    // a browser (and the other way around).
    web: Boolean(web),
    webDecisions,
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
    // A movie that was stopped without anyone choosing it resumes at its play
    // head. HLS does not resume: its playlist would restart at zero.
    resumeSeconds: wantsHls ? 0 : takeResumePoint(stream.id),
    held: false,
    pendingRewind: 0,
    child: null,
    hw,
    upProxy,
  };

  sessions.set(stream.id, session);
  spawnFfmpeg(session);
  // Not every way of creating a session attaches a streaming response: the
  // session API can pre-start one, and HLS redirects before the client polls
  // /hls. Without an initial lease those zero-client sessions can pin an old
  // FFmpeg process/upstream forever and be reused after its signed URL expires.
  scheduleIdleStop(session);
  log.info('relay', `session ${session.id} started`, {
    mode: session.mode, encoder: session.encoder, container: session.container,
    outputType: session.outputType || '',
    templateId: session.templateId || '',
    templateSource: session.templateSource || '',
    upstreamProxy: upProxy ? `yes (${upProxy.kind})` : 'no',
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
  const args = session.resumeSeconds > 0 ? argsWithResume(session.args, session.resumeSeconds) : session.args;
  if (session.resumeSeconds > 0) {
    session.command = argsToCommand(args);
    log.info('relay', `session ${session.id} resumes at ${session.resumeSeconds}s`, {});
  }
  const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: ffmpegEnv(session.hw) });
  session.child = child;
  session.alive = true;
  session.held = false;

  child.stdout.on('data', (chunk) => {
    if (session.child !== child) return; // replaced by a restart (restartBack)
    session.bytesOut += chunk.length;
    session.lastActivity = Date.now();
    for (const client of [...session.clients]) writeToClient(session, client, chunk);
  });
  // Nobody attached (a restart, or a session started by an API call): hold the
  // source at once, so the movie does not run on into a pipe nobody reads.
  applySourceFlow(session);

  let stderrBuffer = '';
  child.stderr.on('data', (chunk) => {
    if (session.child !== child) return;
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
    if (session.child !== child) return;
    session.alive = false;
    logError('relay', `ffmpeg could not be started for session ${session.id}`, err, { command: truncate(session.command, 300) });
    endClients(session, 'ffmpeg could not be started');
  });

  child.on('close', async (code, signal) => {
    // A child replaced by restartBack exits on purpose: nothing here applies to it.
    if (session.child !== child) return;
    session.alive = false;
    const running = Math.round((Date.now() - session.startedAt) / 1000);
    const level = code === 0 || signal === 'SIGTERM' ? 'info' : 'error';
    log[level]('relay', `ffmpeg exited for session ${session.id}`, {
      code, signal, ranSec: running, clients: session.clients.size,
      stderr: truncate(session.stderrTail.slice(-4).join(' | '), 400),
    });

    if (sessions.get(session.streamId) !== session) return; // replaced deliberately

    // Restart while clients are still attached — upstream URLs drop, and the
    // chunked CDNs end transfers early; decideRestart() tells the two cases
    // apart from a genuine end-of-movie. On a mid-movie restart we resume at
    // the last play head instead of starting over. Fatal startup failures (a muxer
    // that cannot carry a mapped track, a dead VAAPI device) never recover by
    // restarting, so they short-circuit the budget.
    const fatal = fatalFfmpegFailure(session.stderrTail, {
      bytesOut: session.bytesOut, code, kind: session.kind,
    });
    // A clean end while clients watch is either the real end or an early cut.
    // If the movie's length is unknown, learn it first so the two can be told apart.
    if (!fatal && shouldLearnDuration(session, { code, signal })) {
      await learnMovieDuration(session).catch(() => null);
      if (sessions.get(session.streamId) !== session) return; // stopped while probing
    }
    const playedSec = playheadSeconds(session);
    const decision = fatal
      ? { restart: false, reason: 'fatal ffmpeg startup error — a restart repeats it' }
      : decideRestart({
        clients: session.clients.size,
        restarts: session.restarts,
        code, signal,
        outTimeMs: playedSec * 1000,
        durationSec: knownDurationSec(session.stream),
        maxRestarts: Math.max(1, Number(getConfig().transcode.maxRestarts) || 3),
      });
    if (fatal) {
      log.error('relay', `ffmpeg cannot process this stream — not restarting`, {
        session: session.id, hint: fatal.hint,
        stderr: truncate(session.stderrTail.slice(-4).join(' | '), 400),
      });
    }
    if (decision.restart) {
      session.restarts += 1;
      // Resume a couple of seconds before the last play head so the player
      // does not lose the GOP boundary it was decoding.
      session.resumeSeconds = playedSec > 10 ? Math.max(0, Math.floor(playedSec) - 2) : 0;
      if (session.resumeSeconds > 0) session.command = argsToCommand(argsWithResume(session.args, session.resumeSeconds));
      log.warn('relay', `restarting ffmpeg for session ${session.id} (attempt ${session.restarts})`, {
        reason: decision.reason, resumeAtSec: session.resumeSeconds,
        stderr: truncate(session.stderrTail.slice(-2).join(' | '), 240),
      });
      setTimeout(() => {
        if (sessions.get(session.streamId) === session && session.clients.size > 0) spawnFfmpeg(session);
      }, 1500).unref?.();
      return;
    }

    const endReason = fatal
      ? `ffmpeg cannot process this source (${truncate(fatal.hint, 160)})`
      : code === 0 ? `stream finished (${decision.reason})` : `ffmpeg exited with code ${code}`;
    // Nobody was attached when it ended (the CDN gave up on a held source, or
    // ffmpeg crashed while the player was away): keep the play head so the next
    // play resumes there. A fatal startup failure would repeat, so it keeps nothing.
    if (!fatal && session.clients.size === 0) rememberResumePoint(session);
    endClients(session, endReason);
    sessions.delete(session.streamId);
    releaseUpstreamProxy(session, decision.reason, { graceMs: 0 });

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
  // The first player back to a session that a player left starts a little earlier.
  if (session.clients.size === 0 && session.pendingRewind > 0 && session.alive && session.kind === 'pipe') {
    const seconds = session.pendingRewind;
    session.pendingRewind = 0;
    restartBack(session, seconds);
  }
  const client = {
    id: `c${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
    ip: req.ip || req.socket?.remoteAddress || 'unknown',
    userAgent: req.headers['user-agent'] || '',
    bytes: 0,
    startedAt: Date.now(),
    res,
    // Flow control: `blocked` while the socket is full (see blockClient).
    blocked: false,
    blockedAt: 0,
    stallTimer: null,
    detach: null,
  };
  session.clients.add(client);
  session.lastActivity = Date.now();
  clearIdleTimer(session);
  applySourceFlow(session);

  log.info('relay', `client attached to ${session.id}`, {
    clients: session.clients.size, ip: client.ip, ua: truncate(client.userAgent, 70), mode: session.mode,
  });

  const finish = (reason) => {
    if (!session.clients.has(client)) return;
    // What the relay had sent this player and it had not shown yet is lost with
    // the connection, so the next start rewinds (see RECONNECT_REWIND_SECONDS).
    session.pendingRewind = RECONNECT_REWIND_SECONDS;
    forgetClient(client);
    session.clients.delete(client);
    log.info('relay', `client detached from ${session.id}`, {
      reason, bytes: client.bytes, sec: Math.round((Date.now() - client.startedAt) / 1000), clients: session.clients.size,
      notReading: Boolean(client.blocked), held: Boolean(session.held), pendingRewind: session.pendingRewind || 0,
    });
    // The last player left: keep the (frozen) session for pauseKeepSeconds, so a
    // player that comes back continues from the same point.
    if (session.clients.size === 0) scheduleIdleStop(session, pauseKeepSeconds());
    applySourceFlow(session);
    onFinish?.(client);
  };
  client.detach = finish;

  req.on('close', () => finish('client closed'));
  req.on('aborted', () => finish('client aborted'));
  res.on('error', () => finish('response error'));
  return { client, finish };
}

function writeToClient(session, client, chunk) {
  let flushed;
  try {
    flushed = client.res.write(chunk);
  } catch (err) {
    log.warn('relay', 'write to client failed — dropping it', { error: String(err?.message || err), ip: client.ip });
    dropClient(session, client, 'write failed');
    return;
  }
  client.bytes += chunk.length;
  if (flushed) return;
  if (!client.blocked) {
    // A full socket is no longer grounds for dropping the player. The source is
    // held (or, while others read, this player queues) until it catches up.
    blockClient(session, client);
    return;
  }
  // Still behind, and the source kept flowing for another player: the queue
  // grows. Past the limit this player is lost, so the others are not held back.
  if (client.res.writableLength > BLOCKED_QUEUE_LIMIT) {
    log.warn('relay', 'dropping a player that cannot keep up while others watch', {
      session: session.id, ip: client.ip, queuedMb: Math.round(client.res.writableLength / 1048576),
    });
    dropClient(session, client, 'cannot keep up');
  }
}

function endClients(session, reason) {
  for (const client of [...session.clients]) {
    forgetClient(client);
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
    web: Boolean(session.web),
    // Why the preview got its particular codecs/subtitle drop — shown in the
    // preview modal and in `GET /api/streams/:id`.
    webDecisions: session.web ? (session.webDecisions || null) : null,
    templateId: session.templateId || '',
    templateSource: session.templateSource || '',
    clients: session.clients.size,
    // true while the source is held (no player, or a player not reading): the
    // movie is waiting, not stuck.
    held: Boolean(session.held),
    resumeSeconds: session.resumeSeconds || 0,
    startedAt: new Date(session.startedAt).toISOString(),
    uptimeSec: Math.round((Date.now() - session.startedAt) / 1000),
    bytesOut: session.bytesOut,
    stats: session.stats,
    restarts: session.restarts,
    alive: session.alive,
    command: session.command,
    hls: Boolean(session.hlsDir),
    progressUrl: session.hlsDir ? `/hls/${session.stream.token}/index.m3u8` : null,
    upstreamProxy: proxyStats(session.upProxy),
  };
}

export function stopAll(reason = 'shutdown') {
  for (const streamId of [...sessions.keys()]) stopSession(streamId, reason);
}

export default {
  ensureSession, attachClient, stopSession, releaseUpstreamProxy, listSessions, getSession,
  touchSessionByToken, stopAll, publicSession, runTemplateTest,
};
