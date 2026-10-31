/**
 * vu-movie — stored plots for the playlist EPG.
 *
 * The meta details view fetches TMDB/OMDB live and used to throw the plot
 * away, and the bouquet push then repeated every lookup under one shared
 * ten-second deadline. On a long playlist that deadline ran out after a
 * handful of titles and every later movie got "No plot available" — until the
 * next push, whose cache hits let it get a little further.
 *
 * A plot is now resolved once per stream and stored on the record
 * (`payload.meta.plot`, no schema change):
 *   1. when a title is added to the playlist (POST /api/streams) — reusing the
 *      exact plot the details view showed if the user opened the title first,
 *      because the details endpoints write into the same cache;
 *   2. by a background backfill for streams that still lack one (at startup
 *      and after every push), without any push deadline;
 *   3. the push itself keeps only a short bounded lookup as a last resort and
 *      also stores whatever it finds, so no lookup is ever repeated.
 *
 * Matching: unattended lookups (add time, backfill, push) accept only a
 * TMDB/OMDB result whose title and year match the stream, exactly as the EPG
 * code did before. A plot the user has actually seen in the details view is
 * taken as-is — that view shows the first provider hit — so the EPG never
 * disagrees with what the UI showed for the same title.
 */
import crypto from 'node:crypto';
import { repo } from '../core/db.js';
import { getConfig } from '../core/config.js';
import { log, errorText } from '../core/log.js';
import * as tmdb from './tmdb.js';
import * as omdb from './omdb.js';

const PLOT_TTL_SECONDS = 30 * 86400;
const MISS_TTL_SECONDS = 86400;

function language() {
  return getConfig().metadata?.language || 'en-US';
}

