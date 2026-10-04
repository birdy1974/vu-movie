/**
 * Unit tests for the structured FFmpeg template fields.
 *
 * The Transcode-templates tab renders a command from these fields and reads an
 * existing command back into them. Both directions have to agree: a wrong flag
 * means VLC shows nothing and the only clue is one line in the log, so — as for
 * the arg builder in media.js — the renderer and the parser are pure functions
 * and are tested here instead of on the NAS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPLATE_FIELDS, TEMPLATE_OPTION_DEFAULTS, ADVANCED_OPTIONS, VF_PRESETS,
  buildTemplateCommand, parseTemplateCommand, renderTemplate, validateTemplateOptions,
  templateOptionWarnings, activeParameters, normaliseTemplateOptions, targetSize,
  vfSnippet, splitFlagString, joinTemplateTokens, templateOptionsSchema,
} from '../src/core/ffmpeg-options.js';
import { validateFfmpegTemplate, parseFfmpegTemplateTokens } from '../src/core/media.js';

/** The parameter set the sibling project (stalker-proxy-manager) exposes. */
const SPM_PARAMETERS = [
  'hw_accel', 'device', 'resolution', 'aspect', 'video_codec', 'video_bitrate',
  'maxrate', 'bufsize', 'fps', 'gop', 'profile', 'level', 'vf_preset', 'low_power',
  'rc_mode', 'global_quality', 'async_depth', 'audio_codec', 'audio_bitrate',
  'audio_channels', 'audio_rate', 'subs', 'output_format', 'extra_input', 'extra_output',
];

const CASES = {
  'default passthrough (mpegts)': {},
  'vaapi 1080p VBR': {
    video_codec: 'h264_vaapi', hw_accel: 'vaapi', resolution: '1080p', video_bitrate: '8000k',
    maxrate: '12000k', bufsize: '8000k', fps: '25', gop: '50', profile: 'high', level: '4.1',
    rc_mode: 'VBR', async_depth: '4', low_power: true, audio_codec: 'aac', audio_bitrate: '192k',
    audio_channels: '6', audio_rate: '48000',
  },
  'vaapi CQP (quality driven, no bitrate)': {
    video_codec: 'h264_vaapi', hw_accel: 'vaapi', resolution: '900p', rc_mode: 'CQP', global_quality: '26',
  },
  'software x264 with advanced flags': {
    video_codec: 'libx264', hw_accel: 'none', resolution: '720p', video_bitrate: '2500k', subs: 'dvb',
    advanced: [
      { flag: '-preset', value: 'veryfast', side: 'output' },
      { flag: '-crf', value: '22', side: 'output' },
      { flag: '-rw_timeout', value: '5000000', side: 'input' },
    ],
  },
  'hls copy': { output_format: 'hls', video_codec: 'copy', audio_codec: 'copy' },
  'matroska with subtitles copied': { output_format: 'matroska', video_codec: 'copy', audio_codec: 'copy', subs: 'keep' },
  'deinterlace preset on the GPU path': {
    video_codec: 'h264_vaapi', hw_accel: 'vaapi', resolution: '1080p', vf_preset: 'deint-vaapi-motion', fps: '50',
  },
  'extra flags survive verbatim': {
    video_codec: 'copy', extra_input: '-live_start_index -3', extra_output: '-metadata title=My_Movie',
  },
};

test('the field schema covers the stalker-proxy-manager parameter set', () => {
  const keys = TEMPLATE_FIELDS.map((field) => field.key);
  for (const parameter of SPM_PARAMETERS) {
    assert.ok(keys.includes(parameter), `missing parameter ${parameter}`);
  }
  const schema = templateOptionsSchema();
  assert.equal(schema.fields.length, TEMPLATE_FIELDS.length);
  assert.ok(schema.advanced.length >= 25, 'the per-flag advanced table is exposed to the editor');
  assert.ok(schema.advanced.some((entry) => entry.flag === '-probesize' && entry.side === 'input'));
  assert.ok(schema.advanced.some((entry) => entry.flag === '-preset' && entry.side === 'output'));
  assert.equal(schema.defaults.output_format, TEMPLATE_OPTION_DEFAULTS.output_format);
  for (const definition of TEMPLATE_FIELDS) {
    assert.ok(definition.label && definition.help, `${definition.key} needs a label and a help text`);
    assert.ok(['video', 'tuning', 'audio', 'subtitles', 'output', 'extra'].includes(definition.group));
  }
  assert.equal(new Set(VF_PRESETS.map((p) => p.id)).size, VF_PRESETS.length);
});

