/**
 * vu-movie — FFmpeg template *fields*: schema, renderer and parser.
 *
 * The Transcode-templates tab used to be a plain textarea: you either knew the
 * ffmpeg flags by heart or you copied them from somewhere. This module gives
 * that tab the same structured parameter set the sibling project
 * (birdy1974/stalker-proxy-manager) exposes, so a template can be built from
 * dropdowns and numbers instead of memory:
 *
 *     fields -> command : buildTemplateCommand(options)   (deterministic renderer)
 *     command -> fields : parseTemplateCommand(command)   (tolerant parser)
 *
 * The two have to meet at a fixed point: a command that goes through
 * fields -> text -> fields -> text must not grow or drift. That is why the
 * renderer and the parser agree on one rule — the flags the renderer owns
 * (hardware init, -vf scale/fps/setsar, mapping, rate control, the container
 * defaults) are consumed by the parser and re-emitted from the fields, while
 * anything the renderer does not recognise is kept in `extra_input` /
 * `extra_output` so nothing an operator typed is silently lost (the exception
 * is a hand-written `-vf`, which cannot survive the field pipeline and is
 * reported instead of being mangled).
 *
 * This file is dependency-free (only the shell-like token splitter from
 * media.js) and side-effect-light so it can be unit tested without a NAS,
 * ffmpeg or a GPU (test/ffmpeg-options.test.js).
 *
 * Values deliberately mirror stalker-proxy-manager's `FFmpegOptions`:
 *   hw_accel, device, resolution, aspect, video_codec, video_bitrate, maxrate,
 *   bufsize, fps, gop, profile, level, vf_preset, low_power, rc_mode,
 *   global_quality, async_depth, audio_codec, audio_bitrate, audio_channels,
 *   audio_rate, subs, output_format, extra_input, extra_output plus the
 *   per-flag "advanced" table (network + muxer options).
 *
 * Container mapping for vu-movie: `output_format` is the same thing as the
 * template's `container` (mpegts | matroska | hls) — the editor shows one
 * control and the two can never disagree.
 */

import { parseFfmpegTemplateTokens } from './media.js';

export const URL_TOKEN = '<url>';
export const OUTPUT_TOKEN = '<output>';

/** Outgoing containers vu-movie can serve. */
export const TEMPLATE_CONTAINERS = ['mpegts', 'matroska', 'hls'];

/** What the command starts with — always emitted, never a user field. */
export const BASE_INPUT_FLAGS = ['-hide_banner', '-nostdin', '-loglevel', 'warning'];

/* ------------------------------------------------------------------ *
 * enumerations (same vocabulary as stalker-proxy-manager)
 * ------------------------------------------------------------------ */

export const HW_ACCELERATION = ['none', 'vaapi', 'qsv'];

/**
 * Video encoders offered in the dropdown, copy first. Every one of these is a
 * real ffmpeg encoder name (``ffmpeg -encoders``); whether a given build has it
 * depends on how ffmpeg was compiled, which is why custom values are still
 * accepted. Grouped: no re-encode, CPU, VAAPI, Quick Sync, NVENC.
 */
export const VIDEO_CODECS = [
  'copy',
  'libx264', 'libx265', 'libvpx-vp9', 'libsvtav1', 'mpeg2video',
  'h264_vaapi', 'hevc_vaapi', 'vp8_vaapi', 'vp9_vaapi', 'av1_vaapi',
  'h264_qsv', 'hevc_qsv',
  'h264_nvenc', 'hevc_nvenc',
];

/**
 * Audio encoders. AAC is mandatory for MPEG-TS and HLS; AC-3/E-AC-3, MP2 and
 * DTS are what set-top boxes understand; Opus/Vorbis need Matroska; PCM and
 * FLAC are lossless (Matroska). `copy` keeps the source, `none` removes audio.
 */
export const AUDIO_CODECS = ['aac', 'ac3', 'eac3', 'mp2', 'mp3', 'libmp3lame', 'libopus', 'libvorbis', 'flac', 'pcm_s16le', 'copy', 'none'];

/**
 * Audio the transport streams actually carry (ISO/IEC 13818-1 registration and
 * the HLS spec both assume these): AAC, AC-3, E-AC-3, MP2 or MP3. Opus/Vorbis,
 * FLAC and PCM need Matroska, so combining them with MPEG-TS or HLS gets a
 * warning instead of a stream that silently fails to decode.
 */
const TS_AUDIO_CODECS = ['aac', 'ac3', 'eac3', 'mp2', 'mp3', 'libmp3lame', 'copy', 'none'];
export const RC_MODES = ['AUTO', 'CQP', 'CBR', 'VBR', 'ICQ', 'QVBR', 'AVBR'];
export const SUB_MODES = ['drop', 'dvb', 'keep'];

/** `-profile:v` for libx264/h264_vaapi/h264_qsv (see x264 --fullhelp). */
export const PROFILES = ['baseline', 'main', 'high', 'high10', 'high422', 'high444'];
/** H.264 levels as ffmpeg/x264 take them (annex A: 1 … 6.2, plus the 1b level). */
export const LEVELS = [
  '1', '1b', '1.1', '1.2', '1.3', '2', '2.1', '2.2', '3', '3.1', '3.2',
  '4', '4.1', '4.2', '5', '5.1', '5.2', '6', '6.1', '6.2',
];

/** Encoders that accept VAAPI-only tuning (-low_power/-rc_mode/-async_depth/…). */
export const VAAPI_ENCODERS = ['h264_vaapi', 'hevc_vaapi', 'vp8_vaapi', 'vp9_vaapi', 'av1_vaapi'];
/** Encoders that accept -profile:v/-level (the H.264 family, incl. NVENC/VAAPI/QSV). */
export const H264_ENCODERS = ['libx264', 'h264_vaapi', 'h264_qsv', 'h264_nvenc'];
/** Rate-control modes where a fixed quantiser, not a bitrate, drives quality. */
const QUALITY_RC_MODES = ['CQP', 'ICQ', 'QVBR'];

/** Canonical (16:9) pixel size per resolution preset. */
export const RESOLUTIONS = {
  '360p': [640, 360], '480p': [854, 480], '576p': [1024, 576], '720p': [1280, 720],
  '1080p': [1920, 1080], '1440p': [2560, 1440], '2160p': [3840, 2160], '4320p': [7680, 4320],
};

/** Aspect ratios the resolution presets are scaled by (width ÷ height). */
export const ASPECT_RATIOS = { '16:9': 16 / 9, '4:3': 4 / 3, '21:9': 21 / 9, '1:1': 1, '9:16': 9 / 16, '64:27': 64 / 27 };

/**
 * Selectable extra filters, spliced FIRST into the -vf chain (before scaling)
 * so a deinterlacer sees full-size fields. Same ids/labels as
 * stalker-proxy-manager, which is where the DS918+ fault-finding list comes
 * from: each entry isolates one suspect (interlaced source, 10-bit pixels,
 * wrong field flags, broken surface handling) and `none` renders nothing, so a
 * template stored before this field existed still builds a familiar command.
 *
 * `vaapi`/`qsv`/`sw` hold one snippet per decode path ('' = not applicable
 * there and rendered as nothing, with a note in the warnings).
 */
