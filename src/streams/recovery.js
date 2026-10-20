/**
 * Verify a saved upstream before playback and refresh it when it has gone stale.
 *
 * The NAS-issued stream id/token are deliberately kept stable: existing VLC,
 * Enigma2 and playlist URLs continue to work. Recovery replaces only the
 * upstream candidate (URL, headers, probe and source), then renews its lifetime.
 *
 * Proofs are remembered in readiness.js: while a proof is inside its trust
 * window (`playlist.prewarmTrustMinutes`, capped by the signed URL's own
 * expiry) playback skips the probe completely. That is what makes pre-warming
 * useful — the keep-warm loop (playlist/maintenance.js) and the manual
 * "prepare" endpoints run this same check/repair *before* anyone presses
 * play, so the expensive path (a 20 s probe timeout, then minutes of
 * Chromium provider searches) no longer happens while the box waits.
 */
import { getConfig } from '../core/config.js';
import { log, errorText } from '../core/log.js';
import * as registry from '../scrapers/registry.js';
import * as relay from './relay.js';
import * as store from './store.js';
import * as readiness from './readiness.js';
import { BROKEN_STATES, checkStreams } from '../playlist/check.js';

const MAX_MATCHES_PER_PROVIDER = 3;
const MAX_RESOLVE_RESULTS = 18;
const inFlight = new Map();

function mediaKind(value) {
  return /series|tv|show/i.test(String(value || '')) ? 'series' : 'movie';
}

function targetFor(stream) {
  return {
    streamId: stream.id,
    title: stream.title,
    sourceId: stream.source_id,
    enabled: true,
    url: stream.upstream?.url || '',
    headers: stream.upstream?.headers || {},
    kind: stream.upstream?.kind || stream.kind || null,
    expiresAt: store.tokenExpiresAt(stream),
  };
}

