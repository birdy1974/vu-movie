/**
 * vu-movie — media helpers: hardware detection, probing and the ffmpeg command builder.
 *
 * This file is the technical heart of the project and it is intentionally
 * dependency-free and side-effect-light so it can be unit-tested (test/media.test.js)
 * without a NAS, ffmpeg or a GPU.
 *
 * Hardware notes for the target box (Synology DS918+ — Intel Celeron J3455,
 * Apollo Lake, Intel HD Graphics 500):
 *   - decode: H.264, HEVC 8/10-bit, VP9, VC-1, MPEG-2   (all fine)
 *   - encode: **H.264 only** via VAAPI. HEVC/VP9 encoding does not exist on this
 *     silicon, so "H.265 output" is CPU-only and unusably slow for live streams.
 *   - one live 1080p H.264 encode at a time; the requested target is 8 Mbit/s.
 *
 * The ffmpeg argument list mirrors the command from the requirements, with the
 * corrections documented in docs/MOCKUP.md §5 (framerate handling + fallbacks).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log, logError, truncate } from './log.js';
import { getConfig } from './config.js';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
export const HW_CACHE_FILE = process.env.HWACCEL_CACHE
  || path.join(process.env.CONFIG_FILE ? path.dirname(process.env.CONFIG_FILE) : '/config', 'hwaccel.json');

/** Where Debian keeps the VA-API driver modules (iHD_drv_video.so / i965_drv_video.so). */
export const LIBVA_DRIVERS_PATH = process.env.LIBVA_DRIVERS_PATH || '/usr/lib/x86_64-linux-gnu/dri';

/* ------------------------------------------------------------------ tunables */

/**
 * `ffmpeg -version` normally answers in well under a second — but on a NAS that
 * is still booting (cold page cache for ~100 shared libraries, Docker importing
 * the image, Postgres migrating, a busy volume) it can take considerably longer.
 * That is why:
 *   - the ceiling is generous (FFMPEG_PROBE_TIMEOUT_MS, 30 s by default), and
 *   - a timeout is NEVER reported as "ffmpeg is missing", and
 *   - a failed check is retried in the background instead of being cached for a
 *     week (the old behaviour: see docs/SYNO.md → troubleshooting).
 */
const BIN_TIMEOUT_MS = Math.max(2_000, Number(process.env.FFMPEG_PROBE_TIMEOUT_MS || 30_000));
const BIN_RETRIES = Math.max(0, Number(process.env.FFMPEG_PROBE_RETRIES ?? 1));
/** How long to wait before re-checking a *failed* binary probe (self-healing). */
const BIN_RECHECK_MS = Math.max(10_000, Number(process.env.FFMPEG_RECHECK_MS || 60_000));
const VAINFO_TIMEOUT_MS = Math.max(2_000, Number(process.env.VAINFO_TIMEOUT_MS || 15_000));
const SELFTEST_TIMEOUT_MS = Math.max(5_000, Number(process.env.VAAPI_SELFTEST_TIMEOUT_MS || 30_000));
/** A working VAAPI pipeline is worth caching for a week … */
const HW_POSITIVE_TTL_MS = 7 * 24 * 3600 * 1000;
/** … a negative one only for minutes, so a fixed driver/permission is picked up. */
const HW_NEGATIVE_TTL_MS = Math.max(60_000, Number(process.env.HWACCEL_RETRY_MS || 5 * 60 * 1000));

/** Candidate locations, best first — a wrong FFMPEG_PATH must not brick the app. */
const FFMPEG_CANDIDATES = [...new Set([
  process.env.FFMPEG_PATH, '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg',
].filter(Boolean))];
const FFPROBE_CANDIDATES = [...new Set([
  process.env.FFPROBE_PATH, '/usr/bin/ffprobe', '/usr/local/bin/ffprobe', 'ffprobe',
].filter(Boolean))];

/** Path the app will actually spawn (updated by checkBinaries()). */
let resolvedFfmpeg = FFMPEG;
let resolvedFfprobe = FFPROBE;
export function ffmpegPath() { return resolvedFfmpeg; }
export function ffprobePath() { return resolvedFfprobe; }

/* ------------------------------------------------------------------ *
 * process helpers — every probe is asynchronous: a slow disk may delay the
 * hardware self-test, it must never freeze the HTTP server or the healthcheck.
 * ------------------------------------------------------------------ */

/**
 * Spawn a command, wait for it, never throw and never block the event loop.
 * The result says *why* it failed: ENOENT (missing), EACCES (permission), a
 * timeout (slow/busy disk) or a non-zero exit — those are very different bugs.
 */
