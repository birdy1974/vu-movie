/**
 * Trending lists and title recommendations built from the user's playlist-add
 * history. This module intentionally has no playback/watch-history input.
 */
import crypto from 'node:crypto';
import { getConfig } from '../core/config.js';
import { repo } from '../core/db.js';
import * as tmdb from './tmdb.js';

const CACHE_VERSION = 'v1';
const SEED_CONCURRENCY = 4;
const SEED_CACHE_SECONDS = 30 * 24 * 60 * 60;
const MISS_CACHE_SECONDS = 6 * 60 * 60;
const RECOMMENDATION_CACHE_SECONDS = 24 * 60 * 60;

function mediaType(value) {
  const type = String(value || 'all').trim().toLowerCase();
  if (['movie', 'movies', 'film'].includes(type)) return 'movie';
  if (['series', 'tv', 'show', 'shows'].includes(type)) return 'series';
  return 'all';
}

function kindFromEvent(event) {
  return /series|tv|show/i.test(String(event?.kind || event?.type || '')) ? 'series' : 'movie';
}

function canonicalTitle(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function historyKey(event) {
  return `${kindFromEvent(event)}|${canonicalTitle(event.title)}|${Number(event.year) || ''}`;
}

function cacheHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function languageKey() {
  return String(getConfig().metadata?.language || 'en-US').toLowerCase();
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  }));
  return output;
}

async function cachedList(key, seconds, load) {
  const cached = await repo.cacheGet(key);
  if (cached && Array.isArray(cached.items)) return cached;
  const items = await load();
  const result = { items };
  await repo.cacheSet(key, result, seconds);
  return result;
}

export async function trendingTitles({ type = 'all', window = 'week', limit = 20 } = {}) {
  const media = mediaType(type);
  const timeframe = window === 'day' ? 'day' : 'week';
  const count = Math.max(1, Math.min(50, Number(limit) || 20));
  const key = `discovery:${CACHE_VERSION}:trending:${languageKey()}:${media}:${timeframe}`;
  const { items } = await cachedList(key, 15 * 60, () => tmdb.getTrendingTMDB({ type: media, window: timeframe }));
  return { items: items.slice(0, count), type: media, window: timeframe };
}

export async function topTenTitles({ type = 'all', limit = 10 } = {}) {
  const media = mediaType(type);
  const count = Math.max(1, Math.min(50, Number(limit) || 10));
  const key = `discovery:${CACHE_VERSION}:top10:${languageKey()}:${media}`;
  const { items } = await cachedList(key, 24 * 60 * 60, () => tmdb.getTopRatedTMDB({ type: media, limit: 50 }));
  return { items: items.slice(0, count), type: media };
}

async function resolveSeed(seed) {
  if (/^\d+$/.test(String(seed.tmdbId || ''))) {
    return { tmdbId: String(seed.tmdbId), type: seed.kind, title: seed.title, count: seed.count, years: seed.years };
  }
  const queryKey = `discovery:${CACHE_VERSION}:seed:${languageKey()}:${cacheHash(historyKey(seed))}`;
  const cached = await repo.cacheGet(queryKey);
  if (cached && Object.hasOwn(cached, 'found')) return cached.found ? cached.seed : null;

  const result = await tmdb.searchTMDB({
    title: seed.title,
    year: seed.year,
    type: seed.kind === 'series' ? 'series' : 'movie',
  });
  const hit = result.results?.find((item) => item.tmdbId) || null;
  const resolved = hit ? {
    tmdbId: String(hit.tmdbId),
    type: hit.type === 'series' ? 'series' : 'movie',
    title: hit.title || seed.title,
    count: seed.count,
    years: seed.years,
  } : null;
  await repo.cacheSet(queryKey, { found: Boolean(resolved), seed: resolved }, resolved ? SEED_CACHE_SECONDS : MISS_CACHE_SECONDS);
  return resolved;
}

async function recommendationsForSeed(seed) {
  const key = `discovery:${CACHE_VERSION}:recommendations:${languageKey()}:${seed.type}:${seed.tmdbId}`;
  const cached = await repo.cacheGet(key);
  if (cached && Array.isArray(cached.items)) return cached.items;
  const items = await tmdb.getTMDBRecommendations({ tmdbId: seed.tmdbId, type: seed.type });
  await repo.cacheSet(key, { items }, RECOMMENDATION_CACHE_SECONDS);
  return items;
}

/**
 * Build a weighted, deduplicated recommendation list from every playlist-add
 * event. Repeated additions increase a seed's weight; they are never dropped
 * from the history, even though identical title lookups are coalesced here.
 */
