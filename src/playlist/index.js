/**
 * vu-movie — the Playlist.
 *
 * Before this module the box had a *set* of streams: every stream that existed
 * was pushed into the bouquet and into the playlist, in creation order. The
 * Playlist tab needs more than that — an explicit order, an enable/disable
 * switch per item, a per-item FFmpeg template and a per-item subtitle — and the
 * outputs (VLC .m3u, Enigma2 bouquet, Xtream catalogue, web player) all have to
 * agree on it.
 *
 * So the playlist is a small ordered list of stream ids with flags, persisted in
 * the config file (it is operator data, not runtime state, and it must survive a
 * restart without Postgres):
 *
 *   playlist.items = [{ streamId, enabled, templateId, subtitleLanguage, addedAt }]
 *
 * Reconciliation is intentionally forgiving: a stream that is not in the list
 * yet (created from the Search tab, or by a version that had no playlist) is
 * appended the first time the list is read, and an item whose stream was
 * deleted disappears. Nothing has to be "registered" by hand.
 *
 * Everything else in this file only *reads* the existing core modules
 * (streams/store.js, streams/export.js, enigma2, subtitles) — the scraping,
 * relay and transcoding code is untouched.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { getConfig, saveConfig } from '../core/config.js';
import { log, errorText } from '../core/log.js';
import { normaliseProfile } from '../core/media.js';
import { uploadSubtitleToReceiver } from '../subtitles/push.js';
import * as store from '../streams/store.js';
import * as relay from '../streams/relay.js';
import * as exporter from '../streams/export.js';
import * as subs from '../subtitles/index.js';
import * as enigma2 from '../enigma2/index.js';

const MAX_ITEMS = 300;

/**
 * How an item's attached subtitle reaches the receiver.
 *
 *   none  attach nothing
 *   soft  a selectable text track inside the Matroska output — no encode at all
 *   burn  hardcoded into the picture: works on every player, but the relay has
 *         to re-encode the video (the one mode that costs the NAS real CPU)
 *   push  copy the .srt onto the box (FTP / mounted share) under the movie's
 *         name — zero transcoding and zero muxing; Enigma2 picks it up next to
 *         a recording of the same name
 *
 * The mode is stored on the *playlist item*; `soft`/`burn` additionally set the
 * stream profile's `subtitles` field, because that is what the ffmpeg builder
 * reads. `push` deliberately leaves the profile untouched (nothing is muxed).
 */
export const SUBTITLE_MODES = ['none', 'soft', 'burn', 'push'];
/** Modes that reach the ffmpeg profile. */
const MUX_SUBTITLE_MODES = ['none', 'soft', 'burn'];

const text = (value, fallback = '') => (value === undefined || value === null ? fallback : String(value));

/* ------------------------------------------------------------------ *
 * persistence
 *
 * The playlist (order, flags, token) lives in the config file, which is a
 * mounted volume on the NAS. That file is not always writable: a read-only
 * mount, a container started without the volume, or a throwaway environment
 * like the sandbox this repository is previewed in. A failed *write* must
 * never fail a *request* — `GET /api/playlist` used to answer 500 with
 * "EACCES: mkdir '/config'", which left the whole Playlist tab (and with it
 * the preview player, the bouquet and the public outputs) empty.
 *
 * So the writes below are best effort: the change is applied in memory
 * (saveConfig() already updates the running config before it touches the
 * disk), the process keeps behaving consistently until it stops, and the
 * operator is told once that nothing was persisted.
 * ------------------------------------------------------------------ */

/** Token generated for this run when the config file cannot be written. */
let memoryToken = '';
/** False as soon as one config write failed; reported to the UI by /api/playlist. */
let configWritable = true;
let persistFailureLogged = false;

/**
 * Persist a playlist patch, tolerating a config file that cannot be written.
 * Returns true when the change really reached the disk.
 */
function persistPlaylist(patch, description) {
  try {
    saveConfig({ playlist: patch });
    configWritable = true;
    return true;
  } catch (err) {
    configWritable = false;
    if (!persistFailureLogged) {
      persistFailureLogged = true;
      log.warn('playlist', `the config file is not writable — ${description} could not be saved (kept in memory for this run only)`,
        { error: errorText(err) });
    }
    return false;
  }
}

/** Whether the last playlist write reached the config file (the UI shows a hint when it did not). */
export function configWritableNow() { return configWritable; }

