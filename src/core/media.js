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
 *   - one 1080p H.264 encode at a time keeps up with real time at ~2-3 Mbit/s.
 *
 * The ffmpeg argument list mirrors the command from the requirements, with the
 * corrections documented in docs/MOCKUP.md §5 (framerate handling + fallbacks).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { log, logError, truncate } from './log.js';
import { getConfig } from './config.js';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const HW_CACHE_FILE = process.env.HWACCEL_CACHE
  || path.join(process.env.CONFIG_FILE ? path.dirname(process.env.CONFIG_FILE) : '/config', 'hwaccel.json');

/* ------------------------------------------------------------------ *
 * binary / hardware detection
 * ------------------------------------------------------------------ */

let binariesCache = null;

/** Are ffmpeg/ffprobe actually present? (Checked once, cheaply.) */
export function checkBinaries({ force = false } = {}) {
  if (binariesCache && !force) return binariesCache;
  const version = (cmd) => {
    const res = spawnSync(cmd, ['-version'], { encoding: 'utf8', timeout: 10000 });
    if (res.error || res.status !== 0) {
      return { ok: false, error: res.error ? String(res.error.message) : `exit ${res.status}` };
    }
    return { ok: true, version: String(res.stdout).split('\n')[0] };
  };
  const ffmpeg = version(FFMPEG);
  const ffprobe = version(FFPROBE);
  binariesCache = { ffmpeg, ffprobe };
  if (ffmpeg.ok) log.info('hwaccel', `ffmpeg: ${ffmpeg.version}`);
  else log.error('hwaccel', `${FFMPEG} not available — scanning and transcoding are DISABLED`, { error: ffmpeg.error });
  if (!ffprobe.ok) log.warn('hwaccel', `${FFPROBE} not available — stream probing is limited`, { error: ffprobe.error });
  return binariesCache;
}

function runVainfo(device) {
  const res = spawnSync('vainfo', ['-d', device], { encoding: 'utf8', timeout: 15000 });
  if (res.error || res.status !== 0) {
    return { ok: false, output: String(res.stdout || ''), error: res.error ? String(res.error.message) : (String(res.stderr || '').trim() || `exit ${res.status}`) };
  }
  const output = String(res.stdout);
  const profiles = output.split('\n').filter((l) => l.includes('VAProfile'));
  const encode = profiles.filter((l) => l.includes('Enc'));
  return {
    ok: true,
    output,
    driver: (output.match(/Driver version:\s*(.+)/) || [])[1]?.trim() || 'unknown',
    /** "VAProfileH264High : VAEntrypointEncSlice" → H.264 encoding is possible. */
    h264Encode: /VAProfileH264\w*\s*:\s*VAEntrypoint\w*Enc\w*/.test(output),
    /** HD Graphics 500: decode-only → this stays false and we log that clearly. */
    hevcEncode: /VAProfileHEVC\w*\s*:\s*VAEntrypoint\w*Enc\w*/.test(output),
    h264Decode: /VAProfileH264\w*\s*:\s*VAEntrypointVLD/.test(output),
    hevcDecode: /VAProfileHEVC\w*\s*:\s*VAEntrypointVLD/.test(output),
    encodeProfiles: encode.map((l) => l.trim()),
  };
}

/**
 * Self-test the vaapi pipelines. This runs a 2 second encode of a generated test
 * pattern and records WHICH framerate variant works, because the `fps` filter
 * cannot run on VAAPI surfaces on every ffmpeg build:
 *   variant 1 = scale_vaapi=…,fps=N            (exactly the command from the spec)
 *   variant 2 = scale_vaapi=… + -fps_mode cfr -r N   (modern ffmpeg)
 *   variant 3 = scale_vaapi=… + -r N                 (legacy syntax)
 */
function selfTestVariant(device, variant) {
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

  const res = spawnSync(FFMPEG, args, { encoding: 'utf8', timeout: 60000 });
  const stderr = String(res.stderr || '').trim();
  return {
    variant,
    ok: !res.error && res.status === 0,
    error: res.error ? String(res.error.message) : (res.status === 0 ? '' : stderr.split('\n').slice(-3).join(' | ')),
  };
}