export function runCommand(command, args = [], { timeoutMs = 30_000, env = null } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const base = {
      command, args, ok: false, timedOut: false, code: null, signal: null,
      stdout: '', stderr: '', error: null, elapsedMs: 0, timeoutMs,
    };

    let child;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env ? { ...process.env, ...env } : process.env,
        // Own process group so a timeout can kill the whole tree (see below).
        detached: true,
      });
    } catch (err) {
      resolve({ ...base, error: err, elapsedMs: Date.now() - startedAt });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    let timer = null;
    const finish = (patch) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({
        ...base, ...patch, timedOut, stdout, stderr,
        ok: !timedOut && !patch.error && patch.code === 0,
        elapsedMs: Date.now() - startedAt,
      });
    };

    timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole process group and answer right away: a wrapper script
      // (`sh -c …`) can otherwise leave a grandchild holding the stdio pipes
      // open, which delays the 'close' event by however long that grandchild
      // lives — the bug that made a 2 s probe look like a 5 s one.
      try { process.kill(-child.pid, 'SIGKILL'); } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      finish({ code: null, signal: 'SIGKILL' });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (error) => finish({ error }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

/** Pure: turn a runCommand() result into an actionable, human-readable reason. */
export function classifyBinaryFailure(result = {}) {
  const {
    command = 'command', error = null, timedOut = false, code = null, stderr = '', timeoutMs = 0,
  } = result;
  if (timedOut) {
    return {
      kind: 'timeout',
      message: `${command} did not answer within ${Math.round(timeoutMs / 1000)} s and was killed — `
        + 'this is a TIMEOUT, not a missing binary (cold/busy disk or an overloaded NAS)',
    };
  }
  if (error?.code === 'ENOENT') return { kind: 'missing', message: `${command} was not found inside the container (ENOENT)` };
  if (error?.code === 'EACCES') return { kind: 'permission', message: `${command} is not executable (EACCES) — check its file mode` };
  if (error) return { kind: 'spawn', message: `${command} could not be started: ${error.message}` };
  const tail = String(stderr).trim().split('\n').slice(-2).join(' | ');
  return { kind: 'exit', message: `${command} exited with ${code}${tail ? `: ${truncate(tail, 200)}` : ''}` };
}

/**
 * The VA-API drivers to try, in order. Pure, so it can be unit-tested.
 *
 * `LIBVA_DRIVER_NAME` from the environment always wins (explicit configuration
 * is respected), iHD is preferred when installed — it is the modern driver — and
 * i965 is the fallback that usually *does* work on Apollo Lake / DS918+ where
 * iHD fails to initialise against Synology's older kernel.
 */
export function libvaDriverCandidates({ env = process.env, driPath = LIBVA_DRIVERS_PATH, exists = fs.existsSync } = {}) {
  const named = String(env.LIBVA_DRIVER_NAME || '').trim();
  const out = [];
  for (const driver of [named, 'iHD', 'i965']) {
    if (!driver || out.includes(driver)) continue;
    if (driver === named || exists(path.join(driPath, `${driver}_drv_video.so`))) out.push(driver);
  }
  return out;
}

/** Environment for an ffmpeg process, pinned to the driver that was proven to work. */
export function ffmpegEnv(hw = null, { env = process.env, driPath = LIBVA_DRIVERS_PATH, exists = fs.existsSync } = {}) {
  const out = { ...env };
  if (hw?.libvaDriver) out.LIBVA_DRIVER_NAME = hw.libvaDriver;
  if (!out.LIBVA_DRIVERS_PATH && exists(driPath)) out.LIBVA_DRIVERS_PATH = driPath;
  return out;
}

/**
 * Pure: may a cached capability file be reused?
 * The important rules (they are what broke on the DS918+):
 *   - a cache entry written while ffmpeg could not be probed is NEVER reused;
 *   - negative results expire in minutes, positive ones in a week;
 *   - a change of device (present/missing) always invalidates.
 */
export function cacheUsable(cached, {
  device, devicePresent, now = Date.now(),
  positiveTtlMs = HW_POSITIVE_TTL_MS, negativeTtlMs = HW_NEGATIVE_TTL_MS,
} = {}) {
  if (!cached || !cached.checkedAt) return { usable: false, why: 'no cached timestamp' };
  const age = now - Date.parse(cached.checkedAt);
  if (!Number.isFinite(age) || age < 0) return { usable: false, why: 'unreadable timestamp' };
  if (cached.device !== device) return { usable: false, why: `cached for a different device (${cached.device})` };
  if (!cached.binaries?.ffmpeg?.ok) return { usable: false, why: 'previous check could not run ffmpeg — never trust that' };
  if (Boolean(cached.devicePresent) !== Boolean(devicePresent)) return { usable: false, why: 'the /dev/dri situation changed' };
  if (age > (cached.available ? positiveTtlMs : negativeTtlMs)) {
    const hours = (age / 3600_000).toFixed(1);
    return { usable: false, why: `${cached.available ? 'positive' : 'negative'} result is ${hours} h old` };
  }
  return { usable: true, why: 'still valid' };
}

/* ------------------------------------------------------------------ *
 * binary / hardware detection
 * ------------------------------------------------------------------ */

let binariesPromise = null;
let binariesValue = null;
let binariesRecheckTimer = null;

/**
 * Are ffmpeg/ffprobe actually present and usable?
 *
 * Asynchronous on purpose: a cold NAS volume can make `ffmpeg -version` take
 * seconds, and the old synchronous version blocked the event loop — which also
 * meant the container answered no healthcheck while it waited.
 *
 * @returns {Promise<{ffmpeg: object, ffprobe: object, checkedAt: string}>}
 */
export function checkBinaries({ force = false } = {}) {
  if (force) {
    clearTimeout(binariesRecheckTimer);
    binariesRecheckTimer = null;
    binariesPromise = null;
  }
  if (!binariesPromise) binariesPromise = checkBinariesNow();
  return binariesPromise;
}

/** Last completed binary check (or null while the very first one is running). */
export function binariesStatus() {
  return binariesValue;
}

async function checkBinariesNow() {
  const ffmpeg = await probeBinary('ffmpeg', FFMPEG_CANDIDATES);
  const ffprobe = await probeBinary('ffprobe', FFPROBE_CANDIDATES);
  if (ffmpeg.ok) resolvedFfmpeg = ffmpeg.path;
  if (ffprobe.ok) resolvedFfprobe = ffprobe.path;

  binariesValue = { ffmpeg, ffprobe, checkedAt: new Date().toISOString() };

  if (ffmpeg.ok) {
    log.info('hwaccel', `ffmpeg: ${ffmpeg.version}`, { path: ffmpeg.path, ms: ffmpeg.elapsedMs });
  } else if (ffmpeg.kind === 'timeout') {
    log.error('hwaccel', 'ffmpeg did not answer in time — this is a TIMEOUT, not a missing binary', {
      timeoutMs: BIN_TIMEOUT_MS, attempts: ffmpeg.attempts, retryInMs: BIN_RECHECK_MS,
    });
  } else {
    log.error('hwaccel', 'ffmpeg is not usable — scanning works, but NOTHING can be streamed or transcoded', {
      error: ffmpeg.error, attempts: ffmpeg.attempts,
    });
  }
  if (!ffprobe.ok) log.warn('hwaccel', 'ffprobe not available — stream probing is limited', { error: ffprobe.error });

  if (!ffmpeg.ok) scheduleBinaryRecheck();
  return binariesValue;
}

/**
 * Pure: which of several failed attempts explains the situation best?
 * Ordered by how much it tells us — a timeout (a real, action-able condition)
 * beats "this path does not exist", which is what the other candidates in the
 * list will report anyway when the configured path is the only real one.
 */
export function pickPrimaryFailure(attempts = []) {
  const priority = ['timeout', 'permission', 'exit', 'spawn', 'missing'];
  return [...attempts].sort((a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind))[0] || {};
}

/**
 * Try every candidate path for a binary. A candidate that does not exist fails
 * instantly (ENOENT); a timeout is the only slow failure and gets one retry
 * before the next candidate is tried.
 */
async function probeBinary(label, candidates) {
  const attempts = [];
  for (const [index, candidate] of candidates.entries()) {
    const tries = index === 0 ? BIN_RETRIES + 1 : 1;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      const res = await runCommand(candidate, ['-version'], { timeoutMs: BIN_TIMEOUT_MS });
      if (res.ok) {
        return {
          ok: true, path: candidate, kind: 'ok', attempts,
          version: String(res.stdout).split('\n')[0].trim() || `${label} (no version banner)`,
          elapsedMs: res.elapsedMs,
        };
      }
      const failure = classifyBinaryFailure(res);
      attempts.push({ candidate, attempt, kind: failure.kind, message: failure.message, elapsedMs: res.elapsedMs });
      // A missing / non-executable path cannot start working on a retry → next.
      if (failure.kind === 'missing' || failure.kind === 'permission') break;
    }
  }
  const primary = pickPrimaryFailure(attempts);
  return {
    ok: false,
    kind: primary.kind || 'missing',
    error: primary.message || `${label} not found (tried ${candidates.join(', ')})`,
    attempts,
    elapsedMs: attempts.reduce((sum, a) => sum + (a.elapsedMs || 0), 0),
  };
}

/**
 * A failed ffmpeg probe must never be sticky: it is retried in the background
 * and, when ffmpeg finally answers, hardware detection runs again — without a
 * container restart and without the user clicking anything.
 */
function scheduleBinaryRecheck() {
  clearTimeout(binariesRecheckTimer);
  binariesRecheckTimer = setTimeout(async () => {
    binariesRecheckTimer = null;
    binariesPromise = null;
    try {
      const fresh = await checkBinaries({ force: true });
      if (fresh.ffmpeg.ok) {
        log.info('hwaccel', 'ffmpeg answered on the retry — re-running the hardware detection');
        startDetection(true).catch((err) => logError('hwaccel', 're-detection failed', err));
      }
    } catch (err) {
      logError('hwaccel', 'background ffmpeg re-check failed', err);
    }
  }, BIN_RECHECK_MS);
  binariesRecheckTimer.unref?.();
}

/** Parse `vainfo` output (pure — unit-tested). */
export function parseVainfoOutput(output) {
  const text = String(output || '');
  const profiles = text.split('\n').filter((l) => l.includes('VAProfile'));
  const encode = profiles.filter((l) => l.includes('Enc'));
  return {
    driverVersion: (text.match(/Driver version:\s*(.+)/) || [])[1]?.trim() || 'unknown',
    /** "VAProfileH264High : VAEntrypointEncSlice" → H.264 encoding is possible. */
    h264Encode: /VAProfileH264\w*\s*:\s*VAEntrypoint\w*Enc\w*/.test(text),
    /** HD Graphics 500: decode-only → this stays false and we log that clearly. */
    hevcEncode: /VAProfileHEVC\w*\s*:\s*VAEntrypoint\w*Enc\w*/.test(text),
    h264Decode: /VAProfileH264\w*\s*:\s*VAEntrypointVLD/.test(text),
    hevcDecode: /VAProfileHEVC\w*\s*:\s*VAEntrypointVLD/.test(text),
    encodeProfiles: encode.map((l) => l.trim()),
  };
}