test('every rendered command is a valid template command', () => {
  for (const [label, options] of Object.entries(CASES)) {
    const container = options.output_format || 'mpegts';
    const command = buildTemplateCommand(options, { container });
    const result = validateFfmpegTemplate(command, { container });
    assert.ok(result.ok, `${label}: ${result.errors.join('; ')} → ${command}`);
    assert.equal(validateTemplateOptions(options, { container }).length, 0, `${label} fields`);
  }
});

test('the default fields reproduce a passthrough remux', () => {
  const { command } = renderTemplate({}, { container: 'mpegts' });
  assert.match(command, /^ffmpeg -hide_banner -nostdin -loglevel warning -i <url>/);
  assert.match(command, /-c:v copy -c:a copy/);
  assert.match(command, /-f mpegts pipe:1$/);
  assert.match(command, /-mpegts_flags \+resend_headers/);
  // No hardware init, no filters, no rate control for a copy.
  assert.doesNotMatch(command, /-init_hw_device/);
  assert.doesNotMatch(command, /-vf/);
  assert.doesNotMatch(command, /-b:v/);
});

test('the VAAPI pipeline carries the DS918+ flags', () => {
  const command = buildTemplateCommand(CASES['vaapi 1080p VBR'], { container: 'mpegts' });
  for (const expected of [
    '-init_hw_device vaapi=intel:/dev/dri/renderD128',
    '-hwaccel vaapi', '-hwaccel_device intel', '-hwaccel_output_format vaapi',
    '-vf scale_vaapi=w=1920:h=1080:format=nv12,fps=25,setsar=1',
    '-c:v h264_vaapi', '-b:v 8000k', '-maxrate 12000k', '-bufsize 8000k',
    '-profile:v high', '-level 4.1', '-g 50', '-r 25',
    '-low_power 1', '-rc_mode VBR', '-async_depth 4',
    '-c:a aac', '-b:a 192k', '-ac 6', '-ar 48000',
  ]) {
    assert.ok(command.includes(expected), `missing ${expected} in ${command}`);
  }
});

test('a quality driven VAAPI mode omits the bitrate but keeps it in the fields', () => {
  const options = { ...CASES['vaapi 1080p VBR'], rc_mode: 'CQP', global_quality: '26' };
  const command = buildTemplateCommand(options, { container: 'mpegts' });
  assert.match(command, /-rc_mode CQP/);
  assert.match(command, /-global_quality 26/);
  assert.doesNotMatch(command, /-b:v/);
  assert.doesNotMatch(command, /-maxrate/);
  const warnings = templateOptionWarnings(options, { container: 'mpegts' });
  assert.ok(warnings.some((text) => text.includes('quality-driven')), 'the editor explains why the bitrate is not in the command');
  assert.equal(activeParameters(options).videoBitrate, false);
});

test('fields → command → fields is a fixed point', () => {
  for (const [label, options] of Object.entries(CASES)) {
    const container = options.output_format || 'mpegts';
    const command = buildTemplateCommand(options, { container });
    const parsed = parseTemplateCommand(command, { base: options, container });
    const rebuilt = buildTemplateCommand(parsed.options, { container });
    assert.equal(rebuilt, command, `${label} drifted`);
    assert.deepEqual(parsed.warnings, [], `${label} should parse without warnings`);
    // Second pass: the parser must not accumulate anything either.
    const again = buildTemplateCommand(parseTemplateCommand(rebuilt, { base: parsed.options, container }).options, { container });
    assert.equal(again, rebuilt, `${label} is not stable on the second pass`);
  }
});

