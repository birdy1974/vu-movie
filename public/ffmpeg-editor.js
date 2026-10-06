/* vu-movie — the FFmpeg parameter editor.
 *
 * One component, used twice:
 *   - the Transcode tab, where it edits a *saved* template of the library
 *   - the Test tab, where it edits a working copy and runs it against a source
 *
 * What it guarantees (this is the whole point of the tab):
 *   - every individual ffmpeg parameter has a selection box with useful values
 *   - a parameter is disabled — with the reason shown — when another parameter
 *     makes it inapplicable (no scaling while the video is copied, no bitrate in
 *     a quality-driven VAAPI rate-control mode, …)
 *   - the advice pane scores the parameter set and lists what to change
 *   - the final ffmpeg command is rendered *by the server* from the parameters,
 *     and editing the command reads the parameters back, so both always agree
 *   - the test pane runs the final command against a real source and prints the
 *     raw ffmpeg output live
 *
 * The schema (field list, choices, advanced flags, defaults) comes from
 * /api/ffmpeg/templates/schema, i.e. from src/core/ffmpeg-options.js — the same
 * module the relay uses. Nothing about ffmpeg is re-implemented in the browser.
 */
'use strict';

const VMFfmpegEditor = (() => {
  // Fallbacks only: the real lists come from the server schema (see
  // src/core/ffmpeg-options.js), so adding an encoder there updates the editor.
  const VAAPI_FALLBACK = ['h264_vaapi', 'hevc_vaapi', 'vp8_vaapi', 'vp9_vaapi', 'av1_vaapi'];
  const H264_FALLBACK = ['libx264', 'h264_vaapi', 'h264_qsv', 'h264_nvenc'];
  const VAAPI = () => (Array.isArray(schema()?.vaapiEncoders) && schema().vaapiEncoders.length ? schema().vaapiEncoders : VAAPI_FALLBACK);
  const H264 = () => (Array.isArray(schema()?.h264Encoders) && schema().h264Encoders.length ? schema().h264Encoders : H264_FALLBACK);
  const QUALITY_RC = ['CQP', 'ICQ', 'QVBR'];
  const CUSTOM = '__custom__';
  const editors = new Map();
  let seq = 0;

  const schema = () => state.ffmpegTemplateSchema;
  const fields = () => schema()?.fields || [];
  const groups = () => schema()?.groups || [];
  const advancedDefs = () => schema()?.advanced || [];
  const fieldDef = (key) => fields().find((def) => def.key === key) || null;
  const advancedDef = (flag) => advancedDefs().find((entry) => entry.flag === flag) || null;

  async function ensureSchema() {
    if (state.ffmpegTemplateSchema?.fields) return state.ffmpegTemplateSchema;
    const res = await api('/api/ffmpeg/templates/schema', { silent: true });
    state.ffmpegTemplateSchema = res.schema;
    return res.schema;
  }

  function defaultOptions(container = 'mpegts') {
    const defaults = { ...(schema()?.defaults || {}), output_format: container, advanced: [] };
    if (!Array.isArray(defaults.advanced)) defaults.advanced = [];
    return defaults;
  }

  const yesNo = (value) => (value === true || value === 'true' ? 'true' : 'false');

  /* ------------------------------------------------------------------ *
   * which parameters apply right now (mirrors activeParameters() on the
   * server, plus the UI-specific reasons)
   * ------------------------------------------------------------------ */

  function computeActive(options = {}, container = 'mpegts') {
    const copy = (options.video_codec || 'copy') === 'copy';
    const transcode = !copy;
    const vaapi = VAAPI().includes(options.video_codec);
    const h264 = H264().includes(options.video_codec);
    const quality = vaapi && QUALITY_RC.includes(String(options.rc_mode || '').toUpperCase());
    const rateBased = transcode && !quality;
    const audioRateControl = options.audio_codec !== 'none' && options.audio_codec !== 'copy';
    const active = {
      output_format: { on: true },
      hw_accel: { on: transcode, why: 'the video is copied — no decoder is involved' },
      device: { on: transcode && options.hw_accel !== 'none', why: options.hw_accel === 'none' ? 'CPU decoding has no device' : 'the video is copied — no decoder is involved' },
      resolution: { on: transcode, why: 'the video is copied — scaling would need a re-encode' },
      aspect: { on: transcode && options.resolution !== 'source', why: options.resolution === 'source' ? '“source” keeps the original size, so no aspect is needed' : 'the video is copied — scaling would need a re-encode' },
      video_codec: { on: true },
      video_bitrate: { on: rateBased, why: quality ? `rc_mode ${options.rc_mode} targets a quality, not a bitrate` : 'the video is copied — nothing is encoded' },
      maxrate: { on: rateBased, why: quality ? `rc_mode ${options.rc_mode} targets a quality, not a bitrate` : 'the video is copied — nothing is encoded' },
      bufsize: { on: rateBased, why: quality ? `rc_mode ${options.rc_mode} targets a quality, not a bitrate` : 'the video is copied — nothing is encoded' },
      fps: { on: transcode, why: 'the video is copied — frame timing is untouched' },
      gop: { on: transcode, why: 'the video is copied — the source keyframes are kept' },
      profile: { on: transcode && h264, why: h264 ? 'the video is copied' : 'only the H.264 encoders take -profile:v' },
      level: { on: transcode && h264, why: h264 ? 'the video is copied' : 'only the H.264 encoders take -level' },
      rc_mode: { on: vaapi, why: vaapi ? '' : 'VAAPI rate control only applies to h264_vaapi / hevc_vaapi' },
      global_quality: { on: quality, why: quality ? '' : 'quality only applies to the CQP / ICQ / QVBR rate-control modes' },
      low_power: { on: options.video_codec === 'h264_vaapi', why: 'the low-power encoder exists for h264_vaapi only' },
      async_depth: { on: vaapi, why: 'async depth only applies to the VAAPI encoders' },
      vf_preset: { on: transcode, why: 'the video is copied — a filter would need a re-encode' },
      audio_codec: { on: true },
      audio_bitrate: { on: audioRateControl, why: options.audio_codec === 'none' ? 'the audio is removed' : 'the audio is copied — its bitrate is the source bitrate' },
      audio_channels: { on: audioRateControl, why: options.audio_codec === 'none' ? 'the audio is removed' : 'the audio is copied — its layout is the source layout' },
      audio_rate: { on: audioRateControl, why: options.audio_codec === 'none' ? 'the audio is removed' : 'the audio is copied — its rate is the source rate' },
      subs: { on: true },
      extra_input: { on: true },
      extra_output: { on: true },
    };
    return { active, copy, transcode, vaapi, h264, quality, rateBased, audioRateControl, container };
  }

  /* ------------------------------------------------------------------ *
   * the advice pane: errors, warnings and optimisation hints
   * ------------------------------------------------------------------ */

  function adviceFor(options, container, extra = []) {
    const facts = computeActive(options, container);
    const out = [...extra];
    const rate = (value) => Number(String(value || '').replace(/[kKmM]$/, '')) * (/[mM]$/.test(String(value)) ? 1000 : 1);
    const bitrate = rate(options.video_bitrate);
    const maxrate = rate(options.maxrate);
    const bufsize = rate(options.bufsize);
    const audioBitrate = rate(options.audio_bitrate);

    // --- errors/warnings first (they come from the server renderer) --------
    if (!facts.transcode) {
      out.push({ level: 'info', text: 'Passthrough: the source video is remuxed, so this template costs almost no CPU. Only the container, subtitles and the audio codec can be changed.' });
      if (options.audio_codec !== 'copy' && options.audio_codec !== 'none') {
        out.push({ level: 'info', text: `The audio is re-encoded to ${options.audio_codec} while the video is copied — that is fine, but it still uses CPU on the NAS.` });
      }
    } else {
      // --- bitrate sanity --------------------------------------------------
      if (facts.rateBased && !bitrate && facts.vaapi) {
        out.push({ level: 'warn', text: 'No video bitrate set: VAAPI falls back to its own default rate control, which can look soft. 8000k for 1080p, 4000k for 720p is a good starting point.' });
      }
      if (facts.rateBased && bitrate) {
        const targetLines = { 480: 1500, 720: 3000, 1080: 6000, 1440: 12000, 2160: 20000 }[String(options.resolution || '').replace('p', '')];
        if (targetLines && bitrate < targetLines * 0.6) {
          out.push({ level: 'warn', text: `${options.video_bitrate} is low for ${options.resolution}: expect visible blocking in fast scenes (about ${targetLines}k is a good target).` });
        }
        if (targetLines && bitrate > targetLines * 2.6) {
          out.push({ level: 'info', text: `${options.video_bitrate} is generous for ${options.resolution} — the stream will not look better than the source, only larger.` });
        }
      }
      if (facts.rateBased && bitrate && !maxrate) {
        out.push({ level: 'info', text: 'Add a peak bitrate (~1.5× the target, e.g. ' + `${Math.round(bitrate * 1.5)}k` + ') so VLC and the VU+ still have headroom without a bitrate spike stalling the buffer.' });
      }
      if (maxrate && bitrate && maxrate < bitrate) {
        out.push({ level: 'warn', text: `Peak bitrate (${options.maxrate}) is below the target bitrate (${options.video_bitrate}) — the encoder can never reach its target.` });
      }
      if (facts.rateBased && (maxrate || options.rc_mode === 'CBR') && !bufsize) {
        out.push({ level: 'info', text: 'A VBV buffer of roughly twice the bitrate (two seconds) smooths CBR/VBR output: add one, e.g. ' + `${Math.round((maxrate || bitrate || 8000) * 2)}k` + '.' });
      }
      if (bufsize && (maxrate || bitrate) && bufsize < (maxrate || bitrate)) {
        out.push({ level: 'warn', text: `The VBV buffer (${options.bufsize}) is smaller than the bitrate it has to smooth — use at least twice the peak bitrate.` });
      }
      // --- fps / gop --------------------------------------------------------
      if (options.fps && Number(options.fps) > 30 && (Number(options.resolution?.replace('p', '')) || 0) >= 1080) {
        out.push({ level: 'info', text: `${options.fps} fps at ${options.resolution} needs a high H.264 level (5.0+) and much more bitrate; the VU+ Duo2 is happiest at 25 or 30 fps.` });
      }
      if (options.gop && options.fps && Number(options.gop) > Number(options.fps) * 4) {
        out.push({ level: 'info', text: `A keyframe interval of ${options.gop} frames is ${(Number(options.gop) / Number(options.fps)).toFixed(1)} s — fine for downloads, slow for channel zapping. ${Math.round(Number(options.fps) * 2)} (= 2 s) starts almost instantly.` });
      }
      // --- VAAPI specifics --------------------------------------------------
      if (facts.vaapi && options.rc_mode === 'CQP' && !options.global_quality) {
        out.push({ level: 'warn', text: 'CQP without a quality value does nothing: set Quality (20–28 is the usable range on Apollo Lake).' });
      }
      if (facts.vaapi && options.rc_mode === 'CQP' && options.global_quality && Number(options.global_quality) < 16) {
        out.push({ level: 'info', text: `Quality ${options.global_quality} is very high — expect a filesize close to lossless and a NAS that has to work for it.` });
      }
      if (facts.vaapi && !options.async_depth) {
        out.push({ level: 'info', text: 'VAAPI throughput improves with “frames in flight” (async depth 2–4) on Apollo Lake; it costs a little latency.' });
      }
      if (options.video_codec === 'hevc_vaapi') {
        out.push({ level: 'info', text: 'Apollo Lake can decode HEVC but not encode it — hevc_vaapi will fail here. Use h264_vaapi for live playback.' });
      }
      if (options.video_codec === 'libx265') {
        out.push({ level: 'info', text: 'libx265 is CPU-only on this box: fine for downloads, too slow for live playback.' });
      }
      if (options.hw_accel === 'vaapi' && options.video_codec && !VAAPI.includes(options.video_codec) && options.video_codec !== 'copy') {
        out.push({ level: 'info', text: 'VAAPI decoding feeds a CPU encoder: the frames are copied back to system memory on every frame. h264_vaapi keeps everything on the GPU.' });
      }
      if (options.hw_accel === 'none' && facts.vaapi) {
        out.push({ level: 'warn', text: `${options.video_codec} is a GPU encoder but hardware decoding is off — the GPU still encodes, yet ffmpeg has to upload every frame. Set “Video decoding” to VAAPI.` });
      }
      if (options.hw_accel === 'vaapi' && options.vf_preset && options.vf_preset !== 'none') {
        const preset = (schema()?.vfPresets || []).find((entry) => entry.id === options.vf_preset);
        if (preset?.cpu) out.push({ level: 'info', text: `“${preset.label}” filters on the CPU: frames are downloaded and re-uploaded, which costs performance on the J3455.` });
        if (preset?.doubles && options.fps && Number(options.fps) <= 30) {
          out.push({ level: 'warn', text: `“${preset.label}” doubles the frame rate, but the fps filter then halves it right back — set FPS to 50 or leave it empty.` });
        }
      }
    }

    // --- audio / subtitles / container --------------------------------------
    if (facts.audioRateControl) {
      if (options.audio_codec === 'aac' && Number(options.audio_channels) > 2 && audioBitrate && audioBitrate <= 192) {
        out.push({ level: 'warn', text: `${options.audio_bitrate} for ${options.audio_channels} channels is thin — use 384k or more for surround, or set channels to 2.` });
      }
      if (Number(options.audio_channels) === 6 && options.audio_codec === 'aac') {
        out.push({ level: 'info', text: 'Six-channel AAC is played by every modern box; the VU+ handles it, but older receivers prefer AC3 (ac3) with the same bitrate.' });
      }
      if (Number(options.audio_rate) && Number(options.audio_rate) !== 48000) {
        out.push({ level: 'info', text: `${options.audio_rate} Hz is unusual for video — 48000 Hz is the safe choice for MPEG-TS.` });
      }
    }
    if (container === 'matroska' && options.subs === 'keep') {
      out.push({ level: 'info', text: 'Matroska + “copy all” keeps the source text subtitles (SRT/ASS) as selectable tracks — this is the only combination that can.' });
    }
    if (container !== 'matroska' && options.subs === 'keep') {
      out.push({ level: 'err', text: '“Copy all” needs the Matroska container; MPEG-TS can only carry DVB bitmap subtitles.' });
    }
    if (container !== 'matroska' && options.subs === 'dvb') {
      out.push({ level: 'warn', text: 'DVB subtitles are bitmaps and can only be copied from a source that already has DVB/PGS subtitles. A text .srt (the Playlist tab attachment) cannot be converted — use the Matroska container, or burn the subtitle into the picture.' });
    }
    if (container === 'matroska' && options.subs === 'dvb') {
      out.push({ level: 'warn', text: 'DVB subtitles belong in MPEG-TS; for Matroska “copy all” keeps every track as it is.' });
    }
    if (container === 'mpegts' && options.output_format && options.output_format !== 'mpegts') {
      out.push({ level: 'err', text: 'The output format parameter and the container disagree — the server stores the container value.' });
    }
    if (container === 'hls' && facts.rateBased && !options.gop) {
      out.push({ level: 'info', text: 'HLS segments are cut on keyframes: a keyframe interval of one to two seconds (25–50 frames) keeps segment lengths predictable.' });
    }
    if (facts.transcode && !options.extra_output) {
      out.push({ level: 'info', text: 'Nothing extra in “Extra output flags”. That is the safe default — add flags only when you know what they change.' });
    }

    // de-duplicate
    const seen = new Set();
    return out.filter((entry) => {
      const key = `${entry.level}|${entry.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /* ------------------------------------------------------------------ *
   * controls
   * ------------------------------------------------------------------ */

  const choiceLabel = (key, value) => {
    if (value === '') return ['rate', 'integer', 'number', 'positive'].includes(fieldDef(key)?.kind) || ['fps', 'gop', 'global_quality', 'async_depth', 'audio_channels', 'audio_rate', 'video_bitrate', 'maxrate', 'bufsize', 'audio_bitrate'].includes(key)
      ? '— (leave to ffmpeg)'
      : '— (default)';
    return value;
  };

  function controlMarkup(def, values = {}) {
    const key = def.key;
    const value = values[key];
    const value2 = value === undefined || value === null ? '' : String(value);
    const id = `ff-${def.key}`;
    const hint = tip(def.help, def.label ? `${def.label} — more information` : 'more information');

    if (def.kind === 'bool') {
      const current = yesNo(value);
      return `<div class="param-field" data-field="${key}">
        <label for="${id}">${escapeHtml(def.label)} ${hint}</label>
        <select id="${id}" data-param="${key}">
          <option value="false"${current === 'false' ? ' selected' : ''}>disabled</option>
          <option value="true"${current === 'true' ? ' selected' : ''}>enabled</option>
        </select>${hint}</div>`;
    }

    if (def.kind === 'flags') {
      return `<div class="param-field" data-field="${key}">
        <label for="${id}">${escapeHtml(def.label)} ${hint}</label>
        <input id="${id}" class="mono" data-param="${key}" value="${escapeHtml(value2)}" placeholder="additional ffmpeg flags" spellcheck="false" autocomplete="off"></div>`;
    }

    const choices = Array.isArray(def.choices) ? def.choices : [];
    const extra = value2 !== '' && !choices.includes(value2) ? [value2] : [];
    const optionList = [...choices, ...extra].map((choice) =>
      `<option value="${escapeHtml(choice)}"${String(choice) === value2 ? ' selected' : ''}>${escapeHtml(choiceLabel(key, choice))}</option>`).join('');
    const customSelected = extra.length > 0;
    const customInput = `<input id="${id}-custom" data-param-custom="${key}" class="mono ${customSelected ? '' : 'hide'}"
      value="${escapeHtml(customSelected ? value2 : '')}" placeholder="custom value" autocomplete="off">`;
    const placeholder = def.kind === 'resolution' ? 'e.g. 1280x720 or 900p'
      : def.kind === 'aspect' ? 'e.g. 16:9' : def.kind === 'rate' ? 'e.g. 8000k' : 'value';
    return `<div class="param-field" data-field="${key}">
      <label for="${id}">${escapeHtml(def.label)} ${hint}</label>
      <div class="param-select-row">
        <select id="${id}" data-param="${key}">${optionList}
          <option value="${CUSTOM}"${customSelected ? ' selected' : ''}>✎ custom value…</option>
        </select>
        ${customInput}
      </div></div>`;
  }

  function advancedRowMarkup(entry, index) {
    const def = advancedDef(entry.flag);
    const choices = def?.choices || [];
    const listId = `ff-adv-list-${index}`;
    return `<div class="adv-row" data-adv-index="${index}">
      <div class="adv-flag" title="${escapeHtml(def ? `${def.label} — ${def.help}` : 'custom ffmpeg flag')}">${escapeHtml(entry.flag)} <span class="adv-side">${escapeHtml(entry.side || 'output')}</span></div>
      <input class="mono" data-adv-value="${index}" value="${escapeHtml(String(entry.value ?? ''))}" placeholder="value" list="${listId}" autocomplete="off">
      <button type="button" class="btn sm ghost" data-adv-remove="${index}" title="remove">✕</button>
      <datalist id="${listId}">${choices.map((choice) => `<option value="${escapeHtml(choice)}"></option>`).join('')}</datalist>
    </div>`;
  }

  /* ------------------------------------------------------------------ *
   * editor instance
   * ------------------------------------------------------------------ */

  /**
   * Create an editor inside `host`.
   *   mode: 'library' — edits saved templates, shows save/delete/outputs
   *         'test'    — edits a working copy, no save button, test-driven
   */
  function create({ host, mode = 'library', externalTestControls = false } = {}) {
    const id = `ff-editor-${++seq}`;
    const instance = {
      id,
      mode,
      externalTestControls,
      template: null,
      options: null,
      container: 'mpegts',
      renderedCommand: '',
      optionsSynced: true,
      messages: [],
      building: false,
      test: { running: null, source: { kind: 'stream', streamId: '', url: '' }, durationMs: 5000, lines: 0 },
      requestSeq: 0,
    };

    host.innerHTML = `<div class="card ff-editor" id="${id}">
      <div class="cardhead">
        <span id="${id}-title">Template editor</span>
        <div class="row">
          <span class="mut" id="${id}-sync-status"></span>
          ${mode === 'library' ? '<button class="btn sm ghost" id="' + id + '-reset">↺ reset parameters</button>' : ''}
          ${mode === 'library' ? '<button class="btn sm pri" id="' + id + '-save">💾 save template</button>' : ''}
        </div>
      </div>
      <div class="cardbody pad12">
        <div class="f2">
          <div class="field"><label for="${id}-name">Name</label>
            <input id="${id}-name" maxlength="100" placeholder="e.g. VAAPI 1080p → MPEG-TS"></div>
          <div class="field"><label for="${id}-description">Description (optional)</label>
            <input id="${id}-description" maxlength="280" placeholder="when to use this template"></div>
        </div>
        <div class="row" style="margin-bottom:8px">
          <label class="row" style="gap:6px;margin:0;color:var(--fg)"><input type="checkbox" id="${id}-enabled" checked>
            <span class="meta" style="margin:0">available for playback (disable to keep it saved but unused)</span></label>
          <span class="mut" id="${id}-active-count"></span>
        </div>

        <h3>Individual FFmpeg parameters ${tip('Greyed-out parameters do not apply to the current combination — hover the field (or its i) to read why.')}</h3>
        <div class="param-grid" id="${id}-params"></div>

        <details class="param-advanced">
          <summary>Advanced parameters <span class="mut" id="${id}-adv-count"></span> ${tip('Anything else ffmpeg accepts. Flags the form owns (-i, -map, codecs, filters, -f …) must be set in their own parameter.')}</summary>
          <div class="row param-adv-add">
            <select id="${id}-adv-flag" style="flex:1;min-width:200px"></select>
            <input id="${id}-adv-value" class="mono" style="flex:1;min-width:120px" placeholder="value" list="${id}-adv-values">
            <datalist id="${id}-adv-values"></datalist>
            <button type="button" class="btn sm" id="${id}-adv-add">+ add</button>
          </div>
          <div class="row param-adv-add hide" id="${id}-adv-custom-row">
            <input id="${id}-adv-custom-flag" class="mono" style="flex:1;min-width:140px" placeholder="-my_flag" autocomplete="off">
            <select id="${id}-adv-custom-side" style="flex:0 0 auto">
              <option value="input">input (before -i)</option>
              <option value="output" selected>output (encoder / muxer)</option>
            </select>
          </div>
          <div id="${id}-adv-rows" class="adv-rows"></div>
        </details>

        ${mode === 'library' ? `<details class="param-advanced" id="${id}-outputs-box">
          <summary>Used for these outputs ${tip('Where this template is used when a stream has no template of its own. The default template covers everything else.')}</summary>
          <div id="${id}-outputs" class="output-grid"></div>
        </details>` : ''}

        <h3 style="margin-top:16px">Advice ${tip('The editor checks the parameter combination and flags what does not match, with the reason and a suggestion.')}</h3>
        <div class="param-messages" id="${id}-advice"></div>

        <h3 style="margin-top:16px">Final FFmpeg command ${tip('Use exactly one <url> right after -i. Output to pipe:1, or <output> for HLS. The relay adds source headers and its safe network defaults when a flag is absent.')}</h3>
        <textarea id="${id}-command" class="mono" rows="7" spellcheck="false" placeholder="ffmpeg -hide_banner -i <url> …"></textarea>
        <div class="row" style="margin-top:8px">
          <button class="btn sm" id="${id}-rebuild">↻ rebuild from parameters</button>
          <button class="btn sm ghost" id="${id}-read">↻ read parameters from command</button>
          <span class="mut" id="${id}-cmd-meta"></span>
        </div>
        <h3 style="margin-top:16px">Test the final command ${tip('Runs the command above against a real source for a few seconds and shows the raw ffmpeg output. Nothing is saved.')}</h3>
        <div class="test-pane">
          ${externalTestControls ? '' : `<div class="f2">
            <div class="field"><label for="${id}-test-source">Input source ${tip('Playlist items and saved streams keep their upstream URL and request headers.')}</label>
              <select id="${id}-test-source"></select></div>
            <div class="field"><label for="${id}-test-duration">Run for (seconds) ${tip('Max 30 s — long enough to read one keyframe, short enough that the relay never stalls.')}</label>
              <input id="${id}-test-duration" type="number" min="1" max="30" step="1" value="5"></div>
          </div>`}
          <div class="field hide" id="${id}-test-url-field"><label for="${id}-test-url">Custom source URL</label>
            <input id="${id}-test-url" class="mono" placeholder="https://…/movie.mp4"></div>
          <div class="row">
            ${externalTestControls ? '' : `<button class="btn pri" id="${id}-test-run">▷ run test</button>
            <button class="btn ghost" id="${id}-test-stop" disabled>■ stop</button>`}
            <button class="btn sm ghost" id="${id}-test-clear">clear output</button>
            ${externalTestControls ? '' : `<span class="mut" id="${id}-test-status"></span>`}
          </div>
          <div class="tpl-test-verdict" id="${id}-test-verdict" style="margin-top:10px">(not run yet)</div>
          <div class="tpl-test-progress" id="${id}-test-progress"></div>
          <pre id="${id}-test-output" class="test-output">— raw ffmpeg output appears here —</pre>
        </div>
      </div>
    </div>`;

    editors.set(id, instance);
    state.editors = Object.fromEntries(editors);
    wireInstance(instance);
    return instance;
  }

  /* ---------------- instance rendering ---------------- */

  function renderParams(instance) {
    const grid = $(`#${instance.id}-params`);
    if (!grid) return;
    const options = instance.options || {};
    grid.innerHTML = groups().map((group) => {
      const list = fields().filter((def) => def.group === group.id);
      if (!list.length) return '';
      return `<div class="param-group">${escapeHtml(group.label)}</div>${list.map((def) => controlMarkup(def, options)).join('')}`;
    }).join('');
    refreshDisabled(instance);
  }

  function renderAdvanced(instance) {
    const host = $(`#${instance.id}-adv-rows`);
    if (!host) return;
    const rows = Array.isArray(instance.options?.advanced) ? instance.options.advanced : [];
    const count = $(`#${instance.id}-adv-count`);
    if (count) count.textContent = rows.length ? `· ${rows.length} set` : '· none set';
    host.innerHTML = rows.length ? rows.map((entry, index) => advancedRowMarkup(entry, index)).join('')
      : '<div class="meta">No advanced parameters — vu-movie\'s own network/muxer defaults apply.</div>';
    const picker = $(`#${instance.id}-adv-flag`);
    if (picker) {
      const list = advancedDefs();
      picker.replaceChildren(
        ...['input', 'output'].flatMap((side) => {
          const entries = list.filter((entry) => entry.side === side);
          if (!entries.length) return [];
          const group = document.createElement('optgroup');
          group.label = side === 'input' ? 'input — before -i' : 'output — encoder / muxer';
          for (const entry of entries) group.append(new Option(`${entry.flag} — ${entry.label}`, entry.flag));
          return [group];
        }),
        new Option('custom flag…', CUSTOM),
      );
    }
    const valueList = $(`#${instance.id}-adv-values`);
    if (valueList) {
      const def = advancedDef(picker?.value);
      valueList.innerHTML = (def?.choices || []).map((choice) => `<option value="${escapeHtml(choice)}"></option>`).join('');
    }
    $(`#${instance.id}-adv-custom-row`)?.classList.toggle('hide', picker?.value !== CUSTOM);
  }

  function renderOutputs(instance) {
    const host = $(`#${instance.id}-outputs`);
    if (!host) return;
    const editor = instance.template || {};
    host.innerHTML = OUTPUT_TYPES.map((output) => {
      const on = Boolean(editor.output && editor.output[output]);
      return `<label class="row${on ? ' on' : ''}" data-output="${output}">
        <input type="checkbox" data-output-check="${output}" ${on ? ' checked' : ''}>
        <span><span class="output-name">${escapeHtml(OUTPUT_LABELS[output] || output)}</span>
        <span class="output-meta">${escapeHtml(outputHint(output))}</span></span>
      </label>`;
    }).join('');
  }

  function outputHint(output) {
    switch (output) {
      case 'vlcTs': return '.ts URL · desktop player';
      case 'vlcMkv': return '.mkv URL · desktop player';
      case 'm3u8': return 'HLS playlist URL';
      case 'm3u': return 'M3U playlist file';
      case 'enigma2': return 'Bouquet entry for VU+ / Duo2';
      case 'direct': return 'Direct 302 redirect';
      case 'download': return 'Saved-to-disk copy';
      default: return '';
    }
  }

  /** Enable/disable every control according to computeActive(). */
  function refreshDisabled(instance) {
    const { active } = computeActive(instance.options || {}, instance.container);
    let on = 0;
    for (const [key, rule] of Object.entries(active)) {
      const wrapper = $(`[data-field="${key}"]`, $(`#${instance.id}-params`));
      if (!wrapper) continue;
      const inputs = $$('select,input', wrapper);
      const disabled = !rule.on;
      inputs.forEach((input) => { input.disabled = disabled; });
      wrapper.classList.toggle('off', disabled);
      wrapper.classList.toggle('on', !disabled);
      // The "why" of a greyed-out parameter goes into its own "i" tooltip, so
      // the form stays quiet and the reason is one hover away.
      const marker = $('.tip', wrapper);
      if (disabled && rule.why) {
        if (marker) {
          marker.dataset.baseTip = marker.dataset.baseTip || marker.dataset.tip || '';
          marker.dataset.tip = `not applicable: ${rule.why}${marker.dataset.baseTip ? `. ${marker.dataset.baseTip}` : ''}`;
        }
        wrapper.title = `not applicable: ${rule.why}`;
      } else {
        if (marker && marker.dataset.baseTip) marker.dataset.tip = marker.dataset.baseTip;
        wrapper.removeAttribute('title');
      }
      if (!disabled) on += 1;
    }
    const count = $(`#${instance.id}-active-count`);
    if (count) count.textContent = `${on} parameter(s) in effect`;
  }

  function renderAdvice(instance, serverMessages = instance.messages) {
    const host = $(`#${instance.id}-advice`);
    if (!host) return;
    const advice = adviceFor(instance.options || {}, instance.container, serverMessages || []);
    if (!advice.length) {
      host.innerHTML = '<div class="param-msg ok">No remarks — the parameter set is internally consistent.</div>';
      return;
    }
    const order = { err: 0, warn: 1, info: 2, ok: 3 };
    host.innerHTML = [...advice].sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9))
      .map((entry) => `<div class="param-msg ${entry.level}">${entry.level === 'err' ? '⛔ ' : entry.level === 'warn' ? '⚠ ' : 'ℹ '}${escapeHtml(entry.text)}</div>`)
      .join('');
  }

  function renderTitle(instance) {
    const title = $(`#${instance.id}-title`);
    const name = $(`#${instance.id}-name`);
    const description = $(`#${instance.id}-description`);
    const enabled = $(`#${instance.id}-enabled`);
    const editor = instance.template;
    if (title) title.textContent = editor?.id ? `Editing “${editor.name || 'untitled'}”` : 'New template';
    if (name) name.value = editor?.name || '';
    if (description) description.value = editor?.description || '';
    if (enabled) enabled.checked = editor ? editor.enabled !== false : true;
    const save = $(`#${instance.id}-save`);
    if (save) save.disabled = !editor;
    const source = instance.mode === 'test' && editor?.sourceLabel ? ` · ${editor.sourceLabel}` : '';
    if (title) title.textContent += source;
  }

  function renderCommand(instance) {
    const textarea = $(`#${instance.id}-command`);
    if (textarea) textarea.value = instance.template?.command || '';
    const meta = $(`#${instance.id}-cmd-meta`);
    if (meta) {
      const command = instance.template?.command || '';
      meta.textContent = command ? `${command.split(/\s+/).filter(Boolean).length} tokens · ${instance.container}` : '';
    }
  }

  function renderAll(instance) {
    renderTitle(instance);
    renderParams(instance);
    renderAdvanced(instance);
    renderOutputs(instance);
    renderCommand(instance);
    renderAdvice(instance);
  }

  /* ---------------- options <-> command ---------------- */

  function optionsForRequest(instance) {
    const options = { ...(instance.options || {}) };
    options.output_format = instance.container;
    options.advanced = (options.advanced || []).map((entry) => ({ ...entry }));
    return options;
  }

  function setStatus(instance, text, kind = 'mut') {
    const el = $(`#${instance.id}-sync-status`);
    if (!el) return;
    el.textContent = text || '';
    el.className = kind === 'err' ? 'mut err-text' : 'mut';
  }

  async function build(instance, { announce = true } = {}) {
    if (!instance.template) return false;
    const seq = ++instance.requestSeq;
    const meta = $(`#${instance.id}-cmd-meta`);
    if (meta) meta.textContent = 'rendering…';
    try {
      const res = await api('/api/ffmpeg/templates/build', {
        method: 'POST', silent: true,
        body: { options: optionsForRequest(instance), container: instance.container },
      });
      if (seq !== instance.requestSeq) return false;
      instance.template.command = res.command;
      instance.renderedCommand = res.command;
      instance.optionsSynced = true;
      instance.messages = [
        ...(res.errors || []).map((text) => ({ level: 'err', text })),
        ...(res.warnings || []).map((text) => ({ level: 'warn', text })),
      ];
      const textarea = $(`#${instance.id}-command`);
      if (textarea) textarea.value = res.command;
      renderAdvice(instance);
      const metaAfter = $(`#${instance.id}-cmd-meta`);
      if (metaAfter) metaAfter.textContent = `${res.command.split(/\s+/).filter(Boolean).length} tokens · ${instance.container}`;
      if (announce) setStatus(instance, res.errors?.length ? 'the parameters need attention' : 'command rendered from the parameters');
      return true;
    } catch (error) {
      if (seq === instance.requestSeq) {
        setStatus(instance, `could not render: ${error.message}`, 'err');
        instance.messages = [{ level: 'err', text: `could not render the command: ${error.message}` }];
        renderAdvice(instance);
      }
      return false;
    }
  }

  async function readFromCommand(instance, { rebuild = false, announce = true } = {}) {
    if (!instance.template) return false;
    const command = ($(`#${instance.id}-command`)?.value ?? instance.template.command ?? '').trim();
    if (!command) return false;
    const seq = ++instance.requestSeq;
    setStatus(instance, 'reading parameters from the command…');
    try {
      const res = await api('/api/ffmpeg/templates/parse', {
        method: 'POST', silent: true,
        body: { command, container: instance.container, base: instance.options || null },
      });
      if (seq !== instance.requestSeq) return false;
      instance.options = {
        ...defaultOptions(instance.container),
        ...res.options,
        output_format: instance.container,
        advanced: Array.isArray(res.options?.advanced) ? res.options.advanced.map((entry) => ({ ...entry })) : [],
      };
      instance.optionsSynced = true;
      instance.messages = [
        ...(res.warnings || []).map((text) => ({ level: 'warn', text })),
        ...(res.errors || []).map((text) => ({ level: 'err', text })),
      ];
      renderParams(instance);
      renderAdvanced(instance);
      renderAdvice(instance);
      if (announce) setStatus(instance, 'parameters read from the command');
      if (!rebuild) return true;
      const before = command;
      const rebuilt = await build(instance, { announce: false });
      if (rebuilt && ($(`#${instance.id}-command`)?.value || '').trim() !== before) {
        instance.messages = [{ level: 'info', text: 'The command was normalised so it matches the parameters — the parameters are what gets saved and run.' }, ...instance.messages];
        renderAdvice(instance);
      }
      return rebuilt;
    } catch (error) {
      if (seq === instance.requestSeq) {
        setStatus(instance, `could not read the command: ${error.message}`, 'err');
        instance.messages = [{ level: 'err', text: `could not read the command: ${error.message}` }];
        renderAdvice(instance);
      }
      return false;
    }
  }

  const scheduleBuild = (instance) => {
    clearTimeout(instance.buildTimer);
    instance.buildTimer = setTimeout(() => build(instance, { announce: false }), 220);
  };

  const scheduleParse = (instance) => {
    clearTimeout(instance.parseTimer);
    instance.parseTimer = setTimeout(() => readFromCommand(instance, { rebuild: false, announce: false }), 700);
  };

  function applyOption(instance, key, value) {
    if (!instance.options) instance.options = defaultOptions(instance.container);
    const def = fieldDef(key);
    instance.options[key] = def?.kind === 'bool' ? value === 'true' : value;
    if (key === 'output_format') {
      instance.container = value || 'mpegts';
      instance.template.container = instance.container;
      if (instance.options) instance.options.output_format = instance.container;
    }
    refreshDisabled(instance);
    scheduleBuild(instance);
  }

  /* ---------------- template handling ---------------- */

  function loadTemplate(instance, template, { sourceLabel = '' } = {}) {
    instance.requestSeq += 1;
    instance.messages = [];
    if (!template) {
      instance.template = null;
      instance.options = null;
      renderAll(instance);
      renderAdvice(instance, []);
      return;
    }
    const container = ['mpegts', 'matroska', 'hls'].includes(template.container) ? template.container : 'mpegts';
    instance.container = container;
    instance.template = {
      ...template,
      container,
      output: { ...(template.output || {}) },
      enabled: template.enabled !== false,
      sourceLabel,
    };
    instance.renderedCommand = String(template.command || '').trim();
    if (template.options && typeof template.options === 'object') {
      instance.options = { ...defaultOptions(container), ...template.options, output_format: container };
      instance.options.advanced = Array.isArray(template.options.advanced) ? template.options.advanced.map((entry) => ({ ...entry })) : [];
      instance.optionsSynced = true;
      renderAll(instance);
    } else {
      // A template saved before this editor existed (or from the API) carries
      // only a command — read the parameters out of it.
      instance.options = defaultOptions(container);
      instance.optionsSynced = false;
      renderAll(instance);
      readFromCommand(instance, { rebuild: true, announce: false });
    }
  }

  function collectTemplate(instance) {
    const editor = instance.template || {};
    const outputs = {};
    for (const output of OUTPUT_TYPES) {
      const checkbox = $(`#${instance.id}-outputs input[data-output-check="${output}"]`);
      if (checkbox?.checked) outputs[output] = editor.id || '__self__';
    }
    const container = instance.container;
    const item = {
      id: editor.id || `template-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: $(`#${instance.id}-name`)?.value.trim() || '',
      description: $(`#${instance.id}-description`)?.value.trim() || '',
      container,
      command: ($(`#${instance.id}-command`)?.value || '').trim(),
      enabled: $(`#${instance.id}-enabled`)?.checked !== false,
      output: outputs,
    };
    if (instance.options) item.options = { ...optionsForRequest(instance), output_format: container };
    return item;
  }

  async function saveTemplate(instance, { makeDefault = false } = {}) {
    if (!instance.template) return;
    clearTimeout(instance.buildTimer);
    clearTimeout(instance.parseTimer);
    const typed = ($(`#${instance.id}-command`)?.value || '').trim();
    if (typed && (!instance.optionsSynced || typed !== instance.renderedCommand)) {
      await readFromCommand(instance, { rebuild: true, announce: false });
    }
    const item = collectTemplate(instance);
    if (!item.name) return toast('Give the template a name first', 'warn');
    if (!item.command) return toast('The template command is empty', 'warn');
    const existing = state.ffmpegTemplates.find((tpl) => tpl.id === item.id);
    const next = existing ? state.ffmpegTemplates.map((tpl) => (tpl.id === item.id ? item : tpl)) : [...state.ffmpegTemplates, item];
    const defaultFfmpegTemplateId = makeDefault ? item.id : (state.defaultFfmpegTemplateId || '');
    const ffmpegDefaults = { ...(state.ffmpegDefaults || {}) };
    for (const [output, owner] of Object.entries(ffmpegDefaults)) {
      if (owner === item.id && !item.output[output]) ffmpegDefaults[output] = '';
    }
    for (const [output, owner] of Object.entries(item.output)) {
      if (owner === '__self__' || owner === item.id) ffmpegDefaults[output] = item.id;
    }
    const res = await api('/api/ffmpeg/templates', {
      method: 'PUT',
      body: { templates: next, defaultFfmpegTemplateId, ffmpegDefaults },
    });
    state.ffmpegTemplates = res.templates;
    state.defaultFfmpegTemplateId = res.defaultFfmpegTemplateId || '';
    state.ffmpegDefaults = res.ffmpegDefaults || {};
    state.ffmpegTemplatesLoaded = true;
    const saved = state.ffmpegTemplates.find((tpl) => tpl.id === item.id) || null;
    if (instance.mode === 'library') loadTemplate(instance, saved);
    App.onTemplatesChanged?.();
    toast(makeDefault ? 'Template saved and set as default' : 'Template saved', 'ok');
    return saved;
  }

  async function deleteTemplate(instance) {
    const editor = instance.template;
    if (!editor?.id) return;
    if (!window.confirm(`Delete FFmpeg template “${editor.name || editor.id}”?`)) return;
    const templates = state.ffmpegTemplates.filter((tpl) => tpl.id !== editor.id);
    const defaultFfmpegTemplateId = state.defaultFfmpegTemplateId === editor.id ? '' : state.defaultFfmpegTemplateId;
    const ffmpegDefaults = { ...(state.ffmpegDefaults || {}) };
    for (const [output, tplId] of Object.entries(ffmpegDefaults)) if (tplId === editor.id) ffmpegDefaults[output] = '';
    const res = await api('/api/ffmpeg/templates', { method: 'PUT', body: { templates, defaultFfmpegTemplateId, ffmpegDefaults } });
    state.ffmpegTemplates = res.templates;
    state.defaultFfmpegTemplateId = res.defaultFfmpegTemplateId || '';
    state.ffmpegDefaults = res.ffmpegDefaults || {};
    if (instance.mode === 'library') loadTemplate(instance, null);
    App.onTemplatesChanged?.();
    toast('Template deleted', 'ok');
  }

  async function setDefaultTemplate(instance) {
    const editor = instance.template;
    if (!editor?.id) return;
    const res = await api('/api/ffmpeg/templates', {
      method: 'PUT',
      body: {
        templates: state.ffmpegTemplates,
        defaultFfmpegTemplateId: state.defaultFfmpegTemplateId === editor.id ? '' : editor.id,
        ffmpegDefaults: state.ffmpegDefaults,
      },
    });
    state.ffmpegTemplates = res.templates;
    state.defaultFfmpegTemplateId = res.defaultFfmpegTemplateId || '';
    state.ffmpegDefaults = res.ffmpegDefaults || {};
    App.onTemplatesChanged?.();
    toast(state.defaultFfmpegTemplateId === editor.id ? 'Set as default template' : 'Default template cleared', 'ok');
  }

  /* ---------------- test pane ---------------- */

  function renderTestSources(instance) {
    if (!instance?.id) return;
    const select = $(`#${instance.id}-test-source`);
    if (!select) return;
    const rememberedId = instance.test?.source?.streamId || '';
    const previous = select.value || (rememberedId ? `stream:${rememberedId}` : '');
    const playlistItems = VMPlaylist.items();
    const saved = state.streams || [];
    const seen = new Set();
    const options = ['<option value="">(pick a source…)</option>'];
    if (playlistItems.length) {
      options.push('<optgroup label="Playlist">');
      for (const item of playlistItems) {
        seen.add(String(item.streamId));
        options.push(`<option value="stream:${escapeHtml(item.streamId)}">${escapeHtml(item.title)}${item.enabled ? '' : ' (disabled)'}</option>`);
      }
      options.push('</optgroup>');
    }
    const others = saved.filter((stream) => !seen.has(String(stream.id)));
    if (others.length) {
      options.push('<optgroup label="Saved streams">');
      for (const stream of others) {
        options.push(`<option value="stream:${escapeHtml(stream.id)}">${escapeHtml(stream.title)}${stream.year ? ` (${stream.year})` : ''}</option>`);
      }
      options.push('</optgroup>');
    }
    options.push('<optgroup label="Other"><option value="url:">custom URL…</option></optgroup>');
    select.innerHTML = options.join('');
    if (previous && [...select.options].some((opt) => opt.value === previous)) select.value = previous;
    else if (playlistItems.length) select.value = `stream:${playlistItems[0].streamId}`;
    instance.test.source = parseSourceValue(select.value, instance);
    $(`#${instance.id}-test-url-field`)?.classList.toggle('hide', instance.test.source.kind !== 'url');
  }

  function parseSourceValue(value, instance) {
    const text = String(value || '');
    if (text.startsWith('url:')) return { kind: 'url', streamId: '', url: text.slice(4) || ($(`#${instance.id}-test-url`)?.value.trim() || '') };
    if (text.startsWith('stream:')) return { kind: 'stream', streamId: text.slice(7), url: '' };
    return { kind: 'stream', streamId: '', url: '' };
  }

  /** The status text lives in the editor, or in the Test tab when it owns the buttons. */
  const testStatus = (instance) => $(`#${instance.id}-test-status`) || (instance.externalTestControls ? $('#test-status') : null);
  const testRunButton = (instance) => $(`#${instance.id}-test-run`) || (instance.externalTestControls ? $('#btn-test-run') : null);
  const testStopButton = (instance) => $(`#${instance.id}-test-stop`) || (instance.externalTestControls ? $('#btn-test-stop') : null);

  function clearTestOutput(instance) {
    const output = $(`#${instance.id}-test-output`);
    if (output) output.textContent = '— raw ffmpeg output appears here —';
    instance.test.lines = 0;
    const verdict = $(`#${instance.id}-test-verdict`);
    if (verdict) {
      verdict.className = 'tpl-test-verdict';
      verdict.textContent = '(not run yet)';
    }
    const progress = $(`#${instance.id}-test-progress`);
    if (progress) progress.textContent = '';
  }

  function appendTestLine(instance, line) {
    const output = $(`#${instance.id}-test-output`);
    if (!output) return;
    if (!instance.test.lines) output.textContent = '';
    instance.test.lines += 1;
    output.textContent += `${line}\n`;
    if (instance.test.lines > 500) {
      output.textContent = output.textContent.split('\n').slice(-400).join('\n');
      instance.test.lines = 400;
    }
    output.scrollTop = output.scrollHeight;
  }

  async function runTest(instance, { source = null, durationMs = null } = {}) {
    if (instance.test.running) return;
    const template = instance.template;
    if (!template?.command) return toast('Nothing to test — the command is empty', 'warn');
    const target = source || instance.test.source || {};
    const duration = Math.max(500, Math.min(30000, Number(durationMs ?? instance.test.durationMs) || 5000));
    if (target.kind !== 'url' && !target.streamId) return toast('Pick an input source to test against', 'warn');
    if (target.kind === 'url' && !target.url) return toast('Enter the custom source URL', 'warn');

    const verdict = $(`#${instance.id}-test-verdict`);
    const status = testStatus(instance);
    const runButton = testRunButton(instance);
    const stopButton = testStopButton(instance);
    clearTestOutput(instance);
    if (verdict) {
      verdict.className = 'tpl-test-verdict';
      verdict.textContent = 'running…';
    }
    if (status) status.textContent = `running ffmpeg for ${(duration / 1000).toFixed(1)} s…`;
    if (stopButton) stopButton.disabled = false;

    const handle = apiSse('/api/ffmpeg/live-test', {
      command: template.command,
      container: instance.container,
      durationMs: duration,
      ...(target.kind === 'url' ? { url: target.url } : { streamId: target.streamId }),
    }, {
      start: (payload) => {
        appendTestLine(instance, `$ ${payload.command}`);
        appendTestLine(instance, `# source: ${payload.stream?.title || payload.stream?.url || '—'} · container ${payload.container} · hardware ${payload.hardware?.available ? 'vaapi' : 'software'}`);
        appendTestLine(instance, '');
      },
      stderr: (payload) => appendTestLine(instance, payload.line),
      stdout: (payload) => appendTestLine(instance, payload.line),
      progress: (payload) => {
        const progress = $(`#${instance.id}-test-progress`);
        if (!progress) return;
        const bits = [
          payload.fps ? `fps ${payload.fps}` : '', payload.bitrate ? `bitrate ${payload.bitrate}` : '',
          payload.speed ? `speed ${payload.speed}` : '', payload.frame != null ? `frame ${payload.frame}` : '',
          payload.outTimeMs != null ? `time ${(Number(payload.outTimeMs) / 1000).toFixed(1)}s` : '',
          payload.dropFrames != null ? `dropped ${payload.dropFrames}` : '',
        ].filter(Boolean);
        progress.textContent = bits.join(' · ');
      },
      done: (payload) => {
        instance.test.running = null;
        if (runButton && !instance.externalTestControls) runButton.textContent = '▷ run test';
        else if (runButton) runButton.disabled = false;
        if (stopButton) stopButton.disabled = true;
        if (status) status.textContent = `finished in ${(Number(payload.durationMs) / 1000).toFixed(1)} s`;
        if (verdict) {
          verdict.className = `tpl-test-verdict ${payload.ok ? 'ok' : payload.bytesOut ? 'warn' : 'err'}`;
          verdict.textContent = payload.ok
            ? `✓ ran cleanly — ${fmtBytes(payload.bytesOut)} of output`
            : `✗ ${payload.error || payload.verdict || 'the command did not work'}`;
        }
      },
      onError: (error) => {
        instance.test.running = null;
        if (runButton && !instance.externalTestControls) runButton.textContent = '▷ run test';
        else if (runButton) runButton.disabled = false;
        if (stopButton) stopButton.disabled = true;
        if (status) status.textContent = 'the live stream failed — trying the one-shot test…';
        appendTestLine(instance, `# live mode failed: ${error.message}`);
        oneShotTest(instance, target, duration);
      },
    });
    instance.test.running = handle;
    if (runButton && !instance.externalTestControls) runButton.textContent = '⧗ running…';
    else if (runButton) runButton.disabled = true;
  }

  /** Fallback when SSE is blocked (some reverse proxies buffer it): the old one-shot test. */
  async function oneShotTest(instance, target, durationMs) {
    const verdict = $(`#${instance.id}-test-verdict`);
    const status = testStatus(instance);
    try {
      const res = await api('/api/ffmpeg/test', {
        method: 'POST',
        body: {
          command: instance.template.command,
          container: instance.container,
          durationMs,
          name: 'editor test',
          ...(target.kind === 'url' ? { url: target.url } : { streamId: target.streamId }),
        },
      });
      const result = res.result || {};
      appendTestLine(instance, `$ ${result.command || instance.template.command}`);
      appendTestLine(instance, (result.stderr || '').trim() || '# (no stderr)');
      if (verdict) {
        verdict.className = `tpl-test-verdict ${result.ok ? 'ok' : 'err'}`;
        verdict.textContent = result.ok
          ? `✓ ran cleanly — ${fmtBytes(result.bytesOut)} of output in ${(result.durationMs / 1000).toFixed(1)} s`
          : `✗ ${result.error || 'no output produced'}`;
      }
      if (status) status.textContent = `finished in ${(result.durationMs / 1000).toFixed(1)} s`;
    } catch (error) {
      if (verdict) {
        verdict.className = 'tpl-test-verdict err';
        verdict.textContent = `✗ ${error.message}`;
      }
      if (status) status.textContent = '';
    }
  }

  function stopTest(instance) {
    instance.test.running?.abort?.();
    instance.test.running = null;
    const runButton = testRunButton(instance);
    const stopButton = testStopButton(instance);
    const status = testStatus(instance);
    if (runButton && !instance.externalTestControls) runButton.textContent = '▷ run test';
    else if (runButton) runButton.disabled = false;
    if (stopButton) stopButton.disabled = true;
    if (status) status.textContent = 'stopped';
  }

  /* ---------------- wiring ---------------- */

  function wireInstance(instance) {
    const root = () => $(`#${instance.id}`);

    // parameters: select + optional custom input
    root().addEventListener('input', (event) => {
      const input = event.target.closest('[data-param]');
      if (input) {
        const key = input.dataset.param;
        if (input.value === CUSTOM) return;
        const field = input.closest('.param-field');
        $('[data-param-custom]', field)?.classList.add('hide');
        applyOption(instance, key, input.value);
        return;
      }
      const custom = event.target.closest('[data-param-custom]');
      if (custom) {
        applyOption(instance, custom.dataset.paramCustom, custom.value);
        return;
      }
      const adv = event.target.closest('[data-adv-value]');
      if (adv) {
        const entry = instance.options?.advanced?.[Number(adv.dataset.advValue)];
        if (entry) {
          entry.value = adv.value;
          scheduleBuild(instance);
        }
      }
    });
    root().addEventListener('change', (event) => {
      const input = event.target.closest('[data-param]');
      if (input && input.value === CUSTOM) {
        // Reveal the free-text box and keep the current value until it is typed.
        const field = input.closest('.param-field');
        const custom = $('[data-param-custom]', field);
        custom.classList.remove('hide');
        custom.focus();
        return;
      }
      const flag = event.target.closest(`#${instance.id}-adv-flag`);
      if (flag) {
        const def = advancedDef(flag.value);
        $(`#${instance.id}-adv-values`).innerHTML = (def?.choices || []).map((choice) => `<option value="${escapeHtml(choice)}"></option>`).join('');
        $(`#${instance.id}-adv-custom-row`)?.classList.toggle('hide', flag.value !== CUSTOM);
        if (def) $(`#${instance.id}-adv-value`).value = def.choices?.[0] || '';
        return;
      }
      const outputCheck = event.target.closest('input[data-output-check]');
      if (outputCheck?.closest(`#${instance.id}-outputs`)) {
        const template = instance.template || {};
        template.output = { ...(template.output || {}) };
        if (outputCheck.checked) template.output[outputCheck.dataset.outputCheck] = template.id || '__self__';
        else delete template.output[outputCheck.dataset.outputCheck];
        renderOutputs(instance);
        return;
      }
      if (event.target.id === `${instance.id}-test-source`) {
        const value = $(`#${instance.id}-test-source`).value;
        instance.test.source = parseSourceValue(value, instance);
        $(`#${instance.id}-test-url-field`)?.classList.toggle('hide', instance.test.source.kind !== 'url');
        return;
      }
      if (event.target.id === `${instance.id}-test-duration`) {
        instance.test.durationMs = Number($(`#${instance.id}-test-duration`).value) * 1000 || 5000;
      }
    });

    // command textarea: the typed command wins and the parameters follow
    $(`#${instance.id}-command`)?.addEventListener('input', () => {
      clearTimeout(instance.buildTimer);
      clearTimeout(instance.parseTimer);
      if (instance.template) instance.template.command = $(`#${instance.id}-command`).value;
      instance.optionsSynced = false;
      setStatus(instance, 'reading parameters from the command…');
      scheduleParse(instance);
    });
    $(`#${instance.id}-rebuild`)?.addEventListener('click', () => build(instance));
    $(`#${instance.id}-read`)?.addEventListener('click', () => readFromCommand(instance, { rebuild: false }));
    $(`#${instance.id}-reset`)?.addEventListener('click', async () => {
      instance.options = defaultOptions(instance.container);
      renderParams(instance);
      renderAdvanced(instance);
      renderAdvice(instance);
      await build(instance, { announce: false });
      setStatus(instance, 'parameters reset to the defaults');
    });
    $(`#${instance.id}-save`)?.addEventListener('click', () => saveTemplate(instance));
    $(`#${instance.id}-name`)?.addEventListener('input', () => { if (instance.template) instance.template.name = $(`#${instance.id}-name`).value; });
    $(`#${instance.id}-description`)?.addEventListener('input', () => { if (instance.template) instance.template.description = $(`#${instance.id}-description`).value; });
    $(`#${instance.id}-enabled`)?.addEventListener('change', () => {
      if (instance.template) instance.template.enabled = $(`#${instance.id}-enabled`).checked;
    });

    // advanced rows
    $(`#${instance.id}-adv-add`)?.addEventListener('click', () => {
      const picker = $(`#${instance.id}-adv-flag`);
      const custom = picker.value === CUSTOM;
      const flag = custom ? $(`#${instance.id}-adv-custom-flag`).value.trim() : picker.value;
      if (!/^-[A-Za-z][\w:-]*$/.test(flag)) return toast('Enter a flag such as -rw_timeout', 'warn');
      if (flag === '-i') return toast('-i is added by the form and cannot be used here', 'warn');
      const def = advancedDef(flag);
      const side = def ? def.side : ($(`#${instance.id}-adv-custom-side`).value === 'input' ? 'input' : 'output');
      if (!instance.options) instance.options = defaultOptions(instance.container);
      instance.options.advanced = [...(instance.options.advanced || []), { flag, value: $(`#${instance.id}-adv-value`).value.trim(), side }];
      $(`#${instance.id}-adv-value`).value = '';
      if (custom) $(`#${instance.id}-adv-custom-flag`).value = '';
      renderAdvanced(instance);
      scheduleBuild(instance);
    });
    $(`#${instance.id}-adv-rows`)?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-adv-remove]');
      if (!button || !instance.options?.advanced) return;
      instance.options.advanced.splice(Number(button.dataset.advRemove), 1);
      renderAdvanced(instance);
      scheduleBuild(instance);
    });
    $(`#${instance.id}-test-url`)?.addEventListener('input', () => {
      instance.test.source = { kind: 'url', streamId: '', url: $(`#${instance.id}-test-url`).value.trim() };
      const select = $(`#${instance.id}-test-source`);
      if (select && !instance.externalTestControls) select.value = 'url:';
    });
    $(`#${instance.id}-test-run`)?.addEventListener('click', () => runTest(instance));
    $(`#${instance.id}-test-stop`)?.addEventListener('click', () => stopTest(instance));
    $(`#${instance.id}-test-clear`)?.addEventListener('click', () => clearTestOutput(instance));
    root().addEventListener('click', (event) => {
      // Clicking the advanced summary keeps the <details> behaviour; nothing else here.
      if (event.target.closest('summary')) return;
    });
  }

  /* ------------------------------------------------------------------ *
   * the Transcode tab: template list + editor
   * ------------------------------------------------------------------ */

  let libraryEditor = null;

  async function initLibrary() {
    await ensureSchema();
    await App.loadFfmpegTemplates?.();
    libraryEditor = create({ host: $('#tpl-editor-host'), mode: 'library' });
    renderLibrary();
    if (state.ffmpegTemplates.length) selectTemplate(selectedId || state.ffmpegTemplates[0].id);
    else loadTemplate(libraryEditor, null);
  }

  let selectedId = '';

  function renderLibrary() {
    const host = $('#tpl-list');
    if (!host) return;
    const list = state.ffmpegTemplates || [];
    if (!list.length) {
      host.innerHTML = '<div class="meta" style="padding:14px">No templates saved yet — press “+ new”.</div>';
    } else {
      host.innerHTML = list.map((item) => {
        const isDefault = state.defaultFfmpegTemplateId === item.id;
        const outputs = OUTPUT_TYPES.filter((output) => item.output && item.output[output]).map((output) => OUTPUT_LABELS[output] || output);
        const command = String(item.command || '').replace(/\s+/g, ' ').trim();
        return `<div class="tpl-row${selectedId === item.id ? ' selected' : ''}${item.enabled === false ? ' disabled' : ''}" data-tpl="${escapeHtml(item.id)}" role="button" tabindex="0">
          <div class="tpl-row-main">
            <div class="tname">${escapeHtml(item.name || 'unnamed')}${isDefault ? ` <span class="tag alt">default</span>` : ''}${item.enabled === false ? ' <span class="tag warn">disabled</span>' : ''}</div>
            <div class="tmeta">${escapeHtml(item.container || '—')} · ${outputs.length ? escapeHtml(outputs.join(', ')) : '<span class="mut">no output assigned</span>'}</div>
            <div class="tmeta mono">${escapeHtml(command.length > 90 ? `${command.slice(0, 90)}…` : command)}</div>
          </div>
          <div class="tpl-row-side">${item.options ? `${Object.keys(item.options).length} params` : 'command only'}</div>
        </div>`;
      }).join('');
      $$('[data-tpl]', host).forEach((row) => {
        const pick = () => selectTemplate(row.dataset.tpl);
        row.addEventListener('click', pick);
        row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); } });
      });
    }
    const note = $('#tpl-list-note');
    if (note) {
      note.textContent = state.defaultFfmpegTemplateId
        ? `Default: ${state.ffmpegTemplates.find((tpl) => tpl.id === state.defaultFfmpegTemplateId)?.name || '—'} — used by every stream without its own template.`
        : 'No default template — new streams use the guided profile builder.';
    }
    const setDefault = $('#btn-tpl-set-default');
    const del = $('#btn-tpl-delete-top');
    const selected = state.ffmpegTemplates.find((tpl) => tpl.id === selectedId);
    if (setDefault) {
      setDefault.disabled = !selected;
      setDefault.textContent = selected && state.defaultFfmpegTemplateId === selected.id ? '★ is the default' : '★ set default';
    }
    if (del) del.disabled = !selected;
  }

  function selectTemplate(id) {
    const item = state.ffmpegTemplates.find((tpl) => tpl.id === id) || null;
    selectedId = item?.id || '';
    renderLibrary();
    loadTemplate(libraryEditor, item);
  }

  function wireLibraryTab() {
    $('#btn-tpl-new')?.addEventListener('click', () => {
      selectedId = '';
      renderLibrary();
      loadTemplate(libraryEditor, { id: '', name: '', description: '', container: 'mpegts', command: '', enabled: true, output: {} });
      build(libraryEditor, { announce: false }).then(() => $(`#${libraryEditor.id}-name`)?.focus());
    });
    $('#btn-tpl-set-default')?.addEventListener('click', () => setDefaultTemplate(libraryEditor));
    $('#btn-tpl-delete-top')?.addEventListener('click', () => deleteTemplate(libraryEditor));
  }

  /* ------------------------------------------------------------------ *
   * the Test tab: template picker + a working copy in the same editor
   * ------------------------------------------------------------------ */

  let testEditor = null;

  async function initTestTab() {
    await ensureSchema();
    await App.loadFfmpegTemplates?.();
    await App.loadStreams?.();
    testEditor = create({ host: $('#test-editor-host'), mode: 'test', externalTestControls: true });
    renderTestTemplatePicker();
    // NB: the instance is required — calling this without one threw
    // "Cannot read properties of undefined (reading 'id')", which aborted
    // initTestTab() before the tab's start/stop buttons were wired.
    renderTestSources(testEditor);
    const first = state.ffmpegTemplates[0];
    if (first) loadTestTemplate(first.id);
    else loadTemplate(testEditor, null);
    wireTestTab();
  }

  function renderTestTemplatePicker() {
    const select = $('#test-template');
    if (!select) return;
    const previous = select.value;
    select.innerHTML = state.ffmpegTemplates.length
      ? state.ffmpegTemplates.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.container)}${item.enabled === false ? ' (disabled)' : ''}${state.defaultFfmpegTemplateId === item.id ? ' ★' : ''}</option>`).join('')
      : '<option value="">(no templates saved yet)</option>';
    if (previous && state.ffmpegTemplates.some((item) => item.id === previous)) select.value = previous;
  }

  function loadTestTemplate(id) {
    const item = state.ffmpegTemplates.find((tpl) => tpl.id === id) || null;
    // A working copy: editing here must not silently change the saved library.
    loadTemplate(testEditor, item ? structuredClone(item) : null, { sourceLabel: item ? 'working copy — save it in the Transcode tab' : '' });
    const select = $('#test-template');
    if (select && item) select.value = item.id;
  }

  function wireTestTab() {
    $('#test-template')?.addEventListener('change', () => loadTestTemplate($('#test-template').value));
    $('#test-source')?.addEventListener('change', () => {
      const value = $('#test-source').value;
      if (value === 'url:') {
        $('#test-url-field')?.classList.remove('hide');
        $('#test-url')?.focus();
        return;
      }
      $('#test-url-field')?.classList.add('hide');
    });
    $('#test-url')?.addEventListener('input', () => { /* read at run time */ });
    $('#test-duration')?.addEventListener('change', () => { /* read at run time */ });
  }

  function testTarget() {
    const value = $('#test-source')?.value || '';
    if (value === 'url:') return { kind: 'url', streamId: '', url: $('#test-url')?.value.trim() || '' };
    if (value.startsWith('stream:')) return { kind: 'stream', streamId: value.slice(7), url: '' };
    return { kind: 'stream', streamId: '', url: '' };
  }

  /** Called by the Test tab's own "start test" button. */
  function runTestTab() {
    const durationMs = Math.max(500, Math.min(30000, (Number($('#test-duration')?.value) || 5) * 1000));
    const target = testTarget();
    syncTabButtons(true);
    const status = $('#test-status');
    if (status) status.textContent = `running ffmpeg for ${(durationMs / 1000).toFixed(1)} s…`;
    return runTest(testEditor, { source: target, durationMs }).finally(() => syncTabButtons(false));
  }

  function stopTestTab() {
    stopTest(testEditor);
    syncTabButtons(false);
  }

  /** Keep the tab's run/stop buttons in step with the editor instance. */
  function syncTabButtons(running) {
    const run = $('#btn-test-run');
    const stop = $('#btn-test-stop');
    if (run) { run.disabled = Boolean(running); run.textContent = running ? '⧗ running…' : '▷ start test'; }
    if (stop) stop.disabled = !running;
  }

  return {
    ensureSchema, create, loadTemplate, saveTemplate, deleteTemplate, setDefaultTemplate,
    initLibrary, initTestTab, renderLibrary, selectTemplate, loadTestTemplate, wireLibraryTab,
    runTestTab, stopTestTab, syncTabButtons, clearTestOutput, renderTestSources, renderTestTemplatePicker, adviceFor, computeActive,
    get testEditor() { return testEditor; },
    get libraryEditor() { return libraryEditor; },
  };
})();

if (typeof window !== 'undefined') window.VMFfmpegEditor = VMFfmpegEditor;