/**
 * Run vainfo with one specific driver. vainfo is only used for *reporting* —
 * the encode self-test below is what decides — so a vainfo failure is recorded
 * and never fatal.
 */
async function runVainfo(device, driver = null) {
  const res = await runCommand('vainfo', ['-d', device], {
    timeoutMs: VAINFO_TIMEOUT_MS,
    env: driver ? { LIBVA_DRIVER_NAME: driver, LIBVA_DRIVERS_PATH } : null,
  });
  const parsed = parseVainfoOutput(res.stdout);
  if (res.ok) return { ok: true, driverName: driver, output: res.stdout, ...parsed };
  const reason = res.timedOut
    ? `vainfo did not answer within ${Math.round(VAINFO_TIMEOUT_MS / 1000)} s`
    : (String(res.stderr).trim().split('\n').slice(-2).join(' | ')
      || String(res.error?.message || `exit ${res.code}`));
  return { ok: false, driverName: driver, output: `${res.stdout}${res.stderr}`, error: reason, ...parsed };
}

/**
 * Self-test the vaapi pipelines. This runs a 2 second encode of a generated test
 * pattern and records WHICH framerate variant works, because the `fps` filter
 * cannot run on VAAPI surfaces on every ffmpeg build:
 *   variant 1 = scale_vaapi=…,fps=N            (exactly the command from the spec)
 *   variant 2 = scale_vaapi=… + -fps_mode cfr -r N   (modern ffmpeg)
 *   variant 3 = scale_vaapi=… + -r N                 (legacy syntax)
 */
async function selfTestVariant(device, variant, driver = null) {
  const filter = variant === 1
    ? 'format=nv12,hwupload,scale_vaapi=w=640:h=360:format=nv12,fps=25'
    : 'format=nv12,hwupload,scale_vaapi=w=640:h=360:format=nv12';
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-init_hw_device', `vaapi=intel:${device}`,
    '-filter_hw_device', 'intel',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25',
    '-t', '2', '-vf', filter,
    '-c:v', 'h264_vaapi', '-b:v', '1000k',
  ];
  if (variant === 1) args.push('-r', '25');
  if (variant === 2) args.push('-fps_mode', 'cfr', '-r', '25');
  if (variant === 3) args.push('-r', '25');
  args.push('-f', 'null', '-');

  const res = await runCommand(ffmpegPath(), args, {
    timeoutMs: SELFTEST_TIMEOUT_MS,
    env: driver ? { LIBVA_DRIVER_NAME: driver, LIBVA_DRIVERS_PATH } : null,
  });
  const stderr = String(res.stderr || '').trim();
  return {
    variant,
    driver,
    ok: res.ok,
    ms: res.elapsedMs,
    error: res.ok
      ? ''
      : (res.timedOut
        ? `timed out after ${Math.round(SELFTEST_TIMEOUT_MS / 1000)} s`
        : (stderr.split('\n').slice(-3).join(' | ') || String(res.error?.message || `exit ${res.code}`))),
  };
}

/** Read the cached capability file; returns null when it is missing or broken. */
function readHwCache() {
  try {
    if (!fs.existsSync(HW_CACHE_FILE)) return null;
    return JSON.parse(fs.readFileSync(HW_CACHE_FILE, 'utf8'));
  } catch (err) {
    log.warn('hwaccel', 'hardware cache unreadable — re-detecting', { error: String(err?.message || err) });
    return null;
  }
}

/**
 * Detect the hardware capability of the machine we run on.
 *
 * Two things this function must get right (they are what broke on the DS918+):
 *   1. a *timeout* while probing ffmpeg is never treated as "ffmpeg missing";
 *   2. every installed VA-API driver is tried (iHD then i965), because iHD fails
 *      to initialise on Apollo Lake with Synology's kernel — the driver that
 *      actually encoded the test pattern is remembered and passed to ffmpeg.
 *
 * Result is cached on disk so the NAS does not re-test on every restart; pass
 * {force:true} to re-run (the Settings page "re-test hardware" button does).
 */
export async function detectHardware({ force = false } = {}) {
  const cfg = getConfig();
  const device = cfg.transcode.device;
  const devicePresent = fs.existsSync(device);

  if (!force) {
    const cached = readHwCache();
    if (cached) {
      const verdict = cacheUsable(cached, { device, devicePresent });
      if (verdict.usable) {
        log.debug('hwaccel', 'using cached hardware capability', {
          checkedAt: cached.checkedAt, available: cached.available, driver: cached.libvaDriver || null,
        });
        return cached;
      }
      log.info('hwaccel', `cached hardware capability ignored — ${verdict.why}`);
    }
  }

  const binaries = await checkBinaries({ force });
  const result = {
    device,
    devicePresent,
    binaries,
    available: false,
    reason: '',
    driver: '',
    driverName: null,
    libvaDriver: null,
    encoder: null,
    h264Encode: false,
    hevcEncode: false,
    h264Decode: false,
    hevcDecode: false,
    fpsVariant: null,
    attempts: [],
    checkedAt: new Date().toISOString(),
    errors: [],
  };

  if (!cfg.transcode.hardware) {
    result.reason = 'hardware acceleration disabled in settings';
    log.warn('hwaccel', result.reason);
  } else if (!binaries.ffmpeg.ok) {
    // The binary check already logged the *real* reason (timeout vs missing) and
    // scheduled a retry, so this stays deliberately vague.
    result.reason = binaries.ffmpeg.kind === 'timeout'
      ? 'ffmpeg did not answer in time (a timeout, not a missing binary) — retrying in the background'
      : `ffmpeg is not usable in the container (${binaries.ffmpeg.error})`;
    log.warn('hwaccel', 'hardware transcoding needs ffmpeg — software path unavailable too until ffmpeg answers', {
      kind: binaries.ffmpeg.kind, attempts: binaries.ffmpeg.attempts,
    });
  } else if (!result.devicePresent) {
    result.reason = `${device} not present — pass /dev/dri into the container (docker-compose devices:)`;
    let driEntries = [];
    try { driEntries = fs.readdirSync('/dev/dri'); } catch { /* no /dev/dri at all */ }
    log.error('hwaccel', result.reason.trim(), {
      device,
      driEntries,
      hint: driEntries.length
        ? 'the host has /dev/dri but not that entry — set VAAPI_DEVICE to one of the entries above'
        : 'the host itself has no /dev/dri — check on the NAS: ls -l /dev/dri (the Intel GPU driver must be loaded)',
    });
  } else {
    const drivers = libvaDriverCandidates();
    if (!drivers.length) {
      log.warn('hwaccel', `no VA-API driver module found in ${LIBVA_DRIVERS_PATH} — letting libva choose`);
      drivers.push(null);
    }
    log.debug('hwaccel', `trying VA-API drivers: ${drivers.map((d) => d || 'libva default').join(' → ')}`);

    let chosen = null;
    for (const driver of drivers) {
      const label = driver || 'libva default';
      const vainfo = await runVainfo(device, driver);
      const attempt = {
        driver: label,
        vainfo: vainfo.ok,
        vainfoError: vainfo.ok ? null : truncate(vainfo.error, 240),
        driverVersion: vainfo.driverVersion,
        fpsVariant: null,
      };

      if (vainfo.ok) {
        log.info('hwaccel', `vaapi (${label}): ${vainfo.driverVersion}`, {
          h264Decode: vainfo.h264Decode, hevcDecode: vainfo.hevcDecode,
          h264Encode: vainfo.h264Encode, hevcEncode: vainfo.hevcEncode,
        });
      } else {
        log.warn('hwaccel', `vainfo failed with ${label} — trying the encoder anyway`, { error: attempt.vainfoError });
        result.errors.push(`vainfo (${label}): ${attempt.vainfoError}`);
      }

      // Pick a framerate variant (only relevant when a fps conversion is requested).
      for (const variant of [1, 2, 3]) {
        const test = await selfTestVariant(device, variant, driver);
        if (test.ok) {
          chosen = { driver, vainfo, variant, ms: test.ms };
          break;
        }
        result.errors.push(`variant ${variant} (${label}): ${truncate(test.error, 240)}`);
        log.warn('hwaccel', `vaapi self-test variant ${variant} failed with ${label}`, { error: truncate(test.error, 200) });
      }
      result.attempts.push(attempt);

      if (chosen) {
        attempt.fpsVariant = chosen.variant;
        break;
      }
      if (drivers.length > 1) {
        log.warn('hwaccel', `${label} cannot encode on this box — trying the next driver`);
      }
    }

    if (chosen) {
      result.available = true;
      result.encoder = 'h264_vaapi';
      result.fpsVariant = chosen.variant;
      result.driverName = chosen.driver;
      result.libvaDriver = chosen.driver;
      result.driver = chosen.vainfo.driverVersion;
      result.h264Encode = chosen.vainfo.h264Encode;
      result.hevcEncode = chosen.vainfo.hevcEncode;
      result.h264Decode = chosen.vainfo.h264Decode;
      result.hevcDecode = chosen.vainfo.hevcDecode;
      log.info('hwaccel', `vaapi self-test ok (variant ${chosen.variant}${chosen.driver ? `, LIBVA_DRIVER_NAME=${chosen.driver}` : ''})`, {
        variantMeaning: chosen.variant === 1
          ? 'fps filter inside the vaapi filter chain'
          : chosen.variant === 2 ? '-fps_mode cfr + -r' : 'legacy -r',
        ms: chosen.ms,
      });
      if (!result.hevcEncode) {
        log.warn('hwaccel', 'HEVC *encoding* is not supported by this GPU (Apollo Lake encodes H.264 only) — H.265 output would be CPU-only');
      }
    } else {
      result.reason = 'no vaapi encode pipeline worked — using software encoding';
      log.error('hwaccel', result.reason, { drivers: result.attempts.map((a) => a.driver), errors: result.errors.slice(-3) });
    }
  }

  try {
    fs.mkdirSync(path.dirname(HW_CACHE_FILE), { recursive: true });
    const payload = {
      ...result,
      /** Written for the humans reading /config/hwaccel.json. */
      note: result.available
        ? `working pipeline: LIBVA_DRIVER_NAME=${result.libvaDriver || '(libva default)'}, fps variant ${result.fpsVariant}`
        : `negative result — re-checked automatically (positive results are cached for 7 days, negative ones for ${Math.round(HW_NEGATIVE_TTL_MS / 60000)} min)`,
    };
    fs.writeFileSync(HW_CACHE_FILE, JSON.stringify(payload, null, 2));
    log.debug('hwaccel', `capability cached in ${HW_CACHE_FILE}`, {
      available: result.available, driver: result.libvaDriver, fpsVariant: result.fpsVariant,
    });
  } catch (err) {
    log.warn('hwaccel', 'could not cache hardware capability', { error: String(err?.message || err) });
  }
  return result;
}

