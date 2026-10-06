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
  targetDimensions, parseProgressLine, argsToCommand, streamKind, headerArgs, headerObject, parseFps,
  parseFfmpegTemplateTokens, validateFfmpegTemplate, outputFormatOf, subtitleSessionNotes,
  buildFfmpegTemplateArgs,
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

test('a Matroska soft mux maps the sidecar first and marks it as the default track', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-sidecar-test-'));
  const subtitlePath = path.join(dir, 'selected subtitle.nl.srt');
  fs.writeFileSync(subtitlePath, 'SRT sidecar test fixture');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

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
  // The sidecar is mapped *before* the source's own subtitle tracks, so it is
  // always subtitle stream 0 — the disposition/metadata below rely on it.
  const maps = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === '-map') maps.push(args[i + 1]);
  assert.deepEqual(maps, ['0:v:0', '0:a:0?', '1:s:0?', '0:s?'], 'sidecar before the source tracks');
  assert.ok(args.includes('-disposition:s:0'), 'the track is flagged default for exteplayer3/Enigma2');
  assert.equal(args[args.indexOf('-disposition:s:0') + 1], 'default');
  assert.equal(args[args.indexOf('-metadata:s:s:0') + 1], 'language=nld');
  assert.equal(args[args.indexOf('-c:s') + 1], 'copy', 'source tracks are copied, never re-encoded');
  assert.equal(args[args.indexOf('-c:s:0') + 1], 'srt');
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
  assert.equal(mkv[mkv.indexOf('-c:s') + 1], 'srt');
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
  // The sidecar is a second input right behind the source, and it is mapped
  // *before* the template's own maps so it is subtitle stream 0.
  const inputIndex = args.indexOf('-i');
  assert.equal(args[inputIndex + 1], 'https://cdn/movie.mp4');
  assert.equal(args[inputIndex + 2], '-i');
  assert.equal(args[inputIndex + 3], subtitlePath);
  assert.equal(args[inputIndex + 4], '-map');
  assert.equal(args[inputIndex + 5], '1:s:0?');
  assert.ok(args.includes('-c:s:0'), 'the sidecar is encoded (text) instead of copied');
  assert.equal(args[args.indexOf('-c:s:0') + 1], 'srt');
  assert.equal(args[args.indexOf('-disposition:s:0') + 1], 'default');
  assert.equal(args[args.indexOf('-metadata:s:s:0') + 1], 'language=nld');
  // The progress flags and the output target still come last.
  assert.deepEqual(args.slice(-4), ['-progress', 'pipe:2', '-nostats', 'pipe:1']);
  assert.deepEqual(subtitleSessionNotes(profile, 'matroska', args), [], 'nothing to warn about');
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
