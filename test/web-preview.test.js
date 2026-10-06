/**
 * Unit tests for the web preview's codec/subtitle decisions.
 *
 * The web preview is the one output whose shape is decided by the *client*, not
 * by the operator: the browser reports what it can decode and the relay has to
 * answer with a subtitle-free MPEG-TS session. These tests pin the three rules
 * that make that work — subtitles always dropped, the operator's template never
 * used, copy only what the browser said it can play — and then run the result
 * through the real guided profile builder so a future change to media.js cannot
 * silently reintroduce a `-c:s` or a sidecar `-map 1:s`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCodecList, videoFamily, audioFamily, supportsFamily,
  decideWebProfile, describeWebDecisions, WEB_REMUX_VIDEO,
} from '../src/streams/web-preview.js';
import { normaliseProfile, buildFfmpegArgs } from '../src/core/media.js';
import { outputTypeForPath, urlsFor } from '../src/streams/store.js';

const HW = { available: true, device: '/dev/dri/renderD128', fpsVariant: 1 };

const PROBE_H264_AAC = {
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSec: 7200,
  video: { codec: 'h264', width: 1920, height: 1080, fps: 23.976 },
  audio: [{ codec: 'aac', channels: 2, language: 'eng' }],
  subtitles: [],
};

const PROBE_HEVC_AC3 = {
  container: 'matroska,webm',
  durationSec: 8400,
  video: { codec: 'hevc', width: 3840, height: 2160, fps: 23.976 },
  audio: [{ codec: 'eac3', channels: 6, language: 'eng' }],
  subtitles: [{ codec: 'subrip', language: 'nld' }],
};

const buildArgs = (profile, probe) => buildFfmpegArgs({
  source: {
    url: 'https://cdn.example.com/x.mkv',
    kind: 'file',
    container: probe.container,
    subtitles: probe.subtitles,
  },
  profile: normaliseProfile(profile, probe),
  hw: HW,
  mode: 'live',
  output: { container: 'mpegts', target: 'pipe:1' },
});

test('codec families map ffprobe names and browser families to one vocabulary', () => {
  assert.equal(videoFamily('h264'), 'avc1');
  assert.equal(videoFamily('AVC1'), 'avc1');
  assert.equal(videoFamily('hevc'), 'hvc1');
  assert.equal(videoFamily('h265'), 'hvc1');
  assert.equal(audioFamily('aac'), 'mp4a');
  assert.equal(audioFamily('ac3'), 'ac-3');
  assert.equal(audioFamily('eac3'), 'ec-3');
  assert.deepEqual([...parseCodecList('avc1, hvc1 ,')], ['avc1', 'hvc1']);
  assert.deepEqual([...parseCodecList(['AVC1'])], ['avc1']);
  assert.equal(supportsFamily(new Set(['avc1']), 'h264'), true);
  assert.equal(supportsFamily(new Set(['avc1']), 'hevc'), false);
  assert.equal(supportsFamily(new Set(['mp4a']), 'aac'), true);
  assert.equal(supportsFamily(new Set(), ''), false);
  assert.equal(WEB_REMUX_VIDEO, 'avc1');
});

test('a browser that plays H.264/AAC gets a subtitle-free remux', () => {
  const { profile, decisions } = decideWebProfile({
    probe: PROBE_H264_AAC,
    videoCodecs: ['avc1', 'hvc1'],
    audioCodecs: ['mp4a', 'ac-3'],
  });

  assert.equal(decisions.copy, true);
  assert.equal(decisions.video.action, 'copy');
  assert.equal(decisions.audio.action, 'copy');
  assert.equal(decisions.subtitles, 'dropped');
  assert.equal(profile.mode, 'copy');
  assert.equal(profile.container, 'mpegts');
  assert.equal(profile.subtitles, 'none', 'the web player never muxes a subtitle');

  const args = buildArgs(profile, PROBE_H264_AAC);
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
  assert.ok(args.includes('-sn'), 'subtitles are dropped, not muxed');
  assert.ok(args.includes('-dn'), 'data streams are dropped too');
  assert.ok(!args.includes('-c:s'), 'no subtitle codec is requested');
  assert.ok(!args.some((a) => /^1:s/.test(a)), 'the attached sidecar is never mapped');
  assert.ok(!args.join(' ').includes('-map 0:s'), 'source subtitle tracks are never mapped');
});

test('HEVC is transcoded even when the browser reports hvc1 support', () => {
  const { profile, decisions } = decideWebProfile({
    probe: PROBE_HEVC_AC3,
    videoCodecs: ['avc1', 'hvc1'],
    audioCodecs: ['ec-3'],
  });

  assert.equal(decisions.copy, false);
  assert.equal(decisions.video.family, 'hvc1');
  assert.equal(decisions.video.remuxSafe, false);
  assert.equal(decisions.video.action, 'transcode');
  assert.equal(decisions.audio.action, 'transcode', 'one transcode switch: audio is re-encoded with the video');
  assert.equal(decisions.audio.target, 'aac');
  assert.ok(decisions.reasons.some((r) => /mpegts\.js only transmuxes H\.264/.test(r)));
  assert.equal(profile.mode, 'auto');
  assert.equal(profile.alwaysTranscode, true);
  assert.equal(profile.audioCodec, 'aac');

  const args = buildArgs(profile, PROBE_HEVC_AC3);
  const codec = args[args.indexOf('-c:v') + 1];
  assert.ok(codec === 'libx264' || codec === 'h264_vaapi', `video is re-encoded to H.264 (got ${codec})`);
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.ok(!args.includes('-c:s'));
  assert.ok(args.includes('-sn'));
});

test('audio the source has but the browser cannot play forces the whole remux to transcode', () => {
  const { profile, decisions } = decideWebProfile({
    probe: PROBE_H264_AAC,
    videoCodecs: ['avc1'],
    audioCodecs: ['mp4a'],
  });
  assert.equal(decisions.copy, true);
  assert.equal(decisions.audio.action, 'copy');

  // An AC-3 source and a browser without AC-3 → AAC. The guided builder has one
  // transcode switch for the whole output, so the video is re-encoded too; that
  // is the documented cost of never handing the player audio it cannot decode.
  const ac3Probe = { ...PROBE_H264_AAC, audio: [{ codec: 'ac3', channels: 6 }] };
  const ac3 = decideWebProfile({ probe: ac3Probe, videoCodecs: ['avc1'], audioCodecs: ['mp4a'] });
  assert.equal(ac3.decisions.video.action, 'transcode');
  assert.equal(ac3.decisions.audio.action, 'transcode');
  assert.equal(ac3.decisions.audio.target, 'aac');
  assert.equal(ac3.profile.mode, 'auto');
  assert.equal(ac3.profile.alwaysTranscode, true);

  const args = buildArgs(ac3.profile, ac3Probe);
  assert.ok(['libx264', 'h264_vaapi'].includes(args[args.indexOf('-c:v') + 1]));
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.ok(args.includes('-sn'));
});

test('a client that reports nothing gets the safe transcode, never a blind remux', () => {
  const { profile, decisions } = decideWebProfile({
    probe: PROBE_H264_AAC,
    reported: false,
  });
  assert.equal(decisions.copy, false);
  assert.equal(decisions.reported, false);
  assert.ok(decisions.reasons.some((r) => /did not report/.test(r)));
  assert.equal(profile.mode, 'auto');
  assert.equal(profile.alwaysTranscode, true);
  assert.equal(profile.subtitles, 'none');

  // No probe at all is the same story: unknown codec → transcode.
  const unknown = decideWebProfile({ probe: null, videoCodecs: ['avc1'], audioCodecs: ['mp4a'] });
  assert.equal(unknown.decisions.copy, false);
  assert.match(unknown.decisions.reasons.join(' '), /no probe result/);
});

test('the web profile overwrites the item template — that is the relay merge order', () => {
  // The relay does `{ ...stream.profile, ...opts.profile, ...decision.profile }`;
  // this is that merge with a stream that carries a receiver template and an
  // attached subtitle.
  const itemProfile = {
    container: 'matroska',
    ffmpegTemplate: 'ffmpeg -i <url> -map 0:v:0 -map 1:s:0? -c:s srt -f matroska pipe:1',
    ffmpegTemplateId: 'tpl-receiver',
    ffmpegTemplateName: 'VU+ with subtitles',
    outputTemplates: { vlcTs: 'tpl-receiver' },
    subtitles: 'soft',
    subtitlePath: '/config/subs/dune.srt',
    mode: 'vaapi',
  };
  const { profile } = decideWebProfile({
    probe: PROBE_H264_AAC, videoCodecs: ['avc1'], audioCodecs: ['mp4a'],
  });
  const merged = { ...itemProfile, ...profile };

  assert.equal(merged.ffmpegTemplate, '', 'the VLC/receiver template must not drive a preview');
  assert.equal(merged.ffmpegTemplateId, '');
  assert.equal(merged.ffmpegTemplateName, '');
  assert.equal(merged.subtitles, 'none');
  assert.equal(merged.subtitlePath, null);
  assert.equal(merged.mode, 'copy', 'the decision overrides the item’s mode');

  // The guided builder then keeps the item's resolution cap/bitrates, which is
  // what an operator expects their stream settings to still mean for the web.
  assert.equal(merged.container, 'mpegts');
});

test('describeWebDecisions renders one actionable line', () => {
  const copy = decideWebProfile({ probe: PROBE_H264_AAC, videoCodecs: ['avc1'], audioCodecs: ['mp4a'] });
  assert.equal(describeWebDecisions(copy.decisions), 'web preview: copy h264 + copy aac, subtitles dropped');

  const transcode = decideWebProfile({ probe: PROBE_HEVC_AC3, videoCodecs: ['avc1'], audioCodecs: ['ec-3'] });
  assert.equal(describeWebDecisions(transcode.decisions),
    'web preview: transcode hevc → h264 + transcode eac3 → aac, subtitles dropped');

  // A stream with no audio at all says so instead of inventing a track.
  const silent = decideWebProfile({ probe: { ...PROBE_H264_AAC, audio: [] }, videoCodecs: ['avc1'] });
  assert.match(describeWebDecisions(silent.decisions), /\+ no audio/);
  assert.equal(describeWebDecisions(null), '');
});

test('the .ts.web URL is its own output type, and urlsFor advertises it', () => {
  assert.equal(outputTypeForPath('/s/tok123/Dune.ts.web'), 'web');
  assert.equal(outputTypeForPath('/s/tok123/web.ts'), 'web');
  assert.equal(outputTypeForPath('/s/tok123/Dune.ts'), 'vlcTs');
  assert.equal(outputTypeForPath('/s/tok123/Dune.ts.enigma2'), 'enigma2');
  assert.equal(outputTypeForPath('/s/tok123/Dune.mkv'), 'vlcMkv');

  const urls = urlsFor({ id: 'abc', token: 'tok123', title: 'Dune', year: 2021, profile: {} }, 'http://nas:8080');
  assert.equal(urls.web, 'http://nas:8080/s/tok123/Dune-2021.ts.web');
  // The `.ts.web` path must never be mistaken for the VLC `.ts` slot: the whole
  // point of the suffix is that a browser cannot end up on the receiver's
  // template (and its subtitles).
  assert.notEqual(outputTypeForPath(new URL(urls.web).pathname), outputTypeForPath(new URL(urls.ts).pathname));
});
