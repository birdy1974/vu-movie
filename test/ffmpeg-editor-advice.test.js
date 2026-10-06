/**
 * The editor's advice pane must never throw.
 *
 * Regression for a one-word typo that took the whole Transcode tab down:
 * `VAAPI()` is the accessor for the encoder list (the list comes from the
 * server schema), but the VAAPI/CPU-encoder hint compared against the function
 * itself (`VAAPI.includes(...)`), so *any* VAAPI template threw a TypeError
 * while rendering. build() caught it and printed "could not render: …" — and
 * because the pane was never repainted, the warnings from the previous
 * parameter set stayed on screen, which is why a template that really was set
 * to `hw_accel: vaapi` kept showing "hardware decode is set to Quick Sync …".
 *
 * public/*.js are browser scripts in one shared global scope (core.js defines
 * `state`, `$`, `escapeHtml`; the editor is an IIFE that hangs itself on
 * `window`), so the test evaluates the real file in a vm context instead of
 * re-implementing it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const editorSource = fs.readFileSync(path.join(ROOT, 'public', 'ffmpeg-editor.js'), 'utf8');

const SCHEMA = {
  vaapiEncoders: ['h264_vaapi', 'hevc_vaapi', 'vp8_vaapi', 'vp9_vaapi', 'av1_vaapi'],
  h264Encoders: ['libx264', 'h264_vaapi', 'h264_qsv', 'h264_nvenc'],
  vfPresets: [{ id: 'none', label: 'none', vaapi: '', qsv: '', sw: '' }],
  defaults: {},
};

/** Load public/ffmpeg-editor.js in a bare context and hand back its API. */
function loadEditor({ schema = SCHEMA } = {}) {
  const sandbox = {
    state: { ffmpegTemplateSchema: schema },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    window: {},
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(editorSource, sandbox, { filename: 'ffmpeg-editor.js' });
  return sandbox.window.VMFfmpegEditor;
}

const base = (over = {}) => ({
  output_format: 'mpegts', hw_accel: 'vaapi', device: '/dev/dri/renderD128',
  resolution: 'source', aspect: '16:9', video_codec: 'h264_vaapi',
  video_bitrate: '8000k', maxrate: '', bufsize: '', fps: '', gop: '', profile: '', level: '',
  vf_preset: 'none', low_power: false, rc_mode: 'VBR', global_quality: '', async_depth: '',
  audio_codec: 'copy', audio_bitrate: '', audio_channels: '', audio_rate: '', subs: 'drop',
  extra_input: '', extra_output: '', advanced: [], ...over,
});

test('a VAAPI template renders advice instead of throwing', () => {
  const editor = loadEditor();
  let advice;
  assert.doesNotThrow(() => { advice = editor.adviceFor(base(), 'mpegts'); }, 'the VAAPI hint used to call the accessor as a list');
  assert.ok(Array.isArray(advice) && advice.length > 0, 'advice is produced');
  const texts = advice.map((entry) => entry.text).join('\n');
  assert.doesNotMatch(texts, /CPU encoder: frames will be copied back/, 'h264_vaapi IS a VAAPI encoder — no copy-back hint');
});

test('a CPU encoder behind VAAPI decoding still gets the copy-back hint', () => {
  const editor = loadEditor();
  const advice = editor.adviceFor(base({ video_codec: 'libx264' }), 'mpegts');
  assert.match(advice.map((entry) => entry.text).join('\n'), /VAAPI decoding feeds a CPU encoder/);
});

test('the encoder lists come from the server schema, with a built-in fallback', () => {
  const custom = loadEditor({ schema: { ...SCHEMA, vaapiEncoders: ['h264_vaapi', 'custom_vaapi'] } });
  const texts = custom.adviceFor(base({ video_codec: 'custom_vaapi' }), 'mpegts').map((entry) => entry.text).join('\n');
  assert.doesNotMatch(texts, /VAAPI decoding feeds a CPU encoder/, 'an encoder the schema lists as VAAPI must count as one');

  const noSchema = loadEditor({ schema: { ...SCHEMA, vaapiEncoders: [] } });
  const fallback = noSchema.adviceFor(base({ video_codec: 'libx264' }), 'mpegts').map((entry) => entry.text).join('\n');
  assert.match(fallback, /VAAPI decoding feeds a CPU encoder/, 'without a schema list the built-in list is used');
});

test('a warning the server already worded is not repeated by the client', () => {
  const editor = loadEditor();
  const server = [{ level: 'warn', text: 'h264_vaapi is a VAAPI encoder but hardware decoding is set to none' }];
  const advice = editor.adviceFor(base({ hw_accel: 'none' }), 'mpegts', server);
  const texts = advice.map((entry) => entry.text);
  assert.equal(texts.filter((text) => /hardware decoding (is set to none|is off)/.test(text)).length, 1, texts.join(' | '));
  assert.match(texts.join('\n'), /is a VAAPI encoder but hardware decoding is set to none/, 'the server wording is kept');
});

test('the accessor functions are always called, never used as lists', () => {
  // `VAAPI` and `H264` are functions returning the (schema-driven) lists. Using
  // them as lists throws inside the advice pane and silently disables it.
  for (const [name, pattern] of Object.entries({ VAAPI: /\bVAAPI\.includes\b/, H264: /\bH264\.includes\b/ })) {
    assert.doesNotMatch(editorSource, pattern, `${name} is called as a function — see VAAPI()/H264() in public/ffmpeg-editor.js`);
  }
});
