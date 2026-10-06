/* vu-movie — "what can this browser actually play?" for the web preview.
 *
 * The preview player is mpegts.js: it transmuxes the relay's MPEG-TS into
 * fragmented MP4 and hands that to Media Source Extensions. So the answer to
 * "which format does the web player support" is not a fixed list in the
 * repository — it depends on the browser in front of the stream (a Mac with
 * HEVC support in MSE is not Firefox). This file asks the browser itself, with
 * `MediaSource.isTypeSupported()` over the codec families that can appear in
 * the operator's library, and then builds the preview URL:
 *
 *   /s/<token>/<slug>.ts.web?codecs=1&vcodecs=avc1,hvc1&acodecs=mp4a
 *
 *   `codecs=1` marks the report as present even when a list comes back empty —
 *   the relay must not read "the browser supports nothing" out of silence.
 *
 * The relay turns that into the session profile: subtitles dropped, the item's
 * FFmpeg template (written for VLC/the receiver) ignored, and copy-vs-transcode
 * decided per track (see src/streams/web-preview.js). Keeping the probe in the
 * browser is deliberate: guessing on the NAS would either transcode everything
 * or hand the player a codec it cannot decode.
 */
'use strict';

(function () {
  /**
   * `[family, MIME the browser can be asked about]` pairs. One representative
   * MIME per family is enough: `isTypeSupported` answers per codec string, and
   * MSE support is decided by the family, not by a profile/level.
   */
  const VIDEO_CANDIDATES = [
    ['avc1', 'video/mp4; codecs="avc1.42E01E"'],   // H.264 — the mpegts.js/TS main line
    ['hvc1', 'video/mp4; codecs="hvc1.1.6.L93.B0"'], // HEVC
    ['av01', 'video/mp4; codecs="av01.0.04M.08"'],  // AV1
    ['vp09', 'video/webm; codecs="vp9"'],           // VP9
  ];
  const AUDIO_CANDIDATES = [
    ['mp4a', 'audio/mp4; codecs="mp4a.40.2"'],      // AAC
    ['ac-3', 'audio/mp4; codecs="ac-3"'],
    ['ec-3', 'audio/mp4; codecs="ec-3"'],
    ['opus', 'audio/webm; codecs="opus"'],
    ['mp3', 'audio/mpeg'],
  ];

  function isTypeSupported(mime) {
    try {
      return typeof window.MediaSource !== 'undefined' && typeof window.MediaSource.isTypeSupported === 'function'
        && window.MediaSource.isTypeSupported(mime) === true;
    } catch {
      return false;
    }
  }

  /** Which families this browser reports. Includes `supported` (MSE at all?). */
  function probe() {
    const video = VIDEO_CANDIDATES.filter(([, mime]) => isTypeSupported(mime)).map(([family]) => family);
    const audio = AUDIO_CANDIDATES.filter(([, mime]) => isTypeSupported(mime)).map(([family]) => family);
    const mse = typeof window.MediaSource !== 'undefined' && typeof window.MediaSource.isTypeSupported === 'function';
    return { video, audio, mse, supported: mse && video.length > 0 };
  }

  /**
   * The preview URL for a stream: the `.ts.web` route plus this browser's codec
   * report. Falls back to appending a query to whatever URL it is given, so an
   * older playlist row without a `web` URL still gets a working request.
   */
  function previewUrl(baseUrl) {
    const base = String(baseUrl || '');
    if (!base) return '';
    const report = probe();
    const query = [
      'codecs=1',
      `vcodecs=${report.video.join(',')}`,
      `acodecs=${report.audio.join(',')}`,
    ].join('&');
    return `${base}${base.includes('?') ? '&' : '?'}${query}`;
  }

  /**
   * One line for the status text, built from the session's `webDecisions`
   * (relay → GET /api/streams/:id). Explains a transcode before the operator
   * starts blaming the network.
   */
  function describeDecisions(decisions) {
    if (!decisions) return '';
    const side = (track, to) => (!track || track.action === 'none' ? 'no audio'
      : track.action === 'copy' ? `copy ${track.source || 'track'}` : `${track.source || 'track'} → ${to}`);
    const video = !decisions.video ? 'video ?'
      : decisions.video.action === 'copy' ? `copy ${decisions.video.source || 'video'}` : `${decisions.video.source || 'video'} → h264`;
    const audio = side(decisions.audio, 'aac');
    // The subtitle reason is already in the sentence — quote the first *other*
    // reason, which is the one that explains a surprise transcode.
    const why = (Array.isArray(decisions.reasons) ? decisions.reasons : []).find((r) => !/subtitle/i.test(String(r)));
    return `web preview: ${video} + ${audio}, subtitles dropped${why ? ` (${why})` : ''}`;
  }

  window.VMWebCodecs = { probe, previewUrl, describeDecisions, isTypeSupported };

  if (typeof module !== 'undefined' && module.exports) module.exports = window.VMWebCodecs;
}());