/**
 * Detect the hardware capability of the machine we run on.
 * Result is cached on disk (configurable volume) so the NAS does not re-test on
 * every restart; pass {force:true} to re-run (Settings page "re-test" button).
 */
export async function detectHardware({ force = false } = {}) {
  const cfg = getConfig();
  const device = cfg.transcode.device;

  if (!force) {
    try {
      if (fs.existsSync(HW_CACHE_FILE)) {
        const cached = JSON.parse(fs.readFileSync(HW_CACHE_FILE, 'utf8'));
        if (cached.device === device && cached.binaries?.ffmpeg && cached.checkedAt
            && Date.now() - Date.parse(cached.checkedAt) < 7 * 24 * 3600 * 1000
            && fs.existsSync(device) === cached.devicePresent) {
          log.debug('hwaccel', 'using cached hardware capability', { checkedAt: cached.checkedAt });
          return cached;
        }
      }
    } catch (err) {
      log.warn('hwaccel', 'hardware cache unreadable — re-detecting', { error: String(err?.message || err) });
    }
  }

  const binaries = checkBinaries({ force });
  const result = {
    device,
    devicePresent: fs.existsSync(device),
    binaries,
    available: false,
    reason: '',
    driver: '',
    encoder: null,
    h264Encode: false,
    hevcEncode: false,
    h264Decode: false,
    hevcDecode: false,
    fpsVariant: null,
    checkedAt: new Date().toISOString(),
    errors: [],
  };

  if (!cfg.transcode.hardware) {
    result.reason = 'hardware acceleration disabled in settings';
    log.warn('hwaccel', result.reason);
  } else if (!binaries.ffmpeg.ok) {
    result.reason = 'ffmpeg missing in the container';
  } else if (!result.devicePresent) {
    result.reason = `${device} not present — pass /dev/dri into the container (docker-compose devices:) `;
    log.error('hwaccel', result.reason.trim());
  } else {
    const vainfo = runVainfo(device);
    result.driver = vainfo.driver || '';
    result.h264Encode = Boolean(vainfo.h264Encode);
    result.hevcEncode = Boolean(vainfo.hevcEncode);
    result.h264Decode = Boolean(vainfo.h264Decode);
    result.hevcDecode = Boolean(vainfo.hevcDecode);
    if (!vainfo.ok) {
      result.errors.push(`vainfo: ${vainfo.error}`);
      log.warn('hwaccel', 'vainfo failed — trying the encoder anyway (vainfo is only used for capability reporting)',
        { error: truncate(vainfo.error, 200) });
    } else {
      log.info('hwaccel', `vaapi driver: ${result.driver}`, {
        h264Decode: result.h264Decode, hevcDecode: result.hevcDecode,
        h264Encode: result.h264Encode, hevcEncode: result.hevcEncode,
      });
      if (!result.hevcEncode) {
        log.warn('hwaccel', 'HEVC *encoding* is not supported by this GPU (Apollo Lake encodes H.264 only) — H.265 output would be CPU-only');
      }
    }

    // Pick a working framerate variant (only relevant when a fps conversion is requested).
    for (const variant of [1, 2, 3]) {
      const test = selfTestVariant(device, variant);
      if (test.ok) {
        result.fpsVariant = variant;
        result.available = true;
        result.encoder = 'h264_vaapi';
        log.info('hwaccel', `vaapi self-test ok (variant ${variant})`, {
          variantMeaning: variant === 1 ? 'fps filter inside the vaapi filter chain' : variant === 2 ? '-fps_mode cfr + -r' : 'legacy -r',
        });
        break;
      }
      result.errors.push(`variant ${variant}: ${test.error}`);
      log.warn('hwaccel', `vaapi self-test variant ${variant} failed`, { error: truncate(test.error, 200) });
    }
    if (!result.available) {
      result.reason = 'no vaapi encode pipeline worked — using software encoding';
      log.error('hwaccel', result.reason, { errors: result.errors.slice(-2) });
    }
  }

  try {
    fs.mkdirSync(path.dirname(HW_CACHE_FILE), { recursive: true });
    fs.writeFileSync(HW_CACHE_FILE, JSON.stringify(result, null, 2));
    log.debug('hwaccel', `capability cached in ${HW_CACHE_FILE}`);
  } catch (err) {
    log.warn('hwaccel', 'could not cache hardware capability', { error: String(err?.message || err) });
  }
  return result;
}

