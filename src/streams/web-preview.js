/**
 * vu-movie — the web preview's “what can this browser actually play?” layer.
 *
 * The browser preview (the ▶ preview modal and the `/watch/<token>` page) uses
 * mpegts.js, which transmuxes MPEG-TS into fragmented MP4 and hands it to Media
 * Source Extensions. What that player can play is therefore decided by **MSE
 * codec support in the browser in front of it** — not by what VLC or the VU+
 * Duo2 accepts, and not by the FFmpeg template the playlist item carries (that
 * one is written for the receiver, often with DVB subtitles and a codec the
 * browser cannot decode).
 *
 * So before a preview starts the page reports the codec families its player
 * supports (`?vcodecs=avc1,hvc1&acodecs=mp4a,ac-3`), and this module turns that
 * plus the stream's own probe into a profile for the guided FFmpeg builder:
 *
 *   - subtitles are **always dropped** (`subtitles: 'none'` → `-sn -dn`, no
 *     sidecar): the browser player has no subtitle pipeline, and a DVB bitmap
 *     track (`-c:s dvbsub`) makes the transmuxer choke;
 *   - the item's FFmpeg template is **overwritten** (cleared), because it
 *     describes the receiver's output, not the browser's;
 *   - video and audio that the browser reported are **copied** (a plain remux,
 *     no CPU), anything else is transcoded to H.264 + AAC — VAAPI when the NAS
 *     has it, libx264 otherwise, exactly like a normal guided session.
 *
 * Pure on purpose: no config, no store, no ffmpeg — the tests hand it probes
 * and codec lists.
 */

/** ffprobe codec name → the family a browser's MSE support list talks about. */
export const VIDEO_FAMILIES = {
  h264: 'avc1', avc1: 'avc1', x264: 'avc1',
  hevc: 'hvc1', h265: 'hvc1', hvc1: 'hvc1', hev1: 'hvc1',
  av1: 'av01',
  vp9: 'vp09', vp90: 'vp09',
  vp8: 'vp08',
  mpeg4: 'mp4v',
  mpeg2video: 'mp2v',
  vc1: 'vc-1',
};

/** ffprobe audio codec name → family. */
export const AUDIO_FAMILIES = {
  aac: 'mp4a', mp4a: 'mp4a',
  ac3: 'ac-3', eac3: 'ec-3', ac_3: 'ac-3',
  mp3: 'mp3', mp2: 'mp3',
  opus: 'opus',
  flac: 'flac',
  vorbis: 'vorbis',
  dts: 'dts',
};

const normalise = (value) => String(value || '').trim().toLowerCase();
const list = (value) => (Array.isArray(value) ? value : String(value || '').split(',')).map(normalise).filter(Boolean);

/**
 * The only video family the web preview may **copy**.
 *
 * mpegts.js transmuxes MPEG-TS into fragmented MP4 and feeds it to MSE. That
 * path is dependable for H.264 (and H.264 in TS is exactly what the player was
 * written for); HEVC/AV1/VP9 in a transport stream is not — even where the
 * browser's MediaSource claims support, the transmuxer or the TS muxer chokes.
 * So a browser that reports `hvc1` still gets H.264 out, which is why the
 * preview may transcode on a machine whose VLC output is a plain remux.
 */
export const WEB_REMUX_VIDEO = 'avc1';

/** `"avc1,hvc1"` / `['AVC1']` → `Set { 'avc1', 'hvc1' }`. */
export function parseCodecList(value) {
  return new Set(list(value));
}

/** Both sides are compared as families, so `h264` and `avc1` mean the same. */
export function videoFamily(codec) {
  const name = normalise(codec);
  if (!name) return null;
  return VIDEO_FAMILIES[name] || name;
}

export function audioFamily(codec) {
  const name = normalise(codec);
  if (!name) return null;
  return AUDIO_FAMILIES[name] || name;
}

/** True when the reporter said this codec's family can be played. */
export function supportsFamily(families, codec) {
  const name = normalise(codec);
  if (!name) return false;
  return families.has(VIDEO_FAMILIES[name] || AUDIO_FAMILIES[name] || name);
}

/**
 * The streams a `-sn`-style output keeps: the first video and first audio track
 * (this mirrors the guided builder's `-map 0:v:0 -map 0:a:0?`).
 */
function firstTracks(probe = {}) {
  const video = probe?.video || null;
  const audio = Array.isArray(probe?.audio) ? probe.audio[0] : probe?.audio || null;
  return { video, audio };
}

/**
 * Decide the web-preview profile.
 *
 * @param {object} input
 *   `probe`         — the stream's own ffprobe result (video/audio/subtitles)
 *   `videoCodecs`   — families the browser reported (`['avc1','hvc1']`)
 *   `audioCodecs`   — families the browser reported (`['mp4a','ac-3']`)
 *   `reported`      — whether the browser actually answered (a client that sends
 *                     nothing gets the safe path, not a copy it cannot play)
 * @returns `{ profile, decisions }` — `profile` are the overrides to merge into
 *   the session's profile, `decisions` explains them for the log and the UI.
 */
