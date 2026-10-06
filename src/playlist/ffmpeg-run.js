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
 *   event: progress { frame, fps, bitrate, speed, outTimeMs, …, raw }
 *   event: done     { ok, exitCode, signal, bytesOut, durationMs, timedOut }
 *
 * The command is parsed into argv (never run through a shell) and validated with
 * the same validator the relay uses, so a test can neither smuggle shell syntax
 * nor run a command the relay would refuse. The run is always bounded: the
 * client asks for a duration and the server caps it at 30 s (MAX_TEST_MS).
 *
 * ffmpeg prints its `-progress pipe:2` stream as one key per line (frame=…,
 * fps=…, bitrate=…, …), so the stats are accumulated across those lines into one
 * object and every progress event also carries the exact line in `raw` — the
 * output panel prints that verbatim. With `-loglevel warning` (the default in
 * .env.example and in the bundled templates) those progress lines are the *only*
 * thing a healthy run prints, so dropping the raw line left the panel looking
 * empty while ffmpeg was working perfectly.
 *
 * Stdout is *not* the log channel — a template that ends in `pipe:1` (vu-movie's
 * own convention) writes the finished stream there, so stdout used to be sliced
 * on newlines and shipped to the browser as thousands of binary "lines": 2.7 MB
 * of MPEG-TS in 8 s, appended by the UI into one <pre> node until the tab locked
 * up. Now stdout is forwarded only while it reads like text: the first binary
 * chunk latches "this pipe carries the stream", after which stdout is counted
 * (see `bytesOut` / `stdoutBinaryBytes` in the verdict) and never printed.
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
/** Text stdout a test may print (the panel shows ~400 lines; this is plenty). */
const MAX_STDOUT_TEXT_CHARS = 64 * 1024;
/** One forwarded stdout line. Longer runs of bytes are media, not a log line. */
const MAX_STDOUT_LINE_CHARS = 2000;
/** Control bytes (except tab/newline) never appear in an ffmpeg log line. */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
/** Anything outside basic ASCII + tab. Real log text is ASCII (ffmpeg is). */
const NON_TEXT_RE = /[^\u0020-\u007e\t]/g;
/** Under this share of printable ASCII the "line" is a chunk of media. */
const MIN_PRINTABLE_RATIO = 0.9;

/**
 * How one raw stdout line should be treated. Pure, so it can be tested with a
 * real MPEG-TS sample instead of an ffmpeg run.
 *
 * @returns {{kind:'empty'}|{kind:'text', text:string}|{kind:'binary', bytes:number}}
 */
export function classifyStdoutLine(line) {
  const raw = String(line ?? '').replace(/\r$/, '');
  if (!raw.trim()) return { kind: 'empty' };
  const nonText = (raw.match(NON_TEXT_RE) || []).length;
  const mostlyAscii = (raw.length - nonText) / raw.length >= MIN_PRINTABLE_RATIO;
  // A "line" this long out of a media pipe is a chunk of packets with no
  // newline in it; binary bytes and near-binary runs are the same thing.
  if (CONTROL_RE.test(raw) || !mostlyAscii || raw.length > MAX_STDOUT_LINE_CHARS) {
    return { kind: 'binary', bytes: raw.length };
  }
  return { kind: 'text', text: raw };
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
  // ffmpeg's -progress output is one key per line, so accumulate it: every
  // progress event then carries the whole picture (frame, fps, bitrate, speed)
  // instead of whichever key happened to arrive last.
  const progressStats = {};
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

  let stdoutText = 0;             // printable characters forwarded so far
  let stdoutBinaryBytes = 0;      // media bytes recognised and suppressed
  let stdoutSuppressedBytes = 0;  // stdout bytes dropped by the caps
  let binaryNoted = false;
  let capNoted = false;
  // Set as soon as stdout turns out to carry the stream: from then on nothing
  // from stdout is printed, only counted (the panel stays readable).
  let stdoutIsMedia = false;

  /** One note (never one per chunk) about media bytes on stdout. */
  const noteBinaryOutput = (bytes) => {
    stdoutBinaryBytes += bytes;
    stdoutIsMedia = true;
    if (binaryNoted) return;
    binaryNoted = true;
    send('stdout', {
      line: '# this template writes the finished stream to stdout (pipe:1) — those bytes are counted, not printed. The verdict reports how many; point the template at <output> to keep the run silent.',
    });
  };

  const noteCap = () => {
    if (capNoted) return;
    capNoted = true;
    send('stdout', { line: `# further stdout suppressed — a test prints at most ${Math.round(MAX_STDOUT_TEXT_CHARS / 1024)} KB of text; the full run is in the app log` });
  };

  const forwardStdout = (raw) => {
    if (stdoutIsMedia) { noteBinaryOutput(raw.length); return; }
    const classified = classifyStdoutLine(raw);
    if (classified.kind === 'empty') return;
    if (classified.kind === 'binary') { noteBinaryOutput(classified.bytes); return; }
    if (stdoutText + classified.text.length > MAX_STDOUT_TEXT_CHARS) {
      stdoutSuppressedBytes += classified.text.length;
      noteCap();
      return;
    }
    stdoutText += classified.text.length;
    send('stdout', { line: classified.text });
  };

  child.stdout.on('data', (chunk) => {
    bytesOut += chunk.length;
    if (stdoutIsMedia) { noteBinaryOutput(chunk.length); return; }
    if (stdoutText >= MAX_STDOUT_TEXT_CHARS) {
      stdoutSuppressedBytes += chunk.length;
      noteCap();
      return;
    }
    stdoutBuffer += chunk.toString('latin1');
    let newline = stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      forwardStdout(line);
      if (stdoutText >= MAX_STDOUT_TEXT_CHARS) break;
      newline = stdoutBuffer.indexOf('\n');
    }
    // A media pipe has no newlines: flush what accumulated instead of letting
    // the buffer grow to the size of the movie.
    if (stdoutBuffer.length > MAX_STDOUT_LINE_CHARS) {
      noteBinaryOutput(stdoutBuffer.length);
      stdoutBuffer = '';
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      if (/^[a-z_]+=/.test(line)) {
        // `raw` is the line exactly as ffmpeg wrote it — the panel shows that.
        send('progress', { ...parseProgressLine(line, progressStats), raw: line });
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
    // The command usually writes to `target`, not to stdout (`bytesOut` counts
    // stdout bytes only), so the file size is what answers "did it produce
    // output?". `finish()` deletes the file, hence the stat first.
    let fileBytes = 0;
    try { fileBytes = fs.statSync(target).size; } catch { /* nothing reached disk */ }
    const produced = bytesOut + fileBytes;
    const ok = produced > 0 && (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT');
    finish({
      ok, exitCode: code, signal: signal || null, bytesOut: produced, fileBytes, stdoutBytes: bytesOut,
      durationMs: Date.now() - startedAt, timedOut,
      verdict: ok
        ? 'the command produced output and stopped cleanly'
        : produced === 0
          ? 'no bytes reached the output — the command did not transcode this source'
          : 'ffmpeg exited with an error — read the raw output above',
      stdoutBinaryBytes,
      stdoutSuppressedBytes,
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
