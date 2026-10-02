/**
 * Tests for the hardware/binary detection layer.
 *
 * These cover the DS918+ failure that made the whole app unusable:
 *   2026-10-02 17:38:53 ERROR hwaccel /usr/bin/ffmpeg not available —
 *               scanning and transcoding are DISABLED {"error":"spawnSync /usr/bin/ffmpeg ETIMEDOUT"}
 *
 * Two rules must hold forever:
 *   1. a TIMEOUT is not a MISSING BINARY (a busy disk must not disable
 *      streaming, and must certainly not be cached for a week), and
 *   2. the driver that actually encoded the test pattern is the one ffmpeg is
 *      started with (iHD on some boxes, i965 on Apollo Lake/DS918+).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  classifyBinaryFailure, runCommand, cacheUsable, libvaDriverCandidates, ffmpegEnv,
  parseVainfoOutput, pickPrimaryFailure,
} from '../src/core/media.js';

/* ------------------------------------------------------------------ *
 * runCommand / classifyBinaryFailure
 * ------------------------------------------------------------------ */

test('runCommand reports success, output and timing', async () => {
  const res = await runCommand(process.execPath, ['-e', 'console.log("hello")'], { timeoutMs: 10_000 });
  assert.equal(res.ok, true);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), 'hello');
  assert.equal(res.timedOut, false);
  assert.ok(res.elapsedMs >= 0);
});

test('a timeout is classified as a timeout — NOT as a missing binary', async () => {
  const res = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { timeoutMs: 300 });
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);

  const failure = classifyBinaryFailure(res);
  assert.equal(failure.kind, 'timeout');
  assert.match(failure.message, /TIMEOUT, not a missing binary/i);
  assert.doesNotMatch(failure.message, /not found/i);
});

test('a binary that does not exist is classified as missing', async () => {
  const res = await runCommand('/nonexistent/ffmpeg-xyz', ['-version'], { timeoutMs: 5_000 });
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, false);
  const failure = classifyBinaryFailure(res);
  assert.equal(failure.kind, 'missing');
  assert.match(failure.message, /ENOENT/);
});

test('a non-zero exit keeps the last stderr lines for the log', () => {
  const failure = classifyBinaryFailure({
    command: '/usr/bin/ffmpeg', code: 1, timedOut: false, stderr: 'line one\nConversion failed!',
  });
  assert.equal(failure.kind, 'exit');
  assert.match(failure.message, /exited with 1/);
  assert.match(failure.message, /Conversion failed!/);
});

test('the reported failure is the most informative one, not the last one', () => {
  // The exact DS918+ shape: the configured path is slow, the fallbacks do not
  // exist. Saying "ffmpeg is missing" there would be a lie.
  const primary = pickPrimaryFailure([
    { candidate: '/usr/bin/ffmpeg', kind: 'timeout', message: 'did not answer within 30 s' },
    { candidate: '/usr/local/bin/ffmpeg', kind: 'missing', message: 'ENOENT' },
    { candidate: 'ffmpeg', kind: 'missing', message: 'ENOENT' },
  ]);
  assert.equal(primary.kind, 'timeout');
  assert.match(primary.message, /did not answer/);
  assert.equal(pickPrimaryFailure([]).kind, undefined);
});

/* ------------------------------------------------------------------ *
 * capability cache — the bug that made the failure permanent
 * ------------------------------------------------------------------ */

const FAILED_BINARIES = { ffmpeg: { ok: false, kind: 'timeout', error: 'did not answer' } };
const OK_BINARIES = { ffmpeg: { ok: true, path: '/usr/bin/ffmpeg', version: 'ffmpeg version 5.1.6' } };

test('a cache entry written while ffmpeg could not be probed is never reused', () => {
  const cached = {
    checkedAt: new Date().toISOString(),   // fresh!
    device: '/dev/dri/renderD128', devicePresent: true,
    binaries: FAILED_BINARIES, available: false,
    reason: 'ffmpeg missing in the container',
  };
  const verdict = cacheUsable(cached, { device: '/dev/dri/renderD128', devicePresent: true });
  assert.equal(verdict.usable, false);
  assert.match(verdict.why, /could not run ffmpeg/);
});

test('a working pipeline is cached for a week, a broken one only for minutes', () => {
  const day = 24 * 3600 * 1000;
  const positive = {
    checkedAt: new Date(Date.now() - 3 * day).toISOString(), device: '/dev/dri/renderD128',
    devicePresent: true, binaries: OK_BINARIES, available: true, libvaDriver: 'i965',
  };
  assert.equal(cacheUsable(positive, { device: '/dev/dri/renderD128', devicePresent: true }).usable, true);
  assert.equal(
    cacheUsable({ ...positive, checkedAt: new Date(Date.now() - 8 * day).toISOString() },
      { device: '/dev/dri/renderD128', devicePresent: true }).usable,
    false,
  );

  const negative = {
    checkedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), device: '/dev/dri/renderD128',
    devicePresent: true, binaries: OK_BINARIES, available: false, reason: 'no vaapi pipeline worked',
  };
  assert.equal(
    cacheUsable(negative, { device: '/dev/dri/renderD128', devicePresent: true, negativeTtlMs: 5 * 60 * 1000 }).usable,
    false,
    'a negative result must be re-tested quickly, not trusted',
  );
});