export const VF_PRESETS = [
  {
    id: 'none', label: 'None (default)', hint: 'no extra filter — the command is exactly what the fields say',
    vaapi: '', qsv: '', sw: '',
  },
  {
    id: 'deint-vaapi-frame', label: 'Deinterlace (VAAPI, frame rate kept)',
    hint: 'GPU deinterlace, 25i stays 25p — first choice for interlaced live TV',
    vaapi: 'deinterlace_vaapi=rate=frame', qsv: '', sw: '',
  },
  {
    id: 'deint-vaapi-auto', label: 'Deinterlace (VAAPI, interlaced frames only)',
    hint: 'as above, but progressive frames pass through untouched (mixed content)',
    vaapi: 'deinterlace_vaapi=rate=frame:auto=1', qsv: '', sw: '',
  },
  {
    id: 'deint-vaapi-field', label: 'Deinterlace bob (VAAPI, double frame rate)',
    hint: 'GPU bob: 25i becomes 50p — set FPS 50 (or blank) to keep it',
    vaapi: 'deinterlace_vaapi=rate=field', qsv: '', sw: '', doubles: true,
  },
  {
    id: 'deint-vaapi-bob', label: 'Deinterlace bob, pinned algorithm (VAAPI mode=bob)',
    hint: 'as above but pins the bob algorithm instead of the driver default',
    vaapi: 'deinterlace_vaapi=mode=bob:rate=field', qsv: '', sw: '', doubles: true,
  },
  {
    id: 'deint-vaapi-motion', label: 'Deinterlace motion-adaptive (VAAPI)',
    hint: 'pins the motion-adaptive algorithm at frame rate (best single-rate quality on Intel)',
    vaapi: 'deinterlace_vaapi=mode=motion_adaptive:rate=frame', qsv: '', sw: '',
  },
  {
    id: 'deint-qsv-advanced', label: 'Deinterlace advanced (QSV)',
    hint: 'GPU advanced (motion-adaptive) deinterlace for Quick Sync templates',
    vaapi: '', qsv: 'vpp_qsv=deinterlace=2', sw: '',
  },
  {
    id: 'deint-qsv-bob', label: 'Deinterlace bob (QSV)',
    hint: 'GPU bob deinterlace for Quick Sync templates (double frame rate)',
    vaapi: '', qsv: 'vpp_qsv=deinterlace=1', sw: '', doubles: true,
  },
  {
    id: 'yadif-frame', label: 'Deinterlace yadif (CPU, frame rate kept)',
    hint: 'reference software deinterlacer; on GPU templates frames are downloaded and re-uploaded',
    vaapi: 'hwdownload,format=yuv420p,yadif=mode=send_frame:parity=auto,hwupload',
    qsv: 'hwdownload,format=yuv420p,yadif=mode=send_frame:parity=auto,hwupload',
    sw: 'yadif=mode=send_frame:parity=auto', cpu: true,
  },
  {
    id: 'yadif-bob', label: 'Deinterlace yadif bob (CPU, double frame rate)',
    hint: 'software bob: 25i becomes 50p — set FPS 50 (or blank) to keep it',
    vaapi: 'hwdownload,format=yuv420p,yadif=mode=send_field:parity=auto,hwupload',
    qsv: 'hwdownload,format=yuv420p,yadif=mode=send_field:parity=auto,hwupload',
    sw: 'yadif=mode=send_field:parity=auto', cpu: true, doubles: true,
  },
  {
    id: 'bwdif-frame', label: 'Deinterlace bwdif (CPU, frame rate kept)',
    hint: 'higher-quality software deinterlacer (motion-weighted); CPU round-trip on GPU templates',
    vaapi: 'hwdownload,format=yuv420p,bwdif=mode=send_frame:parity=auto,hwupload',
    qsv: 'hwdownload,format=yuv420p,bwdif=mode=send_frame:parity=auto,hwupload',
    sw: 'bwdif=mode=send_frame:parity=auto', cpu: true,
  },
  {
    id: 'bwdif-bob', label: 'Deinterlace bwdif bob (CPU, double frame rate)',
    hint: 'software bob, motion-weighted: 25i becomes 50p — set FPS 50 (or blank) to keep it',
    vaapi: 'hwdownload,format=yuv420p,bwdif=mode=send_field:parity=auto,hwupload',
    qsv: 'hwdownload,format=yuv420p,bwdif=mode=send_field:parity=auto,hwupload',
    sw: 'bwdif=mode=send_field:parity=auto', cpu: true, doubles: true,
  },
  {
    id: 'hw-roundtrip', label: 'GPU download/upload round-trip (no-op test)',
    hint: 'frames go to the CPU and back unchanged: if THIS breaks the picture, surface handling is the fault',
    vaapi: 'hwdownload,hwupload', qsv: 'hwdownload,hwupload', sw: '', cpu: true,
  },
  {
    id: 'pixfmt-420p', label: 'Force 8-bit 4:2:0 (10-bit/HDR sources)',
    hint: 'converts through 8-bit yuv420p: isolates 10-bit/odd-pixel-format rejections',
    vaapi: 'hwdownload,format=yuv420p,hwupload', qsv: 'hwdownload,format=yuv420p,hwupload', sw: '', cpu: true,
  },
  {
    id: 'setfield-prog', label: 'Force progressive flag',
    hint: 'marks frames progressive without touching pixels: isolates wrong interlace signalling',
    vaapi: 'setfield=mode=prog', qsv: 'setfield=mode=prog', sw: 'setfield=mode=prog',
  },
  {
    id: 'setfield-tff', label: 'Force top-field-first flag',
    hint: 'marks frames top-field-first: pair with a deinterlacer when parity detection misfires',
    vaapi: 'setfield=mode=tff', qsv: 'setfield=mode=tff', sw: 'setfield=mode=tff',
  },
  {
    id: 'null', label: 'Null (filter-graph sanity check)',
    hint: 'passes frames through untouched: if THIS breaks the picture, filter insertion itself is the fault',
    vaapi: 'null', qsv: 'null', sw: 'null',
  },
];
export const VF_PRESET_IDS = new Set(VF_PRESETS.map((p) => p.id));

/* ------------------------------------------------------------------ *
 * the field schema (one entry per editable parameter)
 * ------------------------------------------------------------------ */

const field = (key, label, group, definition) => ({ key, label, group, ...definition });

/**
 * Every entry maps 1:1 onto an ffmpeg flag the renderer emits. `kind` drives
 * both the client-side input control and the server-side validation:
 *   enum | bool | text | rate | integer | number | positive | resolution | aspect | flags
 */
export const TEMPLATE_GROUPS = [
  { id: 'video', label: 'Video' },
  { id: 'tuning', label: 'Rate control & VAAPI tuning' },
  { id: 'audio', label: 'Audio' },
  { id: 'subtitles', label: 'Subtitles' },
  { id: 'output', label: 'Output' },
  { id: 'extra', label: 'Extra flags' },
];

