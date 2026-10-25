/**
 * Unit tests for the ffmpeg/probe layer.
 *
 * This is the part of vu-movie where a mistake is most expensive: a wrong flag
 * means VLC shows nothing and the only clue is one line in the log. So the arg
 * builder is a pure function and gets tested here instead of on the NAS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildFfmpegArgs, normaliseProfile, parseProbeJson, parseHlsMaster,
  targetDimensions, parseProgressLine, argsToCommand, streamKind, nestedManifestKind, headerArgs, headerObject, parseFps,
  parseFfmpegTemplateTokens, validateFfmpegTemplate, outputFormatOf, subtitleSessionNotes,
  buildFfmpegTemplateArgs,
  buildFfprobeArgs, isDisguisedManifestUrl, isInitSegmentUrl, hlsExtensionPickyArgs,
  parseFfmpegVersion, ffmpegSupportsHlsExtensionPicky,
  parseHlsMediaDuration, parseDashMediaDuration, parseIsoDuration, audioOnlyReason,
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

test('streamKind unwraps DASH→HLS bridge URLs whose manifest sits in a nested param', () => {
  // The field shape: the worker's own path has no extension; v3.m3u8 is the
  // percent-encoded value of ?url=, with the signature beside it.
  const bridge = 'https://dash-hls-bridge.example.workers.dev/?url='
    + encodeURIComponent('https://sacdn.example/dash/5357535498/v3.m3u8?Policy=eyJ')
    + '&Policy=eyJ&Signature=abc';
  assert.equal(nestedManifestKind(bridge), 'hls');
  assert.equal(streamKind(bridge), 'hls', 'the bridge is fed like any HLS source');

  const dashBridge = 'https://proxy.example/translate?u=' + encodeURIComponent('https://cdn/x/index.mpd');
  assert.equal(streamKind(dashBridge), 'dash');
  // A nested plain file does not change the default classification.
  assert.equal(streamKind('https://proxy.example/fetch?url=' + encodeURIComponent('https://cdn/a/movie.mp4')), 'file');
  // No nested http(s) value, nothing to unwrap.
  assert.equal(nestedManifestKind('https://worker.example/?foo=bar'), null);
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

  // Input resilience flags. HLS must NOT get -reconnect_at_eof: together with
  // -reconnect_streamed it makes ffmpeg's HTTP layer reconnect at the clean EOF
  // of every playlist/segment response, so the HLS demuxer never sees the end
  // of the playlist and re-fetches the same m3u8 in a tight loop (no playback).
  for (const flag of ['-rw_timeout', '-reconnect', '-reconnect_streamed', '-reconnect_delay_max', '-fflags', '-err_detect']) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.ok(!args.includes('-reconnect_at_eof'), 'HLS inputs never reconnect at clean EOF');
  assert.ok(args.includes('-live_start_index'), 'HLS inputs keep the live start index');
  assert.ok(args.includes('-headers'));
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-f') + 1], 'mpegts');
  assert.ok(args.includes('-mpegts_flags') && args.includes('+resend_headers'));
  assert.equal(args[args.length - 1], 'pipe:1');
  assert.ok(!args.includes('h264_vaapi'), 'stream copy must not start an encoder');
});

test('reconnect_at_eof is withheld from every HLS input shape but kept for file/DASH', () => {
  // Field failure (ffmpeg 6/7): -reconnect_at_eof + -reconnect_streamed makes
  // the HTTP layer reconnect at the clean EOF of an m3u8, so the HLS demuxer
  // re-reads the same playlist in a tight loop and never opens a segment.
  const profile = normaliseProfile({ mode: 'copy', container: 'mpegts' }, PROBE_1080P_H264);
  const guided = (source) => buildFfmpegArgs({
    source, profile, hw: HW, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });
  const hlsCases = [
    { name: 'explicit hls kind', source: { url: 'https://cdn/hls/index.m3u8', kind: 'hls' } },
    { name: 'hls by URL only', source: { url: 'https://cdn/hls/index.m3u8' } },
    { name: 'DASH→HLS bridge in ?url=', source: { url: 'https://bridge.example/?url=https%3A%2F%2Fcdn%2Fv3.m3u8&Policy=sig' } },
    { name: 'loopback proxy /h URL, no kind', source: { url: 'http://127.0.0.1:8080/up/39dcb355f86ee1688494dd15/h' } },
  ];
  for (const { name, source } of hlsCases) {
    const args = guided(source);
    assert.ok(!args.includes('-reconnect_at_eof'), `${name}: no reconnect_at_eof`);
    for (const flag of ['-reconnect', '-reconnect_streamed', '-reconnect_delay_max', '-rw_timeout']) {
      assert.ok(args.includes(flag), `${name}: keeps ${flag}`);
    }
    assert.ok(args.includes('-live_start_index'), `${name}: keeps the HLS live start index`);
  }

  // Non-HLS sources keep every resilience flag: a cut transfer must resume.
  for (const source of [
    { url: 'https://cdn/movie.mp4', kind: 'file' },
    { url: 'https://cdn/dash/index.mpd', kind: 'dash' },
  ]) {
    const args = guided(source);
    assert.ok(args.includes('-reconnect_at_eof'), `${source.kind}: keeps reconnect_at_eof`);
    assert.ok(!args.includes('-live_start_index'), `${source.kind}: no HLS-only flag`);
  }

  // The template renderer must apply the same rule (its own flag injection).
  const template = 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -c copy -f mpegts pipe:1';
  const hlsTemplate = buildFfmpegTemplateArgs({
    template, source: { url: 'http://127.0.0.1:8080/up/abc123/h', kind: 'hls' },
    profile: { container: 'mpegts' }, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });
  assert.ok(!hlsTemplate.includes('-reconnect_at_eof'), 'template HLS: no reconnect_at_eof');
  assert.ok(hlsTemplate.includes('-reconnect_streamed'), 'template HLS: keeps the other reconnect flags');
  const fileTemplate = buildFfmpegTemplateArgs({
    template, source: { url: 'https://cdn/movie.mp4', kind: 'file' },
    profile: { container: 'mpegts' }, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });
  assert.ok(fileTemplate.includes('-reconnect_at_eof'), 'template file: keeps reconnect_at_eof');
});

test('VAAPI transcoding matches the requested MPEG-TS command shape', () => {
  const profile = normaliseProfile({
    mode: 'vaapi', resolution: 1080, videoBitrate: 8000, audioBitrate: 192,
    audioChannels: 6, fps: '25', container: 'mpegts', subtitles: 'soft',
  }, PROBE_4K_HEVC);
  assert.equal(profile.transcode, true);

  const args = buildFfmpegArgs({
    source: { url: 'https://cdn/master.m3u8', kind: 'hls' },
    profile, hw: HW, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });

  assert.equal(args[args.indexOf('-init_hw_device') + 1], 'vaapi=intel:/dev/dri/renderD128');
  assert.equal(args[args.indexOf('-hwaccel') + 1], 'vaapi');
  assert.equal(args[args.indexOf('-hwaccel_output_format') + 1], 'vaapi');
  assert.equal(args[args.indexOf('-vf') + 1], 'scale_vaapi=w=1920:h=1080:format=nv12,fps=25,setsar=1');
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_vaapi');
  assert.equal(args[args.indexOf('-b:v') + 1], '8000k');
  // Ladder from the requested command: 1.5× peak, buffer = target bitrate.
  assert.equal(args[args.indexOf('-maxrate') + 1], '12000k');
  assert.equal(args[args.indexOf('-bufsize') + 1], '8000k');
  assert.equal(args[args.indexOf('-profile:v') + 1], 'high');
  assert.equal(args[args.indexOf('-level') + 1], '4.1');
  assert.equal(args[args.indexOf('-g') + 1], '50');
  assert.equal(args[args.indexOf('-r') + 1], '25');
  assert.ok(args.indexOf('-r') > args.indexOf('-g'), 'output rate follows the GOP size');
  assert.equal(args[args.indexOf('-rc_mode') + 1], 'VBR');
  assert.equal(args[args.indexOf('-async_depth') + 1], '4');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.equal(args[args.indexOf('-b:a') + 1], '192k');
  assert.equal(args[args.indexOf('-ac') + 1], '6');
  assert.equal(args[args.indexOf('-ar') + 1], '48000');
  assert.equal(args[args.indexOf('-map') + 1], '0:v:0');
  assert.equal(args[args.indexOf('-map', args.indexOf('-map') + 1) + 1], '0:a:0?');
  assert.equal(args[args.indexOf('-map', args.indexOf('-map', args.indexOf('-map') + 1) + 1) + 1], '0:s?');
  assert.ok(!args.includes('-sn'));
  assert.equal(args[args.indexOf('-c:s') + 1], 'dvbsub');
  // The supplied option order matters to the command preview as well.
  const orderedInputOptions = [
    '-reconnect', '-fflags', '-err_detect', '-init_hw_device', '-hwaccel',
    '-hwaccel_device', '-hwaccel_output_format', '-rw_timeout',
    '-analyzeduration', '-probesize', '-i',
  ].map((flag) => args.indexOf(flag));
  assert.deepEqual(orderedInputOptions, [...orderedInputOptions].sort((a, b) => a - b));
  assert.equal(args[args.indexOf('-rw_timeout') + 1], '10000000');
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

test('a Matroska soft mux maps the sidecar first when the source subtitle count is unknown', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-sidecar-test-'));
  const subtitlePath = path.join(dir, 'selected subtitle.nl.srt');
  fs.writeFileSync(subtitlePath, 'SRT sidecar test fixture');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // The source carries no probe subtitle list, so the number of source subtitle
  // tracks in the output is unknown and the sidecar cannot be placed after them
  // safely: it stays first, as subtitle stream 0, where the disposition and
  // language metadata need no index arithmetic.
  const profile = normaliseProfile(
    { mode: 'copy', container: 'matroska', subtitles: 'soft', subtitlePath, subtitleLanguage: 'nld' },
    PROBE_4K_HEVC,
  );
  const args = buildFfmpegArgs({
    source: { url: 'https://cdn/x.mkv', kind: 'file' },
    profile, hw: HW, mode: 'live', output: { container: 'matroska', target: 'pipe:1' },
  });
  const secondInput = args.indexOf('-i', args.indexOf('-i') + 1);
  assert.equal(args[secondInput + 1], subtitlePath, 'the sidecar is a second input');
  const maps = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === '-map') maps.push(args[i + 1]);
  assert.deepEqual(maps, ['0:v:0', '0:a:0?', '1:s:0?', '0:s?'], 'sidecar before the source tracks');
  assert.ok(args.includes('-disposition:s:0'), 'the track is flagged default for exteplayer3/Enigma2');
  assert.equal(args[args.indexOf('-disposition:s:0') + 1], 'default');
  assert.equal(args[args.indexOf('-metadata:s:s:0') + 1], 'language=nld');
  assert.equal(args[args.indexOf('-c:s') + 1], 'copy', 'source tracks are copied, never re-encoded');
  assert.equal(args[args.indexOf('-c:s:0') + 1], 'srt');
});

test('a Matroska soft mux maps the sidecar after the source subtitle tracks and makes it the only default', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-sidecar-order-test-'));
  const subtitlePath = path.join(dir, 'selected subtitle.nl.srt');
  fs.writeFileSync(subtitlePath, 'SRT sidecar test fixture');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // The probe vouches for two source subtitle tracks (a copyable subrip and a
  // mov_text the muxer cannot carry), so the sidecar's stream index is known:
  // it is muxed last, after the source's own tracks.
  const probe = {
    ...PROBE_1080P_H264,
    subtitles: [{ codec: 'mov_text', language: 'eng' }, { codec: 'subrip', language: 'eng' }],
  };
  const profile = normaliseProfile(
    { mode: 'copy', container: 'matroska', subtitles: 'soft', subtitlePath, subtitleLanguage: 'nld' },
    probe,
  );
  const args = buildFfmpegArgs({
    source: { url: 'https://cdn/x.mp4', kind: 'file', subtitles: probe.subtitles },
    profile, hw: HW, mode: 'live', output: { container: 'matroska', target: 'pipe:1' },
  });
  const maps = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === '-map') maps.push(args[i + 1]);
  assert.deepEqual(maps, ['0:v:0', '0:a:0?', '0:s?', '1:s:0?'], 'the sidecar is mapped after the source tracks');
  assert.equal(args[args.indexOf('-c:s') + 1], 'copy');
  assert.equal(args[args.indexOf('-c:s:0') + 1], 'srt', 'the mov_text track is re-encoded at position 0');
  assert.ok(!args.includes('-c:s:1'), 'the subrip track stays on copy at position 1');
  assert.equal(args[args.indexOf('-c:s:2') + 1], 'srt', 'the sidecar is muxed last, at position 2');
  // The source tracks keep the default flag they carried in the source — a
  // second default track makes players pick one, often a partial source track
  // instead of the attachment. The builder clears it and flags only the sidecar.
  assert.equal(args[args.indexOf('-disposition:s') + 1], '-default', 'the default flag is cleared on every subtitle stream');
  assert.equal(args[args.indexOf('-disposition:s:2') + 1], 'default', 'the sidecar is the only default track');
  assert.equal(args[args.indexOf('-metadata:s:s:2') + 1], 'language=nld');
});

test('a text sidecar is never forced into MPEG-TS (ffmpeg cannot make DVB bitmaps from it)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-sidecar-ts-test-'));
  const subtitlePath = path.join(dir, 'movie.nl.srt');
  fs.writeFileSync(subtitlePath, 'SRT sidecar test fixture');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const profile = normaliseProfile({ mode: 'copy', container: 'mpegts', subtitles: 'soft', subtitlePath }, PROBE_4K_HEVC);
  const args = buildFfmpegArgs({
    source: { url: 'https://cdn/x.m3u8', kind: 'hls' },
    profile, hw: HW, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });
  assert.ok(!args.includes(subtitlePath), 'the .srt must not be an input of a TS mux');
  assert.ok(!args.includes('1:s:0?'), 'and it must not be mapped either');
  assert.equal(args[args.indexOf('-c:s') + 1], 'dvbsub', 'source DVB subtitles keep working');

  const notes = subtitleSessionNotes(profile, 'mpegts', args);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /cannot convert a text \.srt/);
});

test('subtitleSessionNotes explains burn-in under a hand-written template', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-burn-note-test-'));
  const subtitlePath = path.join(dir, 'movie.nl.srt');
  fs.writeFileSync(subtitlePath, 'SRT sidecar test fixture');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profile = { subtitles: 'burn', subtitlePath, subtitleLanguage: 'nld' };
  const notes = subtitleSessionNotes(profile, 'mpegts', ['-i', 'https://x', '-c:v', 'copy', '-f', 'mpegts', 'pipe:1']);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /only the guided builder hardcodes subtitles/);
  // The guided builder really does apply it — no note then.
  const burned = ['-vf', 'scale=w=1920:h=1080,subtitles=filename=/x.srt,format=yuv420p', '-f', 'mpegts', 'pipe:1'];
  assert.deepEqual(subtitleSessionNotes(profile, 'mpegts', burned), []);
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
  // Matroska copies what its muxer can carry (the probed subrip track here):
  // a blanket srt re-encode used to die on bitmap sources, and a blanket copy
  // dies on MP4 mov_text sources (see the override tests below).
  assert.equal(mkv[mkv.indexOf('-c:s') + 1], 'copy');
});

test('matroska re-encodes the mov_text tracks a blanket copy cannot carry', () => {
  // The field failure: an MP4 source with a mov_text track (codec id 94213)
  // and `-c:s copy` → "Subtitle codec 94213 is not supported" → the muxer
  // refuses the whole file. The probe knows the track list, so the builder
  // converts just that track to srt and leaves everything else on copy.
  const probe = {
    ...PROBE_1080P_H264,
    subtitles: [{ codec: 'mov_text', language: 'eng' }, { codec: 'hdmv_pgs_subtitle', language: 'eng' }],
  };
  const args = buildFfmpegArgs({
    source: { url: 'https://cdn/x.mp4', kind: 'file', subtitles: probe.subtitles },
    profile: normaliseProfile({ mode: 'copy', container: 'matroska', subtitles: 'soft' }, probe),
    hw: HW, mode: 'live', output: { container: 'matroska', target: 'pipe:1' },
  });
  assert.equal(args[args.indexOf('-c:s') + 1], 'copy');
  assert.equal(args[args.indexOf('-c:s:0') + 1], 'srt', 'the mov_text track is re-encoded');
  assert.ok(!args.includes('-c:s:1'), 'the PGS track stays on copy');

  // With an attached sidecar the source tracks keep their positions and the
  // sidecar is muxed after them (the operator's extra track).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-movtext-test-'));
  const subtitlePath = path.join(dir, 'movie.nl.srt');
  fs.writeFileSync(subtitlePath, 'SRT sidecar test fixture');
  const withSidecar = buildFfmpegArgs({
    source: { url: 'https://cdn/x.mp4', kind: 'file', subtitles: probe.subtitles },
    profile: normaliseProfile({ mode: 'copy', container: 'matroska', subtitles: 'soft', subtitlePath, subtitleLanguage: 'nld' }, probe),
    hw: HW, mode: 'live', output: { container: 'matroska', target: 'pipe:1' },
  });
  const maps = [];
  for (let i = 0; i < withSidecar.length; i += 1) if (withSidecar[i] === '-map') maps.push(withSidecar[i + 1]);
  assert.deepEqual(maps, ['0:v:0', '0:a:0?', '0:s?', '1:s:0?'], 'the sidecar is mapped after the source tracks');
  assert.equal(withSidecar[withSidecar.indexOf('-c:s') + 1], 'copy');
  assert.equal(withSidecar[withSidecar.indexOf('-c:s:0') + 1], 'srt', 'the mov_text track keeps position 0');
  assert.ok(!withSidecar.includes('-c:s:1'), 'the PGS track stays on copy at position 1');
  assert.equal(withSidecar[withSidecar.indexOf('-c:s:2') + 1], 'srt', 'the sidecar is muxed last, at position 2');
  assert.equal(withSidecar[withSidecar.indexOf('-disposition:s') + 1], '-default', 'the default flag the source tracks carried in is cleared');
  assert.equal(withSidecar[withSidecar.indexOf('-disposition:s:2') + 1], 'default', 'the sidecar is the only default track');
  assert.equal(withSidecar[withSidecar.indexOf('-metadata:s:s:2') + 1], 'language=nld');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mpegts only maps the bitmap subtitle tracks of a probed source', () => {
  const subs = [{ codec: 'mov_text', language: 'eng' }, { codec: 'hdmv_pgs_subtitle', language: 'eng' }];
  const profile = normaliseProfile({ mode: 'copy', container: 'mpegts', subtitles: 'soft' }, PROBE_1080P_H264);
  const args = buildFfmpegArgs({
    source: { url: 'https://cdn/x.mp4', kind: 'file', subtitles: subs },
    profile, hw: HW, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });
  assert.ok(!args.includes('0:s?'), 'no blanket subtitle map when the probe knows better');
  assert.ok(args.includes('0:s:1?'), 'the PGS track is mapped …');
  assert.ok(!args.some((a, i) => a === '-map' && args[i + 1] === '0:s:0?'), '… the mov_text track is not (dvbsub cannot eat text)');
  assert.equal(args[args.indexOf('-c:s') + 1], 'dvbsub');

  // A text-only source maps nothing — no crash, and the session notes still
  // explain why the attached subtitle is absent.
  const textOnly = buildFfmpegArgs({
    source: { url: 'https://cdn/x.mp4', kind: 'file', subtitles: [{ codec: 'mov_text' }] },
    profile, hw: HW, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });
  const maps = textOnly.filter((a, i) => textOnly[i - 1] === '-map');
  assert.ok(!maps.some((m) => /^0:s/.test(m)));

  // Without probe info the optimistic blanket map stays.
  const unknown = buildFfmpegArgs({
    source: { url: 'https://cdn/x.mp4', kind: 'file' },
    profile, hw: HW, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });
  assert.ok(unknown.includes('0:s?'));
});

test('a template that copies subtitles re-encodes the mov_text tracks Matroska cannot carry', () => {
  // The exact shape of the field template: maps every source subtitle track
  // and copies them into a live Matroska pipe.
  const template = 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -map 0:s? -dn -c:v copy -c:a copy -c:s copy -f matroska pipe:1';
  const args = buildFfmpegTemplateArgs({
    template,
    source: { url: 'https://cdn/movie.mp4', kind: 'file', subtitles: [{ codec: 'mov_text', language: 'eng' }] },
    profile: {}, mode: 'live', output: { container: 'matroska', target: 'pipe:1' },
  });
  assert.equal(args[args.indexOf('-c:s') + 1], 'copy', 'the template’s own setting is untouched');
  assert.equal(args[args.indexOf('-c:s:0') + 1], 'srt', 'the uncopyable track gets a per-stream re-encode');

  // A subrip track copies fine — no override appears.
  const plain = buildFfmpegTemplateArgs({
    template,
    source: { url: 'https://cdn/movie.mp4', kind: 'file', subtitles: [{ codec: 'subrip', language: 'nld' }] },
    profile: {}, mode: 'live', output: { container: 'matroska', target: 'pipe:1' },
  });
  assert.ok(!plain.includes('-c:s:0'));

  // No probe info → no override (nothing to know), command stays as written.
  const noProbe = buildFfmpegTemplateArgs({
    template, source: { url: 'https://cdn/movie.mp4', kind: 'file' },
    profile: {}, mode: 'live', output: { container: 'matroska', target: 'pipe:1' },
  });
  assert.ok(!noProbe.includes('-c:s:0'));

  // A catch-all `-c copy` copies subtitles too and needs the same override.
  const catchAll = buildFfmpegTemplateArgs({
    template: 'ffmpeg -i <url> -c copy -f matroska pipe:1',
    source: { url: 'https://cdn/movie.mp4', kind: 'file', subtitles: [{ codec: 'mov_text' }] },
    profile: {}, mode: 'live', output: { container: 'matroska', target: 'pipe:1' },
  });
  assert.equal(catchAll[catchAll.indexOf('-c:s:0') + 1], 'srt', 'automatic stream selection picks the first subtitle track');
});

test('an FFmpeg template keeps the subtitle attached to the playlist item', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-template-subs-test-'));
  const subtitlePath = path.join(dir, 'movie.nl.srt');
  fs.writeFileSync(subtitlePath, 'SRT sidecar test fixture');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const template = 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -c:v copy -c:a copy -f matroska <output>';
  const profile = {
    subtitles: 'soft', subtitlePath, subtitleLanguage: 'nld', container: 'matroska',
    ffmpegTemplate: template, ffmpegTemplateId: 'tpl1', ffmpegTemplateName: 'mkv',
  };
  const args = buildFfmpegTemplateArgs({
    template, source: { url: 'https://cdn/movie.mp4', kind: 'file' }, profile, mode: 'live',
    output: { container: 'matroska', target: 'pipe:1' },
  });
  // The sidecar is a second input right behind the source, and its map row goes
  // behind the template's own maps (the template maps no subtitles here, so the
  // sidecar is the only subtitle track — stream 0 either way).
  const inputIndex = args.indexOf('-i');
  assert.equal(args[inputIndex + 1], 'https://cdn/movie.mp4');
  assert.equal(args[inputIndex + 2], '-i');
  assert.equal(args[inputIndex + 3], subtitlePath);
  const maps = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === '-map') maps.push(args[i + 1]);
  assert.deepEqual(maps, ['0:v:0', '0:a:0?', '1:s:0?'], 'the sidecar map follows the template’s maps');
  assert.ok(args.includes('-c:s:0'), 'the sidecar is encoded (text) instead of copied');
  assert.equal(args[args.indexOf('-c:s:0') + 1], 'srt');
  assert.equal(args[args.indexOf('-disposition:s') + 1], '-default', 'the default flag is cleared on every subtitle stream first');
  assert.equal(args[args.indexOf('-disposition:s:0') + 1], 'default', 'then the sidecar is the default track');
  assert.equal(args[args.indexOf('-metadata:s:s:0') + 1], 'language=nld');
  // The progress flags and the output target still come last.
  assert.deepEqual(args.slice(-4), ['-progress', 'pipe:2', '-nostats', 'pipe:1']);
  assert.deepEqual(subtitleSessionNotes(profile, 'matroska', args), [], 'nothing to warn about');
});

test('a copy-all Matroska template puts the attached SRT after source subtitles and selects it as default', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-template-copy-all-subs-test-'));
  const subtitlePath = path.join(dir, 'attached Dutch.srt');
  fs.writeFileSync(subtitlePath, 'SRT sidecar test fixture');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const probeSubtitles = [
    { codec: 'subrip', language: 'eng' },
    { codec: 'mov_text', language: 'eng' },
  ];
  const template = 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -map 0:s? -dn -c:v copy -c:a copy -c:s copy -f matroska <output>';
  const profile = {
    subtitles: 'soft', subtitlePath, subtitleLanguage: 'nld', container: 'matroska',
    ffmpegTemplate: template,
  };
  const args = buildFfmpegTemplateArgs({
    template,
    source: { url: 'https://cdn/movie.mkv', kind: 'file', subtitles: probeSubtitles },
    profile,
    mode: 'live',
    output: { container: 'matroska', target: 'pipe:1' },
  });
  const maps = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === '-map') maps.push(args[i + 1]);
  assert.deepEqual(maps, ['0:v:0', '0:a:0?', '0:s?', '1:s:0?'], 'source tracks stay in their order; the attached SRT is last');
  assert.equal(args[args.indexOf('-c:s') + 1], 'copy', 'the template keeps its copy-all codec');
  assert.ok(!args.includes('-c:s:0'), 'the copyable source SRT track remains a stream copy');
  assert.equal(args[args.indexOf('-c:s:1') + 1], 'srt', 'the uncopyable source mov_text track is converted at index 1');
  assert.ok(!args.includes('-c:s:2'), 'the template’s generic copy applies to the SRT sidecar at index 2');
  assert.equal(args[args.indexOf('-disposition:s') + 1], '-default', 'clear default flags copied from source subtitles');
  assert.equal(args[args.indexOf('-disposition:s:2') + 1], 'default', 'the attached subtitle is the sole default');
  assert.equal(args[args.indexOf('-metadata:s:s:2') + 1], 'language=nld');
  assert.deepEqual(subtitleSessionNotes(profile, 'matroska', args), [], 'the template kept the attached subtitle');
});

test('a template without -map rows keeps video and audio when the sidecar is muxed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-template-nomap-test-'));
  const subtitlePath = path.join(dir, 'movie.nl.srt');
  fs.writeFileSync(subtitlePath, 'SRT sidecar test fixture');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Hand-written templates (and every template saved before the structured
  // editor existed) frequently have no -map at all and rely on ffmpeg's
  // automatic stream selection. Adding a map for the sidecar alone turns that
  // selection off, so the command used to deliver a subtitle-only Matroska:
  // no picture, no sound. The sidecar must bring the main streams with it.
  const template = 'ffmpeg -i <url> -c copy -f matroska <output>';
  const profile = { subtitles: 'soft', subtitlePath, subtitleLanguage: 'nld', container: 'matroska', ffmpegTemplate: template };
  const args = buildFfmpegTemplateArgs({
    template, source: { url: 'https://cdn/movie.mp4', kind: 'file' }, profile, mode: 'live',
    output: { container: 'matroska', target: 'pipe:1' },
  });

  const maps = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === '-map') maps.push(args[i + 1]);
  assert.deepEqual(maps, ['0:v:0', '0:a:0?', '1:s:0?'], 'the source keeps its video and audio next to the sidecar');
  const inputIndex = args.indexOf('-i');
  assert.equal(args[inputIndex + 2], '-i');
  assert.equal(args[inputIndex + 3], subtitlePath, 'the sidecar is still the second input');
  assert.equal(args[args.indexOf('-c:s:0') + 1], 'srt');
  assert.equal(args[args.indexOf('-disposition:s:0') + 1], 'default');
  assert.equal(args[args.indexOf('-metadata:s:s:0') + 1], 'language=nld');
  assert.deepEqual(subtitleSessionNotes(profile, 'matroska', args), [], 'the subtitle really is in the output');
});

test('a text sidecar is never encoded to the template’s bitmap subtitle codec', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-template-dvbsub-test-'));
  const subtitlePath = path.join(dir, 'movie.nl.srt');
  fs.writeFileSync(subtitlePath, 'SRT sidecar test fixture');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // -c:s dvbsub + a text .srt = ffmpeg refuses the whole command ("text to
  // bitmap"). The sidecar therefore keeps a text codec for subtitle stream 0.
  const template = 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -c:v copy -c:a copy -c:s dvbsub -f matroska <output>';
  const args = buildFfmpegTemplateArgs({
    template, source: { url: 'https://cdn/movie.mp4', kind: 'file' },
    profile: { subtitles: 'soft', subtitlePath, subtitleLanguage: 'nld' },
    mode: 'live', output: { container: 'matroska', target: 'pipe:1' },
  });
  assert.equal(args[args.indexOf('-c:s') + 1], 'dvbsub', 'the template’s own setting is untouched');
  assert.equal(args[args.indexOf('-c:s:0') + 1], 'srt', 'the text sidecar is written as text');

  // A template that already names a text codec wins — no duplicate flag.
  const textTemplate = 'ffmpeg -i <url> -map 0:v:0 -c:v copy -c:s copy -f matroska <output>';
  const textArgs = buildFfmpegTemplateArgs({
    template: textTemplate, source: { url: 'https://cdn/movie.mp4', kind: 'file' },
    profile: { subtitles: 'soft', subtitlePath, subtitleLanguage: 'nld' },
    mode: 'live', output: { container: 'matroska', target: 'pipe:1' },
  });
  assert.ok(!textArgs.includes('-c:s:0'), 'copy/srt/ass are fine for a text track');
});

test('a template that drops subtitles is left alone — and says so', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-template-sn-test-'));
  const subtitlePath = path.join(dir, 'movie.nl.srt');
  fs.writeFileSync(subtitlePath, 'SRT sidecar test fixture');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const template = 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -sn -c:v copy -c:a copy -f matroska <output>';
  const profile = { subtitles: 'soft', subtitlePath, subtitleLanguage: 'nld', container: 'matroska', ffmpegTemplate: template };
  const args = buildFfmpegTemplateArgs({
    template, source: { url: 'https://cdn/movie.mp4' }, profile, mode: 'live',
    output: { container: 'matroska', target: 'pipe:1' },
  });
  assert.ok(!args.includes(subtitlePath), 'the operator asked for -sn, so no subtitle input');
  const notes = subtitleSessionNotes(profile, 'matroska', args);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /an FFmpeg template drops it/);
});

test('a sidecar is not injected into a template that already maps a second input', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-template-map1-test-'));
  const subtitlePath = path.join(dir, 'movie.nl.srt');
  fs.writeFileSync(subtitlePath, 'SRT sidecar test fixture');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const template = 'ffmpeg -i <url> -i /downloads/fixed.srt -map 0:v:0 -map 1:s:0? -c:v copy -f matroska <output>';
  const args = buildFfmpegTemplateArgs({
    template, source: { url: 'https://cdn/movie.mp4' }, profile: { subtitles: 'soft', subtitlePath },
    mode: 'live', output: { container: 'matroska', target: 'pipe:1' },
  });
  assert.ok(!args.includes(subtitlePath), 'the template owns its inputs — do not shift its stream indices');

  // `-map 1` (a whole second input) counts as owning it too, with or without
  // the stream specifier.
  for (const map of ['-map 1', '-map 1:a:0?', '-map 1,0']) {
    const owns = `ffmpeg -i <url> -i /downloads/fixed.srt ${map} -c:v copy -f matroska <output>`;
    const owned = buildFfmpegTemplateArgs({
      template: owns, source: { url: 'https://cdn/movie.mp4' }, profile: { subtitles: 'soft', subtitlePath },
      mode: 'live', output: { container: 'matroska', target: 'pipe:1' },
    });
    assert.ok(!owned.includes(subtitlePath), `${map} owns input 1`);
  }
});

test('live playback is paced at 1x so a real-time client is never flooded', () => {
  const profile = normaliseProfile({ mode: 'copy', container: 'mpegts' }, PROBE_1080P_H264);
  const proxied = { url: 'http://127.0.0.1:8080/up/secret/f', kind: 'file' };

  const live = buildFfmpegArgs({
    source: proxied, profile, hw: HW, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });
  assert.ok(live.includes('-re'), 'live sessions read their input at the native rate');
  assert.ok(live.indexOf('-re') < live.indexOf('-i'), '-re is an input option and must precede -i');

  const download = buildFfmpegArgs({
    source: { url: 'https://cdn.example.com/movie.mp4', kind: 'file' },
    profile, hw: HW, mode: 'file', output: { container: 'matroska', target: '/downloads/movie.mkv' },
  });
  assert.ok(!download.includes('-re'), 'downloads and template tests stay as fast as the source allows');

  const unpaced = buildFfmpegArgs({
    source: proxied, profile: { ...profile, realtime: false }, hw: HW, mode: 'live',
    output: { container: 'mpegts', target: 'pipe:1' },
  });
  assert.ok(!unpaced.includes('-re'), 'a per-stream override can restore full-speed streaming');
});

test('live templates are paced too (the Enigma2 receiver path is a template)', () => {
  const template = 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -c:v copy -c:a copy -f matroska -live 1 pipe:1';
  const args = buildFfmpegArgs({
    source: { url: 'http://127.0.0.1:8080/up/secret/f', kind: 'file' },
    profile: normaliseProfile({ container: 'matroska', ffmpegTemplate: template }, PROBE_1080P_H264),
    hw: HW, mode: 'live', output: { container: 'matroska', target: 'pipe:1' },
  });
  assert.ok(args.includes('-re'), 'the relay injects -re into a template that has no pacing of its own');
  assert.ok(args.indexOf('-re') < args.indexOf('-i'));
  assert.ok(args.includes('-progress'));

  // A template that spells out its own pacing must not get a second flag.
  const explicit = buildFfmpegArgs({
    source: { url: 'http://127.0.0.1:8080/up/secret/f', kind: 'file' },
    profile: normaliseProfile({ container: 'matroska', ffmpegTemplate: 'ffmpeg -readrate 1 -i <url> -c:v copy -f matroska pipe:1' }, PROBE_1080P_H264),
    hw: HW, mode: 'live', output: { container: 'matroska', target: 'pipe:1' },
  });
  assert.ok(!explicit.includes('-re'), '-readrate wins over the automatic pacing');

  // …and a file download through a template stays unpaced.
  const download = buildFfmpegArgs({
    source: { url: 'https://cdn.example.com/movie.mp4', kind: 'file' },
    profile: normaliseProfile({ container: 'matroska', ffmpegTemplate: template }, PROBE_1080P_H264),
    hw: HW, mode: 'file', output: { container: 'matroska', target: '/downloads/movie.mkv' },
  });
  assert.ok(!download.includes('-re'));
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

test('audioOnlyReason flags a probed rendition that has sound but no picture', () => {
  // The Kraken/Tenzing failure: a DASH→HLS bridge exposes the audio
  // AdaptationSet as its only HLS variant, ffprobe succeeds with
  // video:none/audio:1, and the guided builder then dies on `-map 0:v:0`.
  const audioOnly = {
    container: 'hls',
    durationSec: 6000,
    video: null,
    audio: [{ codec: 'aac', channels: 2 }],
    subtitles: [],
  };
  assert.match(audioOnlyReason(audioOnly), /no video stream/);
  // Subtitles alone prove the input is media without video too.
  assert.match(audioOnlyReason({ video: null, audio: [], subtitles: [{ codec: 'subrip' }] }), /no video stream/);
  // A normal movie probe, a missing probe and an ambiguous empty probe all
  // pass: only a *positive* audio-only finding may reject a candidate.
  assert.equal(audioOnlyReason({ video: { codec: 'hevc' }, audio: [], subtitles: [] }), null);
  assert.equal(audioOnlyReason(null), null);
  assert.equal(audioOnlyReason({ video: null, audio: [], subtitles: [] }), null);
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

test('FFmpeg templates validate placeholders and refuse shell commands', () => {
  const pipe = 'ffmpeg -i <url> -map 0:v:0 -c:v copy -c:a copy -f mpegts pipe:1';
  assert.deepEqual(validateFfmpegTemplate(pipe, { container: 'mpegts' }), {
    ok: true, errors: [], container: 'mpegts',
  });
  assert.equal(validateFfmpegTemplate(pipe, { container: 'matroska' }).ok, false);
  assert.equal(validateFfmpegTemplate('ffmpeg -i https://example.test/movie.mp4 -f mpegts pipe:1').ok, false);
  assert.equal(validateFfmpegTemplate('ffmpeg -i <url> -f hls pipe:1', { container: 'hls' }).ok, false);
  assert.equal(validateFfmpegTemplate('sh -c "echo bad"').ok, false, 'templates cannot change the executable');
  assert.deepEqual(parseFfmpegTemplateTokens(`ffmpeg -metadata "title=Director's cut; echo"`), [
    'ffmpeg', '-metadata', "title=Director's cut; echo",
  ]);
});

test('outputFormatOf reports the muxer the argv really writes', () => {
  assert.equal(outputFormatOf(['-i', 'https://x/y.mp4', '-f', 'matroska', '-live', '1', 'pipe:1']), 'matroska');
  assert.equal(outputFormatOf(['-f', 'hls', '-hls_time', '2', '-f', 'mpegts', 'pipe:1']), 'mpegts', 'the last -f wins');
  assert.equal(outputFormatOf(['-i', 'https://x/y.mp4', 'pipe:1']), null, 'no -f → ffmpeg picks by target');
  assert.equal(outputFormatOf([]), null);
});

test('custom live templates preserve the signed URL and merge source auth headers', () => {
  const url = 'https://cdn.example.com/movie.mp4?sig=a1b2&expires=1791117426';
  const template = [
    'ffmpeg -headers "User-Agent: Template UA',
    'X-Template: yes" -i <url> -map 0:v:0 -vf "drawtext=text=\'Director & Daughter\'" -c:v libx264 -f mpegts pipe:1',
  ].join('\r\n');
  const profile = normaliseProfile({ container: 'mpegts', ffmpegTemplate: template }, PROBE_1080P_H264);
  const args = buildFfmpegArgs({
    source: { url, headers: { Referer: 'https://player.example/watch', Cookie: 'sid=secret', 'User-Agent': 'Source UA' }, kind: 'file' },
    profile, hw: HW, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' },
  });
  assert.equal(args[args.indexOf('-i') + 1], url, 'query ampersands stay in one argv value');
  const headers = args[args.indexOf('-headers') + 1];
  assert.match(headers, /Referer: https:\/\/player\.example\/watch/);
  assert.match(headers, /Cookie: sid=secret/);
  assert.match(headers, /User-Agent: Template UA/);
  assert.match(headers, /X-Template: yes/);
  assert.equal(args[args.indexOf('-vf') + 1], "drawtext=text='Director & Daughter'");
  assert.ok(args.includes('-progress') && args.includes('pipe:2'));
  assert.equal(args.at(-1), 'pipe:1');
  assert.equal(args.filter((arg) => arg === '-headers').length, 1);
  assert.ok(!args.includes('-user_agent'), 'the explicit template User-Agent is respected');
});

test('custom HLS templates receive the relay playlist output path', () => {
  const template = 'ffmpeg -i {{url}} -map 0:v:0 -c:v copy -f hls -hls_time 2 {{output}}';
  const args = buildFfmpegArgs({
    source: { url: 'https://cdn.example.com/master.m3u8', headers: {}, kind: 'hls' },
    profile: normaliseProfile({ container: 'hls', ffmpegTemplate: template }, PROBE_1080P_H264),
    hw: HW, mode: 'live', output: { container: 'hls', target: '/tmp/hls/abc/index.m3u8' },
  });
  assert.equal(args[args.indexOf('-i') + 1], 'https://cdn.example.com/master.m3u8');
  assert.equal(args.at(-1), '/tmp/hls/abc/index.m3u8');
  assert.equal(args[args.indexOf('-f') + 1], 'hls');
});

test('custom template is only used for live output, not a file download', () => {
  const profile = normaliseProfile({ mode: 'copy', container: 'mpegts', ffmpegTemplate: 'ffmpeg -i <url> -c:v copy -f mpegts pipe:1' }, PROBE_1080P_H264);
  const args = buildFfmpegArgs({
    source: { url: 'https://cdn.example.com/movie.mp4', headers: {}, kind: 'file' },
    profile, hw: HW, mode: 'file', output: { container: 'mpegts', target: '/downloads/movie.ts' },
  });
  assert.equal(args.at(-1), '/downloads/movie.ts');
});

test('argsToCommand is copy-pasteable, including signed URLs and multiline headers', () => {
  const cmd = argsToCommand(['-i', 'https://x/y.m3u8', '-vf', 'scale_vaapi=w=1280:h=720', '-f', 'mpegts', 'pipe:1']);
  assert.equal(cmd, 'ffmpeg -i https://x/y.m3u8 -vf scale_vaapi=w=1280:h=720 -f mpegts pipe:1');
  const quoted = argsToCommand(['-vf', 'subtitles=filename=/downloads/my movie.srt']);
  assert.ok(quoted.includes("'subtitles=filename=/downloads/my movie.srt'"), quoted);

  const signedUrl = 'https://cdn.example.com/movie.mp4?sign=abc123&t=1791117426';
  const headers = 'Referer: https://moviebox.example/play/title\r\nUser-Agent: Test Agent';
  const signed = argsToCommand(['-headers', headers, '-i', signedUrl, '-map', '0:v:0']);
  assert.equal(signed, `ffmpeg -headers '${headers}' -i '${signedUrl}' -map 0:v:0`);
  assert.ok(!signed.includes('&t=1791117426 -map'), 'the query ampersand is inside shell quotes');

  const apostrophe = argsToCommand(['-metadata', "title=Director's cut $HOME; echo"]);
  assert.equal(apostrophe, "ffmpeg -metadata 'title=Director'\\''s cut $HOME; echo'");
  assert.equal(argsToCommand(['~/movie.mp4']), "ffmpeg '~/movie.mp4'");
});

test('argsToCommand round-trips shell-sensitive values through POSIX sh', () => {
  const args = [
    '-headers', 'Referer: https://moviebox.example/play/title\r\nUser-Agent: Test Agent',
    '-i', 'https://cdn.example.com/movie.mp4?sign=abc123&t=1791117426',
    '-metadata', "title=Director's cut $HOME; echo", '~/movie.mp4', '-map', '0:v:0',
  ];
  const command = argsToCommand(args);
  const result = spawnSync('/bin/sh', ['-c', `set -- ${command}; printf '%s\\0' "$@"`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\0').slice(0, -1), ['ffmpeg', ...args]);
});

test('an fMP4 init segment and a disguised HLS playlist are recognised by name', () => {
  // The 1080p "movie" that played as 1.4 KB was an init segment.
  assert.equal(isInitSegmentUrl('https://n.example/hls/x/1080p/init.mp4'), true);
  assert.equal(isInitSegmentUrl('https://n.example/hls/x/720p/init_720.m4s?t=1'), true);
  assert.equal(isInitSegmentUrl('https://n.example/hls/x/1080p/seg00001.mp4'), false);
  assert.equal(isInitSegmentUrl('https://n.example/movie.mp4'), false);

  // The real 1080p movie was an HLS playlist named .jpg.
  assert.equal(isDisguisedManifestUrl('https://n.example/hls/x/1080p/playlist.jpg'), true);
  assert.equal(isDisguisedManifestUrl('https://n.example/hls/x/1080p/playlist.jpg?sig=1'), true);
  assert.equal(isDisguisedManifestUrl('https://n.example/hls/x/master.m3u8'), false);
  assert.equal(isDisguisedManifestUrl('https://n.example/poster.jpg'), false);
  assert.equal(streamKind('https://n.example/hls/x/1080p/playlist.jpg'), 'hls');
  assert.equal(streamKind('https://n.example/poster.jpg'), 'file');
});

const FF_519 = 'ffmpeg version 5.1.9-0+deb12u1 Copyright (c) 2000-2024 the FFmpeg developers';
const FF_702 = 'ffmpeg version 7.0.2-static https://johnvansickle.com/ffmpeg/  Copyright (c) 2000-2024';

test('the HLS extension_picky enforcement exists only on the ffmpeg 5.1.x line', () => {
  // Verified against the n4.4/n5.0/n5.1.9/n6.1.2/n7.0.2 hls.c option tables:
  // extension_picky + allowed_segment_extensions shipped only in 5.1.x and
  // were removed in 6.0; an unknown option makes ffmpeg exit before -i opens
  // (reproduced with 4.2.2 and 7.0.2 binaries: "Unrecognized option
  // 'extension_picky'").
  for (const banner of [
    'ffmpeg version 5.1 Copyright (c) 2000-2022 the FFmpeg developers',
    'ffmpeg version 5.1.2-static https://johnvansickle.com/ffmpeg/',
    FF_519,
  ]) {
    assert.deepEqual(parseFfmpegVersion(banner).major, 5);
    assert.equal(ffmpegSupportsHlsExtensionPicky(banner), true, banner);
  }
  for (const banner of [
    'ffmpeg version 4.2.2-static https://johnvansickle.com/ffmpeg/',
    'ffmpeg version 4.4.3-0+deb11u1 Copyright (c) 2000-2021',
    'ffmpeg version 5.0.1-0ubuntu1 Copyright (c) 2000-2022',
    'ffmpeg version 6.0 Copyright (c) 2000-2023 the FFmpeg developers',
    'ffmpeg version 6.1.2-1~deb13u1 Copyright (c) 2000-2024',
    FF_702,
    'ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers',
  ]) {
    assert.equal(ffmpegSupportsHlsExtensionPicky(banner), false, banner);
  }
  // Unparseable banners (nightly N-builds, missing binary) fail closed: the
  // option must not be sent where its existence cannot be established.
  for (const banner of [null, '', 'ffmpeg version N-118371-g8c2c7f1ac0', 'garbage']) {
    assert.equal(ffmpegSupportsHlsExtensionPicky(banner), false, JSON.stringify(banner));
  }
});

test('hlsExtensionPickyArgs switches off 5.1 extension checks for every HLS URL shape', () => {
  const hlsUrls = [
    // Disguised manifest (the original .jpg case).
    'https://n.example/hls/x/1080p/playlist.jpg',
    // Ordinary HLS.
    'https://n.example/x/master.m3u8',
    // DASH→HLS bridge: the worker path is extensionless, the .m3u8 is nested.
    'https://bridge.example.workers.dev/?url=' + encodeURIComponent('https://cdn/v3.m3u8?Policy=eyJ'),
    // The production failure: the relay's extensionless loopback proxy route,
    // whose rewritten objects are /up/<secret>/hls/u/<id> without extensions.
    'http://127.0.0.1:8080/up/9f3a2b1c/h',
    'http://127.0.0.1:8080/up/9f3a2b1c/h?fresh=1',
  ];
  for (const url of hlsUrls) {
    // -extension_picky 0 is the master switch at the top of test_segment():
    // it disarms BOTH the allowed_segment_extensions check and the
    // probed-format extension cross-check that ALL alone could not pass.
    assert.deepEqual(hlsExtensionPickyArgs(url, FF_519), ['-extension_picky', '0'], url);
    assert.deepEqual(hlsExtensionPickyArgs(url, FF_702), [], `7.0.2 has no such option: ${url}`);
    assert.deepEqual(hlsExtensionPickyArgs(url), [], `no cached banner fails closed: ${url}`);
  }
  // Non-HLS inputs never get the option, even on a build that supports it.
  for (const url of ['https://n.example/movie.mp4', 'https://n.example/manifest.mpd']) {
    assert.deepEqual(hlsExtensionPickyArgs(url, FF_519), [], url);
  }
});

test('ffprobe and both ffmpeg builders use -extension_picky 0 only for HLS on 5.1.x', () => {
  const loopback = 'http://127.0.0.1:8080/up/9f3a2b1c/h';
  const disguised = 'https://n.example/hls/x/1080p/playlist.jpg';

  // ffprobe: present on 5.1.x, before the URL which stays last.
  const probeArgs = buildFfprobeArgs(loopback, { ffmpegVersion: FF_519 });
  const at = probeArgs.indexOf('-extension_picky');
  assert.ok(at > 0 && probeArgs[at + 1] === '0' && at < probeArgs.length - 1);
  assert.equal(probeArgs.at(-1), loopback);
  assert.equal(buildFfprobeArgs(loopback, { ffmpegVersion: FF_702 }).includes('-extension_picky'), false);
  assert.equal(buildFfprobeArgs('https://n.example/movie.mp4', { ffmpegVersion: FF_519 })
    .includes('-extension_picky'), false);

  const profile = normaliseProfile({ mode: 'copy', container: 'mpegts' }, PROBE_1080P_H264);
  const base = { profile, hw: HW, mode: 'live', output: { container: 'mpegts', target: 'pipe:1' } };

  // Guided builder, proxied HLS (extensionless loopback URL, kind still hls).
  const guided51 = buildFfmpegArgs({ ...base, source: { url: loopback, kind: 'hls' }, ffmpegVersion: FF_519 });
  const gAt = guided51.indexOf('-extension_picky');
  assert.ok(gAt > 0 && guided51[gAt + 1] === '0' && gAt < guided51.indexOf('-i'));
  const guided70 = buildFfmpegArgs({ ...base, source: { url: loopback, kind: 'hls' }, ffmpegVersion: FF_702 });
  assert.equal(guided70.includes('-extension_picky'), false, '7.0.2 would call it an Unrecognized option');
  // No version supplied (binary probe never ran): fail closed rather than risk
  // a fatal unknown option on 6.x/7.x.
  const guidedUnknown = buildFfmpegArgs({ ...base, source: { url: loopback, kind: 'hls' } });
  assert.equal(guidedUnknown.includes('-extension_picky'), false);
  // A progressive file never goes near the HLS demuxer option.
  const fileArgs = buildFfmpegArgs({ ...base, source: { url: 'https://n.example/movie.mp4', kind: 'file' }, ffmpegVersion: FF_519 });
  assert.equal(fileArgs.includes('-extension_picky'), false);

  // Template builder, disguised manifest.
  const tplArgs = buildFfmpegTemplateArgs({
    template: 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -c:v copy -c:a copy -f matroska pipe:1',
    source: { url: disguised, kind: 'hls' },
    profile: { container: 'matroska' },
    mode: 'live',
    output: { container: 'matroska', target: 'pipe:1' },
    ffmpegVersion: FF_519,
  });
  const tplAt = tplArgs.indexOf('-extension_picky');
  assert.ok(tplAt > 0 && tplArgs[tplAt + 1] === '0' && tplAt < tplArgs.indexOf('-i'));
  const tpl70 = buildFfmpegTemplateArgs({
    template: 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -c:v copy -c:a copy -f matroska pipe:1',
    source: { url: disguised, kind: 'hls' },
    profile: { container: 'matroska' },
    mode: 'live',
    output: { container: 'matroska', target: 'pipe:1' },
    ffmpegVersion: FF_702,
  });
  assert.equal(tpl70.includes('-extension_picky'), false);

  // Template routed through the guided builder's ffmpegTemplate branch keeps
  // the version decision consistent.
  const viaTemplate = buildFfmpegArgs({
    ...base,
    profile: normaliseProfile({ mode: 'copy', container: 'mpegts', ffmpegTemplate: 'ffmpeg -i <url> -c copy -f mpegts pipe:1' }, PROBE_1080P_H264),
    source: { url: loopback, kind: 'hls' },
    ffmpegVersion: FF_519,
  });
  const vAt = viaTemplate.indexOf('-extension_picky');
  assert.ok(vAt > 0 && viaTemplate[vAt + 1] === '0' && vAt < viaTemplate.indexOf('-i'));

  // The 5.1-only -allowed_segment_extensions ALL from the first attempt is no
  // longer emitted anywhere: extension_picky 0 disarms that check too, and
  // sending both would leave a redundant flag in the rendered command.
  for (const args of [guided51, tplArgs, viaTemplate, probeArgs]) {
    assert.equal(args.includes('-allowed_segment_extensions'), false);
  }
});

test('a VOD HLS media playlist gives its length; a live window does not', () => {
  const vod = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg0.jpg\n#EXTINF:4.5,\nseg1.jpg\n#EXT-X-ENDLIST\n';
  assert.equal(parseHlsMediaDuration(vod), 14.5);
  assert.equal(parseHlsMediaDuration('#EXTM3U\n#EXTINF:10,\nseg0.ts\n'), null, 'no ENDLIST: still live, no length');
  assert.equal(parseHlsMediaDuration('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n#EXT-X-ENDLIST\n'), null, 'a master has no segments');
  assert.equal(parseHlsMediaDuration(''), null);
});

test('ISO-8601 durations and static DASH MPDs give their length', () => {
  assert.equal(parseIsoDuration('PT1H30M15.5S'), 5415.5);
  assert.equal(parseIsoDuration('P1DT2H'), 93600);
  assert.equal(parseIsoDuration('PT'), null);
  assert.equal(parseIsoDuration('soon'), null);
  assert.equal(parseDashMediaDuration('<MPD type="static" mediaPresentationDuration="PT2H0M0S"></MPD>'), 7200);
  assert.equal(parseDashMediaDuration('<MPD type="dynamic" mediaPresentationDuration="PT2H"></MPD>'), null, 'live MPD');
  assert.equal(parseDashMediaDuration('<MPD></MPD>'), null);
});

