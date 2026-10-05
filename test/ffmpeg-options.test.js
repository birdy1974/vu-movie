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

/* ------------------------------------------------------------------ *
 * the values offered in the dropdowns
 *
 * The prefilled lists have to be real ffmpeg values: a name that does not
 * exist in the build only fails once a stream is running, and a missing level
 * or sample rate silently pushes the operator into the "custom value…" path.
 * These assertions pin the vocabulary to the ffmpeg documentation (encoders,
 * -profile:v / -level, -r, -ar, -b:a) and to stalker-proxy-manager's schema.
 * ------------------------------------------------------------------ */

test('the offered video encoders are real ffmpeg encoder names', () => {
  const { videoCodecs } = templateOptionsSchema();
  // encoders a Synology/Intel box realistically runs, plus copy
  for (const name of ['copy', 'libx264', 'libx265', 'mpeg2video', 'h264_vaapi', 'hevc_vaapi', 'vp9_vaapi', 'h264_qsv', 'hevc_qsv']) {
    assert.ok(videoCodecs.includes(name), `${name} is offered`);
  }
  // AV1 and NVENC are real names too — they just may not exist on the host
  for (const name of ['libsvtav1', 'av1_vaapi', 'h264_nvenc', 'hevc_nvenc', 'libvpx-vp9']) {
    assert.ok(videoCodecs.includes(name), `${name} is offered`);
  }
  assert.equal(new Set(videoCodecs).size, videoCodecs.length, 'no duplicates');
});

test('the offered audio encoders cover what TS, MKV and the box need', () => {
  const { audioCodecs } = templateOptionsSchema();
  for (const name of ['aac', 'ac3', 'eac3', 'mp2', 'mp3', 'libopus', 'flac', 'pcm_s16le', 'copy', 'none']) {
    assert.ok(audioCodecs.includes(name), `${name} is offered`);
  }
  // dca needs -strict experimental, so it must not be a one-click choice
  assert.ok(!audioCodecs.includes('dca'));
});

test('H.264 profiles and levels match the ffmpeg/x264 vocabulary', () => {
  const field = (key) => TEMPLATE_FIELDS.find((f) => f.key === key);
  const profiles = field('profile').choices;
  for (const name of ['baseline', 'main', 'high', 'high10', 'high422', 'high444']) assert.ok(profiles.includes(name), `profile ${name}`);
  const levels = field('level').choices;
  // Annex A: 1 … 6.2 and the 1b level, exactly as -level:v accepts them
  for (const name of ['1', '1b', '1.1', '2.2', '3.1', '4.1', '5.1', '6.2']) assert.ok(levels.includes(name), `level ${name}`);
  assert.ok(!levels.includes('7.0'), 'level 7 does not exist');
});

test('frame rates, sample rates and bitrates are ffmpeg-acceptable values', () => {
  const field = (key) => TEMPLATE_FIELDS.find((f) => f.key === key);
  const fps = field('fps').choices.filter(Boolean);
  assert.deepEqual(fps.filter((v) => !/^\d+(\.\d+)?$/.test(v)), [], 'every FPS is a number');
  for (const rate of ['23.976', '29.97', '59.94', '25', '50', '60', '120']) assert.ok(fps.includes(rate), `fps ${rate}`);

  const rates = field('audio_rate').choices.filter(Boolean).map(Number);
  for (const rate of [8000, 11025, 22050, 32000, 44100, 48000, 96000, 192000]) assert.ok(rates.includes(rate), `sample rate ${rate}`);
  assert.ok(Math.max(...rates) <= 384000, 'the encoders accept up to 384 kHz');

  const bitrates = field('audio_bitrate').choices.filter(Boolean);
  assert.ok(bitrates.every((v) => /^\d+k$/.test(v)), 'audio bitrates are kbit/s');
  for (const rate of ['128k', '192k', '384k', '640k']) assert.ok(bitrates.includes(rate), `audio bitrate ${rate}`);

  const videoRates = field('video_bitrate').choices.filter(Boolean);
  assert.ok(videoRates.every((v) => /^\d+k$/.test(v)), 'video bitrates are kbit/s');
});