/** One playlist entry, coerced into the shape the rest of the app expects. */
function normaliseItem(entry = {}) {
  const streamId = text(entry.streamId || entry.stream_id || entry.id).trim();
  if (!streamId) return null;
  return {
    streamId,
    enabled: entry.enabled !== false,
    templateId: text(entry.templateId).trim(),
    subtitleLanguage: text(entry.subtitleLanguage).trim().toLowerCase(),
    // '' = not chosen yet: the item then follows the stream profile.
    subtitleMode: SUBTITLE_MODES.includes(text(entry.subtitleMode).trim().toLowerCase())
      ? text(entry.subtitleMode).trim().toLowerCase()
      : '',
    addedAt: text(entry.addedAt, new Date().toISOString()),
  };
}

function rawItems() {
  const items = getConfig().playlist?.items;
  return Array.isArray(items) ? items.map(normaliseItem).filter(Boolean) : [];
}

/** The playlist name, used for the bouquet, the M3U and the Xtream account. */
export function name() {
  return text(getConfig().playlist?.name, 'vu-movie').trim() || 'vu-movie';
}

/**
 * The unguessable handle in every public output URL (/pl/<token>/…). Created on
 * first use and stored in the config, so an URL handed to the VU+ or to an IPTV
 * app keeps working across restarts. When the config file cannot be written the
 * token is still generated and reused for the lifetime of the process, so those
 * URLs work for this run instead of the endpoint failing.
 */
export function token() {
  const existing = text(getConfig().playlist?.token).trim();
  if (existing) return existing;
  if (memoryToken) return memoryToken;
  const created = crypto.randomBytes(12).toString('base64url');
  memoryToken = created;
  const stored = persistPlaylist({ token: created }, 'the playlist token');
  log.info('playlist', stored
    ? 'generated the playlist token for the public output URLs'
    : 'generated the playlist token for this run (it could not be written to the config file)');
  return created;
}

