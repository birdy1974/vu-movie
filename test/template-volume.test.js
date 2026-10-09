/**
 * The "Volume change" field of an FFmpeg template (audio_gain): a level change
 * in dB for the audio of one output, set from a slider in the template editor.
 *
 * Why it is built this way (measured with ffmpeg 7.0 on synthetic programme
 * material, AC-3 and AAC encoders, decoded again to read the level):
 *  - -af cannot be combined with -c:a copy (ffmpeg refuses the command), so a
 *    level change re-encodes the audio or it is not applied at all;
 *  - volume=+6dB is exact with alimiter level=disabled; with auto level on the
 *    output came out about 0.4 dB hotter than asked for;
 *  - a boost pushes full-scale peaks over 0 dBFS, which the encoder clips. The
 *    limiter at 0.89 kept the decoded peaks under -0.7 dBFS;
 *  - a limiter placed before a stereo downmix did not hold the peaks, because
 *    the downmix happens after the chain, so the layout is set inside the chain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  TEMPLATE_FIELDS, TEMPLATE_OPTION_DEFAULTS, templateOptionsSchema,
  buildTemplateCommand, parseTemplateCommand, renderTemplate, validateTemplateOptions,
  activeParameters, audioGainFilter,
} from '../src/core/ffmpeg-options.js';
import { buildFfmpegTemplateArgs } from '../src/core/media.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const browserSource = (file) => fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');

/** A passthrough TS template for the Enigma2 box: video copied, audio chosen per test. */
const BOX = { video_codec: 'copy', output_format: 'mpegts' };
const LIMITER = 'alimiter=limit=0.89:level=disabled';

/* ----------------------------------------------------- the field itself */

test('the volume change is a -12 to +12 dB slider in the audio group, off by default', () => {
  const field = TEMPLATE_FIELDS.find((definition) => definition.key === 'audio_gain');
  assert.ok(field, 'the audio_gain field exists');
  assert.equal(field.kind, 'decibels');
  assert.equal(field.group, 'audio');
  assert.equal(field.min, -12);
  assert.equal(field.max, 12);
  assert.equal(field.step, 1);
  assert.ok(field.label && field.help, 'it has a label and a help text');
  assert.equal(TEMPLATE_OPTION_DEFAULTS.audio_gain, '0');
  assert.ok(templateOptionsSchema().fields.some((definition) => definition.key === 'audio_gain' && definition.kind === 'decibels'));
});

test('a boost re-encodes through a limiter that sits just under full scale', () => {
  const command = buildTemplateCommand({ ...BOX, audio_codec: 'ac3', audio_gain: '6' }, { container: 'mpegts' });
  assert.match(command, new RegExp(`-c:a ac3 -af volume=6dB,${LIMITER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`));
  assert.equal(command.match(/-af /g).length, 1, 'one audio filter, not two');
});

test('a cut needs no limiter', () => {
  const command = buildTemplateCommand({ ...BOX, audio_codec: 'aac', audio_gain: '-3' }, { container: 'mpegts' });
  assert.match(command, /-af volume=-3dB(?: |$)/);
  assert.doesNotMatch(command, /alimiter/);
});

test('with a channel count the layout is set inside the chain, ahead of the limiter', () => {
  const stereo = buildTemplateCommand({ ...BOX, audio_codec: 'ac3', audio_channels: '2', audio_gain: '6' }, { container: 'mpegts' });
  assert.match(stereo, /-ac 2 -af aformat=channel_layouts=stereo,volume=6dB,alimiter=/);
  const surround = buildTemplateCommand({ ...BOX, audio_codec: 'ac3', audio_channels: '6', audio_gain: '-3' }, { container: 'mpegts' });
  assert.match(surround, /-ac 6 -af aformat=channel_layouts=5\.1,volume=-3dB(?: |$)/);
});

test('a level of zero leaves every command exactly as it was before the field existed', () => {
  const cases = [
    { audio_codec: 'ac3' },
    { audio_codec: 'aac', audio_channels: '2', audio_bitrate: '192k' },
    { audio_codec: 'copy' },
    { audio_codec: 'none' },
    { video_codec: 'libx264', resolution: '720p', video_bitrate: '4000k', audio_codec: 'ac3' },
  ];
  for (const options of cases) {
    const without = buildTemplateCommand({ ...BOX, ...options }, { container: 'mpegts' });
    const withZero = buildTemplateCommand({ ...BOX, ...options, audio_gain: '0' }, { container: 'mpegts' });
    assert.equal(withZero, without, JSON.stringify(options));
    assert.doesNotMatch(without, /-af /, JSON.stringify(options));
  }
});

test('copied or removed audio gets no filter, and the form says why', () => {
  const copied = renderTemplate({ ...BOX, audio_codec: 'copy', audio_gain: '6' }, { container: 'mpegts' });
  assert.doesNotMatch(copied.command, /-af /);
  assert.ok(copied.warnings.some((text) => /not applied while the audio is copied/.test(text)), copied.warnings.join(' | '));

  const removed = renderTemplate({ ...BOX, audio_codec: 'none', audio_gain: '6' }, { container: 'mpegts' });
  assert.doesNotMatch(removed.command, /-af /);
  assert.ok(removed.warnings.some((text) => /audio is removed/.test(text)), removed.warnings.join(' | '));
});