test('every advanced suggestion is a positive value for its own flag', () => {
  const flag = (name) => ADVANCED_OPTIONS.find((entry) => entry.flag === name);
  assert.ok(flag('-preset').choices.includes('veryfast'));
  assert.ok(flag('-tune').choices.includes('zerolatency'));
  assert.deepEqual(flag('-reconnect').choices, ['0', '1']);
  assert.ok(flag('-probesize').choices.every((v) => Number(v) >= 32));
  assert.ok(flag('-mpegts_flags').choices.some((v) => v.includes('resend_headers')));
  // the timeout ladder reaches the 60 s that stalker-proxy-manager ships
  assert.ok(flag('-rw_timeout').choices.includes('60000000'), flag('-rw_timeout').choices.join(' '));
  assert.equal(flag('-rw_timeout').max, 2147483647);
  // and the two player identities its editor offers for stubborn portals
  assert.deepEqual(flag('-user_agent').choices, ['Lavf/61.7.100', 'VLC/3.0.21 LibVLC/3.0.21']);
  assert.ok(flag('-hls_flags').choices.some((v) => v.includes('delete_segments')));
  // nothing may be offered for a flag the renderer owns
  const owned = new Set(templateOptionsSchema().formOwnedFlags);
  for (const entry of ADVANCED_OPTIONS) assert.ok(!owned.has(entry.flag), `${entry.flag} is not form-owned`);
});

test('Matroska-only audio is flagged when the container is MPEG-TS or HLS', () => {
  const base = { ...TEMPLATE_OPTION_DEFAULTS, video_codec: 'copy', audio_codec: 'flac' };
  const ts = templateOptionWarnings(normaliseTemplateOptions(base, { container: 'mpegts' }), { container: 'mpegts' });
  assert.ok(ts.some((w) => w.includes('needs the Matroska container')), ts.join(' | '));
  const mkv = templateOptionWarnings(normaliseTemplateOptions(base, { container: 'matroska' }), { container: 'matroska' });
  assert.ok(!mkv.some((w) => w.includes('needs the Matroska container')), mkv.join(' | '));
  // …and the broad list still builds a valid command
  const rendered = renderTemplate(normaliseTemplateOptions({ ...TEMPLATE_OPTION_DEFAULTS, video_codec: 'copy', audio_codec: 'flac' }, { container: 'matroska' }), { container: 'matroska' });
  assert.match(rendered.command, /-c:a flac/);
});

test('the newly offered encoders render and validate', () => {
  const cases = [
    { video_codec: 'av1_vaapi', hw_accel: 'vaapi', rc_mode: 'CQP', global_quality: '26', output_format: 'matroska' },
    { video_codec: 'libsvtav1', hw_accel: 'none', video_bitrate: '2500k', output_format: 'matroska' },
    { video_codec: 'h264_nvenc', hw_accel: 'none', profile: 'high', level: '4.1', video_bitrate: '8000k', output_format: 'matroska' },
    { video_codec: 'h264_vaapi', profile: 'high10', level: '5.1', output_format: 'mpegts' },
  ];
  for (const raw of cases) {
    const options = normaliseTemplateOptions({ ...TEMPLATE_OPTION_DEFAULTS, ...raw }, { container: raw.output_format });
    assert.deepEqual(validateTemplateOptions(options, { container: raw.output_format }), [], `${raw.video_codec} validates`);
    const { command } = renderTemplate(options, { container: raw.output_format });
    assert.ok(command.includes(`-c:v ${raw.video_codec}`), command);
  }
});

test('the editor gets the encoder families from the schema (no second copy)', () => {
  const schema = templateOptionsSchema();
  assert.deepEqual(schema.vaapiEncoders, ['h264_vaapi', 'hevc_vaapi', 'vp8_vaapi', 'vp9_vaapi', 'av1_vaapi']);
  assert.ok(schema.h264Encoders.includes('h264_nvenc'));
  // an encoder added to the family list is recognised as VAAPI by activeParameters
  const options = normaliseTemplateOptions({ ...TEMPLATE_OPTION_DEFAULTS, video_codec: 'av1_vaapi', rc_mode: 'CQP' }, { container: 'matroska' });
  assert.equal(activeParameters(options, { container: 'matroska' }).vaapiTuning, true);
});