function matchingResults(results, stream) {
  const expectedTitle = registry.canonicalTitleKey(stream.title);
  const expectedKind = mediaKind(stream.kind);
  const expectedYear = Number(stream.year) || null;
  if (!expectedTitle) return [];

  return (Array.isArray(results) ? results : []).map((result, index) => {
    if (!result?.url || registry.canonicalTitleKey(result.title) !== expectedTitle) return null;
    if (result.kind && mediaKind(result.kind) !== expectedKind) return null;
    const year = Number(result.year) || null;
    // A same-title remake is not an acceptable replacement when both years are known.
    if (expectedYear && year && year !== expectedYear) return null;
    return {
      result,
      index,
      score: (expectedYear && year ? 100 : 35)
        + (result.sourceId === stream.source_id ? 5 : 0),
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_RESOLVE_RESULTS).map(({ result }) => result);
}

async function searchOriginalProvider(stream, { searchSource = registry.searchSource, searchAll = registry.searchAll, signal } = {}) {
  const sourceId = String(stream.source_id || '');
  if (!sourceId) return [];
  if (sourceId === 'moviebox') {
    const found = await searchAll(stream.title, {
      sources: [], type: mediaKind(stream.kind), includeMoviebox: true,
      limitPerSource: 6, detailed: true, signal,
    });
    return matchingResults(found?.results?.filter((item) => item.sourceId === 'moviebox'), stream);
  }
  const source = registry.getSource(sourceId);
  if (!source || source.enabled === false) return [];
  const rows = await searchSource(source, stream.title, { signal });
  return matchingResults(rows, stream);
}

async function searchOtherProviders(stream, { searchAll = registry.searchAll, signal } = {}) {
  const previousSource = String(stream.source_id || '');
  const sources = registry.loadSources().filter((source) => source.enabled && source.id !== previousSource).map((source) => source.id);
  const found = await searchAll(stream.title, {
    sources,
    type: mediaKind(stream.kind),
    limitPerSource: 6,
    includeMoviebox: previousSource !== 'moviebox',
    detailed: true,
    signal,
  });
  return matchingResults(found?.results, stream);
}

async function resolveFromResults(stream, results, {
  resolveTarget = registry.resolveTarget,
  prober = registry.probeCandidates,
  signal = null,
} = {}) {
  for (const result of results) {
    if (signal?.aborted) throw Object.assign(new Error('stream recovery aborted'), { name: 'AbortError' });
    try {
      const sourceId = result.sourceId || '';
      const resolved = await resolveTarget({
        url: result.url,
        sourceId,
        title: stream.title,
        year: stream.year || result.year || null,
        kind: mediaKind(stream.kind),
        season: Number(stream.upstream?.season) || 0,
        episode: Number(stream.upstream?.episode) || 0,
        useBrowser: sourceId !== 'moviebox',
        signal,
      });
      if (!resolved?.candidates?.length) continue;
      const candidates = await prober(resolved.candidates, {
        limit: Number(getConfig().scraper.maxCandidates) || undefined,
        concurrency: 2,
        signal,
      });
      const playable = (candidates || []).find((candidate) => candidate.ok === true && candidate.unverified !== true);
      if (playable) return { candidate: { ...playable, sourceId: playable.sourceId || result.sourceId }, result, verified: true };
      // If ffprobe is explicitly disabled/unavailable, still let a fresh resolve
      // replace an expired URL. The playback caller will be told it is unverified.
      const unverified = (candidates || []).find((candidate) => candidate.ok !== false && candidate.unverified === true);
      if (unverified) return { candidate: { ...unverified, sourceId: unverified.sourceId || result.sourceId }, result, verified: false };
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      log.warn('recovery', `could not resolve "${stream.title}" from ${result.sourceId || 'a provider'}`, {
        streamId: stream.id,
        provider: result.sourceId || '',
        error: errorText(error),
      });
    }
  }
  return null;
}

async function findFreshCandidate(stream, options) {
  let sameProvider = [];
  try {
    sameProvider = await searchOriginalProvider(stream, options);
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'AbortError') throw error;
    log.warn('recovery', `same-provider search failed for "${stream.title}"`, {
      streamId: stream.id, provider: stream.source_id || '', error: errorText(error),
    });
  }
  if (sameProvider.length) {
    log.info('recovery', `trying ${sameProvider.length} same-provider result(s) for "${stream.title}"`, {
      streamId: stream.id, provider: stream.source_id || '',
    });
    const same = await resolveFromResults(stream, sameProvider, options);
    if (same) return same;
  }

  let otherProviders = [];
  try {
    otherProviders = await searchOtherProviders(stream, options);
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'AbortError') throw error;
    log.warn('recovery', `other-provider search failed for "${stream.title}"`, {
      streamId: stream.id, error: errorText(error),
    });
  }
  if (!otherProviders.length) return null;
  log.info('recovery', `trying ${otherProviders.length} result(s) from other providers for "${stream.title}"`, {
    streamId: stream.id,
    providers: [...new Set(otherProviders.map((item) => item.sourceId).filter(Boolean))].join(','),
  });
  return resolveFromResults(stream, otherProviders, options);
}

async function refreshRecord(stream, candidate) {
  // A delete during the network resolve should not resurrect a removed stream.
  if (!await store.getStream(stream.id)) return null;
  const updated = await store.createStream({
    id: stream.id,
    token: stream.token,
    created_at: stream.created_at,
    playlist_name: stream.playlist_name,
    subtitle_id: stream.subtitle_id,
    source_id: candidate.sourceId || stream.source_id,
    payload: stream.payload || {},
    title: stream.title,
    year: stream.year,
    kind: stream.kind,
    poster: stream.poster,
    posterReferer: stream.payload?.meta?.posterReferer || '',
    description: stream.description,
    candidate: { ...candidate, sourceId: candidate.sourceId || stream.source_id },
    profile: stream.profile || {},
    season: stream.upstream?.season || null,
    episode: stream.upstream?.episode || null,
  });
  // If a session was idling on the dead URL, make the next request build a
  // session from the refreshed candidate. The public stream URL/token is stable.
  relay.stopSession(stream.id, 'upstream refreshed after availability check');
  readiness.forget(String(stream.id));
  return updated;
}