test('a filter the operator wrote is not doubled: the level change is refused with a reason', () => {
  const result = renderTemplate({ ...BOX, audio_codec: 'ac3', audio_gain: '6', extra_output: '-af aresample=async=1000' }, { container: 'mpegts' });
  assert.equal(result.command.match(/-af /g).length, 1);
  assert.match(result.command, /-af aresample=async=1000/);
  assert.ok(result.warnings.some((text) => /already carry an audio filter/.test(text)), result.warnings.join(' | '));
});

test('fields → command → fields is a fixed point for the level change', () => {
  for (const gain of ['6', '-3', '0', '12', '-12']) {
    for (const channels of ['', '2', '6']) {
      for (const codec of ['ac3', 'aac']) {
        const options = { ...BOX, audio_codec: codec, audio_channels: channels, audio_gain: gain };
        const once = buildTemplateCommand(options, { container: 'mpegts' });
        const label = JSON.stringify({ gain, channels, codec });
        // No base: the level has to come back out of the command text itself.
        const parsed = parseTemplateCommand(once, { container: 'mpegts' });
        assert.equal(parsed.options.audio_gain, gain === '0' ? '' : String(Number(gain)), label);
        assert.equal(buildTemplateCommand(parsed.options, { container: 'mpegts' }), once, `drifted: ${label}`);
        assert.deepEqual(parsed.warnings, [], label);
      }
    }
  }
});

test('a hand-written level is read back into the field, and another filter stays as typed', () => {
  const head = 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -c:v copy -c:a ac3';
  const tail = '-f mpegts pipe:1';

  const boost = parseTemplateCommand(`${head} -af "volume=6dB,${LIMITER}" ${tail}`, { container: 'mpegts' });
  assert.equal(boost.options.audio_gain, '6');
  assert.equal(boost.options.extra_output, '');

  const cut = parseTemplateCommand(`${head} -filter:a volume=-3dB ${tail}`, { container: 'mpegts' });
  assert.equal(cut.options.audio_gain, '-3');

  const plus = parseTemplateCommand(`${head} -af volume=+4dB ${tail}`, { container: 'mpegts' });
  assert.equal(plus.options.audio_gain, '4');

  const foreign = parseTemplateCommand(`${head} -af aresample=async=1000 ${tail}`, { container: 'mpegts' });
  assert.match(foreign.options.extra_output, /-af aresample=async=1000/);
  assert.equal(foreign.options.audio_gain, '');
  assert.deepEqual(foreign.warnings, []);

  const mixed = parseTemplateCommand(`${head} -af "volume=2dB,hqdn3d=1" ${tail}`, { container: 'mpegts' });
  assert.match(mixed.options.extra_output, /-af volume=2dB,hqdn3d=1/);
  assert.equal(mixed.options.audio_gain, '');
});

test('the level is validated: a slider value from -12 to +12 dB and nothing else', () => {
  for (const ok of ['', '0', '6', '-12', '12', '2.5', '+4']) {
    assert.deepEqual(validateTemplateOptions({ audio_gain: ok }, { container: 'mpegts' }), [], `"${ok}" should be accepted`);
  }
  for (const bad of ['13', '-13', 'loud', '6dB', 'NaN']) {
    const errors = validateTemplateOptions({ audio_gain: bad }, { container: 'mpegts' });
    assert.ok(errors.some((text) => /Volume change/.test(text)), `"${bad}" should be refused: ${errors.join(' | ')}`);
  }
});

test('the level counts as in effect only when it changes the output', () => {
  assert.equal(activeParameters({ ...BOX, audio_codec: 'ac3', audio_gain: '6' }, { container: 'mpegts' }).audioGain, true);
  assert.equal(activeParameters({ ...BOX, audio_codec: 'copy', audio_gain: '6' }, { container: 'mpegts' }).audioGain, false);
  assert.equal(activeParameters({ ...BOX, audio_codec: 'ac3', audio_gain: '0' }, { container: 'mpegts' }).audioGain, false);
  assert.equal(activeParameters({ ...BOX, audio_codec: 'ac3', audio_gain: '6', extra_output: '-af aresample=1' }, { container: 'mpegts' }).audioGain, false);
});

test('the helper gives the chain for a level and nothing for zero', () => {
  assert.equal(audioGainFilter('6'), `volume=6dB,${LIMITER}`);
  assert.equal(audioGainFilter('6', '2'), `aformat=channel_layouts=stereo,volume=6dB,${LIMITER}`);
  assert.equal(audioGainFilter('-3', '6'), 'aformat=channel_layouts=5.1,volume=-3dB');
  assert.equal(audioGainFilter('0'), null);
  assert.equal(audioGainFilter(''), null);
});