export const TEMPLATE_FIELDS = [
  field('hw_accel', 'Video decoding', 'video', {
    help: 'Hardware path for decoding. Match VAAPI/QSV encoders to their hardware path; CPU encoders normally need CPU decoding. Availability depends on the host.',
    kind: 'enum', choices: HW_ACCELERATION, custom: false,
  }),
  field('device', 'GPU device', 'video', {
    help: 'Render node inside the container. Ignored for CPU decoding or video copy.',
    kind: 'text', choices: ['/dev/dri/renderD128', '/dev/dri/renderD129', '/dev/dri/renderD130'],
  }),
  field('resolution', 'Output size', 'video', {
    help: 'Output size when re-encoding. Choose source to omit resizing; custom values accept an even WIDTHxHEIGHT (16–8192 pixels) or a height such as 900p. Explicit dimensions override the aspect.',
    kind: 'resolution', choices: ['source', ...Object.keys(RESOLUTIONS)],
  }),
  field('aspect', 'Aspect ratio', 'video', {
    help: 'Width:height ratio used to calculate the width for a height preset. Pixels are square. Ignored for explicit WIDTHxHEIGHT, source size or video copy.',
    kind: 'aspect', choices: Object.keys(ASPECT_RATIOS),
  }),
  field('video_codec', 'Video encoder', 'video', {
    help: 'Video encoder, or copy for no re-encoding. Scaling, FPS and quality controls do not apply to copy.',
    kind: 'enum', choices: VIDEO_CODECS,
  }),
  field('video_bitrate', 'Video bitrate', 'tuning', {
    help: 'Target video bits/second: 8000k = 8 Mbit/s. Blank leaves it to the encoder. Not emitted for VAAPI CQP/ICQ/QVBR or video copy.',
    kind: 'rate', choices: ['', '500k', '750k', '1000k', '1500k', '2500k', '4000k', '6000k', '8000k', '12000k', '20000k'],
  }),
  field('maxrate', 'Peak bitrate', 'tuning', {
    help: 'Peak video bitrate. Normally at least the target bitrate; pair it with a VBV buffer. Blank omits it (CBR falls back to the target bitrate).',
    kind: 'rate', choices: ['', '1100k', '1200k', '1800k', '2750k', '4800k', '8000k', '12000k', '20000k'],
  }),
  field('bufsize', 'VBV buffer', 'tuning', {
    help: 'VBV buffer capacity in bits, not bytes. About twice the bitrate is two seconds of buffering. Blank omits it.',
    kind: 'rate', choices: ['', '2000k', '2400k', '4000k', '8000k', '12000k', '24000k', '40000k'],
  }),
  field('fps', 'Output FPS', 'tuning', {
    help: 'Output frames per second while re-encoding. Blank keeps source timing. Decimal rates such as 23.976 or 59.94 are supported.',
    kind: 'positive', choices: ['', '15', '23.976', '24', '25', '29.97', '30', '50', '59.94', '60', '100', '120'],
  }),
  field('gop', 'Keyframe interval', 'tuning', {
    help: 'Maximum frames between keyframes. At 25 FPS, 50 is roughly two seconds. 0 is intra-only; blank uses the encoder default.',
    kind: 'integer', min: 0, max: 2147483647,
    choices: ['', '0', '1', '24', '25', '48', '50', '60', '100', '120', '250'],
  }),
  field('profile', 'H.264 profile', 'tuning', {
    help: 'H.264 compatibility profile. Baseline suits older decoders; main/high improve compression; high10/high422/high444 add bit depth and chroma (and cost decoder support). Blank lets ffmpeg choose. Only emitted for H.264 encoders.',
    kind: 'enum', choices: ['', ...PROFILES], custom: false,
  }),
  field('level', 'H.264 level', 'tuning', {
    help: 'H.264 decoder limits (resolution, rate and bitrate): the values ffmpeg/x264 accept are 1–6.2, including 1b. 4.1 is common for 1080p; larger or faster video may need 5.x/6.x. Blank is automatic.',
    kind: 'enum', choices: ['', ...LEVELS], custom: true,
  }),
  field('rc_mode', 'VAAPI rate control', 'tuning', {
    help: 'VAAPI rate control: CQP fixes the quantiser; CBR/VBR target a bitrate; ICQ/QVBR/AVBR are driver-dependent. AUTO omits the flag. Ignored by CPU/QSV encoders.',
    kind: 'enum', choices: ['', ...RC_MODES], custom: false,
  }),
  field('global_quality', 'Quality (CQP/ICQ/QVBR)', 'tuning', {
    help: 'VAAPI quality for CQP, ICQ and QVBR: lower means better quality and a larger output. Blank/AUTO lets the encoder choose.',
    kind: 'integer', min: 0, max: 51, choices: ['', 'AUTO', '18', '20', '22', '24', '26', '28', '30', '32', '36', '40', '51'],
  }),
  field('low_power', 'Low-power encoder', 'tuning', {
    help: 'Use the low-power H.264 VAAPI encoder (fixed-function EncSliceLP). Faster and cheaper on Apollo Lake; requires driver support. Only emitted for h264_vaapi.',
    kind: 'bool',
  }),
  field('async_depth', 'VAAPI frames in flight', 'tuning', {
    help: 'VAAPI frames processed concurrently. 1–64; usually 1–8. Higher values can improve throughput but add latency. Blank omits the flag.',
    kind: 'integer', min: 1, max: 64, choices: ['', '1', '2', '4', '8', '16', '32', '64'],
  }),
  field('vf_preset', 'Extra video filter', 'video', {
    help: 'An extra video filter spliced first into the filter chain. Match the filter to the decode path; CPU filters pull frames off the GPU. For an arbitrary filter graph use the full command.',
    kind: 'enum', choices: VF_PRESETS.map((p) => p.id), custom: false, labels: Object.fromEntries(VF_PRESETS.map((p) => [p.id, p.label])),
  }),
  field('audio_codec', 'Audio encoder', 'audio', {
    help: 'Audio encoder; copy preserves the source and none removes audio.',
    kind: 'enum', choices: AUDIO_CODECS,
  }),
  field('audio_bitrate', 'Audio bitrate', 'audio', {
    help: 'Target audio bits/second. 128k–192k is common for stereo AAC; surround often needs 384k–640k. Blank is automatic; ignored for copy/none.',
    kind: 'rate', choices: ['', '48k', '64k', '96k', '112k', '128k', '160k', '192k', '224k', '256k', '320k', '384k', '448k', '512k', '640k'],
  }),
  field('audio_channels', 'Audio channels', 'audio', {
    help: 'Number of encoded audio channels: 1 mono, 2 stereo, 6 for 5.1, 8 for 7.1. Blank preserves the input layout; ignored for copy/none.',
    kind: 'integer', min: 1, max: 64, choices: ['', '1', '2', '6', '8'],
  }),
  field('audio_rate', 'Audio sample rate', 'audio', {
    help: 'Encoded audio samples/second (Hz). 48000 is standard for video. Blank keeps the source rate; ignored for copy/none.',
    kind: 'integer', min: 8000, max: 384000,
    choices: ['', '8000', '11025', '12000', '16000', '22050', '24000', '32000', '44100', '48000', '64000', '88200', '96000', '176400', '192000', '384000'],
  }),
  field('subs', 'Subtitles', 'subtitles', {
    help: 'Drop removes subtitles. DVB copies the source\'s own DVB/PGS bitmap subtitles into an MPEG-TS output — a text .srt cannot be turned into DVB bitmaps by ffmpeg, so use Matroska or burn-in for those. Copy all needs Matroska and keeps text (SRT/ASS) and bitmap tracks. The subtitle an item carries from the Playlist tab is muxed on top of this choice; burn-in needs the full command.',
    kind: 'enum', choices: [...SUB_MODES], custom: false,
    // The stored tokens are terse; the advice pane, the validator and the
    // README all talk about “copy all”, so the box has to say it too.
    labels: {
      drop: 'drop — no subtitles in the output',
      dvb: 'DVB bitmaps — copy the source’s own DVB/PGS (MPEG-TS)',
      keep: 'copy all — keep every track (Matroska)',
    },
  }),
  field('output_format', 'Output format', 'output', {
    help: 'MPEG-TS for live TV, Matroska for subtitle-capable VOD, or HLS segment files. This is the template\'s container; the relay picks the matching output target.',
    kind: 'enum', choices: [...TEMPLATE_CONTAINERS], custom: false,
  }),
  field('extra_input', 'Extra input flags', 'extra', {
    help: 'Additional ffmpeg flags before -i, as one line. Quote values containing spaces. Flags the form owns (-i, -map, codecs, filters, -f …) must be changed in their own field.',
    kind: 'flags',
  }),
  field('extra_output', 'Extra output flags', 'extra', {
    help: 'Additional ffmpeg flags after the encoder and before the muxer. Quote values containing spaces. Flags the form owns (-i, -map, codecs, filters, -f …) must be changed in their own field.',
    kind: 'flags',
  }),
];

export const TEMPLATE_FIELD_KEYS = TEMPLATE_FIELDS.map((f) => f.key);
const FIELD_BY_KEY = new Map(TEMPLATE_FIELDS.map((f) => [f.key, f]));

/* ------------------------------------------------------------------ *
 * the advanced table: one flag/value pair per row, in/out side
 * ------------------------------------------------------------------ */

const adv = (flag, side, label, help, kind = 'text', choices = [], min = null, max = null) =>
  ({ flag, side, label, help, kind, choices, min, max });