export function tokenMatches(candidate) {
  const expected = text(getConfig().playlist?.token).trim() || memoryToken;
  if (!expected || !candidate) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Persist the whole list (order is the caller's order). */
export function saveItems(items = []) {
  const next = [];
  const seen = new Set();
  for (const raw of items) {
    const item = normaliseItem(raw);
    if (!item || seen.has(item.streamId)) continue;
    seen.add(item.streamId);
    next.push(item);
    if (next.length >= MAX_ITEMS) break;
  }
  persistPlaylist({ items: next }, 'the playlist order and flags');
  return next;
}

/**
 * Read the playlist, adding streams that appeared since the last read and
 * dropping items whose stream is gone. Only writes when something changed, so a
 * GET does not rewrite the config file on every poll.
 */
export async function sync({ persist = true } = {}) {
  const streams = await store.listStreams();
  const available = new Map(streams.map((s) => [String(s.id), s]));
  const current = rawItems();
  const items = [];
  const seen = new Set();
  const dropped = [];
  for (const item of current) {
    if (!available.has(item.streamId)) { dropped.push(item.streamId); continue; }
    if (seen.has(item.streamId)) continue;
    seen.add(item.streamId);
    items.push(item);
  }
  // listStreams() is newest-first; append oldest-first so the playlist starts in
  // the order the streams were created.
  const added = streams.filter((s) => !seen.has(String(s.id))).reverse().map((s) => normaliseItem({ streamId: s.id }));
  items.push(...added);
  const changed = dropped.length || added.length || items.length !== current.length;
  if (changed) {
    if (dropped.length) log.info('playlist', `${dropped.length} item(s) removed — the stream no longer exists`, { streamIds: dropped.slice(0, 10) });
    if (added.length) log.info('playlist', `${added.length} new stream(s) appended to the playlist`);
    if (persist) return saveItems(items);
  }
  return items;
}

/** Resolve every item against the stream store, in playlist order. */
export async function entries({ baseUrl = '' } = {}) {
  const items = await sync();
  const resolved = [];
  for (const item of items) {
    const stream = await store.getStream(item.streamId);
    if (!stream) continue;
    const session = relay.getSession(stream.id);
    resolved.push({
      ...item,
      stream,
      urls: store.urlsFor(stream, baseUrl),
      session: session ? relay.publicSession(session) : null,
    });
  }
  return resolved;
}

/** The streams the outputs are built from: enabled, in playlist order. */
export async function enabledStreams() {
  const list = await entries();
  return list.filter((entry) => entry.enabled).map((entry) => entry.stream);
}

/** Add streams (idempotent; existing items keep their flags and position). */
export async function addItems(streamIds = [], { enabled = true } = {}) {
  const wanted = (Array.isArray(streamIds) ? streamIds : [streamIds]).map((id) => text(id).trim()).filter(Boolean);
  const items = await sync();
  const known = new Set(items.map((item) => item.streamId));
  let added = 0;
  for (const streamId of wanted) {
    const stream = await store.getStream(streamId);
    if (!stream) throw Object.assign(new Error(`stream "${streamId}" not found`), { status: 404 });
    if (known.has(streamId)) continue;
    items.push(normaliseItem({ streamId, enabled }));
    known.add(streamId);
    added += 1;
  }
  if (added) saveItems(items);
  return { items, added };
}

/** Remove one item (the stream itself stays in the library). */
export async function removeItem(streamId) {
  const items = await sync();
  const next = items.filter((item) => item.streamId !== String(streamId));
  saveItems(next);
  return { removed: items.length - next.length, items: next };
}

/**
 * Per-item flags: enabled, template, subtitle language, subtitle mode. Sent as
 * a patch so the UI can flip one switch without resending the whole list.
 *
 * See SUBTITLE_MODES for what the mode does. Changing it restarts a running
 * session (the ffmpeg command changes) and, for `push`, copies the .srt to the
 * receiver right away so the operator gets an answer instead of a silent
 * "nothing happened".
 */
export async function updateItem(streamId, patch = {}) {
  const items = await sync();
  const index = items.findIndex((item) => item.streamId === String(streamId));
  if (index < 0) throw Object.assign(new Error(`"${streamId}" is not in the playlist`), { status: 404 });
  const current = items[index];
  const next = {
    ...current,
    enabled: patch.enabled === undefined ? current.enabled : patch.enabled !== false,
    templateId: patch.templateId === undefined ? current.templateId : text(patch.templateId).trim(),
    subtitleLanguage: patch.subtitleLanguage === undefined ? current.subtitleLanguage : text(patch.subtitleLanguage).trim().toLowerCase(),
  };
  items[index] = next;
  saveItems(items);

  if (patch.subtitleMode !== undefined) {
    const mode = text(patch.subtitleMode).trim().toLowerCase();
    if (!SUBTITLE_MODES.includes(mode)) {
      throw Object.assign(new Error(`subtitle mode must be one of: ${SUBTITLE_MODES.join(', ')}`), { status: 422 });
    }
    const stream = await store.getStream(streamId);
    if (!stream) throw Object.assign(new Error('stream not found'), { status: 404 });

    // Persist the choice on the item *before* the side effects, so a failed
    // push (FTP down, no mount) still leaves the operator's intent recorded.
    next.subtitleMode = mode;
    items[index] = next;
    saveItems(items);

    if (MUX_SUBTITLE_MODES.includes(mode)) {
      const before = text(stream.profile?.subtitles, 'none');
      if (before !== mode) {
        const profile = { ...(stream.profile || {}), subtitles: mode };
        await persistStream(stream, normaliseProfile(profile, stream.upstream?.probe || null));
        relay.stopSession(stream.id, 'subtitle mode changed');
        log.info('playlist', `subtitle mode of "${stream.title}" set to ${mode}`, { stream: stream.id, from: before });
      }
    } else {
      // push: nothing is muxed, so the profile must not ask for a track either.
      if (text(stream.profile?.subtitles, 'none') !== 'none') {
        const profile = { ...(stream.profile || {}), subtitles: 'none' };
        await persistStream(stream, normaliseProfile(profile, stream.upstream?.probe || null));
        relay.stopSession(stream.id, 'subtitle mode changed');
      }
      const pushed = await pushSubtitle(stream);
      if (!pushed.ok) {
        throw Object.assign(new Error(`could not copy the subtitle to the receiver: ${pushed.error}`), { status: 502 });
      }
      log.info('playlist', `subtitle of "${stream.title}" copied to the receiver ${pushed.path}`, { stream: stream.id, via: pushed.via });
      next.pushed = pushed;
    }
  }
  return next;
}

/**
 * Copy an item's attached .srt onto the receiver (FTP upload, or a copy into a
 * mounted receiver share). No transcoding, no muxing — this is the cheapest way
 * to get Dutch subtitles onto a Duo2 and the only one that costs the NAS
 * literally nothing.
 */
export async function pushSubtitle(stream) {
  const file = stream?.profile?.subtitlePath;
  if (!file || !fs.existsSync(file)) return { ok: false, error: 'no subtitle is attached to this item yet' };
  const language = text(stream.profile?.subtitleLanguage, '') || 'sub';
  const name = `${store.slugify(`${stream.title}${stream.year ? `-${stream.year}` : ''}`)}.${String(language).slice(0, 3)}.srt`;
  const dir = getConfig().subtitles.receiverDir || '/media/hdd/movie';
  try {
    const result = uploadSubtitleToReceiver(file, name, dir);
    return result.ok === false ? result : { ...result, name, dir };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

/** Reorder the playlist; ids that are not in the list are ignored, missing ones keep their place at the end. */
export async function reorder(streamIds = []) {
  const items = await sync();
  const byId = new Map(items.map((item) => [item.streamId, item]));
  const next = [];
  for (const id of (Array.isArray(streamIds) ? streamIds : []).map((value) => text(value).trim())) {
    const item = byId.get(id);
    if (!item) continue;
    next.push(item);
    byId.delete(id);
  }
  for (const item of items) if (byId.has(item.streamId)) next.push(item);
  return saveItems(next);
}

/* ------------------------------------------------------------------ *
 * per-item actions
 * ------------------------------------------------------------------ */

/** Re-save a stream record (the store upserts on id). */
async function persistStream(stream, profile) {
  const saved = await store.createStream({
    ...stream,
    candidate: {
      url: stream.upstream?.url,
      headers: stream.upstream?.headers,
      probe: stream.upstream?.probe,
      sourceId: stream.source_id,
    },
    profile,
    title: stream.title,
    year: stream.year,
    kind: stream.kind,
  });
  return saved;
}

/**
 * Point a stream at one of the saved FFmpeg templates (or back at the guided
 * profile builder with an empty id). The template's command is copied into the
 * profile so the relay runs exactly what the Transcode tab shows, and the
 * `ffmpegTemplateId` keeps the link for later comparisons.
 */
export async function assignTemplate(streamId, templateId, { outputType = '' } = {}) {
  const stream = await store.getStream(streamId);
  if (!stream) throw Object.assign(new Error('stream not found'), { status: 404 });
  const id = text(templateId).trim();
  const profile = { ...(stream.profile || {}) };
  if (!id) {
    delete profile.ffmpegTemplate;
    delete profile.ffmpegTemplateId;
    delete profile.ffmpegTemplateName;
  } else {
    const template = (getConfig().transcode.ffmpegTemplates || []).find((item) => item?.id === id);
    if (!template) throw Object.assign(new Error(`FFmpeg template "${id}" was not found`), { status: 404 });
    if (outputType) {
      profile.outputTemplates = { ...(profile.outputTemplates || {}), [outputType]: id };
    } else {
      profile.ffmpegTemplate = template.command;
      profile.ffmpegTemplateId = template.id;
      profile.ffmpegTemplateName = template.name || '';
      profile.container = template.container || profile.container;
    }
  }
  await persistStream(stream, normaliseProfile(profile, stream.upstream?.probe || null));
  relay.stopSession(stream.id, 'FFmpeg template changed from the playlist');
  await updateItem(streamId, { templateId: outputType ? text(stream.profile?.ffmpegTemplateId).trim() : id });
  log.info('playlist', `template ${id ? `"${id}"` : '(guided builder)'} assigned to "${stream.title}"`, {
    stream: stream.id, outputType: outputType || 'stream',
  });
  return store.getStream(streamId);
}

/**
 * Attach a subtitle to a playlist item. Accepts either a subtitle *search
 * result* (downloaded through the provider) or raw SRT text (the "assign a file"
 * button — the browser reads the file and posts its contents, so no multipart
 * upload path is needed).
 */
export async function attachSubtitle(streamId, { result = null, srt = null, language = '', offsetMs = 0 } = {}) {
  const stream = await store.getStream(streamId);
  if (!stream) throw Object.assign(new Error('stream not found'), { status: 404 });
  let fetched;
  if (srt && String(srt).trim()) {
    const body = String(srt);
    if (!/-->/.test(body)) throw Object.assign(new Error('that file does not look like a subtitle (no "-->" cue found)'), { status: 422 });
    fetched = {
      srt: body,
      cues: (body.match(/-->/g) || []).length,
      language: text(language || 'nl').toLowerCase().slice(0, 8) || 'nl',
      provider: 'file',
      release: 'uploaded file',
    };
  } else if (result?.providerId) {
    fetched = await subs.fetchSubtitle(result, { offsetMs: Number(offsetMs) || 0 });
  } else {
    throw Object.assign(new Error('a subtitle result or an .srt file is required'), { status: 422 });
  }

  const stored = subs.storeSubtitle(fetched.srt, {
    slug: store.slugify(`${stream.title}-${stream.year || ''}`),
    language: fetched.language,
  });
  const profile = {
    ...(stream.profile || {}),
    subtitlePath: stored,
    subtitleLanguage: fetched.language === 'nl' ? 'nld' : fetched.language === 'en' ? 'eng' : fetched.language,
    subtitles: stream.profile?.subtitles && stream.profile.subtitles !== 'none' ? stream.profile.subtitles : 'soft',
  };
  await persistStream(stream, normaliseProfile(profile, stream.upstream?.probe || null));
  const item = await updateItem(streamId, { subtitleLanguage: fetched.language });
  relay.stopSession(stream.id, 'subtitle changed');
  log.info('playlist', `subtitle ${fetched.language} attached to "${stream.title}"`, {
    stream: stream.id, cues: fetched.cues, provider: fetched.provider,
  });
  // An item already set to "copy the .srt to the box" gets the new file right
  // away — otherwise the receiver would keep the previous language/version while
  // the UI happily reports the new one.
  let pushed = null;
  if (item.subtitleMode === 'push') {
    const fresh = await store.getStream(streamId);
    const result = await pushSubtitle(fresh);
    if (result.ok) {
      pushed = result;
      log.info('playlist', `new subtitle for "${stream.title}" copied to the receiver`, { stream: stream.id, path: result.path });
    } else {
      log.warn('playlist', `could not copy the new subtitle of "${stream.title}" to the receiver`, { stream: stream.id, error: result.error });
      pushed = result;
    }
  }
  return { ...fetched, stored, pushed, stream: await store.getStream(streamId) };
}

/** Detach the stored subtitle from a playlist item. */
export async function detachSubtitle(streamId) {
  const stream = await store.getStream(streamId);
  if (!stream) throw Object.assign(new Error('stream not found'), { status: 404 });
  const profile = { ...(stream.profile || {}) };
  delete profile.subtitlePath;
  delete profile.subtitleLanguage;
  await persistStream(stream, profile);
  relay.stopSession(stream.id, 'subtitle removed');
  log.info('playlist', `subtitle removed from "${stream.title}"`, { stream: stream.id });
  return store.getStream(streamId);
}

/* ------------------------------------------------------------------ *
 * outputs: m3u / bouquet / xtream
 * ------------------------------------------------------------------ */

/**
 * The .m3u / .m3u8 output of the playlist. `hls` picks the `.m3u8` (HLS) relay
 * URL for streams whose profile actually produces HLS segments; every other
 * stream gets its .ts URL, which is what VLC, Kodi and IPTV apps play.
 */
export async function playlistText(baseUrl, { name: playlistName = null, hls = false } = {}) {
  const streams = await enabledStreams();
  const items = streams.map((stream) => {
    const urls = store.urlsFor(stream, baseUrl);
    const useHls = hls && stream.profile?.container === 'hls';
    const subtitle = stream.profile?.subtitlePath || '';
    return {
      title: `${stream.title}${stream.year ? ` (${stream.year})` : ''}`,
      url: useHls ? urls.hls : urls.ts,
      logo: stream.poster,
      quality: stream.upstream?.quality,
      group: playlistName || name(),
      subtitle: subtitle || undefined,
    };
  });
  return { text: exporter.buildM3U(items, { name: playlistName || name() }), count: items.length };
}

/** The Enigma2 bouquet for the enabled items, in playlist order. */
export async function bouquet(baseUrl, { serviceType = null } = {}) {
  const streams = await enabledStreams();
  const entries = streams.map((stream) => ({
    title: stream.title,
    year: stream.year,
    url: store.urlsFor(stream, baseUrl).forBox,
    description: `${stream.title}${stream.year ? ` (${stream.year})` : ''} — ${stream.upstream?.quality || 'source'}`,
    subtitle: stream.profile?.subtitlePath ? (stream.profile.subtitleLanguage || '').slice(0, 3) : null,
    season: stream.upstream?.season || null,
    series: stream.title,
  }));
  const built = enigma2.buildBouquet({
    name: name(),
    serviceType: serviceType || getConfig().enigma2.serviceType || 4097,
    entries,
  });
  return { ...built, count: entries.length };
}

/** Short summary used by the Stream tab's header and by the log page. */
export async function summary() {
  const items = await entries();
  return {
    total: items.length,
    enabled: items.filter((item) => item.enabled).length,
    withTemplate: items.filter((item) => item.stream.profile?.ffmpegTemplate).length,
    withSubtitle: items.filter((item) => item.stream.profile?.subtitlePath).length,
  };
}

export default {
  name, token, tokenMatches, saveItems, sync, entries, enabledStreams, addItems, removeItem,
  updateItem, reorder, assignTemplate, attachSubtitle, detachSubtitle, pushSubtitle, playlistText, bouquet, summary,
  configWritableNow,
};