function hash(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function kindOf(value) {
  return value === 'series' || value === 'tv' ? 'series' : 'movie';
}

/** The normalised lookup query of a stream record or bouquet entry. */
export function plotQuery(source = {}) {
  const meta = source.payload?.meta || {};
  return {
    title: String(source.title || '').trim(),
    year: Number(source.year) || null,
    kind: kindOf(source.kind),
    imdbId: source.imdbId || meta.imdbId || null,
    tmdbId: source.tmdbId || meta.tmdbId || null,
  };
}

/**
 * Cache keys, most specific first. Provider ids identify a title regardless
 * of how a scraper spelled it; the title key is what the details view and the
 * add path share when no id is known. The language is part of every key so a
 * changed Settings → Metadata language does not serve old-language plots.
 */
export function plotCacheKeys(query) {
  const q = plotQuery(query);
  const keys = [];
  if (q.tmdbId) keys.push(`plot:v2:tmdb:${hash([kindOf(q.kind), String(q.tmdbId), language()])}`);
  if (q.imdbId) keys.push(`plot:v2:imdb:${hash([String(q.imdbId), language()])}`);
  if (q.title) keys.push(`plot:v2:title:${hash([q.title.toLowerCase(), q.year, q.kind, language()])}`);
  return keys;
}

function cleanPlot(value) {
  const text = String(value || '').trim();
  return text && text !== 'N/A' ? text : '';
}

/** The plot the details view or an earlier lookup already produced, if any. */
export async function cachedPlot(query, { cache = repo } = {}) {
  for (const key of plotCacheKeys(query)) {
    const hit = await cache.cacheGet(key);
    if (hit?.plot) return { ...hit, cached: true };
    if (hit?.miss) return { plot: '', miss: true, cached: true };
  }
  return null;
}

/** Remember a resolved plot under every key the title can be asked by. */
export async function rememberPlot(query, result, { cache = repo } = {}) {
  const plot = cleanPlot(result?.plot);
  if (!plot) return null;
  const value = {
    plot,
    imdbId: result.imdbId || plotQuery(query).imdbId || null,
    tmdbId: result.tmdbId || plotQuery(query).tmdbId || null,
    source: result.source || null,
  };
  const keys = new Set([...plotCacheKeys(query), ...plotCacheKeys({ ...plotQuery(query), imdbId: value.imdbId, tmdbId: value.tmdbId })]);
  for (const key of keys) await cache.cacheSet(key, value, PLOT_TTL_SECONDS);
  return value;
}

/** A confirmed "no matching title" is kept for a day so backfills do not repeat it every run. */
async function rememberMiss(query, { cache = repo } = {}) {
  const [key] = plotCacheKeys(query).slice(-1);
  if (key) await cache.cacheSet(key, { plot: '', miss: true }, MISS_TTL_SECONDS);
}

/**
 * Called by the metadata detail endpoints: the plot the user is looking at
 * becomes the stored plot of that title when it is added (or backfilled).
 */
export async function rememberEnrichedPlot(query, enriched, { cache = repo } = {}) {
  if (!enriched) return null;
  const plot = cleanPlot(enriched.tmdb?.overview) || cleanPlot(enriched.omdb?.plot);
  if (!plot) return null;
  return rememberPlot(query, {
    plot,
    imdbId: enriched.imdbId || enriched.tmdb?.imdbId || enriched.omdb?.imdbId || null,
    tmdbId: enriched.tmdbId || enriched.tmdb?.tmdbId || null,
    source: enriched.tmdb?.overview ? 'tmdb' : 'omdb',
  }, { cache });
}

function titleKey(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Unattended lookups only accept a result that is clearly the same title. */
export function matchesTitle(entry, candidate) {
  if (entry.tmdbId || entry.imdbId) return true;
  const wanted = titleKey(entry.title);
  const names = [candidate?.title, candidate?.originalTitle].map(titleKey);
  const yearMatches = !entry.year || !candidate?.year || Math.abs(Number(entry.year) - Number(candidate.year)) <= 1;
  return Boolean(wanted && names.includes(wanted) && yearMatches);
}

export function providersConfigured() {
  return tmdb.isConfigured() || omdb.isConfigured();
}

/** TMDB first, OMDB second; returns `{ plot, imdbId, tmdbId, source }` or null. */
export async function lookupPlot(entry, signal) {
  const query = { title: entry.title, year: entry.year, type: entry.kind, imdbId: entry.imdbId, tmdbId: entry.tmdbId, signal };
  if (tmdb.isConfigured()) {
    try {
      const results = await tmdb.searchTMDB(query);
      const hit = results.results?.find((item) => matchesTitle(entry, item) && cleanPlot(item.overview));
      if (hit) return { plot: cleanPlot(hit.overview), imdbId: hit.imdbId || null, tmdbId: hit.tmdbId || null, source: 'tmdb' };
    } catch (error) { if (signal?.aborted) throw error; }
  }
  if (omdb.isConfigured() && !signal?.aborted) {
    const result = await omdb.searchOMDB(query);
    if (matchesTitle(entry, result) && cleanPlot(result.plot)) return { plot: cleanPlot(result.plot), imdbId: result.imdbId || null, tmdbId: null, source: 'omdb' };
  }
  return null;
}

function normaliseLookupResult(value) {
  if (!value) return null;
  if (typeof value === 'string') return cleanPlot(value) ? { plot: cleanPlot(value) } : null;
  return cleanPlot(value.plot) ? { ...value, plot: cleanPlot(value.plot) } : null;
}

/**
 * Resolve the plot of one title: shared cache first, then the providers.
 * Returns `{ plot, imdbId, tmdbId, source, cached }` or null. A provider
 * failure propagates (callers decide whether to retry later); a confirmed
 * miss is cached and returns null.
 */
export async function resolvePlot(query, { signal = undefined, lookup = lookupPlot, cache = repo } = {}) {
  const q = plotQuery(query);
  if (!q.title && !q.imdbId && !q.tmdbId) return null;
  const hit = await cachedPlot(q, { cache });
  if (hit?.plot) return hit;
  if (hit?.miss) return null;
  // Without provider keys there is nothing to ask — and nothing to remember
  // as a miss, or keys added later would wait a day for these titles.
  if (lookup === lookupPlot && !providersConfigured()) return null;
  if (signal?.aborted) throw new Error('plot lookup aborted');
  const found = normaliseLookupResult(await lookup(q, signal));
  if (found) return { ...(await rememberPlot(q, found, { cache })), cached: false };
  if (!signal?.aborted) await rememberMiss(q, { cache });
  return null;
}

/** The plot text the EPG should publish for a stream record. */
export function storedPlot(stream) {
  const meta = stream?.payload?.meta || {};
  return cleanPlot(meta.plot) || cleanPlot(stream?.description) || cleanPlot(meta.description);
}

export function hasStoredPlot(stream) {
  return Boolean(cleanPlot(stream?.payload?.meta?.plot));
}

/** Write a resolved plot (and the provider ids it came with) onto the stream record. */
export async function storePlotOnStream(stream, result, { db = repo } = {}) {
  const plot = cleanPlot(result?.plot);
  if (!stream?.id || !plot) return stream;
  // Re-read before writing: another chore (subtitle attach, template change)
  // may have saved the record since the caller loaded it.
  const current = await db.getStream(stream.id);
  if (!current || current.payload?.meta?.ephemeral === true) return current || stream;
  const meta = {
    ...(current.payload?.meta || {}),
    plot,
    plotSource: result.source || null,
    plotAt: new Date().toISOString(),
    ...(result.imdbId && !current.payload?.meta?.imdbId ? { imdbId: result.imdbId } : {}),
    ...(result.tmdbId && !current.payload?.meta?.tmdbId ? { tmdbId: result.tmdbId } : {}),
  };
  const payload = { ...(current.payload || {}), meta };
  const saved = await db.saveStream({ ...current, payload });
  // Callers that still hold the old object (afterStreamCreated's subtitle
  // chores re-save `stream` as-is) must not write the plot away again.
  stream.payload = payload;
  return saved;
}

/**
 * Make sure a stream carries a plot: cache or providers, then persist.
 * Never throws — a missing plot must not fail the chore that asked for it.
 * Returns `{ state: 'stored' | 'exists' | 'missing' | 'skipped' | 'error', plot }`.
 */
export async function ensureStreamPlot(stream, { timeoutMs = 15000, signal = undefined, lookup = lookupPlot, cache = repo, db = repo } = {}) {
  if (!stream?.id || stream.payload?.meta?.ephemeral === true) return { state: 'skipped', plot: storedPlot(stream) };
  if (hasStoredPlot(stream)) return { state: 'exists', plot: storedPlot(stream) };
  if (!providersConfigured() && lookup === lookupPlot) return { state: 'skipped', plot: storedPlot(stream) };
  try {
    const abort = signal || AbortSignal.timeout(timeoutMs);
    const found = await resolvePlot(plotQuery(stream), { signal: abort, lookup, cache });
    if (!found) return { state: 'missing', plot: storedPlot(stream) };
    await storePlotOnStream(stream, found, { db });
    return { state: 'stored', plot: found.plot, cached: found.cached === true };
  } catch (error) {
    log.warn('metadata', `plot lookup failed for "${stream.title}"`, { error: errorText(error), stream: stream.id });
    return { state: 'error', plot: storedPlot(stream), error: errorText(error) };
  }
}

/* ---------------- background backfill ---------------- */

let backfillRun = null;
const backfillState = { lastStartedAt: null, lastFinishedAt: null, lastSummary: null };

/**
 * Fill the stored plot of every saved (non-preview) stream that lacks one,
 * one lookup at a time and without a push deadline. Concurrent calls join
 * the run in progress. Returns `{ checked, stored, missing, errors }`.
 */
export function backfillStoredPlots({ reason = 'manual', streams = null, lookup = lookupPlot, cache = repo, db = repo, timeoutMs = 15000 } = {}) {
  if (backfillRun) return backfillRun;
  backfillRun = (async () => {
    const summary = { reason, checked: 0, stored: 0, missing: 0, errors: 0 };
    backfillState.lastStartedAt = new Date().toISOString();
    try {
      if (!providersConfigured() && lookup === lookupPlot) return summary;
      const rows = streams || (await db.listStreams(200)).filter((row) => row?.payload?.meta?.ephemeral !== true);
      for (const row of rows) {
        if (hasStoredPlot(row)) continue;
        summary.checked += 1;
        const result = await ensureStreamPlot(row, { timeoutMs, lookup, cache, db });
        if (result.state === 'stored') summary.stored += 1;
        else if (result.state === 'error') summary.errors += 1;
        else summary.missing += 1;
      }
      if (summary.checked) log.info('metadata', 'stored plot backfill finished', summary);
      return summary;
    } finally {
      backfillState.lastFinishedAt = new Date().toISOString();
      backfillState.lastSummary = summary;
      backfillRun = null;
    }
  })();
  return backfillRun;
}

export function backfillStatus() {
  return { running: Boolean(backfillRun), ...backfillState };
}

export default {
  plotQuery, plotCacheKeys, cachedPlot, rememberPlot, rememberEnrichedPlot, matchesTitle, lookupPlot, resolvePlot,
  storedPlot, hasStoredPlot, storePlotOnStream, ensureStreamPlot, backfillStoredPlots, backfillStatus, providersConfigured,
};