export const ADVANCED_OPTIONS = [
  /* input side */
  adv('-rw_timeout', 'input', 'Network read timeout (µs)', 'Microseconds waiting for network reads. 10000000 = 10 seconds; 0 disables the timeout. Slow IPTV panels are happy with 60 s.', 'integer', ['0', '5000000', '10000000', '20000000', '30000000', '60000000'], 0, 2147483647),
  adv('-reconnect', 'input', 'Reconnect on disconnect', 'HTTP reconnect after an unexpected disconnect: 0 off, 1 on.', 'integer', ['0', '1'], 0, 1),
  adv('-reconnect_at_eof', 'input', 'Reconnect at end of input', '1 treats end-of-file as an error and reconnects. Prefer 0 for finite VOD files.', 'integer', ['0', '1'], 0, 1),
  adv('-reconnect_streamed', 'input', 'Reconnect non-seekable input', '1 permits reconnecting streamed/non-seekable HTTP inputs.', 'integer', ['0', '1'], 0, 1),
  adv('-reconnect_on_network_error', 'input', 'Reconnect on network error', '1 retries TCP/TLS network errors.', 'integer', ['0', '1'], 0, 1),
  adv('-reconnect_delay_max', 'input', 'Maximum reconnect delay (s)', 'Longest retry delay in seconds.', 'integer', ['1', '2', '5', '10', '30', '60'], 0, 4294),
  adv('-probesize', 'input', 'Probe size (bytes)', 'Bytes read to identify streams; at least 32. Smaller starts sooner but can miss tracks.', 'integer', ['32768', '500000', '1000000', '5000000', '10000000'], 32, 2147483647),
  adv('-analyzeduration', 'input', 'Analysis duration (µs)', 'Time budget for stream analysis in microseconds. 0 selects ffmpeg\'s automatic default.', 'integer', ['0', '500000', '1000000', '3000000', '5000000'], 0, 2147483647),
  adv('-thread_queue_size', 'input', 'Input packet queue', 'Maximum queued packets. More tolerates bursts but uses memory and can add latency.', 'integer', ['8', '64', '256', '512', '1024'], 1, 2147483647),
  adv('-fflags', 'input', 'Input format flags', 'Combine flags with +. nobuffer reduces buffering but can hurt unreliable sources.', 'text', ['+genpts+discardcorrupt', '+genpts', '+nobuffer', '+genpts+nobuffer+discardcorrupt']),
  adv('-err_detect', 'input', 'Decoder error handling', 'ignore_err continues after errors; careful/compliant/strict are progressively stricter.', 'text', ['ignore_err', 'careful', 'compliant', 'strict']),
  adv('-user_agent', 'input', 'HTTP User-Agent', 'User-Agent presented to the source. The presets are the ones stalker-proxy-manager ships (ffmpeg’s own Lavf identity, and the VLC identity some portals insist on). A template override wins over the automatic player identity.', 'text', ['Lavf/61.7.100', 'VLC/3.0.21 LibVLC/3.0.21']),
  adv('-referer', 'input', 'HTTP Referer', 'Optional source website URL sent as the HTTP Referer header.', 'text', []),
  adv('-headers', 'input', 'Extra HTTP headers', 'Additional HTTP request headers, one per line ending with a backslash-n. Values containing a colon need quoting.', 'text', []),
  /* output side */
  adv('-preset', 'output', 'Encoder speed preset', 'CPU x264/x265: faster saves CPU but needs more bitrate.', 'text', ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow', 'placebo']),
  adv('-crf', 'output', 'CPU constant quality (CRF)', 'x264/x265 quality target: lower is better and larger. Remove the video bitrate to avoid mixing rate targets.', 'number', ['18', '20', '22', '23', '24', '26', '28', '30'], 0, 51),
  adv('-tune', 'output', 'Encoder tuning', 'Encoder-specific content/latency tuning. zerolatency reduces buffering.', 'text', ['zerolatency', 'film', 'animation', 'grain', 'stillimage', 'psnr', 'ssim', 'fastdecode']),
  adv('-threads', 'output', 'Encoder threads', '0 is automatic. Larger values use more CPU; support depends on the encoder.', 'integer', ['0', '1', '2', '4', '8', '16'], 0, 2147483647),
  adv('-max_muxing_queue_size', 'output', 'Muxing packet queue', 'Packets buffered while waiting for all output streams. Raising it may resolve a queue overflow.', 'integer', ['128', '512', '1024', '4096'], 1, 2147483647),
  adv('-muxdelay', 'output', 'Mux delay (s)', 'Maximum mux delay in seconds. For TS, 0 can reduce startup latency.', 'number', ['0', '0.1', '0.5', '0.7', '1'], 0, 3600),
  adv('-flush_packets', 'output', 'Flush output packets', '-1 automatic, 0 buffered, 1 flush after each packet. 1 normally minimises streaming latency.', 'integer', ['-1', '0', '1'], -1, 1),
  adv('-fps_mode', 'output', 'Frame-rate conversion', 'How to handle timestamps when the output rate differs: cfr duplicates/drops frames, passthrough leaves them alone. The VAAPI path on this box needs cfr when FPS is set.', 'text', ['cfr', 'passthrough', 'vfr', 'drop', 'auto']),
  adv('-mpegts_flags', 'output', 'MPEG-TS flags', 'TS muxer flags; +resend_headers regularly repeats stream headers for players joining late.', 'text', ['+resend_headers', '+resend_headers+initial_discontinuity', '+pat_pmt_at_frames']),
  adv('-hls_time', 'output', 'HLS segment duration (s)', 'Target segment duration; actual boundaries follow keyframes. HLS only.', 'number', ['1', '2', '4', '6', '10'], 0.1, 3600),
  adv('-hls_init_time', 'output', 'HLS first segment (s)', 'Target duration of the first segment, so a player can start before a full segment exists. HLS only.', 'number', ['0.5', '1', '2', '4'], 0.1, 3600),
  adv('-hls_list_size', 'output', 'HLS playlist length', 'Segments kept in the playlist. 0 keeps all segments. HLS only.', 'integer', ['0', '3', '6', '10', '20'], 0, 2147483647),
  adv('-hls_flags', 'output', 'HLS flags', 'Combine HLS muxer flags with +. delete_segments removes expired segments.', 'text', ['delete_segments+omit_endlist+independent_segments', 'delete_segments', 'independent_segments', 'append_list']),
  adv('-live', 'output', 'Matroska live mode', '1 creates a non-seekable live MKV stream. Keep enabled for pipe:1. Matroska only.', 'integer', ['0', '1'], 0, 1),
  adv('-metadata', 'output', 'Output metadata', 'One key=value metadata entry, quoted if it contains spaces. For several entries add several rows.', 'text', ['title=My stream', 'comment=vu-movie']),
  adv('-bsf:v', 'output', 'Video bitstream filter', 'Bitstream filter applied to a copied video stream. h264_mp4toannexb is what an Enigma2 receiver needs when the source is AVCC (MP4/MKV). An empty value suppresses the automatic filter.', 'text', ['h264_mp4toannexb', 'hevc_mp4toannexb', 'extract_extradata']),
];

export const ADVANCED_BY_FLAG = new Map(ADVANCED_OPTIONS.map((a) => [a.flag, a]));
const ADVANCED_INPUT_FLAGS = ADVANCED_OPTIONS.filter((a) => a.side === 'input').map((a) => a.flag);

/* ------------------------------------------------------------------ *
 * defaults
 * ------------------------------------------------------------------ */

/**
 * Defaults for a *new* template. They reproduce the command the Stream tab has
 * always suggested (`starterFfmpegTemplate`): a passthrough remux into
 * MPEG-TS. Turning video_codec into an encoder switches the renderer into the
 * DS918+-tuned transcode pipeline.
 */
export const TEMPLATE_OPTION_DEFAULTS = {
  hw_accel: 'none',
  device: '/dev/dri/renderD128',
  resolution: 'source',
  aspect: '16:9',
  video_codec: 'copy',
  video_bitrate: '8000k',
  maxrate: '',
  bufsize: '',
  fps: '',
  gop: '',
  profile: '',
  level: '',
  vf_preset: 'none',
  low_power: false,
  rc_mode: 'VBR',
  global_quality: '',
  async_depth: '',
  audio_codec: 'copy',
  audio_bitrate: '',
  audio_channels: '',
  audio_rate: '',
  subs: 'drop',
  output_format: 'mpegts',
  extra_input: '',
  extra_output: '',
  advanced: [],
};

/**
 * Starting point for parsing a command that has no stored fields.
 *
 * The new-template defaults are deliberately *not* used here: a command that
 * omits `-b:v` must not grow one just because the app suggests 8000k for a new
 * template. Only the structural defaults survive (decode path, container,
 * aspect…); every value field starts blank, so an omitted flag stays omitted.
 */
export const TEMPLATE_PARSE_BASELINE = {
  ...TEMPLATE_OPTION_DEFAULTS,
  video_bitrate: '', maxrate: '', bufsize: '', fps: '', gop: '', profile: '', level: '',
  rc_mode: '', global_quality: '', async_depth: '',
  audio_bitrate: '', audio_channels: '', audio_rate: '',
};

/** Defaults applied by the relay when a flag is absent (shown in the help text). */
export const RUNTIME_DEFAULTS = {
  '-rw_timeout': '10000000',
  '-reconnect': '1',
  '-reconnect_at_eof': '1',
  '-reconnect_streamed': '1',
  '-reconnect_delay_max': '5',
  '-fflags': '+genpts+discardcorrupt',
  '-err_detect': 'ignore_err',
};

/**
 * Container defaults the renderer owns. `-max_muxing_queue_size 1024` is what
 * the guided builder emits in live mode; packet flushing is what stops VLC and
 * the VU+ waiting behind ffmpeg's output buffer.
 */
const CONTAINER_FLAGS = {
  mpegts: [['-mpegts_flags', '+resend_headers'], ['-flush_packets', '1'], ['-max_muxing_queue_size', '1024']],
  matroska: [['-live', '1'], ['-max_muxing_queue_size', '1024']],
  hls: [
    ['-hls_time', '2'], ['-hls_init_time', '1'], ['-hls_list_size', '10'],
    ['-hls_flags', 'delete_segments+omit_endlist+independent_segments'],
    ['-max_muxing_queue_size', '1024'],
  ],
};

/**
 * Flags the renderer emits itself. They must not be smuggled in through the raw
 * extra flags, or the command would carry the same flag twice (the last one
 * wins in ffmpeg, so the form would silently lie about what is running).
 */
export const FORM_OWNED_FLAGS = new Set([
  '-i', '-map', '-an', '-sn', '-dn', '-vf', '-filter:v',
  '-c', '-codec', '-c:v', '-vcodec', '-c:a', '-acodec', '-c:s', '-scodec',
  '-b:v', '-maxrate', '-bufsize', '-g', '-r', '-profile:v', '-level',
  '-rc_mode', '-global_quality', '-low_power', '-async_depth',
  '-b:a', '-ac', '-ar', '-f', '-init_hw_device', '-hwaccel', '-hwaccel_device',
  // -fps_mode is NOT here: it may be added as an advanced flag (the form never
  // writes it — the relay builder in media.js owns the VAAPI cfr handling).
  '-hwaccel_output_format', '-hide_banner', '-nostdin', '-loglevel', '-progress', '-nostats',
]);

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

/** Shell-quote one token the way parseFfmpegTemplateTokens() reads it back. */
export function quoteTemplateToken(token) {
  const text = String(token);
  if (text && !/[\s"'\\$`]/.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
}

/** Render an argv list back into a copy-pasteable command line. */
export function joinTemplateTokens(tokens) {
  return tokens.map(quoteTemplateToken).join(' ');
}

/** Split a raw flag string, tolerating a half-typed command (unbalanced quotes). */
export function splitFlagString(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  try { return parseFfmpegTemplateTokens(text); } catch {
    return text.split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']|["']$/g, ''));
  }
}

/** Pixel size for a resolution label + aspect ratio; null when unresizable. */
export function targetSize(resolution, aspect = '16:9') {
  if (!resolution || resolution === 'source') return null;
  const label = String(resolution).trim();
  const explicit = /^(\d+)\s*x\s*(\d+)$/i.exec(label);
  if (explicit) {
    const w = Number(explicit[1]); const h = Number(explicit[2]);
    return [w, h].every((n) => Number.isInteger(n) && n >= 16 && n <= 8192 && n % 2 === 0) ? [w, h] : null;
  }
  const height = /^(\d+)p$/i.exec(label);
  if (!height) return null;
  const h = Number(height[1]);
  if (!Number.isInteger(h) || h < 16 || h > 8192 || h % 2 !== 0) return null;
  const ratio = ASPECT_RATIOS[aspect] || ASPECT_RATIOS['16:9'];
  let w = Math.round((h * ratio) / 2) * 2;
  w = Math.min(8192, Math.max(16, w));
  return [w, h];
}