/**
 * Hardware detection state.
 *
 * Detection runs in the background: a full run can take a few seconds (three
 * vaapi self-test encodes) and it must never delay the HTTP server, the
 * healthcheck or a playback request. Callers `await hardware()`; the settings
 * page forces a fresh run.
 */
let hwPromise = null;
let hwValue = null;
let hwStartedAt = 0;

function pendingHardware(reason) {
  return {
    pending: true,
    device: getConfig().transcode.device,
    devicePresent: null,
    binaries: binariesStatus(),
    available: false,
    reason: reason || 'hardware detection is still running — software encoding in the meantime',
    driver: '', driverName: null, libvaDriver: null, encoder: null,
    h264Encode: false, hevcEncode: false, h264Decode: false, hevcDecode: false,
    fpsVariant: null, attempts: [], errors: [],
    checkedAt: new Date(hwStartedAt || Date.now()).toISOString(),
  };
}

/**
 * Start (or reuse) a detection run.
 * @param {boolean} force  run the self-test again instead of using the cache
 * @param {number}  waitMs give up waiting after this many ms and return the
 *                         current state instead — a stream must not hang just
 *                         because the GPU is slow to answer; the next session
 *                         picks up the real result.
 */
export function hardware({ force = false, waitMs = 0 } = {}) {
  if (!hwPromise || force) hwPromise = startDetection(force);
  if (!waitMs) return hwPromise;
  return Promise.race([hwPromise, delay(waitMs).then(() => hardwareStatus())]);
}

/** The settled result — or a `pending` placeholder, never a hang. */
export function hardwareStatus() {
  if (hwValue) return hwValue;
  return pendingHardware(hwStartedAt ? undefined : 'hardware detection has not run yet');
}

/** True while a detection run has neither resolved nor failed. */
export function hardwarePending() {
  return hwStartedAt > 0 && !hwValue;
}

function startDetection(force) {
  hwValue = null;
  hwStartedAt = Date.now();
  return detectHardware({ force })
    .then((result) => { hwValue = result; return result; })
    .catch((err) => {
      logError('hwaccel', 'hardware detection failed', err);
      hwValue = { ...pendingHardware(), pending: false, reason: `hardware detection failed: ${err?.message || err}` };
      return hwValue;
    });
}

const delay = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/**
 * Full diagnostic report for the "ffmpeg does not work" class of problems.
 * Every probe is timed, so the answer needs no guessing: which binary answered
 * (and how long it took), what the exited container can see, which VA-API
 * driver actually encodes. Used by GET /api/diagnostics/ffmpeg.
 */
export async function diagnoseFfmpeg({ device = null } = {}) {
  const target = device || getConfig().transcode.device;
  const startedAt = Date.now();
  const binaries = await checkBinaries({ force: true }); // also clears a failed state
  const report = {
    ok: Boolean(binaries.ffmpeg.ok),
    ffmpeg: binaries.ffmpeg,
    ffprobe: binaries.ffprobe,
    searched: { ffmpeg: FFMPEG_CANDIDATES, ffprobe: FFPROBE_CANDIDATES },
    config: {
      FFMPEG_PATH: process.env.FFMPEG_PATH || null,
      device: target,
      LIBVA_DRIVER_NAME: process.env.LIBVA_DRIVER_NAME || null,
      LIBVA_DRIVERS_PATH,
      hardwareEnabled: getConfig().transcode.hardware,
      probeTimeoutMs: BIN_TIMEOUT_MS,
    },
    devicePresent: fs.existsSync(target),
    driEntries: (() => { try { return fs.readdirSync('/dev/dri'); } catch { return []; } })(),
    drivers: [],
    elapsedMs: 0,
  };

  if (report.ok && report.devicePresent) {
    const drivers = libvaDriverCandidates();
    if (!drivers.length) drivers.push(null); // let libva pick its own default
    for (const driver of drivers) {
      const vainfo = await runVainfo(target, driver);
      const smoke = await selfTestVariant(target, 2, driver);
      report.drivers.push({
        driver: driver || 'libva default',
        vainfo: { ok: vainfo.ok, version: vainfo.driverVersion, error: vainfo.error || null },
        encode: { ok: smoke.ok, ms: smoke.ms ?? null, error: smoke.error || null },
        h264Encode: vainfo.h264Encode,
        hevcEncode: vainfo.hevcEncode,
      });
    }
  }

  report.hardwareOk = report.drivers.some((d) => d.encode.ok);
  report.elapsedMs = Date.now() - startedAt;
  report.hint = report.ok
    ? (report.hardwareOk
      ? 'ffmpeg works and at least one VA-API driver encodes — hardware transcoding is usable'
      : (report.devicePresent
        ? 'ffmpeg works, but no VA-API driver could encode: check /dev/dri permissions and LIBVA_DRIVER_NAME (i965 is the usual fix on Apollo Lake)'
        : `ffmpeg works, but ${target} is not in the container — pass /dev/dri through (docker-compose devices:)`))
    : (binaries.ffmpeg.kind === 'timeout'
      ? `ffmpeg exists but did not answer within ${Math.round(BIN_TIMEOUT_MS / 1000)} s — the NAS is slow right now, the app retries automatically`
      : String(binaries.ffmpeg.error || 'ffmpeg is not available'));
  return report;
}