async function runAvailabilityCheck(stream, {
  reason = 'playback',
  autoRepair = getConfig().playlist?.autoRepairEnabled !== false,
  initialCheck = null,
  signal = null,
  prober = registry.probeCandidates,
  searchSource = registry.searchSource,
  searchAll = registry.searchAll,
  resolveTarget = registry.resolveTarget,
} = {}) {
  const current = await store.getStream(stream?.id || stream);
  if (!current) return { ok: false, stream: null, repaired: false, result: null, error: 'stream not found' };

  const check = initialCheck || (await checkStreams([targetFor(current)], { concurrency: 1, signal, prober })).results[0];
  if (!check) return { ok: false, stream: current, repaired: false, result: null, error: 'availability check returned no result' };
  if (check.state === 'working') {
    readiness.markVerified(current, check);
    return { ok: true, stream: current, repaired: false, verified: true, result: check };
  }
  if (check.state === 'unverified') {
    // Don't treat missing ffprobe / disabled probing as a dead source, and don't
    // block playback solely because this container cannot verify it.
    readiness.markVerified(current, check);
    return { ok: true, stream: current, repaired: false, verified: false, result: check };
  }
  if (!BROKEN_STATES.includes(check.state) && check.state !== 'skipped') {
    return { ok: true, stream: current, repaired: false, verified: false, result: check };
  }
  if (!autoRepair) {
    const error = check.error || 'upstream is not active';
    readiness.markFailed(current, error, { state: check.state });
    return { ok: false, stream: current, repaired: false, verified: false, result: check, error };
  }

  const options = { reason, signal, prober, searchSource, searchAll, resolveTarget };
  const fresh = await findFreshCandidate(current, options);
  if (!fresh) {
    const detail = `automatic refresh found no playable match for "${current.title}"`;
    const result = { ...check, repairError: detail };
    readiness.markFailed(current, detail, { state: check.state });
    log.warn('recovery', detail, { streamId: current.id, previousSource: current.source_id || '', reason });
    return { ok: false, stream: current, repaired: false, verified: false, result, error: detail };
  }

  const updated = await refreshRecord(current, fresh.candidate);
  if (!updated) {
    return { ok: false, stream: null, repaired: false, verified: false, result: check, error: 'stream was deleted while it was being refreshed' };
  }
  const refreshedCheck = {
    ...check,
    sourceId: updated.source_id || fresh.candidate.sourceId || '',
    state: fresh.verified ? 'working' : 'unverified',
    ok: fresh.verified,
    error: null,
    repairError: null,
    repaired: true,
    previousSourceId: current.source_id || '',
    sourceChanged: Boolean(current.source_id && updated.source_id && current.source_id !== updated.source_id),
    probe: fresh.candidate.probe || null,
    probeMs: Number(fresh.candidate.probeMs) || null,
  };
  readiness.markVerified(updated, refreshedCheck);
  log.info('recovery', `refreshed upstream for "${updated.title}"`, {
    streamId: updated.id,
    previousSource: current.source_id || '',
    source: updated.source_id || '',
    verified: fresh.verified,
    reason,
  });
  return { ok: true, stream: updated, repaired: true, verified: fresh.verified, result: refreshedCheck };
}

