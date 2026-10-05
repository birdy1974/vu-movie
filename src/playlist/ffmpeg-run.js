/**
 * vu-movie — live FFmpeg test runs.
 *
 * The Transcode and Test tabs both want the same thing: press a button, pick an
 * input source, and watch what the final ffmpeg command *actually prints* —
 * line by line, including the encoder chatter a successful run makes.
 *
 * `POST /api/ffmpeg/live-test` answers with Server-Sent Events (over a plain
 * fetch, so the browser can abort it) instead of JSON:
 *
 *   event: start    { command, argv, container, output }
 *   event: stderr   { line }
 *   event: stdout   { line }          (usually empty — ffmpeg logs on stderr)
 *   event: progress { frame, fps, bitrate, speed, outTimeMs, … }
 *   event: done     { ok, exitCode, signal, bytesOut, durationMs, timedOut }
 *
 * The command is parsed into argv (never run through a shell) and validated with
 * the same validator the relay uses, so a test can neither smuggle shell syntax
 * nor run a command the relay would refuse. The run is always bounded: the
 * client asks for a duration and the server caps it at 30 s (MAX_TEST_MS).
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log, errorText, truncate } from '../core/log.js';
import { getConfig } from '../core/config.js';
import { buildFfmpegTemplateArgs, hardware, argsToCommand, ffmpegPath, ffmpegEnv, validateFfmpegTemplate } from '../core/media.js';
import { parseProgressLine } from '../core/media.js';
import * as store from '../streams/store.js';

const router = express.Router();
const MAX_TEST_MS = 30_000;
const MIN_TEST_MS = 500;

function inputError(message) {
  const error = new Error(message);
  error.status = 422;
  return error;
}

/**
 * The stream a test runs against: a saved stream, or an ad-hoc URL from the
 * body (the Test tab's "custom URL" field). Signed cookies/referers of a saved
 * stream are replayed, which is the whole point of testing against it.
 */
async function resolveTestStream(body) {
  const streamId = String(body.streamId || '').trim();
  if (streamId) {
    const stream = await store.getStream(streamId);
    if (!stream) throw inputError(`stream "${streamId}" not found`);
    return stream;
  }
  const url = String(body.url || '').trim();
  if (!url) throw inputError('streamId or url is required');
  if (!/^https?:\/\//i.test(url)) throw inputError('url must start with http:// or https://');
  const headers = {};
  if (body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)) {
    for (const [key, value] of Object.entries(body.headers)) {
      if (typeof value === 'string' && value) headers[key] = value;
    }
  }
  return {
    id: `live-test-${Date.now().toString(36)}`,
    token: 'live-test',
    title: 'ad-hoc test source',
    upstream: { url, headers, kind: null },
    profile: {},
  };
}

router.post('/live-test', async (req, res) => {
  const body = req.body || {};
  const command = String(body.command || '').trim();
  if (!command) return res.status(422).json({ ok: false, error: 'command is required' });

  let stream;
  try {
    stream = await resolveTestStream(body);
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, error: errorText(err) });
  }

  const container = String(body.container || '').trim() || null;
  const validation = validateFfmpegTemplate(command, { container });
  if (!validation.ok) return res.status(422).json({ ok: false, error: validation.errors.join('; '), details: validation.errors });

  const durationMs = Math.min(Math.max(Number(body.durationMs) || 5000, MIN_TEST_MS), MAX_TEST_MS);
  const tmpRoot = path.join(getConfig().storage.tmp, 'live-test');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const target = path.join(tmpRoot, `${stream.id}-${Date.now().toString(36)}.ts`);
  const effectiveContainer = container || validation.container || 'mpegts';

  const hw = await hardware({ waitMs: 5000 }).catch(() => ({ available: false, reason: 'hardware probe unavailable' }));
  let args;
  try {
    args = buildFfmpegTemplateArgs({
      template: command,
      source: { url: stream.upstream.url, headers: stream.upstream.headers || {}, kind: stream.upstream.kind || undefined },
      profile: { container: effectiveContainer },
      mode: 'file',
      output: { container: effectiveContainer, target },
    });
  } catch (err) {
    return res.status(422).json({ ok: false, error: errorText(err) });
  }
  const renderedCommand = argsToCommand(args);

  // ---- SSE headers -------------------------------------------------------
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, payload) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ }
  };

  log.info('playlist', 'live template test start', {
    streamId: stream.id, container: effectiveContainer, durationMs, command: truncate(renderedCommand, 400),
  });

  const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: ffmpegEnv(hw) });
  const startedAt = Date.now();
  let bytesOut = 0;
  let stderrBuffer = '';
  let stdoutBuffer = '';
  let timedOut = false;
  let finished = false;

  send('start', {
    command: renderedCommand,
    argv: args,
    container: effectiveContainer,
    durationMs,
    stream: { id: stream.id, title: stream.title, url: stream.upstream.url },
    hardware: { available: hw.available === true, reason: hw.reason || null, encoder: hw.encoder || null },
  });

  const finish = (payload) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { fs.rmSync(target, { force: true }); } catch { /* the file may never exist */ }
    send('done', payload);
    res.end();
    log.info('playlist', 'live template test done', {
      streamId: stream.id, ok: payload.ok, bytesOut: payload.bytesOut, exitCode: payload.exitCode,
      signal: payload.signal, durationMs: payload.durationMs, timedOut: payload.timedOut,
    });
  };

  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    // Give ffmpeg a moment to flush its last lines, then stop waiting for it.
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, 1500);
  }, durationMs);

  child.stdout.on('data', (chunk) => {
    bytesOut += chunk.length;
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) if (line.trim()) send('stdout', { line });
  });

  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      if (/^[a-z_]+=/.test(line)) {
        send('progress', parseProgressLine(line, {}));
        continue;
      }
      send('stderr', { line });
    }
  });

  child.on('error', (err) => {
    send('stderr', { line: `could not start ffmpeg: ${errorText(err)}` });
    finish({ ok: false, error: errorText(err), exitCode: null, signal: null, bytesOut, durationMs: Date.now() - startedAt, timedOut: false });
  });

  child.on('close', (code, signal) => {
    if (stderrBuffer.trim()) send('stderr', { line: stderrBuffer.trim() });
    const ok = bytesOut > 0 && (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT');
    finish({
      ok, exitCode: code, signal: signal || null, bytesOut,
      durationMs: Date.now() - startedAt, timedOut,
      verdict: ok
        ? 'the command produced output and stopped cleanly'
        : bytesOut === 0
          ? 'no bytes reached the output — the command did not transcode this source'
          : 'ffmpeg exited with an error — read the raw output above',
    });
  });

  req.on('close', () => {
    if (finished) return;
    log.warn('playlist', 'live template test aborted by the client', { streamId: stream.id });
    finished = true;
    clearTimeout(timer);
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
  });
});

export default router;