/* ------------------------------------------------------------------ *
 * source classification + probing
 * ------------------------------------------------------------------ */

/** 'hls' | 'dash' | 'file' — determines how ffmpeg is fed. */
export function streamKind(url) {
  const clean = String(url || '').split('?')[0].toLowerCase();
  if (clean.endsWith('.m3u8') || clean.includes('.m3u8')) return 'hls';
  if (clean.endsWith('.mpd')) return 'dash';
  return 'file';
}

/**
 * Headers must be a name→value map. A bare list of names — the shape
 * /find/resolve used to hand the UI — carries no values and would otherwise
 * become `0: Referer` / `1: User-Agent` ffmpeg arguments, so it is ignored.
 */
export function headerObject(headers) {
  return headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : {};
}

/** ffmpeg expects all extra headers in one CRLF separated string. */
export function headerArgs(headers = {}) {
  const lines = Object.entries(headerObject(headers))
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}`);
  return lines.length ? ['-headers', lines.join('\r\n') + '\r\n'] : [];
}

const URL_TEMPLATE_TOKENS = new Set(['<url>', '{{url}}']);
const OUTPUT_TEMPLATE_TOKENS = new Set(['<output>', '{{output}}']);
const TEMPLATE_CONTAINERS = new Set(['mpegts', 'matroska', 'hls']);

/**
 * Split a command template into argv without invoking a shell. Single/double
 * quotes and backslash escapes are understood; variable expansion, command
 * substitution, globs, redirects and shell operators are deliberately inert.
 */
export function parseFfmpegTemplateTokens(command) {
  const text = String(command ?? '');
  if (text.length > 24000) throw new Error('FFmpeg template is too long (maximum 24,000 characters)');
  const words = [];
  let word = '';
  let started = false;
  let quote = '';

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") quote = '';
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') { quote = ''; continue; }
      if (char === '\\' && i + 1 < text.length) {
        const next = text[i + 1];
        if (next === '\n') { i += 1; continue; }
        if ('"\\$`'.includes(next)) { word += next; i += 1; continue; }
      }
      word += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) { words.push(word); word = ''; started = false; }
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === '\\') {
      if (i + 1 >= text.length) throw new Error('FFmpeg template ends with an unfinished backslash escape');
      if (text[i + 1] === '\n') { i += 1; continue; }
      word += text[i + 1];
      i += 1;
      started = true;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error('FFmpeg template has an unclosed quote');
  if (started) words.push(word);
  return words;
}

function ffmpegTemplateArgs(command) {
  const tokens = parseFfmpegTemplateTokens(command);
  if (tokens.length && /^(?:.*\/)?ffmpeg(?:\.exe)?$/i.test(tokens[0])) tokens.shift();
  else if (tokens.length && !tokens[0].startsWith('-')) {
    throw new Error('Template must start with ffmpeg or an FFmpeg option (shell commands are not supported)');
  }
  return tokens;
}

function lastOptionValue(tokens, flag) {
  const index = tokens.lastIndexOf(flag);
  return index >= 0 ? tokens[index + 1] : null;
}

/** Validate a complete, reusable FFmpeg command template before saving/running it. */
export function validateFfmpegTemplate(command, { container = '' } = {}) {
  const errors = [];
  let args = [];
  try { args = ffmpegTemplateArgs(command); }
  catch (error) { return { ok: false, errors: [error.message], container: null }; }
  if (!args.length) return { ok: false, errors: ['FFmpeg template is empty'], container: null };

  const urlIndexes = args.flatMap((arg, index) => URL_TEMPLATE_TOKENS.has(arg) ? [index] : []);
  if (urlIndexes.length !== 1) errors.push('Use exactly one <url> placeholder as the value of -i');
  const urlIndex = urlIndexes[0] ?? -1;
  if (urlIndex < 1 || args[urlIndex - 1] !== '-i') errors.push('The <url> placeholder must immediately follow -i');

  const outputIndexes = args.flatMap((arg, index) => OUTPUT_TEMPLATE_TOKENS.has(arg) ? [index] : []);
  if (outputIndexes.length > 1) errors.push('Use at most one <output> placeholder');
  const usesOutput = outputIndexes.length === 1;
  const target = args.at(-1);
  if (usesOutput && outputIndexes[0] !== args.length - 1) errors.push('<output> must be the final command argument');
  if (!usesOutput && !['pipe:1', '-'].includes(target)) errors.push('The output must be pipe:1, -, or a final <output> placeholder');

  const format = lastOptionValue(args, '-f');
  if (!format || format.startsWith('-')) errors.push('Set an output format with -f (mpegts, matroska, or hls)');
  else if (!TEMPLATE_CONTAINERS.has(format)) errors.push(`Unsupported outgoing container "${format}"`);
  if (container && format && format !== container) errors.push(`The command uses -f ${format}, but the selected container is ${container}`);
  if (format === 'hls' && !usesOutput) errors.push('HLS templates must end with <output> so segments go to the relay directory');
  if (container === 'hls' && !usesOutput) errors.push('HLS templates must use the final <output> placeholder');

  for (const flag of ['-i', '-f', '-headers', '-user_agent', '-referer']) {
    const index = args.indexOf(flag);
    if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('-')) && flag !== '-i') {
      errors.push(`${flag} needs a value`);
    }
  }
  return { ok: errors.length === 0, errors, container: format || null };
}

function mergeTemplateHeaders(existing, sourceHeaders) {
  const linesByName = new Map();
  const unparsed = [];
  const addLine = (line, prefer = true) => {
    const text = String(line || '').trimEnd();
    if (!text) return;
    const colon = text.indexOf(':');
    if (colon < 1) { unparsed.push(text); return; }
    const name = text.slice(0, colon).trim();
    if (!name) { unparsed.push(text); return; }
    const key = name.toLowerCase();
    if (prefer || !linesByName.has(key)) linesByName.set(key, text);
  };
  for (const [name, value] of Object.entries(headerObject(sourceHeaders))) {
    if (value !== undefined && value !== null && value !== '') addLine(`${name}: ${value}`, false);
  }
  for (const line of String(existing || '').split(/\r?\n/)) addLine(line, true);
  const result = [...linesByName.values(), ...unparsed].join('\r\n');
  return result ? `${result}\r\n` : '';
}

/**
 * Render a template to an argv list. Source URLs and private request headers are
 * inserted as individual argv values, never interpolated into shell text.
 */