export async function playlistRecommendations(history = [], { type = 'all', limit = 20 } = {}) {
  const media = mediaType(type);
  const count = Math.max(1, Math.min(50, Number(limit) || 20));
  const selected = (Array.isArray(history) ? history : []).filter((event) => {
    if (!event?.title || !String(event.title).trim()) return false;
    return media === 'all' || kindFromEvent(event) === media;
  });
  const seedsByHistoryKey = new Map();
  for (const event of selected) {
    const key = historyKey(event);
    if (!key.split('|')[1]) continue;
    const seed = seedsByHistoryKey.get(key) || {
      title: String(event.title).trim(),
      year: Number(event.year) || null,
      kind: kindFromEvent(event),
      tmdbId: event.tmdbId || event.tmdb_id || null,
      count: 0,
      years: new Set(),
    };
    seed.count += 1;
    if (Number(event.year)) seed.years.add(Number(event.year));
    if (!seed.tmdbId && (event.tmdbId || event.tmdb_id)) seed.tmdbId = event.tmdbId || event.tmdb_id;
    seedsByHistoryKey.set(key, seed);
  }
  const uniqueSeeds = [...seedsByHistoryKey.values()];
  if (!uniqueSeeds.length) {
    return {
      items: [], type: media, historyCount: selected.length, uniqueHistoryTitles: 0,
      resolvedHistoryTitles: 0, seedCount: 0, partialFailures: 0,
    };
  }

  const resolvedResults = await mapLimit(uniqueSeeds, SEED_CONCURRENCY, async (seed) => {
    try { return { seed, result: await resolveSeed(seed), error: null }; }
    catch (error) { return { seed, result: null, error: String(error?.message || error) }; }
  });
  const resolvedTitles = resolvedResults.filter((entry) => entry.result);
  const partialErrors = resolvedResults.filter((entry) => entry.error).map((entry) => entry.error);

  // Different spellings/years can resolve to the same TMDB id. Keep every
  // addition's weight while making one recommendation request per actual title.
  const seedsById = new Map();
  for (const { seed, result } of resolvedTitles) {
    const key = `${result.type}:${result.tmdbId}`;
    const merged = seedsById.get(key) || { ...result, count: 0, historyTitles: new Set() };
    merged.count += seed.count;
    merged.historyTitles.add(seed.title);
    seedsById.set(key, merged);
  }
  const resolvedSeeds = [...seedsById.values()];
  const previousTitles = new Set(selected.map((event) => `${kindFromEvent(event)}|${canonicalTitle(event.title)}`));
  const candidates = new Map();
  const recommendationResults = await mapLimit(resolvedSeeds, SEED_CONCURRENCY, async (seed) => {
    try { return { seed, items: await recommendationsForSeed(seed), error: null }; }
    catch (error) { return { seed, items: [], error: String(error?.message || error) }; }
  });

  for (const result of recommendationResults) {
    if (result.error) partialErrors.push(result.error);
    for (const item of result.items) {
      if (!item?.tmdbId || !item.title) continue;
      const kind = item.type === 'series' ? 'series' : 'movie';
      if (media !== 'all' && kind !== media) continue;
      if (previousTitles.has(`${kind}|${canonicalTitle(item.title)}`)) continue;
      const key = `${kind}:${item.tmdbId}`;
      const candidate = candidates.get(key) || {
        ...item,
        score: 0,
        matches: 0,
        historyMatches: 0,
        matchedTitles: new Set(),
      };
      candidate.score += result.seed.count;
      candidate.matches += 1;
      candidate.historyMatches += result.seed.count;
      for (const title of result.seed.historyTitles) candidate.matchedTitles.add(title);
      candidates.set(key, candidate);
    }
  }

  const items = [...candidates.values()].map((candidate) => ({
    ...candidate,
    matchedTitles: [...candidate.matchedTitles],
  })).sort((a, b) => b.score - a.score
    || b.matches - a.matches
    || Number(b.rating || 0) - Number(a.rating || 0)
    || Number(b.votes || 0) - Number(a.votes || 0))
    .slice(0, count);

  return {
    items,
    type: media,
    historyCount: selected.length,
    uniqueHistoryTitles: uniqueSeeds.length,
    resolvedHistoryTitles: resolvedTitles.length,
    seedCount: resolvedSeeds.length,
    partialFailures: partialErrors.length,
  };
}

export default { trendingTitles, topTenTitles, playlistRecommendations };
