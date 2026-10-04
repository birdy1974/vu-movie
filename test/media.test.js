/**
 * Unit tests for the ffmpeg/probe layer.
 *
 * This is the part of vu-movie where a mistake is most expensive: a wrong flag
 * means VLC shows nothing and the only clue is one line in the log. So the arg
 * builder is a pure function and gets tested here instead of on the NAS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFfmpegArgs, normaliseProfile, parseProbeJson, parseHlsMaster,
  targetDimensions, parseProgressLine, argsToCommand, streamKind, headerArgs, headerObject, parseFps,
} from '../src/core/media.js';

const PROBE_1080P_H264 = {
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSec: 7200,
  bitrate: 6000000,
  video: { codec: 'h264', width: 1920, height: 1080, fps: 23.976, pixFmt: 'yuv420p', profile: 'High' },
  audio: [{ codec: 'aac', channels: 2, language: 'eng' }],
  subtitles: [],
};

const PROBE_4K_HEVC = {
  container: 'matroska,webm',
  durationSec: 8400,
  video: { codec: 'hevc', width: 3840, height: 2160, fps: 23.976, pixFmt: 'yuv420p10le', bitrate: 18000000 },
  audio: [{ codec: 'eac3', channels: 6, language: 'eng' }],
  subtitles: [{ codec: 'subrip', language: 'nld' }],
};

const HW = { available: true, device: '/dev/dri/renderD128', fpsVariant: 1 };

test('streamKind recognises the source families', () => {
  assert.equal(streamKind('https://x/y/master.m3u8?token=1'), 'hls');
  assert.equal(streamKind('https://x/y/manifest.mpd'), 'dash');
  assert.equal(streamKind('https://x/y/movie.mp4'), 'file');
});

test('headerArgs turns header objects into one -headers argument', () => {
  const args = headerArgs({ Referer: 'https://a/', 'User-Agent': 'UA' });
  assert.equal(args[0], '-headers');
  assert.ok(args[1].includes('Referer: https://a/'));
  assert.ok(args[1].includes('User-Agent: UA'));
  assert.deepEqual(headerArgs({}), []);
  assert.deepEqual(headerArgs(undefined), []);
});

test('a bare list of header names never becomes numbered ffmpeg headers', () => {
  // /find/resolve used to send ["Referer","User-Agent"] to the UI, which posted
  // it back verbatim; the relay then sent `-headers "0: Referer\r\n1: User-Agent"`
  // to ffmpeg and lost every cookie. The list must be ignored, not serialised.
  assert.deepEqual(headerArgs(['Referer', 'User-Agent']), []);
  assert.deepEqual(headerObject(['Referer', 'User-Agent']), {});
  assert.deepEqual(headerObject(null), {});
  assert.deepEqual(headerObject({ Referer: 'https://a/' }), { Referer: 'https://a/' });

  const profile = normaliseProfile({ mode: 'copy' }, PROBE_1080P_H264);
  const args = buildFfmpegArgs({
    source: { url: 'https://cdn/x.mp4', headers: ['Referer', 'User-Agent'], kind: 'file' },
    profile, hw: HW, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });
  assert.ok(!args.join(' ').includes('0: Referer'), 'no numbered header lines');
  const ua = args[args.indexOf('-user_agent') + 1];
  assert.ok(typeof ua === 'string' && ua.startsWith('Mozilla/5.0'), 'falls back to the configured UA');
});

test('copy/remux produces a single playable MPEG-TS on stdout', () => {
  const profile = normaliseProfile({ mode: 'copy', container: 'mpegts' }, PROBE_1080P_H264);
  assert.equal(profile.transcode, false, 'a 1080p H.264 source must not be re-encoded');
  assert.equal(profile.encoder, 'copy');

  const args = buildFfmpegArgs({
    source: { url: 'https://cdn.example.com/master.m3u8', headers: { Referer: 'https://site/' }, kind: 'hls' },
    profile, hw: HW, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });

  // input resilience flags from the requirements
  for (const flag of ['-rw_timeout', '-reconnect', '-reconnect_at_eof', '-reconnect_streamed', '-reconnect_delay_max', '-fflags', '-err_detect']) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.ok(args.includes('-headers'));
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-f') + 1], 'mpegts');
  assert.ok(args.includes('-mpegts_flags') && args.includes('+resend_headers'));
  assert.equal(args[args.length - 1], 'pipe:1');
  assert.ok(!args.includes('h264_vaapi'), 'stream copy must not start an encoder');
});

test('VAAPI transcoding matches the documented command shape', () => {
  const profile = normaliseProfile({
    mode: 'vaapi', resolution: 720, videoBitrate: 1000, audioBitrate: 128,
    audioChannels: 2, fps: '25', container: 'mpegts',
  }, PROBE_4K_HEVC);
  assert.equal(profile.transcode, true);

  const args = buildFfmpegArgs({
    source: { url: 'https://cdn/master.m3u8', kind: 'hls' },
    profile, hw: HW, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });

  assert.equal(args[args.indexOf('-init_hw_device') + 1], 'vaapi=intel:/dev/dri/renderD128');
  assert.equal(args[args.indexOf('-hwaccel') + 1], 'vaapi');
  assert.equal(args[args.indexOf('-hwaccel_output_format') + 1], 'vaapi');
  assert.equal(args[args.indexOf('-vf') + 1], 'scale_vaapi=w=1280:h=720:format=nv12,fps=25,setsar=1');
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_vaapi');
  assert.equal(args[args.indexOf('-b:v') + 1], '1000k');
  // Ladder from the DUO2 field test: 1.5× peak, bufsize = target bitrate.
  assert.equal(args[args.indexOf('-maxrate') + 1], '1500k');
  assert.equal(args[args.indexOf('-bufsize') + 1], '1000k');
  assert.equal(args[args.indexOf('-rc_mode') + 1], 'VBR');
  assert.equal(args[args.indexOf('-async_depth') + 1], '4');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.equal(args[args.indexOf('-b:a') + 1], '128k');
  assert.equal(args[args.indexOf('-map') + 1], '0:v:0');
  // live-specific flags from the same confirmed-working command
  assert.equal(args[args.indexOf('-analyzeduration') + 1], '1000000');
  assert.equal(args[args.indexOf('-probesize') + 1], '1000000');
  assert.equal(args[args.indexOf('-flush_packets') + 1], '1');
});

test('a vaapi profile on a box without a working GPU degrades to software', () => {
  const profile = normaliseProfile({ mode: 'vaapi', resolution: 720, videoBitrate: 1000 }, PROBE_4K_HEVC);
  assert.equal(profile.encoder, 'vaapi', 'the profile still asks for vaapi');
  const args = buildFfmpegArgs({
    source: { url: 'https://cdn/x.m3u8', kind: 'hls' },
    profile, hw: { available: false }, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });
  // Before: `-c:v h264_vaapi` with no `-init_hw_device` — ffmpeg rejects that.
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.ok(!args.includes('h264_vaapi'));
  assert.ok(!args.includes('-init_hw_device'));
  assert.equal(args[args.indexOf('-preset') + 1], 'veryfast');
  const vf = args[args.indexOf('-vf') + 1] || '';
  assert.ok(!vf.includes('scale_vaapi'), `software path must not use VAAPI filters: ${vf}`);
  assert.ok(vf.includes('scale=w=1280:h=720'), vf);
});

test('when the GPU cannot run the fps filter, ffmpeg converts on output instead', () => {
  const profile = normaliseProfile({ mode: 'vaapi', resolution: 720, fps: '25' }, PROBE_4K_HEVC);
  const args = buildFfmpegArgs({
    source: { url: 'https://cdn/x.m3u8', kind: 'hls' },
    profile, hw: { ...HW, fpsVariant: 2 }, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });
  assert.equal(args[args.indexOf('-vf') + 1], 'scale_vaapi=w=1280:h=720:format=nv12,setsar=1');
  assert.ok(!args.includes('fps=25'), 'the fps filter cannot run on VAAPI surfaces');
  assert.equal(args[args.indexOf('-fps_mode') + 1], 'cfr');
  assert.equal(args[args.indexOf('-r') + 1], '25');
});

test('software encoding is used when the GPU is missing', () => {
  const profile = normaliseProfile({ mode: 'x264', resolution: 720, videoBitrate: 1500 }, PROBE_4K_HEVC);
  assert.equal(profile.encoder, 'libx264');
  const args = buildFfmpegArgs({
    source: { url: 'https://cdn/x.m3u8', kind: 'hls' },
    profile, hw: { available: false }, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.ok(!args.includes('-init_hw_device'));
  const vf = args[args.indexOf('-vf') + 1];
  assert.ok(vf.includes('scale=w=1280:h=720'), `filter chain was: ${vf}`);
});

test('Matroska output for downloads, MPEG-TS for live', () => {
  const profile = normaliseProfile({ mode: 'copy', container: 'matroska' }, PROBE_1080P_H264);
  const args = buildFfmpegArgs({
    source: { url: 'https://cdn/x.m3u8', kind: 'hls' },
    profile, hw: HW, mode: 'live', output: { container: 'matroska', target: 'pipe:1' },
  });
  assert.equal(args[args.indexOf('-f') + 1], 'matroska');
  assert.equal(args[args.indexOf('-live') + 1], '1', 'matroska needs -live 1 when writing to a pipe');
});

test('HLS output writes a playlist plus segments instead of stdout', () => {
  const profile = normaliseProfile({ mode: 'copy', container: 'hls' }, PROBE_1080P_H264);
  const args = buildFfmpegArgs({
    source: { url: 'https://cdn/x.m3u8', kind: 'hls' },
    profile, hw: HW, mode: 'live',
    output: { container: 'hls', target: '/tmp/vumovie/hls/tok/index.m3u8', hlsDir: '/tmp/vumovie/hls/tok', hlsTime: 2, hlsListSize: 10 },
  });
  assert.equal(args[args.indexOf('-f') + 1], 'hls');
  assert.equal(args[args.indexOf('-hls_time') + 1], '2');
  assert.equal(args[args.indexOf('-hls_list_size') + 1], '10');
  assert.ok(args.includes('-hls_segment_filename'));
  assert.equal(args[args.length - 1], '/tmp/vumovie/hls/tok/index.m3u8');
  assert.ok(!args.includes('pipe:1'));
});

test('burning in subtitles forces the software subtitle filter', () => {
  const profile = normaliseProfile({
    mode: 'x264', alwaysTranscode: true, resolution: 720,
    subtitles: 'burn', subtitlePath: '/downloads/subs/my movie.nl.srt',
  }, PROBE_4K_HEVC);
  const args = buildFfmpegArgs({
    source: { url: 'https://cdn/x.m3u8', kind: 'hls' },
    profile, hw: HW, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });
  const vf = args[args.indexOf('-vf') + 1];
  assert.ok(vf.includes('subtitles=filename=/downloads/subs/my movie.nl.srt'), vf);
  assert.ok(vf.includes('scale='));
});

test('soft muxing picks the right subtitle codec per container', () => {
  const base = { mode: 'copy', subtitles: 'soft', subtitlePath: '/downloads/subs/x.srt' };
  const ts = buildFfmpegArgs({
    source: { url: 'https://cdn/x.m3u8', kind: 'hls' },
    profile: normaliseProfile({ ...base, container: 'mpegts' }, PROBE_4K_HEVC),
    hw: HW, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });
  assert.equal(ts[ts.indexOf('-c:s') + 1], 'dvbsub', 'Enigma2 understands DVB subtitles in TS');

  const mkv = buildFfmpegArgs({
    source: { url: 'https://cdn/x.m3u8', kind: 'hls' },
    profile: normaliseProfile({ ...base, container: 'matroska' }, PROBE_4K_HEVC),
    hw: HW, mode: 'file', output: { container: 'matroska', target: '/downloads/x.mkv' },
  });
  assert.equal(mkv[mkv.indexOf('-c:s') + 1], 'srt');
});

test('normaliseProfile decides copy vs transcode and explains why', () => {
  const clean = normaliseProfile({ resolution: 1080 }, PROBE_1080P_H264);
  assert.equal(clean.transcode, false);
  assert.match(clean.reasons.join(' '), /already matches|stream copy/);

  const fourK = normaliseProfile({ resolution: 1080 }, PROBE_4K_HEVC);
  assert.equal(fourK.transcode, true);
  assert.ok(fourK.reasons.some((r) => /2160p/.test(r) || /hevc/.test(r)), fourK.reasons.join(';'));

  const forced = normaliseProfile({ resolution: 1080, alwaysTranscode: true }, PROBE_1080P_H264);
  assert.equal(forced.transcode, true);
  assert.match(forced.reasons.join(' '), /always/);

  const h265 = normaliseProfile({ mode: 'h265', alwaysTranscode: true }, PROBE_1080P_H264);
  assert.equal(h265.encoder, 'libx265');
  const hevcArgs = buildFfmpegArgs({
    source: { url: 'https://cdn/x.m3u8', kind: 'hls' },
    profile: h265, hw: HW, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });
  assert.equal(hevcArgs[hevcArgs.indexOf('-c:v') + 1], 'libx265');
});

test('targetDimensions keeps even numbers and honours 4:3', () => {
  assert.deepEqual(targetDimensions({ resolution: 720, aspect: '169' }), { w: 1280, h: 720 });
  assert.deepEqual(targetDimensions({ resolution: 720, aspect: '43' }), { w: 960, h: 720 });
  const fromSource = targetDimensions({ resolution: 1080, aspect: 'source', sourceWidth: 1920, sourceHeight: 800 });
  assert.equal(fromSource.w % 2, 0);
  assert.equal(fromSource.h, 1080);
});

test('parseProbeJson normalises codecs, fps, tracks and HDR', () => {
  const info = parseProbeJson({
    format: { format_name: 'matroska,webm', duration: '7200.5', bit_rate: '18000000' },
    streams: [
      { codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, r_frame_rate: '24000/1001', color_transfer: 'smpte2084' },
      { codec_type: 'audio', index: 1, codec_name: 'eac3', channels: 6, tags: { language: 'eng' } },
      { codec_type: 'subtitle', index: 2, codec_name: 'subrip', tags: { language: 'nld' } },
    ],
  });
  assert.equal(info.video.codec, 'hevc');
  assert.equal(info.video.height, 2160);
  assert.equal(info.video.fps, 23.976);
  assert.equal(info.audio[0].channels, 6);
  assert.equal(info.subtitles[0].language, 'nld');
});

test('parseHlsMaster reads variants and resolves relative URLs', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
    '1080/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1280x720',
    'https://cdn.example.com/720/index.m3u8',
  ].join('\n');
  const variants = parseHlsMaster(master, 'https://cdn.example.com/dash/');
  assert.equal(variants.length, 2);
  assert.equal(variants[0].height, 1080);
  assert.equal(variants[0].url, 'https://cdn.example.com/dash/1080/index.m3u8');
  assert.equal(variants[1].url, 'https://cdn.example.com/720/index.m3u8');
  assert.equal(parseFps('25/1'), 25);
});

test('parseProgressLine reads ffmpeg -progress output', () => {
  let stats = {};
  for (const line of ['frame=1250', 'fps=23.98', 'bitrate=2480.5kbits/s', 'speed=0.94x', 'out_time_ms=52100000']) {
    stats = parseProgressLine(line, stats);
  }
  assert.equal(stats.frame, 1250);
  assert.equal(stats.fps, 23.98);
  assert.equal(stats.speed, '0.94x');
  assert.equal(stats.outTimeMs, 52100);
});

test('argsToCommand is copy-pasteable', () => {
  const cmd = argsToCommand(['-i', 'https://x/y.m3u8', '-vf', 'scale_vaapi=w=1280:h=720', '-f', 'mpegts', 'pipe:1']);
  assert.equal(cmd, 'ffmpeg -i https://x/y.m3u8 -vf scale_vaapi=w=1280:h=720 -f mpegts pipe:1');
  const quoted = argsToCommand(['-vf', 'subtitles=filename=/downloads/my movie.srt']);
  assert.ok(quoted.includes('"subtitles=filename=/downloads/my movie.srt"'), quoted);
});