export function buildFfmpegTemplateArgs({ template, source, profile = {}, mode = 'live', output = { target: 'pipe:1' } }) {
  const container = output.container || profile.container || 'mpegts';
  const validation = validateFfmpegTemplate(template, { container });
  if (!validation.ok) {
    const error = new Error(validation.errors.join('; '));
    error.status = 422;
    error.details = validation.errors;
    throw error;
  }
  if (!source?.url) {
    const error = new Error('FFmpeg template needs a resolved source URL');
    error.status = 422;
    throw error;
  }

  const tokens = ffmpegTemplateArgs(template);
  const urlMarker = tokens.findIndex((arg) => URL_TEMPLATE_TOKENS.has(arg));
  const target = output.target || 'pipe:1';
  const args = tokens.map((arg) => URL_TEMPLATE_TOKENS.has(arg) ? String(source.url)
    : OUTPUT_TEMPLATE_TOKENS.has(arg) ? String(target) : arg);
  let inputIndex = urlMarker - 1;
  const isHttp = /^https?:/i.test(String(source.url));
  const prefix = [];
  const hasOption = (flag) => args.includes(flag);
  const addInputOption = (flag, value = null, when = true) => {
    if (!when || hasOption(flag)) return;
    prefix.push(flag);
    if (value !== null) prefix.push(value);
  };

  addInputOption('-hide_banner');
  addInputOption('-nostdin');
  addInputOption('-loglevel', process.env.FFMPEG_LOGLEVEL || 'warning');
  if (isHttp) {
    addInputOption('-fflags', '+genpts+discardcorrupt');
    addInputOption('-err_detect', 'ignore_err');
    addInputOption('-reconnect', '1');
    addInputOption('-reconnect_at_eof', '1');
    addInputOption('-reconnect_streamed', '1');
    addInputOption('-reconnect_delay_max', '5');
    addInputOption('-rw_timeout', '10000000');
    if (mode === 'live') {
      addInputOption('-analyzeduration', '1000000');
      addInputOption('-probesize', '1000000');
      addInputOption('-live_start_index', '-3', streamKind(source.url) === 'hls');
    }

    const headers = headerObject(source.headers);
    const headerIndex = args.findIndex((arg, index) => arg === '-headers' && index < inputIndex);
    const explicitUserAgent = args.slice(0, inputIndex).includes('-user_agent');
    const explicitReferer = args.slice(0, inputIndex).includes('-referer');
    const automaticHeaders = { ...headers };
    if (explicitUserAgent) {
      for (const key of Object.keys(automaticHeaders)) if (key.toLowerCase() === 'user-agent') delete automaticHeaders[key];
    }
    if (explicitReferer) {
      for (const key of Object.keys(automaticHeaders)) if (key.toLowerCase() === 'referer') delete automaticHeaders[key];
    }
    if (headerIndex >= 0 && headerIndex + 1 < inputIndex) {
      args[headerIndex + 1] = mergeTemplateHeaders(args[headerIndex + 1], automaticHeaders);
    } else {
      prefix.push(...headerArgs(automaticHeaders));
    }
    const existingHeadersText = headerIndex >= 0 ? String(args[headerIndex + 1] || '') : '';
    const hasUserAgentHeader = /(?:^|\r?\n)\s*user-agent\s*:/i.test(existingHeadersText)
      || Object.keys(automaticHeaders).some((key) => key.toLowerCase() === 'user-agent' && automaticHeaders[key]);
    if (!explicitUserAgent && !hasUserAgentHeader) {
      const userAgent = Object.entries(headers).find(([key]) => key.toLowerCase() === 'user-agent')?.[1]
        || getConfig().scraper.userAgent;
      prefix.push('-user_agent', String(userAgent));
    }
  }
  args.splice(inputIndex, 0, ...prefix);

  if (mode === 'live') {
    const outputIndex = args.length - 1;
    const progress = [];
    if (!args.includes('-progress')) progress.push('-progress', 'pipe:2');
    if (!args.includes('-nostats')) progress.push('-nostats');
    args.splice(outputIndex, 0, ...progress);
  }
  return args;
}

export function buildFfprobeArgs(url, { headers = {}, timeoutMs = 20000 } = {}) {
  const h = headerObject(headers);
  return [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    '-rw_timeout', String(timeoutMs * 1000),
    '-user_agent', h['User-Agent'] || getConfig().scraper.userAgent,
    ...headerArgs(h),
    url,
  ];
}

export function parseFps(value) {
  if (!value) return null;
  const [num, den] = String(value).split('/').map(Number);
  if (!den) return num || null;
  const fps = num / den;
  return Number.isFinite(fps) ? Math.round(fps * 1000) / 1000 : null;
}

/** Normalise the raw ffprobe JSON into what the UI and the profile builder need. */
export function parseProbeJson(json) {
  if (!json) return null;
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const subs = streams.filter((s) => s.codec_type === 'subtitle');
  const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  return {
    container: json.format?.format_name || null,
    durationSec: num(json.format?.duration),
    sizeBytes: num(json.format?.size),
    bitrate: num(json.format?.bit_rate),
    video: video ? {
      codec: video.codec_name,
      profile: video.profile || null,
      width: num(video.width),
      height: num(video.height),
      fps: parseFps(video.r_frame_rate || video.avg_frame_rate),
      pixFmt: video.pix_fmt || null,
      bitrate: num(video.bit_rate),
      hdr: /bt2020|smpte2084|arib-std-b67/i.test(String(video.color_transfer || '')),
      interlaced: /interlaced/i.test(String(video.field_order || '')),
    } : null,
    audio: audios.map((a) => ({
      index: a.index,
      codec: a.codec_name,
      channels: num(a.channels),
      channelLayout: a.channel_layout || null,
      bitrate: num(a.bit_rate),
      language: a.tags?.language || null,
      title: a.tags?.title || null,
    })),
    subtitles: subs.map((s) => ({ index: s.index, codec: s.codec_name, language: s.tags?.language || null })),
    raw: json,
  };
}

/** Run ffprobe; returns null (and logs why) on failure instead of throwing. */
export async function probe(url, { headers = {}, timeoutMs = 20000 } = {}) {
  const binaries = await checkBinaries();
  if (!binaries.ffprobe.ok) return null;
  const args = buildFfprobeArgs(url, { headers, timeoutMs });
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(ffprobePath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      log.warn('resolver', `ffprobe timed out after ${timeoutMs} ms`, { url: truncate(url, 120) });
      child.kill('SIGKILL');
    }, timeoutMs + 2000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (error) => {
      clearTimeout(timer);
      logError('resolver', 'ffprobe could not be started', error);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (code !== 0) {
        log.warn('resolver', 'ffprobe failed for candidate', {
          code, ms, url: truncate(url, 140), stderr: truncate(err.trim().split('\n').slice(-2).join(' | '), 200),
        });
        return resolve(null);
      }
      try {
        const info = parseProbeJson(JSON.parse(out));
        log.debug('resolver', 'probe ok', {
          url: truncate(url, 90), ms,
          video: info.video ? `${info.video.codec} ${info.video.width}x${info.video.height}@${info.video.fps}` : 'none',
          audio: info.audio.length, subs: info.subtitles.length,
        });
        resolve(info);
      } catch (error) {
        logError('resolver', 'could not parse ffprobe output', error, { url: truncate(url, 120) });
        resolve(null);
      }
    });
  });
}