/** The literal -vf snippet for (preset, decode path); '' = nothing to render. */
export function vfSnippet(presetId, hwAccel) {
  const preset = VF_PRESETS.find((p) => p.id === presetId);
  if (!preset || preset.id === 'none') return '';
  if (hwAccel === 'vaapi') return preset.vaapi || '';
  if (hwAccel === 'qsv') return preset.qsv || '';
  return preset.sw || '';
}

/** Which decode path a preset needs ('' = works everywhere). */
export function vfPresetNeeds(presetId) {
  const preset = VF_PRESETS.find((p) => p.id === presetId);
  if (!preset || preset.id === 'none') return '';
  if (preset.vaapi && !preset.qsv && !preset.sw) return 'VAAPI decoding';
  if (preset.qsv && !preset.vaapi && !preset.sw) return 'Quick Sync (QSV) decoding';
  if ((preset.vaapi || preset.qsv) && !preset.sw) return 'GPU decoding (VAAPI or Quick Sync)';
  return '';
}

/* ------------------------------------------------------------------ *
 * normalisation + validation
 * ------------------------------------------------------------------ */

/** Keep only known keys, coerce every type, drop nothing the user typed. */
export function normaliseTemplateOptions(raw = {}, { container = null } = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { ...TEMPLATE_OPTION_DEFAULTS };
  for (const key of TEMPLATE_FIELD_KEYS) {
    if (!hasOwn(source, key)) continue;
    const value = source[key];
    if (key === 'low_power') out[key] = toBool(value, TEMPLATE_OPTION_DEFAULTS.low_power);
    else out[key] = value === undefined || value === null ? '' : String(value);
  }
  if (container && TEMPLATE_CONTAINERS.includes(container)) out.output_format = container;
  else if (!TEMPLATE_CONTAINERS.includes(out.output_format)) out.output_format = 'mpegts';
  if (!HW_ACCELERATION.includes(out.hw_accel)) out.hw_accel = TEMPLATE_OPTION_DEFAULTS.hw_accel;
  if (!out.device) out.device = TEMPLATE_OPTION_DEFAULTS.device;
  if (!VF_PRESET_IDS.has(out.vf_preset)) out.vf_preset = 'none';
  if (!SUB_MODES.includes(out.subs)) out.subs = 'drop';
  out.rc_mode = String(out.rc_mode || '').toUpperCase();
  out.advanced = normaliseAdvanced(source.advanced);
  return out;
}

/** [{flag, value, side}] — unknown flags default to the output side. */
function normaliseAdvanced(raw) {
  const list = Array.isArray(raw) ? raw
    : (raw && typeof raw === 'object' ? Object.entries(raw).map(([flag, value]) => ({ flag, value })) : []);
  const out = [];
  for (const entry of list) {
    if (!entry) continue;
    const flag = String(typeof entry === 'string' ? entry : entry.flag || '').trim();
    if (!/^-[A-Za-z][\w:-]*$/.test(flag) || flag === '-i') continue;
    const known = ADVANCED_BY_FLAG.get(flag);
    const side = ['input', 'output'].includes(entry.side) ? entry.side : (known?.side || 'output');
    const value = entry.value === undefined || entry.value === null ? '' : String(entry.value);
    out.push({ flag, value, side });
  }
  return out;
}

/** What the renderer honours for a given option set (used by UI notes + checks). */
export function activeParameters(options = {}, { container = null } = {}) {
  const o = normaliseTemplateOptions(options, { container });
  const transcode = o.video_codec !== 'copy';
  const qualityMode = VAAPI_ENCODERS.includes(o.video_codec)
    && QUALITY_RC_MODES.includes(o.rc_mode);
  const rateBased = transcode && !qualityMode;
  const live = (container || o.output_format) === 'mpegts';
  return {
    transcode,
    hw: transcode && o.hw_accel !== 'none',
    scaling: transcode && o.resolution !== 'source',
    fps: transcode && Boolean(o.fps),
    videoBitrate: rateBased && Boolean(o.video_bitrate),
    maxrate: rateBased && Boolean(o.maxrate),
    bufsize: rateBased && Boolean(o.bufsize),
    profileLevel: transcode && H264_ENCODERS.includes(o.video_codec),
    quality: VAAPI_ENCODERS.includes(o.video_codec) && QUALITY_RC_MODES.includes(o.rc_mode) && Boolean(o.global_quality) && o.global_quality !== 'AUTO',
    vaapiTuning: VAAPI_ENCODERS.includes(o.video_codec),
    audio: o.audio_codec !== 'none',
    audioRateControl: o.audio_codec !== 'none' && o.audio_codec !== 'copy',
    subs: (container || o.output_format) === 'matroska' && o.subs === 'keep' ? 'keep' : (o.subs === 'drop' ? 'drop' : 'dvb'),
    copyRemux: !transcode,
    mpegts: live,
  };
}

function validateValue(key, value, definition) {
  if (value === '' || value === undefined || value === null) return null;
  const text = String(value);
  switch (definition.kind) {
    case 'rate':
      if (!/^\d+(?:\.\d+)?[kKmMgG]?$/.test(text.trim()) || Number(text.trim().replace(/[kKmMgG]$/i, '')) <= 0) {
        return 'use a positive rate such as 2500k or 8M';
      }
      return null;
    case 'integer':
      if (!/^-?\d+$/.test(text.trim())) return 'use a whole number';
      if (definition.min !== undefined && definition.min !== null && Number(text) < definition.min) return `use at least ${definition.min}`;
      if (definition.max !== undefined && definition.max !== null && Number(text) > definition.max) return `use at most ${definition.max}`;
      return null;
    case 'number':
      if (!Number.isFinite(Number(text))) return 'use a finite number';
      if (definition.min !== undefined && definition.min !== null && Number(text) < definition.min) return `use at least ${definition.min}`;
      if (definition.max !== undefined && definition.max !== null && Number(text) > definition.max) return `use at most ${definition.max}`;
      return null;
    case 'positive': {
      const number = Number(text);
      if (!Number.isFinite(number) || number <= 0 || number > 1000) return 'use a rate greater than 0 and at most 1000';
      return null;
    }
    case 'resolution':
      if (text !== 'source' && !targetSize(text, '16:9')) return 'use a preset, an even WIDTHxHEIGHT (16–8192), source, or an even height such as 900p';
      return null;
    case 'aspect':
      if (!ASPECT_RATIOS[text] && !/^[1-9]\d{0,2}:[1-9]\d{0,2}$/.test(text)) return 'use a positive width:height ratio such as 16:9';
      return null;
    case 'enum':
      if (definition.choices.includes(text)) return null;
      if (definition.custom === false) return `choose one of: ${definition.choices.filter(Boolean).join(', ')}`;
      if (!/^[\w.-]+$/.test(text)) return 'enter a single name, not additional flags';
      return null;
    case 'flags': {
      if (/[\r\n]/.test(text)) return 'use a single line (quote values that contain spaces)';
      const tokens = splitFlagString(text);
      const offending = tokens.find((token) => FORM_OWNED_FLAGS.has(token) || token === URL_TOKEN || token === OUTPUT_TOKEN);
      if (offending) {
        if (offending === URL_TOKEN || offending === OUTPUT_TOKEN) return `${offending} is added by the form, it must not appear in the extra flags`;
        return `${offending} is owned by the form — use its own field (or the full command) instead`;
      }
      return null;
    }
    default:
      return /[\r\n]/.test(text) ? 'use a single line' : null;
  }
}

/**
 * All validation errors for one option set (empty = valid).
 *
 * The *raw* value is checked, not the normalised one: normalisation clamps an
 * unknown encoder or container to a safe default so a command can still be
 * rendered, which would otherwise hide exactly the mistake the operator needs
 * to see. An absent key is fine — it means "use the default".
 */
export function validateTemplateOptions(options = {}, { container = null } = {}) {
  const raw = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const o = normaliseTemplateOptions(raw, { container });
  const fmt = container || o.output_format;
  const errors = [];
  for (const definition of TEMPLATE_FIELDS) {
    if (!hasOwn(raw, definition.key)) continue;
    if (definition.kind === 'bool') continue;
    const value = String(raw[definition.key] ?? '');
    const definitionWithChoices = { ...definition, choices: definition.choices || [], custom: definition.custom };
    const error = validateValue(definition.key, value, definitionWithChoices);
    if (error) { errors.push(`${definition.label}: ${error}`); continue; }
    if (definition.key === 'output_format' && container && value && value !== container) {
      errors.push(`Output format: ${value} does not match the template container (${container})`);
    }
  }
  if (o.video_codec !== 'copy' && o.hw_accel !== 'none' && !String(o.device || '').startsWith('/dev/')) {
    errors.push('GPU device: use a render node such as /dev/dri/renderD128');
  }
  if (o.rc_mode && o.rc_mode !== 'AUTO' && !RC_MODES.includes(o.rc_mode)) errors.push('VAAPI rate control: choose a supported mode');
  for (const { flag, value } of o.advanced) {
    const definition = ADVANCED_BY_FLAG.get(flag);
    if (!definition || value === '') continue;
    const error = validateValue(flag, value, definition);
    if (error) errors.push(`${definition.label} (${flag}): ${error}`);
  }
  if (o.subs === 'keep' && fmt !== 'matroska') {
    errors.push('Subtitles: “copy all” needs the Matroska output format (TS/HLS can only carry DVB bitmap subtitles)');
  }
  return errors;
}