export function decideWebProfile({ probe = {}, videoCodecs = [], audioCodecs = [], reported = true } = {}) {
  const video = parseCodecList(videoCodecs);
  const audio = parseCodecList(audioCodecs);
  const { video: sourceVideo, audio: sourceAudio } = firstTracks(probe);
  const videoCodec = sourceVideo?.codec || null;
  const audioCodec = sourceAudio?.codec || null;

  const videoFamilyName = videoFamily(videoCodec);
  const audioFamilyName = audioFamily(audioCodec);
  const hasAudio = Boolean(sourceAudio) || probe?.hasAudio === true;
  // A browser that reported nothing at all is not “supports everything”: treat
  // it as unknown and transcode, so the preview plays instead of failing with a
  // demuxer error the operator has to decode.
  const videoKnown = Boolean(videoCodec) && reported;
  const audioKnown = (!hasAudio && !audioCodec) || (Boolean(audioCodec) && reported);
  const videoSupported = videoKnown && videoFamilyName === WEB_REMUX_VIDEO && video.has(WEB_REMUX_VIDEO);
  const audioSupported = !hasAudio || (audioKnown && audioFamilyName && audio.has(audioFamilyName));
  // All or nothing: the guided builder re-encodes the whole output as soon as
  // one track needs it, so a browser that cannot decode the source's audio also
  // costs the video copy (documented, and still cheaper than a dead preview).
  const copy = videoSupported && audioSupported;

  const reasons = [];
  if (!reported) reasons.push('the browser did not report its codec support — transcoding to H.264/AAC is the only safe choice');
  if (!videoCodec) reasons.push('the stream has no probe result, so its video codec is unknown');
  else if (!videoFamilyName || !video.has(videoFamilyName)) reasons.push(`the browser cannot play ${videoCodec} (needs ${videoFamilyName || '?'} support)`);
  else if (videoFamilyName !== WEB_REMUX_VIDEO) reasons.push(`${videoCodec} would need transcoding: mpegts.js only transmuxes H.264 reliably`);
  if (hasAudio) {
    if (!audioCodec) reasons.push('the stream has no probe result, so its audio codec is unknown');
    else if (!audioFamilyName || !audio.has(audioFamilyName)) reasons.push(`the browser cannot play ${audioCodec} audio (needs ${audioFamilyName || '?'} support)`);
  }
  reasons.push('subtitles are dropped for the web player');

  const decisions = {
    copy,
    reported,
    video: {
      source: videoCodec, family: videoFamilyName, remuxSafe: videoFamilyName === WEB_REMUX_VIDEO,
      // `supported` is what the browser reported (per track); `action` is what
      // the session will really do — a track the browser can decode is still
      // re-encoded when the other track forces the output through the encoder.
      supported: Boolean(videoSupported),
      action: copy ? 'copy' : 'transcode', target: copy ? null : 'h264',
    },
    audio: {
      source: audioCodec, family: audioFamilyName, supported: hasAudio ? Boolean(audioSupported) : true,
      // Copy only in a full remux; if the video is re-encoded the audio goes
      // through the same encode (the builder has one transcode switch).
      action: !hasAudio ? 'none' : copy ? 'copy' : 'transcode',
      target: !hasAudio || copy ? null : 'aac',
    },
    subtitles: 'dropped',
    container: 'mpegts',
    reasons,
  };

  const profile = {
    container: 'mpegts',
    // The item's template (and the per-output template map) describe the
    // receiver, not the browser — clear them so the guided builder owns the
    // command.
    ffmpegTemplate: '',
    ffmpegTemplateId: '',
    ffmpegTemplateName: '',
    subtitles: 'none',
    subtitlePath: null,
  };

  if (copy) {
    // A remux only. `mode: 'copy'` also pins the builder to `-c:v copy
    // -c:a copy`, which is what makes a preview cost no CPU at all.
    profile.mode = 'copy';
  } else {
    profile.mode = 'auto';
    profile.alwaysTranscode = true;
    // The requested output is H.264 in MPEG-TS; keep the configured resolution
    // cap and bitrates, only the codecs are forced.
    profile.audioCodec = 'aac';
  }

  return { profile, decisions };
}

/** One line for the log / the preview modal: what will happen and why. */
export function describeWebDecisions(decisions) {
  if (!decisions) return '';
  const video = decisions.video?.action === 'copy'
    ? `copy ${decisions.video.source || 'video'}`
    : `transcode ${decisions.video.source || 'video'} → h264`;
  const audio = decisions.audio?.action === 'none' ? 'no audio'
    : decisions.audio?.action === 'copy' ? `copy ${decisions.audio.source || 'audio'}`
      : `transcode ${decisions.audio.source || 'audio'} → aac`;
  return `web preview: ${video} + ${audio}, subtitles dropped`;
}

export default {
  VIDEO_FAMILIES, AUDIO_FAMILIES, parseCodecList, videoFamily, audioFamily,
  supportsFamily, decideWebProfile, describeWebDecisions,
};