let hwPromise = null;
/** Memoised accessor used by the stream/transcode code. */
export function hardware({ force = false } = {}) {
  if (!hwPromise || force) hwPromise = detectHardware({ force });
  return hwPromise;
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

/** ffmpeg expects all extra headers in one CRLF separated string. */
export function headerArgs(headers = {}) {
  const lines = Object.entries(headers)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}`);
  return lines.length ? ['-headers', lines.join('\r\n') + '\r\n'] : [];
}

export function buildFfprobeArgs(url, { headers = {}, timeoutMs = 20000 } = {}) {
  return [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    '-rw_timeout', String(timeoutMs * 1000),
    '-user_agent', headers['User-Agent'] || getConfig().scraper.userAgent,
    ...headerArgs(headers),
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
  if (!checkBinaries().ffprobe.ok) return null;
  const args = buildFfprobeArgs(url, { headers, timeoutMs });
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(FFPROBE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
    subtitles: input.subtitles || 'none',               // none | soft | burn
    subtitlePath: input.subtitlePath || null,
    subtitleLanguage: input.subtitleLanguage || 'nld',
    deinterlace: Boolean(input.deinterlace),
    hardware: input.hardware ?? true,
    scaleMethod: input.scaleMethod || 'auto',
  };

  // Decide whether an encode is needed at all.
  const v = probeInfo?.video;
  const needsDownscale = v?.height ? v.height > p.resolution : false;
  const unsupportedCodec = v?.codec ? !['h264', 'avc1'].includes(String(v.codec).toLowerCase()) : false;
  const forced = p.mode === 'copy' ? false : (p.alwaysTranscode || p.mode === 'vaapi' || p.mode === 'x264');
  const burnIn = p.subtitles === 'burn';
  const softMux = p.subtitles === 'soft' && Boolean(p.subtitlePath);

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
  const args = ['-hide_banner', '-nostdin', '-loglevel', process.env.FFMPEG_LOGLEVEL || 'warning'];
  const isHttp = /^https?:/i.test(source.url || '');
  const kind = source.kind || streamKind(source.url);

  // --- input resilience (identical to the command in the requirements) ---
  if (isHttp) {
    args.push(
      '-rw_timeout', '10000000',
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
    );
  }
  args.push('-fflags', '+genpts+discardcorrupt', '-err_detect', 'ignore_err');
  if (isHttp) {
    args.push('-user_agent', source.headers?.['User-Agent'] || getConfig().scraper.userAgent);
    args.push(...headerArgs(source.headers));
  }
  if (mode === 'live' && kind === 'hls') args.push('-live_start_index', '-3');

  // --- hardware decode ---
  const useVaapi = p.transcode && p.encoder === 'vaapi' && hw.available;
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
    args.push('-filter_hw_device', 'intel');
  }

  args.push('-i', source.url);

  // --- video filter chain ---
  const vf = [];
  if (p.deinterlace) vf.push('yadif');
  const { w, h } = p.dimensions || { w: 1920, h: 1080 };
  const needScale = Boolean(p.transcode) && (p.mode !== 'copy');
  if (needScale && p.encoder === 'vaapi' && !burnIn) {
    vf.push(`scale_vaapi=w=${w}:h=${h}:format=nv12`);
  } else if (needScale) {
    vf.push(`scale=w=${w}:h=${h}`);
  }
  const wantsFps = Boolean(p.fps && p.fps !== 'source');
  // The fps filter can only run on VAAPI surfaces when the build supports it
  // (variant 1 in the self-test). Otherwise the conversion happens on output
  // via -fps_mode/-r, which is why it is NOT added to the filter chain here.
  const fpsInChain = wantsFps && (p.encoder !== 'vaapi' || burnIn || hw?.fpsVariant === 1);
  if (fpsInChain) vf.push(`fps=${p.fps}`);
  if (burnIn) {
    vf.push(`subtitles=filename=${escapeFilterPath(p.subtitlePath)}`);
    if (p.encoder === 'vaapi') vf.push('format=nv12', 'hwupload');
    else vf.push('format=yuv420p');
  } else if (p.transcode && p.encoder === 'libx264') {
    vf.push('format=yuv420p');
  }
  const filterString = vf.filter(Boolean).join(',');
  if (filterString) args.push('-vf', filterString);

  // --- stream mapping ---
  args.push('-map', '0:v:0', '-map', '0:a:0?');
  if (p.softMux) args.push('-map', '0:s:0?');
  args.push('-dn');
  if (!p.softMux) args.push('-sn');

  // --- video codec ---
  if (!p.transcode) {
    args.push('-c:v', 'copy');
    if (source.bsf) args.push('-bsf:v', source.bsf);
    else if (container === 'mpegts' && (kind === 'file' || source.bsf === undefined) && /mp4|mov|m4v/i.test(String(source.container || ''))) {
      args.push('-bsf:v', 'h264_mp4toannexb');
    }
  } else if (p.encoder === 'vaapi') {
    const vb = Number(p.videoBitrate || 2500);
    args.push(
      '-c:v', 'h264_vaapi',
      '-b:v', `${vb}k`,
      '-maxrate', `${Math.round(vb * 1.2)}k`,
      '-bufsize', `${Math.round(vb * 1.8)}k`,
      '-profile:v', 'high',
      '-level', '4.1',
      '-g', String(Math.round(Number(p.fps && p.fps !== 'source' ? p.fps : 25) * 2)),
    );
  } else if (p.encoder === 'libx264') {
    const vb = Number(p.videoBitrate || 2500);
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
      '-maxrate', `${Math.round(vb * 1.2)}k`, '-bufsize', `${Math.round(vb * 1.8)}k`,
      '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
      '-g', String(Math.round(Number(p.fps && p.fps !== 'source' ? p.fps : 25) * 2)),
    );
  } else if (p.encoder === 'libx265') {
    // CPU only — Apollo Lake has no HEVC encoder. Kept for downloads, not live use.
    args.push('-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '24', '-tag:v', 'hvc1');
  }

  // --- framerate conversion (only when not already done in the filter chain) ---
  if (wantsFps && !fpsInChain) {
    const variant = p.encoder === 'vaapi' ? hw?.fpsVariant : null;
    if (variant === 3) args.push('-r', String(p.fps)); // legacy ffmpeg syntax
    else args.push('-fps_mode', 'cfr', '-r', String(p.fps));
  }

  // --- audio ---
  if (p.transcode) {
    args.push('-c:a', p.audioCodec || 'aac');
    if ((p.audioCodec || 'aac') !== 'copy') {
      args.push('-b:a', `${p.audioBitrate || 128}k`, '-ac', String(p.audioChannels || 2), '-ar', '48000');
    }
  } else {
    args.push('-c:a', 'copy');
  }

  // --- subtitles (soft mux) ---
  if (p.softMux) {
    if (container === 'matroska') {
      args.push('-c:s', 'srt', '-metadata:s:s:0', `language=${p.subtitleLanguage || 'nld'}`);
    } else {
      // MPEG-TS/HLS carry DVB subtitles — this is what Enigma2 understands.
      args.push('-c:s', 'dvbsub', '-metadata:s:s:0', `language=${p.subtitleLanguage || 'nld'}`);
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
  }
  args.push('-max_muxing_queue_size', '1024');
  if (mode === 'live') args.push('-progress', 'pipe:2', '-nostats');
  args.push(output.target);
  return args;
}

function vh(encoder, transcode) { return transcode ? encoder : 'copy'; }

/** ffmpeg filter paths need escaping of : \ ' and , */
export function escapeFilterPath(p) {
  return String(p).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,');
}

/** Human readable command string (used by the UI "generated command" box). */
export function argsToCommand(args) {
  return ['ffmpeg', ...args.map((a) => (/[\s"'\\$]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a))].join(' ');
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
  FFMPEG, FFPROBE, checkBinaries, hardware, detectHardware, probe, parseProbeJson,
  parseHlsMaster, streamKind, buildFfmpegArgs, buildFfprobeArgs, normaliseProfile,
  targetDimensions, argsToCommand, parseProgressLine,
};