/** Notes that are not errors but change what the command does. */
export function templateOptionWarnings(options = {}, { container = null } = {}) {
  const o = normaliseTemplateOptions(options, { container });
  const fmt = container || o.output_format;
  const warnings = [];
  const active = activeParameters(o, { container: fmt });
  if (!active.transcode) {
    if (o.hw_accel !== 'none') warnings.push(`hardware decoding is ignored while the video is copied (${o.video_codec})`);
    if (o.resolution !== 'source') warnings.push('output size is ignored while the video is copied');
    if (o.video_bitrate || o.fps || o.gop) warnings.push('bitrate/FPS/keyframe settings are ignored while the video is copied');
  } else {
    if (VAAPI_ENCODERS.includes(o.video_codec) && QUALITY_RC_MODES.includes(o.rc_mode) && o.video_bitrate) {
      warnings.push(`rc_mode ${o.rc_mode} is quality-driven: ${o.video_bitrate} is kept in the fields but not in the command (flip to VBR/CBR to use it)`);
    }
    if (o.video_codec === 'hevc_vaapi' && o.low_power) warnings.push('low-power is only available for H.264 on this Intel generation and will be ignored');
    if (o.hw_accel === 'none' && VAAPI_ENCODERS.includes(o.video_codec)) warnings.push(`${o.video_codec} is a VAAPI encoder but hardware decoding is set to none`);
    if (o.hw_accel === 'vaapi' && !VAAPI_ENCODERS.includes(o.video_codec) && o.video_codec !== 'copy') {
      warnings.push(`hardware decode is set to VAAPI but ${o.video_codec} is a CPU encoder: frames will be copied back to system memory`);
    }
    if (o.hw_accel === 'qsv' && !o.video_codec.endsWith('_qsv')) warnings.push(`hardware decode is set to Quick Sync but ${o.video_codec} is not a QSV encoder`);
    if (o.video_codec === 'libx265') warnings.push('HEVC encoding is CPU-only on this box (Apollo Lake has no HEVC encoder) — fine for downloads, not for live use');
  }
  if (o.subs === 'dvb' && (fmt === 'mpegts' || fmt === 'hls')) {
    warnings.push('DVB subtitles are bitmaps: this only works when the source already carries DVB or PGS subtitles (ffmpeg cannot convert a text .srt to DVB) — attach an .srt and use the Matroska container, or burn the subtitle in');
  }
  if ((fmt === 'mpegts' || fmt === 'hls') && o.audio_codec && !TS_AUDIO_CODECS.includes(o.audio_codec)) {
    warnings.push(`${fmt === 'mpegts' ? 'MPEG-TS' : 'HLS'} carries AAC, AC-3, E-AC-3, MP2 or MP3 audio: ${o.audio_codec} needs the Matroska container`);
  }
  const snippet = vfSnippet(o.vf_preset, o.hw_accel);
  if (VF_PRESET_IDS.has(o.vf_preset) && o.vf_preset !== 'none' && !snippet) {
    const needs = vfPresetNeeds(o.vf_preset);
    if (needs) warnings.push(`the selected video filter only works with ${needs} — nothing was added to the command`);
  }
  if (o.output_format !== fmt) warnings.push(`the template container is ${fmt}, so output_format is stored as ${fmt}`);
  return warnings;
}

/* ------------------------------------------------------------------ *
 * renderer
 * ------------------------------------------------------------------ */

function rateOrNull(value) { return value ? String(value) : null; }

/**
 * Render the complete ffmpeg command for an option set.
 *
 * The pipeline mirrors what the guided builder (buildFfmpegArgs in media.js)
 * emits, in the same order, so a template and a hand-built profile stay
 * recognisably the same command:
 *   base flags → hardware init → input flags → -i <url> → -vf → mapping →
 *   encoder + rate control → audio → subtitles → output flags → muxer → target
 */
export function buildTemplateCommand(rawOptions = {}, {
  container = null, urlToken = URL_TOKEN, outputToken = OUTPUT_TOKEN,
} = {}) {
  const o = normaliseTemplateOptions(rawOptions, { container });
  const fmt = container && TEMPLATE_CONTAINERS.includes(container) ? container : o.output_format;
  const active = activeParameters(o, { container: fmt });
  const tokens = ['ffmpeg', ...BASE_INPUT_FLAGS];

  // --- hardware decode init (only when a GPU actually decodes) -------------
  if (o.video_codec !== 'copy' && o.hw_accel === 'vaapi') {
    tokens.push(
      '-init_hw_device', `vaapi=intel:${o.device}`,
      '-hwaccel', 'vaapi', '-hwaccel_device', 'intel',
      '-hwaccel_output_format', 'vaapi',
    );
  } else if (o.video_codec !== 'copy' && o.hw_accel === 'qsv') {
    tokens.push(
      '-init_hw_device', `qsv=hw:${o.device}`,
      '-hwaccel', 'qsv', '-hwaccel_device', 'hw',
      '-hwaccel_output_format', 'qsv',
    );
  }

  // --- advanced input flags (the operator's explicit overrides) -----------
  for (const entry of o.advanced) if (entry.side === 'input' && entry.value !== '') tokens.push(entry.flag, entry.value);
  tokens.push(...splitFlagString(o.extra_input));
  tokens.push('-i', urlToken);

  // --- video filters -------------------------------------------------------
  if (o.video_codec !== 'copy') {
    const filters = [];
    const snippet = vfSnippet(o.vf_preset, o.hw_accel);
    if (snippet) filters.push(snippet);
    const size = o.resolution === 'source' ? null : targetSize(o.resolution, o.aspect);
    if (o.hw_accel === 'vaapi') filters.push(size ? `scale_vaapi=w=${size[0]}:h=${size[1]}:format=nv12` : 'scale_vaapi=format=nv12');
    else if (o.hw_accel === 'qsv') { if (size) filters.push(`scale_qsv=w=${size[0]}:h=${size[1]}:format=nv12`); }
    else {
      if (size) filters.push(`scale=w=${size[0]}:h=${size[1]}`);
      filters.push('format=yuv420p');
    }
    if (o.fps) filters.push(`fps=${o.fps}`);
    filters.push('setsar=1');
    tokens.push('-vf', filters.join(','));
  }

  // --- stream mapping ------------------------------------------------------
  tokens.push('-map', '0:v:0');
  if (o.audio_codec === 'none') tokens.push('-an');
  else tokens.push('-map', '0:a:0?');
  if (active.subs !== 'drop') tokens.push('-map', '0:s?');
  tokens.push('-dn');
  if (active.subs === 'drop') tokens.push('-sn');

  // --- video encoder -------------------------------------------------------
  if (o.video_codec === 'copy') {
    tokens.push('-c:v', 'copy');
  } else {
    tokens.push('-c:v', o.video_codec);
    if (active.videoBitrate) tokens.push('-b:v', o.video_bitrate);
    if (active.maxrate) tokens.push('-maxrate', o.maxrate);
    else if (o.rc_mode === 'CBR' && active.transcode && o.video_bitrate) tokens.push('-maxrate', o.video_bitrate);
    if (active.bufsize) tokens.push('-bufsize', o.bufsize);
    else if (o.rc_mode === 'CBR' && active.transcode && o.video_bitrate) {
      const value = Number(String(o.video_bitrate).replace(/[kKmMgG]$/, '')) * 2;
      tokens.push('-bufsize', `${value}k`);
    }
    if (active.profileLevel && o.profile) tokens.push('-profile:v', o.profile);
    if (active.profileLevel && o.level) tokens.push('-level', o.level);
    if (o.gop) tokens.push('-g', String(o.gop));
    if (o.fps) tokens.push('-r', String(o.fps));
    if (active.vaapiTuning) {
      if (o.video_codec === 'h264_vaapi' && o.low_power) tokens.push('-low_power', '1');
      if (o.rc_mode && o.rc_mode !== 'AUTO') tokens.push('-rc_mode', o.rc_mode);
      if (active.quality) tokens.push('-global_quality', String(o.global_quality));
      if (o.async_depth) tokens.push('-async_depth', String(o.async_depth));
    }
  }

  // --- audio ---------------------------------------------------------------
  if (o.audio_codec !== 'none') {
    tokens.push('-c:a', o.audio_codec);
    if (o.audio_codec !== 'copy') {
      if (o.audio_bitrate) tokens.push('-b:a', o.audio_bitrate);
      if (o.audio_channels) tokens.push('-ac', String(o.audio_channels));
      if (o.audio_rate) tokens.push('-ar', String(o.audio_rate));
    }
  }

  // --- subtitles -----------------------------------------------------------
  if (active.subs === 'dvb') tokens.push('-c:s', o.video_codec === 'copy' ? 'copy' : 'dvbsub');
  else if (active.subs === 'keep') tokens.push('-c:s', 'copy');

  // Encoder tuning, metadata and muxer overrides the operator added by hand.
  // They share the extra-output position so a flag that moves between the
  // advanced table and the raw flag box does not reorder the command.
  for (const entry of o.advanced) if (entry.side === 'output' && entry.value !== '') tokens.push(entry.flag, entry.value);
  tokens.push(...splitFlagString(o.extra_output));

  // --- container specific flags the renderer owns --------------------------
  const explicit = new Set([
    ...o.advanced.map((entry) => entry.flag),
    ...splitFlagString(o.extra_output).filter((token) => token.startsWith('-')),
    ...splitFlagString(o.extra_input).filter((token) => token.startsWith('-')),
  ]);
  for (const [flag, value] of CONTAINER_FLAGS[fmt] || []) {
    if (explicit.has(flag)) continue;
    tokens.push(flag, value);
  }
  // AVCC→Annex-B for a copied H.264 stream: the MPEG-TS demuxer on Enigma2
  // wants start codes, otherwise a copy remux plays audio and a black picture.
  // An explicit -bsf:v row (even with an empty value) wins.
  const bsfRow = o.advanced.find((entry) => entry.flag === '-bsf:v');
  if (!bsfRow && o.video_codec === 'copy' && fmt === 'mpegts' && !explicit.has('-bsf:v')) {
    tokens.push('-bsf:v', 'h264_mp4toannexb');
  }

  // --- muxer + target ------------------------------------------------------
  tokens.push('-f', fmt);
  tokens.push(fmt === 'hls' ? outputToken : 'pipe:1');
  return joinTemplateTokens(tokens);
}