test('the parser recovers the fields from a command it did not write', () => {
  const legacy = 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -vf scale=1280:720 -c:v libx264 -c:a copy -f mpegts pipe:1';
  const { options, warnings } = parseTemplateCommand(legacy, { container: 'mpegts' });
  assert.equal(options.video_codec, 'libx264');
  assert.equal(options.hw_accel, 'none');
  assert.equal(options.resolution, '720p');
  assert.equal(options.audio_codec, 'copy');
  assert.equal(options.output_format, 'mpegts');
  assert.equal(warnings.length, 0);
  // …and the rebuilt command is still the same behaviour.
  const rebuilt = buildTemplateCommand(options, { container: 'mpegts' });
  assert.match(rebuilt, /scale=w=1280:h=720/);
  assert.match(rebuilt, /-c:v libx264/);
});

test('the parser recovers a VAAPI mirror command including its hardware block', () => {
  const command = [
    'ffmpeg -hide_banner -nostdin -loglevel warning',
    '-init_hw_device vaapi=intel:/dev/dri/renderD128 -hwaccel vaapi -hwaccel_device intel -hwaccel_output_format vaapi',
    '-i <url> -vf scale_vaapi=w=1280:h=720:format=nv12,setsar=1',
    '-map 0:v:0 -map 0:a:0? -c:v h264_vaapi -b:v 4000k -rc_mode CQP -global_quality 24 -c:a ac3 -f mpegts pipe:1',
  ].join(' ');
  const { options } = parseTemplateCommand(command, { container: 'mpegts' });
  assert.equal(options.hw_accel, 'vaapi');
  assert.equal(options.device, '/dev/dri/renderD128');
  assert.equal(options.video_codec, 'h264_vaapi');
  assert.equal(options.resolution, '720p');
  assert.equal(options.video_bitrate, '4000k');
  assert.equal(options.rc_mode, 'CQP');
  assert.equal(options.global_quality, '24');
  assert.equal(options.audio_codec, 'ac3');
});

test('the parser keeps what it does not understand instead of dropping it', () => {
  const command = 'ffmpeg -live_start_index -3 -analyzeduration 3000000 -i <url> -c:v copy -f mpegts pipe:1';
  const { options } = parseTemplateCommand(command, { container: 'mpegts' });
  assert.match(options.extra_input, /-live_start_index -3/);
});

test('a foreign -vf is reported, not silently mangled', () => {
  const { warnings } = parseTemplateCommand('ffmpeg -i <url> -vf "hqdn3d=1.5:1.5:6:6" -c:v libx264 -f mpegts pipe:1', { container: 'mpegts' });
  assert.ok(warnings.some((text) => text.includes('hqdn3d')), warnings.join('; '));
});

test('validation rejects unusable values and form-owned extra flags', () => {
  const bad = {
    video_bitrate: 'fast', fps: '0', gop: '2.5', resolution: '1233p', aspect: 'wide',
    output_format: 'mp4', subs: 'burn', extra_output: '-c:v libx264', extra_input: '-i <url>',
  };
  const errors = validateTemplateOptions(bad, { container: 'mpegts' });
  const text = errors.join(' | ');
  assert.ok(errors.length >= 8, text);
  assert.match(text, /Video bitrate/);
  assert.match(text, /Output size/);
  assert.match(text, /Output format/);
  assert.match(text, /Subtitles/);
  assert.match(text, /owned by the form/);
});

test('“copy all subtitles” only validates on Matroska', () => {
  assert.equal(validateTemplateOptions({ subs: 'keep', output_format: 'matroska' }, { container: 'matroska' }).length, 0);
  const errors = validateTemplateOptions({ subs: 'keep' }, { container: 'mpegts' });
  assert.ok(errors.some((text) => text.includes('Matroska')));
  // The renderer degrades it to the bitmap mode the container can carry.
  const command = buildTemplateCommand({ subs: 'keep', video_codec: 'copy' }, { container: 'mpegts' });
  assert.match(command, /-c:s copy/);
});

test('option normalisation coerces types and keeps the container authoritative', () => {
  const options = normaliseTemplateOptions({
    low_power: 'false', video_bitrate: 4000, hw_accel: 'nonsense', vf_preset: 'unknown', subs: 'weird',
    output_format: 'mp4', advanced: { '-crf': '22' },
  }, { container: 'matroska' });
  assert.equal(options.low_power, false);
  assert.equal(options.video_bitrate, '4000');
  assert.equal(options.hw_accel, 'none');
  assert.equal(options.vf_preset, 'none');
  assert.equal(options.subs, 'drop');
  assert.equal(options.output_format, 'matroska');
  assert.deepEqual(options.advanced, [{ flag: '-crf', value: '22', side: 'output' }]);
});