/** Parse an HLS master playlist into variant streams (pure, unit-tested). */
export function parseHlsMaster(text, baseUrl = '') {
  const lines = String(text || '').split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const attrs = {};
    for (const m of line.slice(line.indexOf(':') + 1).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
      attrs[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    const uri = (lines[i + 1] || '').trim();
    if (!uri || uri.startsWith('#')) continue;
    let url = uri;
    try { url = new URL(uri, baseUrl).toString(); } catch { /* keep relative */ }
    const [w, h] = String(attrs.RESOLUTION || '').split('x').map(Number);
    variants.push({
      url,
      bandwidth: Number(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || 0),
      width: w || null,
      height: h || null,
      codecs: attrs.CODECS || null,
      name: attrs.NAME || null,
      frameRate: attrs['FRAME-RATE'] ? Number(attrs['FRAME-RATE']) : null,
    });
  }
  return variants.sort((a, b) => (b.height || 0) - (a.height || 0));
}

/* ------------------------------------------------------------------ *
 * profile + ffmpeg command construction
 * ------------------------------------------------------------------ */

/** Target dimensions per resolution + aspect. Keeps h even (H.264 requirement). */
export function targetDimensions({ resolution = 1080, aspect = 'source', sourceWidth, sourceHeight }) {
  const h = ({ 480: 480, 720: 720, 1080: 1080 })[Number(resolution)] || 1080;
  if (aspect === 'source' && sourceWidth && sourceHeight) {
    const ratio = sourceWidth / sourceHeight;
    const w = Math.round((h * ratio) / 2) * 2;
    return { w: Math.max(2, w), h };
  }
  const ratio = aspect === '43' ? 4 / 3 : 16 / 9;
  return { w: Math.round((h * ratio) / 2) * 2, h };
}

export function normaliseProfile(input = {}, probeInfo = null) {
  const cfg = getConfig().transcode;
  const p = {
    mode: input.mode || cfg.mode,                       // auto | copy | vaapi | x264
    alwaysTranscode: input.alwaysTranscode ?? cfg.alwaysTranscode,
    resolution: Number(input.resolution || cfg.resolution),
    aspect: input.aspect || cfg.aspect,                 // source | 169 | 43
    videoBitrate: Number(input.videoBitrate || cfg.videoBitrate),
    audioBitrate: Number(input.audioBitrate || cfg.audioBitrate),
    audioChannels: Number(input.audioChannels || cfg.audioChannels),
    audioCodec: input.audioCodec || 'aac',
    fps: input.fps || cfg.fps,                          // source | 25 | 30
    container: input.container || cfg.container,        // mpegts | matroska
    subtitles: input.subtitles || 'soft',               // none | soft | burn
    subtitlePath: input.subtitlePath || null,
    subtitleLanguage: input.subtitleLanguage || 'nld',
    deinterlace: Boolean(input.deinterlace),
    hardware: input.hardware ?? true,
    scaleMethod: input.scaleMethod || 'auto',
    ffmpegTemplate: typeof input.ffmpegTemplate === 'string' ? input.ffmpegTemplate : '',
    ffmpegTemplateId: typeof input.ffmpegTemplateId === 'string' ? input.ffmpegTemplateId : '',
    ffmpegTemplateName: typeof input.ffmpegTemplateName === 'string' ? input.ffmpegTemplateName : '',
  };

  // Decide whether an encode is needed at all.
  const v = probeInfo?.video;
  const needsDownscale = v?.height ? v.height > p.resolution : false;
  const unsupportedCodec = v?.codec ? !['h264', 'avc1'].includes(String(v.codec).toLowerCase()) : false;
  const forced = p.mode === 'copy' ? false : (p.alwaysTranscode || p.mode === 'vaapi' || p.mode === 'x264');
  const burnIn = p.subtitles === 'burn';
  const softMux = p.subtitles === 'soft';

  p.transcode = p.mode !== 'copy' && (forced || needsDownscale || unsupportedCodec || burnIn);
  p.softMux = softMux;
  p.reasons = [];
  if (p.mode === 'copy') p.reasons.push('profile explicitly set to copy/remux');
  else if (p.alwaysTranscode) p.reasons.push('always-transcode enabled');
  else if (p.mode === 'vaapi' || p.mode === 'x264') p.reasons.push(`encoder forced (${p.mode})`);
  else if (needsDownscale) p.reasons.push(`source is ${v.height}p > target ${p.resolution}p`);
  else if (unsupportedCodec) p.reasons.push(`source codec ${v.codec} is not directly playable on VLC/Enigma2`);
  if (burnIn) p.reasons.push('subtitles are burned in');
  if (!p.transcode) p.reasons.push('source already matches the target (stream copy / remux)');

  p.encoder = p.transcode
    ? (p.mode === 'x264' ? 'libx264' : p.mode === 'h265' ? 'libx265' : (p.hardware ? 'vaapi' : 'libx264'))
    : 'copy';
  p.dimensions = targetDimensions({
    resolution: p.resolution, aspect: p.aspect,
    sourceWidth: v?.width, sourceHeight: v?.height,
  });
  return p;
}

/**
 * Build the ffmpeg argument vector.
 *
 * @param {object} o
 * @param {{url:string, headers?:object, kind?:string, bsf?:string}} o.source
 * @param {object} o.profile   — see normaliseProfile()
 * @param {object} o.hw        — result of hardware()
 * @param {'live'|'file'} o.mode
 * @param {{target:string, container?:string}} o.output
 */
export function buildFfmpegArgs({ source, profile, hw = {}, mode = 'live', output = { target: 'pipe:1' } }) {
  const p = profile || {};
  const container = output.container || p.container || 'mpegts';
  if (mode === 'live' && String(p.ffmpegTemplate || '').trim()) {
    return buildFfmpegTemplateArgs({
      template: p.ffmpegTemplate, source, profile: p, mode,
      output: { ...output, container },
    });
  }
  const args = ['-hide_banner', '-nostdin', '-loglevel', process.env.FFMPEG_LOGLEVEL || 'warning'];
  const isHttp = /^https?:/i.test(source.url || '');
  const kind = source.kind || streamKind(source.url);

  // An encoder this box cannot actually run must never reach the command line:
  // a profile that asks for vaapi where the GPU self-test failed used to emit
  // `-c:v h264_vaapi` *without* `-init_hw_device` (only the hwaccel block checks
  // hw.available), i.e. a command ffmpeg is guaranteed to reject. Fall back to
  // the software encoder, shaped by transcode.encoderFallback below.
  const encoder = p.transcode && p.encoder === 'vaapi' && !hw?.available ? 'libx264' : p.encoder;
  const sidecarSubtitlePath = p.subtitles === 'soft' && p.subtitlePath && fs.existsSync(p.subtitlePath)
    ? p.subtitlePath
    : null;

  // --- input resilience (keep the supplied command's option order) ---
  if (isHttp) {
    args.push(
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
    );
  }
  args.push('-fflags', '+genpts+discardcorrupt', '-err_detect', 'ignore_err');

  // --- hardware decode ---
  const useVaapi = p.transcode && encoder === 'vaapi';
  const burnIn = p.subtitles === 'burn' && p.subtitlePath;
  if (useVaapi) {
    args.push(
      '-init_hw_device', `vaapi=intel:${hw.device || getConfig().transcode.device}`,
      '-hwaccel', 'vaapi',
      '-hwaccel_device', 'intel',
    );
    // burn-in needs system-memory frames for the subtitles filter (hwdownload),
    // so in that case we deliberately do NOT keep frames in GPU memory.
    if (!burnIn) args.push('-hwaccel_output_format', 'vaapi');
    else args.push('-filter_hw_device', 'intel');
  }

  if (isHttp) {
    args.push('-rw_timeout', '10000000');
    const sourceHeaders = headerObject(source.headers);
    args.push('-user_agent', sourceHeaders['User-Agent'] || getConfig().scraper.userAgent);
    args.push(...headerArgs(sourceHeaders));
  }
  // Live playback: a 1 MB probe window starts the picture sooner and stops
  // ffmpeg scanning deep into a long VOD manifest (flag from the field-tested
  // command the DUO2 test ran with).
  if (mode === 'live') args.push('-analyzeduration', '1000000', '-probesize', '1000000');
  if (mode === 'live' && kind === 'hls') args.push('-live_start_index', '-3');

  args.push('-i', source.url);
  if (sidecarSubtitlePath) args.push('-i', sidecarSubtitlePath);

  // --- video filter chain ---
  const vf = [];
  if (p.deinterlace) vf.push('yadif');
  const { w, h } = p.dimensions || { w: 1920, h: 1080 };
  const needScale = Boolean(p.transcode) && (p.mode !== 'copy');
  if (needScale && encoder === 'vaapi' && !burnIn) {
    vf.push(`scale_vaapi=w=${w}:h=${h}:format=nv12`);
  } else if (needScale) {
    vf.push(`scale=w=${w}:h=${h}`);
  }
  // A requested output rate requires a video encode; leave stream-copy sources untouched.
  const wantsFps = Boolean(p.transcode && p.fps && p.fps !== 'source');
  // The fps filter can only run on VAAPI surfaces when the build supports it
  // (variant 1 in the self-test). Otherwise the conversion happens on output
  // via -fps_mode/-r, which is why it is NOT added to the filter chain here.
  const fpsInChain = wantsFps && (encoder !== 'vaapi' || burnIn || hw?.fpsVariant === 1);
  if (fpsInChain) vf.push(`fps=${p.fps}`);
  // The confirmed-working VAAPI command ends the scale chain with setsar=1, so
  // an odd source SAR cannot letterbox or shift the picture on VLC/the VU+.
  if (needScale && encoder === 'vaapi' && !burnIn) vf.push('setsar=1');
  if (burnIn) {
    vf.push(`subtitles=filename=${escapeFilterPath(p.subtitlePath)}`);
    if (encoder === 'vaapi') vf.push('format=nv12', 'hwupload');
    else vf.push('format=yuv420p');
  } else if (p.transcode && encoder === 'libx264') {
    vf.push('format=yuv420p');
  }
  const filterString = vf.filter(Boolean).join(',');
  if (filterString) args.push('-vf', filterString);

  // --- stream mapping ---
  args.push('-map', '0:v:0', '-map', '0:a:0?');
  if (p.softMux) {
    args.push('-map', '0:s?');
    if (sidecarSubtitlePath) args.push('-map', '1:s:0?');
  }
  args.push('-dn');
  if (!p.softMux) args.push('-sn');

  // --- video codec ---
  if (!p.transcode) {
    args.push('-c:v', 'copy');
    if (source.bsf) args.push('-bsf:v', source.bsf);
    else if (container === 'mpegts' && (kind === 'file' || source.bsf === undefined) && /mp4|mov|m4v/i.test(String(source.container || ''))) {
      args.push('-bsf:v', 'h264_mp4toannexb');
    }
  } else if (encoder === 'vaapi') {
    const vb = Number(p.videoBitrate || getConfig().transcode.videoBitrate || 8000);
    args.push(
      '-c:v', 'h264_vaapi',
      '-b:v', `${vb}k`,
      // VBR ladder from the confirmed-working command: 1.5× peak, bufsize = the
      // target bitrate (low latency, so zapping does not wait for a big VBV).
      '-maxrate', `${Math.round(vb * 1.5)}k`,
      '-bufsize', `${vb}k`,
      '-profile:v', 'high',
      '-level', '4.1',
      '-g', String(Math.round(Number(p.fps && p.fps !== 'source' ? p.fps : 25) * 2)),
      ...(wantsFps ? ['-r', String(p.fps)] : []),
      '-rc_mode', 'VBR',
      '-async_depth', '4',
    );
  } else if (encoder === 'libx264') {
    const vb = Number(p.videoBitrate || getConfig().transcode.videoBitrate || 8000);
    // transcode.encoderFallback (Settings → Transcode, ENCODER_FALLBACK) is the
    // software fallback *command*; it was declared, shown in the UI and read by
    // nothing — the preset/crf were hard-coded here. Split it into ffmpeg args;
    // a value that lost its codec name falls back to the documented default.
    const fallbackArgs = String(getConfig().transcode.encoderFallback || '').trim().split(/\s+/).filter(Boolean);
    const codecArgs = fallbackArgs.length >= 2 ? fallbackArgs : ['libx264', '-preset', 'veryfast', '-crf', '22'];
    args.push(
      '-c:v', ...codecArgs,
      '-maxrate', `${Math.round(vb * 1.2)}k`, '-bufsize', `${Math.round(vb * 1.8)}k`,
      '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
      '-g', String(Math.round(Number(p.fps && p.fps !== 'source' ? p.fps : 25) * 2)),
    );
  } else if (encoder === 'libx265') {
    // CPU only — Apollo Lake has no HEVC encoder. Kept for downloads, not live use.
    args.push('-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '24', '-tag:v', 'hvc1');
  }

  // --- framerate conversion (only when not already done in the filter chain) ---
  if (wantsFps && !fpsInChain) {
    const variant = encoder === 'vaapi' ? hw?.fpsVariant : null;
    if (encoder === 'vaapi') {
      // The VAAPI profile already carries the requested output -r immediately
      // after -g (as in the supplied command); only older builds need fallback
      // timestamp handling when their fps filter self-test failed.
      if (variant !== 3) args.push('-fps_mode', 'cfr');
    } else {
      args.push('-fps_mode', 'cfr', '-r', String(p.fps));
    }
  }

  // --- audio ---
  if (p.transcode) {
    args.push('-c:a', p.audioCodec || 'aac');
    if ((p.audioCodec || 'aac') !== 'copy') {
      args.push(
        '-b:a', `${p.audioBitrate || getConfig().transcode.audioBitrate || 192}k`,
        '-ac', String(p.audioChannels || getConfig().transcode.audioChannels || 6),
        '-ar', '48000',
      );
    }
  } else {
    args.push('-c:a', 'copy');
  }

  // --- subtitles (soft mux) ---
  if (p.softMux) {
    if (container === 'matroska') args.push('-c:s', 'srt');
    else {
      // MPEG-TS/HLS carry DVB subtitles — this is what Enigma2 understands.
      args.push('-c:s', 'dvbsub');
    }
  }

  // --- container / output ---
  if (container === 'hls') {
    // Segmented output: the same single ffmpeg process writes an endless live
    // playlist + segments. Clients get a seekable-live experience and browsers
    // (which cannot play raw MPEG-TS) work too.
    const dir = output.hlsDir || (output.target ? path.dirname(output.target) : getConfig().storage.tmp);
    args.push(
      '-f', 'hls',
      '-hls_time', String(output.hlsTime ?? 2),
      '-hls_init_time', '1',
      '-hls_list_size', String(output.hlsListSize ?? 8),
      '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    );
  } else if (container === 'matroska') {
    args.push('-f', 'matroska');
    if (mode === 'live') args.push('-live', '1');
  } else {
    args.push('-f', 'mpegts', '-mpegts_flags', '+resend_headers');
    // Flush every packet straight away so VLC/the VU+ start zapping without a
    // muxer buffer delay (flag from the confirmed-working command).
    if (mode === 'live') args.push('-flush_packets', '1');
  }
  args.push('-max_muxing_queue_size', '1024');
  if (mode === 'live') args.push('-progress', 'pipe:2', '-nostats');
  args.push(output.target);
  return args;
}


/** ffmpeg filter paths need escaping of : \ ' and , */
export function escapeFilterPath(p) {
  return String(p).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,');
}

/**
 * Render a copy-pasteable POSIX-shell command for the UI/logs.
 *
 * URLs commonly contain `&` query separators. Leaving those bare makes Bash
 * background the command at the first `&`, truncating signed URLs (which then
 * fail with HTTP 403) and treating later ffmpeg flags as separate commands.
 * Use a conservative unquoted character allowlist and single-quote everything
 * else so shell operators, globs, whitespace, newlines and `$` stay literal.
 */
export function argsToCommand(args) {
  const shellArg = (value) => {
    const text = String(value);
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
    return `'${text.replace(/'/g, "'\\''")}'`;
  };
  return ['ffmpeg', ...args.map(shellArg)].join(' ');
}

/** Parse `-progress` key=value lines into a stats object. */
export function parseProgressLine(line, stats = {}) {
  const m = /^([a-z_]+)=(.*)$/.exec(line.trim());
  if (!m) return stats;
  const [, key, value] = m;
  const num = Number(value);
  switch (key) {
    case 'frame': stats.frame = num; break;
    case 'fps': stats.fps = num; break;
    case 'bitrate': stats.bitrate = value; break;
    case 'total_size': stats.totalSize = num; break;
    case 'out_time_ms': stats.outTimeMs = num / 1000; break;
    case 'speed': stats.speed = value; break;
    case 'drop_frames': stats.dropFrames = num; break;
    case 'dup_frames': stats.dupFrames = num; break;
    case 'progress': stats.progress = value; break;
    default: break;
  }
  return stats;
}

export default {
  FFMPEG, FFPROBE, HW_CACHE_FILE, LIBVA_DRIVERS_PATH,
  checkBinaries, binariesStatus, hardware, hardwareStatus, hardwarePending, detectHardware,
  ffmpegPath, ffprobePath, ffmpegEnv, libvaDriverCandidates, cacheUsable,
  runCommand, classifyBinaryFailure, parseVainfoOutput,
  probe, parseProbeJson, parseHlsMaster, streamKind, buildFfmpegArgs, buildFfprobeArgs,
  normaliseProfile, targetDimensions, argsToCommand, parseProgressLine,
};