/** Render + validate in one call (what the API/UI preview uses). */
export function renderTemplate(options = {}, { container = null } = {}) {
  return {
    command: buildTemplateCommand(options, { container }),
    errors: validateTemplateOptions(options, { container }),
    warnings: templateOptionWarnings(options, { container }),
  };
}

/* ------------------------------------------------------------------ *
 * parser: command -> fields
 * ------------------------------------------------------------------ */

const OWNED_NO_VALUE = new Set(['-hide_banner', '-nostdin', '-dn', '-sn', '-an']);
const OWNED_WITH_VALUE = new Set([
  '-hwaccel', '-hwaccel_device', '-hwaccel_output_format', '-filter_hw_device', '-map',
]);
/** Owned flag/value pairs consumed only while the value is the built-in default. */
const OWNED_DEFAULTS = new Map([
  ['-loglevel', 'warning'], ['-progress', 'pipe:2'],
]);
const CODEC_FLAGS = { '-c:v': 'video_codec', '-vcodec': 'video_codec', '-c:a': 'audio_codec', '-acodec': 'audio_codec' };
const VIDEO_VALUE_FLAGS = {
  '-b:v': 'video_bitrate', '-maxrate': 'maxrate', '-bufsize': 'bufsize', '-g': 'gop',
  '-r': 'fps', '-level': 'level', '-global_quality': 'global_quality', '-async_depth': 'async_depth',
};
const AUDIO_VALUE_FLAGS = { '-b:a': 'audio_bitrate', '-ac': 'audio_channels', '-ar': 'audio_rate' };
const CONTAINER_ALIASES = { mkv: 'matroska', matroska: 'matroska', mpegts: 'mpegts', hls: 'hls' };

