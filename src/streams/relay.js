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
import { log, logError, truncate } from '../core/log.js';
import { getConfig } from '../core/config.js';
import {
  FFMPEG, hardware, buildFfmpegArgs, argsToCommand, parseProgressLine, normaliseProfile,
} from '../core/media.js';

/** streamId → session */
const sessions = new Map();

export function listSessions() {
  return [...sessions.values()].map((s) => publicSession(s));
}

export function getSession(streamId) {
  return sessions.get(streamId) || null;
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
    log.debug('relay', `reusing session for stream ${stream.id}`, { clients: existing.clients.size });
    return existing;
  }

  const cfg = getConfig();
  const container = opts.container || opts.profile?.container || stream.profile?.container || cfg.transcode.container;
  const profileInput = { ...(stream.profile || {}), ...(opts.profile || {}), container };
  const profile = normaliseProfile(profileInput, stream.upstream?.probe || null);
  const hw = await hardware();

  const wantsHls = container === 'hls';
  // Segment length: 2 s keeps the VU+ zapping latency low, browsers happy and the
  // muxer overhead reasonable on a Celeron. Tunable through CONFIG.
  const hlsTime = Number(cfg.transcode.hlsSegmentSeconds) || 2;
  const hlsDir = wantsHls ? hlsDirFor(stream) : null;
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
    mode: profile.transcode ? 'transcode' : 'copy',
    encoder: profile.transcode ? (hw.available && profile.encoder === 'vaapi' ? 'h264_vaapi' : profile.encoder || 'libx264') : 'copy',
    profile: effectiveProfile,
    hlsDir: wantsHls ? hlsDirFor(stream) : null,
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

function spawnFfmpeg(session) {
  const cfg = getConfig();
  const child = spawn(FFMPEG, session.args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

export default { ensureSession, attachClient, stopSession, listSessions, getSession, stopAll, publicSession };