test('extra flags round trip through quoting', () => {
  const options = { extra_output: '-metadata title="My Movie" -metadata comment=vu-movie' };
  const command = buildTemplateCommand(options, { container: 'mpegts' });
  assert.ok(parseFfmpegTemplateTokens(command).includes('title=My Movie'), command);
  const parsed = parseTemplateCommand(command, { base: options, container: 'mpegts' });
  assert.equal(buildTemplateCommand(parsed.options, { container: 'mpegts' }), command);
});

test('the video filter presets render per decode path and warn when they cannot', () => {
  assert.equal(vfSnippet('deint-vaapi-frame', 'vaapi'), 'deinterlace_vaapi=rate=frame');
  assert.equal(vfSnippet('deint-vaapi-frame', 'none'), '');
  const options = { video_codec: 'libx264', hw_accel: 'none', resolution: '720p', vf_preset: 'deint-vaapi-frame' };
  const command = buildTemplateCommand(options, { container: 'mpegts' });
  assert.doesNotMatch(command, /deinterlace_vaapi/);
  assert.ok(templateOptionWarnings(options).some((text) => text.includes('VAAPI')));
});

test('targetSize understands presets, explicit sizes and aspect ratios', () => {
  assert.deepEqual(targetSize('720p', '16:9'), [1280, 720]);
  assert.deepEqual(targetSize('720p', '4:3'), [960, 720]);
  assert.deepEqual(targetSize('1920x800'), [1920, 800]);
  assert.equal(targetSize('source'), null);
  assert.equal(targetSize('1233p'), null, 'odd heights are rejected');
  assert.equal(targetSize('1921x800'), null, 'odd widths are rejected');
});

test('split/join helpers keep a half-typed command readable', () => {
  assert.deepEqual(splitFlagString('-rw_timeout 5000000 -headers "X: 1"'), ['-rw_timeout', '5000000', '-headers', 'X: 1']);
  assert.deepEqual(splitFlagString('-metadata "unbalanced'), ['-metadata', 'unbalanced']);
  assert.equal(joinTemplateTokens(['-metadata', 'title=My Movie']), '-metadata "title=My Movie"');
});

test('the advanced table keeps an explicit override and drops a default one', () => {
  const withOverride = { advanced: [{ flag: '-mpegts_flags', value: '+discont_start', side: 'output' }] };
  const command = buildTemplateCommand(withOverride, { container: 'mpegts' });
  assert.match(command, /-mpegts_flags \+discont_start/);
  assert.doesNotMatch(command, /\+resend_headers/);
  const parsed = parseTemplateCommand(command, { base: withOverride, container: 'mpegts' });
  assert.deepEqual(parsed.options.advanced, [{ flag: '-mpegts_flags', value: '+discont_start', side: 'output' }]);

  const defaults = parseTemplateCommand(buildTemplateCommand({}, { container: 'mpegts' }), { container: 'mpegts' });
  assert.deepEqual(defaults.options.advanced, [], 'container defaults are re-rendered, never stored');
});

test('an empty -bsf:v entry suppresses the automatic Annex-B filter', () => {
  const options = { video_codec: 'copy', advanced: [{ flag: '-bsf:v', value: '', side: 'output' }] };
  const command = buildTemplateCommand(options, { container: 'mpegts' });
  assert.doesNotMatch(command, /-bsf:v/);
  const withBsf = buildTemplateCommand({ video_codec: 'copy' }, { container: 'mpegts' });
  assert.match(withBsf, /-bsf:v h264_mp4toannexb/);
});

test('an advanced flag is documented for the editor', () => {
  for (const entry of ADVANCED_OPTIONS) {
    assert.match(entry.flag, /^-[A-Za-z]/, entry.flag);
    assert.ok(['input', 'output'].includes(entry.side), entry.flag);
    assert.ok(entry.label && entry.help, entry.flag);
  }
});