test('cache is invalidated when the device or the /dev/dri situation changes', () => {
  const cached = {
    checkedAt: new Date().toISOString(), device: '/dev/dri/renderD128', devicePresent: true,
    binaries: OK_BINARIES, available: true,
  };
  assert.equal(cacheUsable(cached, { device: '/dev/dri/card0', devicePresent: true }).usable, false);
  assert.equal(cacheUsable(cached, { device: '/dev/dri/renderD128', devicePresent: false }).usable, false);
  assert.equal(cacheUsable(null, { device: '/dev/dri/renderD128', devicePresent: true }).usable, false);
  assert.equal(cacheUsable({}, { device: '/dev/dri/renderD128', devicePresent: true }).usable, false);
});

/* ------------------------------------------------------------------ *
 * VA-API driver selection (iHD vs i965 on Apollo Lake)
 * ------------------------------------------------------------------ */

test('libvaDriverCandidates honours the environment first, then iHD, then i965', () => {
  const exists = (p) => ['/dri/iHD_drv_video.so', '/dri/i965_drv_video.so'].includes(p);

  // Nothing configured: modern driver first, legacy fallback second.
  assert.deepEqual(
    libvaDriverCandidates({ env: {}, driPath: '/dri', exists }),
    ['iHD', 'i965'],
  );

  // Explicit configuration wins, but the fallback stays available.
  assert.deepEqual(
    libvaDriverCandidates({ env: { LIBVA_DRIVER_NAME: 'i965' }, driPath: '/dri', exists }),
    ['i965', 'iHD'],
  );

  // Only i965 installed (the DS918+ image variant) → no pointless iHD attempt.
  assert.deepEqual(
    libvaDriverCandidates({ env: {}, driPath: '/dri', exists: (p) => p === '/dri/i965_drv_video.so' }),
    ['i965'],
  );

  // A forced driver is tried even if its .so cannot be seen from here.
  assert.deepEqual(
    libvaDriverCandidates({ env: { LIBVA_DRIVER_NAME: 'iHD' }, driPath: '/dri', exists: () => false }),
    ['iHD'],
  );

  assert.deepEqual(libvaDriverCandidates({ env: {}, driPath: '/dri', exists: () => false }), []);
});

test('ffmpegEnv pins the proven driver and keeps an explicit drivers path', () => {
  const env = ffmpegEnv({ libvaDriver: 'i965' }, { env: { PATH: '/bin', LIBVA_DRIVER_NAME: 'iHD' }, driPath: '/dri', exists: () => true });
  assert.equal(env.LIBVA_DRIVER_NAME, 'i965');
  assert.equal(env.LIBVA_DRIVERS_PATH, '/dri');
  assert.equal(env.PATH, '/bin', 'the rest of the environment must survive');

  const pinned = ffmpegEnv({ libvaDriver: 'iHD' }, { env: { LIBVA_DRIVERS_PATH: '/custom/dri' }, driPath: '/dri', exists: () => true });
  assert.equal(pinned.LIBVA_DRIVERS_PATH, '/custom/dri', 'never overwrite an explicit path');

  const software = ffmpegEnv({ available: false }, { env: {}, driPath: '/nope', exists: () => false });
  assert.equal(software.LIBVA_DRIVER_NAME, undefined);
  assert.equal(software.LIBVA_DRIVERS_PATH, undefined);
});

test('parseVainfoOutput reads the Apollo Lake profile list', () => {
  const output = [
    'vainfo: VA-API version: 1.17 (libva 2.12.0)',
    'vainfo: Driver version: Intel i965 driver for Intel(R) Broxton - 2.4.3',
    '      VAProfileH264Main               : VAEntrypointVLD',
    '      VAProfileH264Main               : VAEntrypointEncSlice',
    '      VAProfileH264High               : VAEntrypointVLD',
    '      VAProfileH264High               : VAEntrypointEncSlice',
    '      VAProfileHEVCMain               : VAEntrypointVLD',
    '      VAProfileHEVCMain10             : VAEntrypointVLD',
  ].join('\n');
  const parsed = parseVainfoOutput(output);
  assert.equal(parsed.driverVersion, 'Intel i965 driver for Intel(R) Broxton - 2.4.3');
  assert.equal(parsed.h264Encode, true);
  assert.equal(parsed.h264Decode, true);
  assert.equal(parsed.hevcDecode, true);
  assert.equal(parsed.hevcEncode, false, 'Apollo Lake cannot encode HEVC');
  assert.equal(parsed.encodeProfiles.length, 2);
});

test('ffmpegEnv output is spawnable (integration sanity check)', async () => {
  const res = await runCommand('/bin/sh', ['-c', 'echo "$LIBVA_DRIVER_NAME|$LIBVA_DRIVERS_PATH"'], {
    timeoutMs: 5_000,
    env: ffmpegEnv({ libvaDriver: 'i965' }, { env: { PATH: '/bin:/usr/bin' }, driPath: '/dri', exists: () => true }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.stdout.trim(), 'i965|/dri');
});

test('media.js is importable without a GPU, ffmpeg or a database', async () => {
  // The module must stay side-effect-free: importing it may not spawn anything.
  const mod = await import('../src/core/media.js');
  assert.equal(typeof mod.checkBinaries, 'function');
  assert.equal(typeof mod.hardwareStatus, 'function');
  assert.equal(typeof mod.diagnoseFfmpeg, 'function');
  assert.equal(path.isAbsolute(mod.HW_CACHE_FILE), true);
  // hardwareStatus() before any run must not throw and must not claim hardware.
  const status = mod.hardwareStatus();
  assert.equal(status.available, false);
});