/** Check a stream and, if it is dead/expired, try the same provider then others. */
export function ensureStreamReady(streamOrId, options = {}) {
  const id = String(typeof streamOrId === 'object' ? streamOrId?.id || '' : streamOrId || '');
  if (!id) return Promise.resolve({ ok: false, stream: null, repaired: false, result: null, error: 'stream id is required' });
  const existing = inFlight.get(id);
  if (existing) return existing;

  if (!options.initialCheck && !options.forceCheck) {
    // Fast path: a proof from an earlier check/pre-warm is still trusted, so
    // playback starts now instead of after an ffprobe run. The gate here is
    // id-only; the URL is re-compared against the stored stream below, so a
    // proof for a since-replaced upstream is never reused.
    if (readiness.getReadiness(id).ready) {
      return store.getStream(id).then((stream) => {
        if (!stream) return { ok: false, stream: null, repaired: false, verified: false, result: null, error: 'stream not found' };
        const proof = readiness.cachedProof(stream);
        if (!proof) return ensureStreamReady(stream, { ...options, forceCheck: true });
        log.debug('recovery', `pre-warmed link for "${stream.title}" is still trusted — starting without a re-probe`, {
          streamId: id,
          verifiedSecAgo: Math.max(0, Math.round((Date.now() - proof.at) / 1000)),
          trustedUntil: new Date(proof.trustUntil).toISOString(),
          reason: options.reason || 'playback',
        });
        return {
          ok: true,
          stream,
          repaired: false,
          verified: proof.state === 'working',
          result: { ...proof.result, cached: true, trustedUntil: new Date(proof.trustUntil).toISOString() },
        };
      });
    }
  }

  readiness.beginCheck(id);
  const operation = runAvailabilityCheck(typeof streamOrId === 'object' ? streamOrId : { id }, options)
    .catch((error) => {
      if (error?.name === 'AbortError') throw error;
      const message = errorText(error);
      log.warn('recovery', `availability/recovery failed for stream ${id}`, { streamId: id, error: message });
      readiness.markFailed(id, message);
      return { ok: false, stream: null, repaired: false, verified: false, result: null, error: message };
    })
    .finally(() => { inFlight.delete(id); readiness.endCheck(id); });
  inFlight.set(id, operation);
  return operation;
}

/**
 * Start verifying (and, if needed, repairing) a stream *now*, in the
 * background, and return immediately. This is the manual "prepare" action:
 * by the time the viewer zaps to the title on the box, a trusted proof is
 * already stored and playback takes the fast path above.
 *
 * A manual prepare always runs — failure backoff only throttles the
 * background keep-warm loop. With `force: false` (the default) a stream
 * whose proof is still trusted is reported as already ready instead of
 * being probed again.
 */
export async function prewarmStream(streamOrId, options = {}) {
  const { reason = 'prewarm', force = false, ...ensureOptions } = options;
  const id = String(typeof streamOrId === 'object' ? streamOrId?.id || '' : streamOrId || '');
  const stream = (typeof streamOrId === 'object' && streamOrId?.upstream)
    ? streamOrId
    : (id ? await store.getStream(id) : null);
  if (!stream) {
    return { started: false, alreadyReady: false, alreadyPreparing: false, readiness: readiness.getReadiness(id), error: 'stream not found' };
  }
  if (inFlight.has(String(stream.id)) || readiness.isChecking(stream.id)) {
    return { started: false, alreadyReady: false, alreadyPreparing: true, readiness: readiness.getReadiness(stream) };
  }
  if (!force && readiness.cachedProof(stream)) {
    return { started: false, alreadyReady: true, alreadyPreparing: false, readiness: readiness.getReadiness(stream) };
  }
  const operation = ensureStreamReady(stream, { ...ensureOptions, reason, forceCheck: true });
  // Fire-and-forget by contract: ensureStreamReady already converts failures
  // into a result, but an abort (a caller-supplied signal) must not become an
  // unhandled rejection nobody is awaiting.
  operation.catch(() => {});
  log.info('recovery', `pre-warming "${stream.title}" in the background`, { streamId: stream.id, reason, force });
  return { started: true, alreadyReady: false, alreadyPreparing: false, readiness: readiness.getReadiness(stream) };
}

/** Readiness for one stream, loading the record first when only an id is given. */
export async function getStreamReadiness(streamOrId) {
  if (typeof streamOrId === 'object' && streamOrId) return readiness.getReadiness(streamOrId);
  const stream = await store.getStream(String(streamOrId || ''));
  return readiness.getReadiness(stream || String(streamOrId || ''));
}

/**
 * Record a proof obtained outside ensureStreamReady (a Playlist "check
 * streams" run, or a just-created stream whose candidate was already probed
 * during resolve) so the next play can take the fast path too.
 */
export function markStreamVerified(stream, result) {
  return readiness.markVerified(stream, result);
}

export function forgetStreamAvailability(streamId) {
  readiness.forget(String(streamId));
}

export default {
  ensureStreamReady,
  prewarmStream,
  getStreamReadiness,
  markStreamVerified,
  forgetStreamAvailability,
};