function splitFilterChain(vf) {
  return String(vf).split(/,(?![^()]*\))/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse an existing command back into fields.
 *
 * `base` is the option set to start from (the template's stored fields): a
 * command cannot express everything — an omitted `-rc_mode` is "whatever the
 * template already said", not "AUTO" — so only the flags the text mentions are
 * overwritten. The result is `{ options, warnings }` and never throws: an
 * unparseable quote turns into a warning, not a 500.
 */
export function parseTemplateCommand(command, { base = null, container = null } = {}) {
  const warnings = [];
  let tokens;
  try {
    tokens = parseFfmpegTemplateTokens(String(command || ''));
  } catch (error) {
    return {
      options: normaliseTemplateOptions(base || TEMPLATE_PARSE_BASELINE, { container }),
      warnings: [`could not read the command: ${error.message}`],
    };
  }
  if (tokens.length && /^(?:.*[/\\])?ffmpeg(?:\.exe)?$/i.test(tokens[0])) tokens = tokens.slice(1);

  const out = normaliseTemplateOptions(base || TEMPLATE_PARSE_BASELINE, { container });
  out.advanced = normaliseAdvanced(base?.advanced || out.advanced);
  // Occurrences found in the text are merged back into the stored list rather
  // than into a flag-keyed map: `-metadata` may legitimately appear twice, and
  // a map would silently keep only the last one.
  const parsedAdvanced = [];
  const setAdvanced = (flag, value, side) => parsedAdvanced.push({ flag, value, side });
  const unhandledIn = [];
  const unhandledOut = [];
  let inputSide = true;
  let videoCopy = false;
  let subMap = false;
  let snSeen = false;
  let subCodec = null;
  let sawScale = false;

  // The container decides which flags are "the renderer's own defaults" (and
  // are therefore re-rendered rather than kept as an explicit override). `-f`
  // may appear anywhere before the target, so look at the whole command first.
  let declaredFormat = null;
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i] !== '-f') continue;
    declaredFormat = CONTAINER_ALIASES[String(tokens[i + 1]).toLowerCase()] || declaredFormat;
  }
  const defaultsForContainer = new Map(
    (CONTAINER_FLAGS[declaredFormat || (TEMPLATE_CONTAINERS.includes(container) ? container : out.output_format)] || [])
      .map(([flag, value]) => [flag, value]),
  );
  const take = (index) => (index + 1 < tokens.length ? tokens[index + 1] : null);
  const isOwnedAdvanced = (flag) => ADVANCED_BY_FLAG.has(flag);
  /** A container default the renderer re-creates from the container field. */
  const isContainerDefault = (flag, value) => value !== null && defaultsForContainer.get(flag) === value;

  for (let i = 0; i < tokens.length;) {
    const token = tokens[i];
    const next = take(i);

    if (token === '-i') {
      inputSide = false;
      i += next === null ? 1 : 2;
      continue;
    }

    if (inputSide) {
      if (token === '-init_hw_device') {
        const spec = String(next || '');
        if (spec.startsWith('vaapi')) {
          out.hw_accel = 'vaapi';
          if (spec.includes(':')) out.device = spec.slice(spec.indexOf(':') + 1);
        } else if (spec.startsWith('qsv')) {
          out.hw_accel = 'qsv';
          const rest = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : '';
          if (rest) out.device = rest.replace(/^hw:/, '');
        }
        i += 2;
        continue;
      }
      if (OWNED_NO_VALUE.has(token)) { i += 1; continue; }
      if (OWNED_DEFAULTS.has(token)) {
        // The built-in default is consumed and re-emitted; any other value is
        // the operator's override and is kept verbatim.
        if (next === null || next === OWNED_DEFAULTS.get(token)) { i += next === null ? 1 : 2; continue; }
        unhandledIn.push(token, next); i += 2; continue;
      }
      if (OWNED_WITH_VALUE.has(token)) { i += next === null ? 1 : 2; continue; }
      if (isContainerDefault(token, next)) { i += 2; continue; }
      if (isOwnedAdvanced(token)) {
        if (next === null) { setAdvanced(token, '', ADVANCED_BY_FLAG.get(token).side); i += 1; }
        else { setAdvanced(token, next, ADVANCED_BY_FLAG.get(token).side); i += 2; }
        continue;
      }
      if (token.startsWith('-') && token !== '-') {
        // Unknown option: keep it verbatim, with its value when it has one.
        if (next !== null && !next.startsWith('-')) { unhandledIn.push(token, next); i += 2; }
        else { unhandledIn.push(token); i += 1; }
        continue;
      }
      i += 1;
      continue;
    }

    // ------------------------------- output side ---------------------------
    if (token === '-vf' || token === '-filter:v') {
      let chain = String(next || '');
      // A preset is a whole snippet (a CPU deinterlacer is `hwdownload,…,hwupload`
      // — four filters), so match it as a comma-boundary prefix before the
      // individual filters are inspected.
      for (const preset of VF_PRESETS) {
        const match = [preset.vaapi, preset.qsv, preset.sw]
          .filter(Boolean)
          .find((snippet) => chain === snippet || chain.startsWith(`${snippet},`));
        if (!match) continue;
        out.vf_preset = preset.id;
        chain = chain.slice(match.length).replace(/^,/, '');
        break;
      }
      for (const filter of splitFilterChain(chain)) {
        if (filter.startsWith('scale_vaapi')) {
          out.hw_accel = 'vaapi'; sawScale = true;
          const size = /scale_vaapi=(?:w=)?(\d+)(?::h=|:)(\d+)/.exec(filter);
          if (size) applySize(out, Number(size[1]), Number(size[2]));
        } else if (filter.startsWith('scale_qsv')) {
          out.hw_accel = 'qsv'; sawScale = true;
          const size = /scale_qsv=(?:w=)?(\d+)(?::h=|:)(\d+)/.exec(filter);
          if (size) applySize(out, Number(size[1]), Number(size[2]));
        } else if (filter.startsWith('scale=')) {
          out.hw_accel = 'none'; sawScale = true;
          const size = /scale=(?:w=)?(\d+)(?::h=|:)(\d+)/.exec(filter);
          if (size) applySize(out, Number(size[1]), Number(size[2]));
        } else if (filter.startsWith('fps=')) {
          out.fps = filter.slice(4).replace(/\/.*$/, '');
        } else if (filter === 'setsar=1' || filter === 'format=yuv420p' || filter === 'format=nv12' || filter === 'null') {
          // renderer-owned no-ops
        } else {
          const owner = VF_PRESETS.find((p) => filter === p.vaapi || filter === p.qsv || filter === p.sw);
          if (owner) out.vf_preset = owner.id;
          else warnings.push(`unrecognised video filter '${filter}' — it cannot be represented as a field and will be dropped`);
        }
      }
      i += next === null ? 1 : 2;
      continue;
    }
    if (token === '-map') { if (String(next || '').includes(':s')) subMap = true; i += 2; continue; }
    if (token === '-an') { out.audio_codec = 'none'; i += 1; continue; }
    if (token === '-sn') { snSeen = true; i += 1; continue; }
    if (token === '-dn') { i += 1; continue; }
    if (token === '-c:s' || token === '-scodec') { subCodec = next; i += 2; continue; }
    if (token === '-low_power') { out.low_power = toBool(next, true); i += 2; continue; }
    if (token === '-rc_mode') { out.rc_mode = String(next || '').toUpperCase(); i += 2; continue; }
    if (token === '-profile:v' || token === '-profile') { out.profile = String(next || ''); i += 2; continue; }
    if (CODEC_FLAGS[token]) {
      const key = CODEC_FLAGS[token];
      out[key] = String(next || '');
      if (key === 'video_codec' && out.video_codec === 'copy') { videoCopy = true; out.hw_accel = 'none'; out.resolution = 'source'; }
      i += 2;
      continue;
    }
    if (VIDEO_VALUE_FLAGS[token]) { out[VIDEO_VALUE_FLAGS[token]] = String(next || ''); i += 2; continue; }
    if (AUDIO_VALUE_FLAGS[token]) { out[AUDIO_VALUE_FLAGS[token]] = String(next || ''); i += 2; continue; }
    if (token === '-f') {
      const fmt = CONTAINER_ALIASES[String(next || '').toLowerCase()];
      if (fmt) out.output_format = fmt;
      else if (next) unhandledOut.push(token, next);
      i += 2;
      continue;
    }
    if (token === 'pipe:1' || token === '-' || token === OUTPUT_TOKEN || token === URL_TOKEN || token === 'index.m3u8') { i += 1; continue; }
    if (isContainerDefault(token, next)) { i += 2; continue; }
    if (isOwnedAdvanced(token)) {
      if (next === null || (next.startsWith('-') && !/^-\d/.test(next))) {
        setAdvanced(token, '', ADVANCED_BY_FLAG.get(token).side);
        i += 1;
      } else {
        setAdvanced(token, next, ADVANCED_BY_FLAG.get(token).side);
        i += 2;
      }
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      if (next !== null && !next.startsWith('-')) { unhandledOut.push(token, next); i += 2; }
      else { unhandledOut.push(token); i += 1; }
      continue;
    }
    i += 1;
  }

  out.extra_input = joinTemplateTokens(unhandledIn);
  out.extra_output = joinTemplateTokens(unhandledOut);
  if (container && TEMPLATE_CONTAINERS.includes(container)) out.output_format = container;
  // Merge: update the stored entry in place when the flag was already there
  // (a partial parse must not reorder the table), append anything new.
  const merged = out.advanced.map((entry) => ({ ...entry }));
  const consumed = new Set();
  for (const found of parsedAdvanced) {
    const index = merged.findIndex((entry, position) => entry.flag === found.flag && !consumed.has(position));
    if (index >= 0) { merged[index] = { ...found }; consumed.add(index); }
    else { merged.push({ ...found }); consumed.add(merged.length - 1); }
  }
  out.advanced = merged.filter((entry) => {
    // Defaults the renderer re-creates are dropped again, so a round trip is a
    // fixed point instead of a command that grows one copy per save.
    if (entry.value !== '' && entry.value === defaultsForContainer.get(entry.flag)) return false;
    const bsfDefault = out.video_codec === 'copy' && out.output_format === 'mpegts' && entry.flag === '-bsf:v' && entry.value === 'h264_mp4toannexb';
    return !bsfDefault;
  });

  // Subtitle verdict, order-independent: a subtitle map or codec without -sn
  // means "keep as DVB"; an explicit -sn alone means drop; nothing mentioned
  // keeps the base value.
  if ((subMap || subCodec !== null) && !snSeen) {
    out.subs = out.output_format === 'matroska' && subCodec === 'copy' ? 'keep' : 'dvb';
    if (out.subs === 'keep' && subCodec && subCodec !== 'copy') {
      warnings.push(`the command encodes subtitles with -c:s ${subCodec}; the Subtitles field copies every track (use the full command for a specific subtitle codec)`);
    }
  } else if (snSeen) {
    out.subs = 'drop';
  }
  if (!videoCopy && !sawScale && out.video_codec !== 'copy' && out.resolution !== 'source') {
    // No scale filter in the text: the command does not resize, so neither
    // should the fields claim it does.
    warnings.push('the command has no scale filter — set the output size to source to keep it that way');
  }
  return { options: out, warnings };
}

function applySize(out, width, height) {
  const preset = Object.entries(RESOLUTIONS).find(([, size]) => size[1] === height);
  if (!preset) { out.resolution = `${width}x${height}`; return; }
  const label = preset[0];
  const exact = targetSize(label, '16:9');
  if (exact && exact[0] === width) { out.resolution = label; return; }
  const aspect = Object.entries(ASPECT_RATIOS).find(([key, ratio]) =>
    targetSize(label, key)?.[0] === width);
  if (aspect) { out.resolution = label; out.aspect = aspect[0]; return; }
  out.resolution = `${width}x${height}`;
}

/* ------------------------------------------------------------------ *
 * schema for the API/UI
 * ------------------------------------------------------------------ */

/** Everything the browser needs to draw the parameter form. */
export function templateOptionsSchema() {
  return {
    fields: TEMPLATE_FIELDS.map((definition) => ({ ...definition })),
    groups: TEMPLATE_GROUPS,
    advanced: ADVANCED_OPTIONS.map((entry) => ({ ...entry })),
    vfPresets: VF_PRESETS.map(({ id, label, hint, cpu, doubles }) => ({ id, label, hint, cpu: Boolean(cpu), doubles: Boolean(doubles) })),
    containers: TEMPLATE_CONTAINERS,
    hwAcceleration: HW_ACCELERATION,
    videoCodecs: VIDEO_CODECS,
    audioCodecs: AUDIO_CODECS,
    // The editor needs to know which encoders accept VAAPI tuning and which
    // take -profile:v/-level; sending them avoids a second hard-coded copy in
    // public/ffmpeg-editor.js drifting away from this file.
    vaapiEncoders: VAAPI_ENCODERS,
    h264Encoders: H264_ENCODERS,
    rcModes: RC_MODES,
    subModes: SUB_MODES,
    resolutions: Object.keys(RESOLUTIONS),
    aspects: Object.keys(ASPECT_RATIOS),
    defaults: { ...TEMPLATE_OPTION_DEFAULTS },
    runtimeDefaults: RUNTIME_DEFAULTS,
    formOwnedFlags: [...FORM_OWNED_FLAGS],
    urlToken: URL_TOKEN,
    outputToken: OUTPUT_TOKEN,
  };
}

export default {
  URL_TOKEN, OUTPUT_TOKEN, TEMPLATE_FIELDS, TEMPLATE_GROUPS, ADVANCED_OPTIONS, VF_PRESETS,
  TEMPLATE_OPTION_DEFAULTS, TEMPLATE_CONTAINERS, RESOLUTIONS, ASPECT_RATIOS,
  normaliseTemplateOptions, validateTemplateOptions, templateOptionWarnings, activeParameters,
  buildTemplateCommand, renderTemplate, parseTemplateCommand, templateOptionsSchema, TEMPLATE_PARSE_BASELINE,
  targetSize, vfSnippet, vfPresetNeeds, joinTemplateTokens, splitFlagString, quoteTemplateToken,
};
