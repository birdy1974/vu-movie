/**
 * vu-movie — “are the streams in the playlist still working?”
 *
 * A playlist item stores the upstream URL it was resolved to, and that URL is
 * the part of the chain that rots: signed tokens expire, mirrors disappear,
 * CDNs start geo-blocking and one-off hostnames lose their DNS. The Search tab
 * already proves a candidate before offering it (`registry.probeCandidates`);
 * this module runs the same proof over the playlist, on demand, and reports one
 * state per item — plus whether a fresh resolve is worth it.
 *
 * Pure by design: the caller hands over plain targets (this module reads no
 * store and no config) and may inject the prober, which is what the tests do.
 * Reusing the candidate prober means the playlist check expands HLS masters,
 * preflights DNS/TCP and reports the same failure wording as a search.
 *
 * States:
 *   working     ffprobe played the URL — `probe` carries what it found
 *   dead        the probe failed; `error` says why (dead mirror, 403, …)
 *   expired     the stream's own upstream-token TTL has passed (no network needed)
 *   unverified  probing is switched off in Settings or ffprobe is missing
 *   skipped     the item has no upstream URL to check
 */

import { log } from '../core/log.js';
import { streamKind } from '../core/media.js';
import { probeCandidates } from '../scrapers/registry.js';

/** Every state a checked item can end in (in the order the summary lists them). */
export const CHECK_STATES = ['working', 'dead', 'expired', 'unverified', 'skipped'];

/** The states that mean “this stream will not play right now”. */
export const BROKEN_STATES = ['dead', 'expired'];

const isoAt = (value) => new Date(value).toISOString();

/** `2026-10-06 20:15 (UTC)` — short, for a tag title / log line. */
function shortStamp(value) {
  return isoAt(value).replace('T', ' ').slice(0, 16);
}

/** Count one result per state + the totals the UI shows. */
export function summariseCheck(results = [], { ms = null, checkedAt = Date.now(), probing = null } = {}) {
  const summary = {
    checked: results.length,
    checkedAt: isoAt(checkedAt),
    ms,
    probing: probing !== false,
  };
  for (const state of CHECK_STATES) {
    summary[state] = results.filter((result) => result.state === state).length;
  }
  // “broken” = everything that will not play now; unverified/skipped are not
  // failures, they are unknowns, and the UI keeps them apart.
  summary.broken = results.filter((result) => BROKEN_STATES.includes(result.state)).length;
  return summary;
}

/** The probe fields the UI actually shows — never the whole ffprobe payload. */
export function trimProbe(info) {
  if (!info) return null;
  const audio = Array.isArray(info.audio) ? info.audio : info.audio ? [info.audio] : [];
  return {
    container: info.container || null,
    durationSec: Number(info.durationSec) || null,
    video: info.video ? {
      codec: info.video.codec || null,
      width: Number(info.video.width) || null,
      height: Number(info.video.height) || null,
      fps: Number(info.video.fps) || null,
    } : null,
    audio: audio.slice(0, 3).map((track) => ({ codec: track?.codec || null, channels: Number(track?.channels) || null })),
    subtitleTracks: Array.isArray(info.subtitles) ? info.subtitles.length : 0,
  };
}

/**
 * Check the given targets (playlist order preserved).
 *
 * @param {Array} targets  `{ streamId, title, sourceId, enabled, url, headers, kind, expiresAt }`
 * @param {Object} options
 *   `prober`    — `probeCandidates`-compatible function (injected by tests)
 *   `signal`    — abort a long check (a closed request)
 *   `now`       — clock, for the expiry test + the summary stamp
 *   `concurrency` — how many upstreams are probed at once. Two on purpose: a
 *                 NAS has one WAN and ffprobe sessions are held open for the
 *                 whole probe, so three+ at once mostly queue on the uplink
 *                 while making the log unreadable.
 */
export async function checkStreams(targets = [], {
  signal = null, concurrency = 2, now = () => Date.now(), prober = probeCandidates,
} = {}) {
  const list = (Array.isArray(targets) ? targets : []).filter(Boolean);
  const checkedAt = now();
  const started = now();
  const results = new Array(list.length).fill(null);

  // Pass 1 — everything that needs no network: no URL, or a token TTL that
  // already passed. Those items never reach ffprobe.
  const toProbe = [];
  list.forEach((target, index) => {
    const base = {
      streamId: String(target.streamId || ''),
      title: target.title || '',
      sourceId: target.sourceId || '',
      enabled: target.enabled !== false,
    };
    if (!target.url) {
      results[index] = { ...base, state: 'skipped', ok: false, error: 'no upstream URL stored for this stream', probeMs: null, probe: null };
      return;
    }
    const expiresAt = target.expiresAt ? new Date(target.expiresAt).getTime() : 0;
    if (expiresAt && expiresAt < checkedAt) {
      results[index] = {
        ...base, state: 'expired', ok: false, probeMs: null, probe: null,
        error: `the upstream token expired at ${shortStamp(expiresAt)} — re-resolve the title for a fresh URL`,
      };
      return;
    }
    toProbe.push({ index, base, target });
  });

  // Pass 2 — probe through the same pipeline a search uses. The `_checkIndex`
  // rides along on the candidate so the (ranked) answer can be put back in
  // playlist order.
  if (toProbe.length) {
    const candidates = toProbe.map(({ index, base, target }) => ({
      _checkIndex: index,
      url: target.url,
      headers: target.headers || {},
      sourceId: base.sourceId,
      kind: target.kind || streamKind(target.url),
    }));
    const probed = await prober(candidates, { concurrency, signal });
    const answered = new Set();
    for (const candidate of probed || []) {
      const index = Number.isInteger(candidate?._checkIndex) ? candidate._checkIndex : null;
      if (index == null) continue;
      answered.add(index);
      const pending = toProbe.find((entry) => entry.index === index);
      const base = pending?.base || { streamId: '', title: '', sourceId: '', enabled: true };
      const unverified = candidate.unverified === true || candidate.ok === undefined;
      const ok = candidate.ok !== false && !unverified;
      results[index] = {
        ...base,
        state: unverified ? 'unverified' : ok ? 'working' : 'dead',
        ok: ok && !unverified,
        error: ok || unverified ? null : (candidate.error || 'probe failed'),
        probeMs: Number.isFinite(candidate.probeMs) ? candidate.probeMs : null,
        probe: trimProbe(candidate.probe),
        variants: Array.isArray(candidate.variants) ? candidate.variants.length : 0,
      };
    }
    // A prober that answered nothing for an item (a stub, or a bug) must not
    // turn into a silent hole in the list.
    for (const { index, base } of toProbe) {
      if (!answered.has(index)) {
        results[index] = { ...base, state: 'unverified', ok: false, error: 'the prober did not answer for this stream', probeMs: null, probe: null };
      }
    }
  }

  const outcome = results.filter(Boolean);
  const summary = summariseCheck(outcome, { ms: now() - started, checkedAt, probing: toProbe.length > 0 });
  const broken = outcome.filter((result) => BROKEN_STATES.includes(result.state));
  log.info('playlist', `stream check: ${summary.working}/${summary.checked} working`, {
    dead: summary.dead,
    expired: summary.expired,
    unverified: summary.unverified,
    skipped: summary.skipped,
    ms: summary.ms,
    ...(broken.length ? { broken: broken.map((result) => `${result.title || result.streamId} (${result.error || result.state})`).join('; ') } : {}),
  });
  return { results: outcome, summary };
}

export default { CHECK_STATES, BROKEN_STATES, summariseCheck, trimProbe, checkStreams };