test('the relay gets the chain as one argument, not split at its commas', () => {
  const command = buildTemplateCommand({ ...BOX, audio_codec: 'ac3', audio_channels: '2', audio_gain: '6' }, { container: 'mpegts' });
  const args = buildFfmpegTemplateArgs({
    template: command,
    source: { url: 'https://example.test/movie.mp4' },
    profile: {},
    mode: 'live',
    output: { target: 'pipe:1' },
  });
  const at = args.indexOf('-af');
  assert.ok(at > 0, args.join(' '));
  assert.equal(args[at + 1], `aformat=channel_layouts=stereo,volume=6dB,${LIMITER}`);
});

/* ------------------------------------------------- the browser side */

/** A minimal element for the browser scripts: records what they write and handlers they attach. */
function makeElement(selector = '') {
  const classes = new Set();
  const children = new Map();
  return {
    selector,
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    dataset: {},
    style: {},
    handlers: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, on) => {
        const next = on === undefined ? !classes.has(name) : Boolean(on);
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) { this[name] = String(value); },
    getAttribute(name) { return this[name] ?? null; },
    removeAttribute(name) { delete this[name]; },
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
    removeEventListener() {},
    querySelector(child) {
      if (!children.has(child)) children.set(child, makeElement(child));
      return children.get(child);
    },
    querySelectorAll: () => [],
    closest: () => null,
    appendChild() {}, append() {}, replaceChildren() {}, remove() {}, focus() {}, blur() {}, click() {}, select() {}, setSelectionRange() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  };
}

/** Load core.js and the template editor in one browser-like sandbox, with the server's schema. */
function loadEditorPage() {
  const elements = new Map();
  const elementFor = (selector) => {
    if (!elements.has(selector)) elements.set(selector, makeElement(selector));
    return elements.get(selector);
  };
  const document = {
    readyState: 'loading',
    hidden: false,
    body: elementFor('body'),
    querySelector: elementFor,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    createElement: () => makeElement(),
    execCommand: () => false,
  };
  const store = new Map();
  const sandbox = {
    console,
    document,
    Option: class Option { constructor(text = '', value = '') { this.text = text; this.value = value; } },
    window: {
      addEventListener() {}, removeEventListener() {}, location: { hash: '' }, innerWidth: 1280, innerHeight: 800,
    },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    // Scheduled builds would call the API: the test drives the editor directly instead.
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    AbortController, URL, URLSearchParams, TextEncoder, TextDecoder, Blob, performance,
    fetch: () => Promise.reject(new Error('no network in this test')),
    __schema: templateOptionsSchema(),
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(browserSource('core.js'), context, { filename: 'public/core.js' });
  vm.runInContext('state.ffmpegTemplateSchema = __schema;', context);
  vm.runInContext(browserSource('ffmpeg-editor.js'), context, { filename: 'public/ffmpeg-editor.js' });
  return { editor: sandbox.window.VMFfmpegEditor, elementFor };
}

test('the editor reads the level as off for copy and as live for a re-encode', () => {
  const { editor } = loadEditorPage();
  const copied = editor.computeActive({ ...BOX, audio_codec: 'copy', audio_gain: '6' }, 'mpegts').active.audio_gain;
  assert.equal(copied.on, false);
  assert.match(copied.why, /copied/);
  const encoded = editor.computeActive({ ...BOX, audio_codec: 'ac3', audio_gain: '6' }, 'mpegts').active.audio_gain;
  assert.equal(encoded.on, true);
});

test('the editor draws a slider with a live readout, and moving it sets the level', () => {
  const { editor, elementFor } = loadEditorPage();
  const host = elementFor('#host');
  const instance = editor.create({ host });
  editor.loadTemplate(instance, {
    id: 'box', name: 'Box', container: 'mpegts', enabled: true, output: {},
    command: 'ffmpeg -i <url> -c:a ac3 -af volume=6dB,alimiter=limit=0.89:level=disabled -f mpegts pipe:1',
    options: { ...BOX, audio_codec: 'ac3', audio_gain: '6' },
  });

  const grid = elementFor(`#${instance.id}-params`).innerHTML;
  assert.match(grid, /type="range"[^>]*data-param="audio_gain"/);
  assert.match(grid, /min="-12" max="12" step="1"/);
  assert.match(grid, /value="6"/);
  assert.match(grid, /<output data-param-readout="audio_gain">\+6 dB<\/output>/);

  // Move the slider to -3 and run the handler the browser would run.
  const readout = elementFor('readout-stub');
  const field = elementFor('field-stub');
  field.querySelector = (selector) => (selector === '[data-param-readout]' ? readout : null);
  const input = {
    dataset: { param: 'audio_gain' },
    value: '-3',
    closest: (selector) => (selector === '[data-param]' ? input : selector === '.param-field' ? field : null),
  };
  const [onInput] = elementFor(`#${instance.id}`).handlers.input;
  onInput({ target: input });
  assert.equal(readout.textContent, '-3 dB');
  assert.equal(instance.options.audio_gain, '-3');
});
