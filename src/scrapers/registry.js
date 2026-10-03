/**
 * vu-movie — source registry and the resolve pipeline.
 *
 * Layers (per your decision D1):
 *   1. recipes   — per-site JSON describing search + how to open a title
 *   2. browser   — generic headless sniffer (always available, handles WASM players)
 *   3. moviebox  — native signed-API client, no browser needed
 *   4. external  — optional external extractor (your own resolver, …)
 *
 * Whatever layer produced a candidate, the candidate is then *probed* with ffprobe
 * before it is offered: dead mirrors, expired tokens and 403s are filtered out here
 * instead of failing later in VLC.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorText, log, logError, truncate } from '../core/log.js';
import { getConfig } from '../core/config.js';
import { probe, parseHlsMaster, streamKind, checkBinaries } from '../core/media.js';
import { request, resolveUrl } from './http.js';
import { normalizeSearchMetadata } from './metadata.js';
import * as browser from './browser.js';
import * as moviebox from './moviebox.js';
import { diagnoseReachability } from './diagnostics.js';
import * as external from './external.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_FILE = path.join(__dirname, 'builtin-sources.json');

let cache = null;

/** Load built-in recipes + user overrides (/config/sources/*.json). */
export function loadSources({ force = false } = {}) {
  if (cache && !force) return cache;
  const cfg = getConfig();
  const byId = new Map();

  const addFrom = (file) => {
    try {
      if (!fs.existsSync(file)) return 0;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const recipe of list) {
        if (!recipe?.id) continue;
        byId.set(recipe.id, recipe);
      }
      log.debug('scraper', `loaded ${list.length} source recipe(s) from ${file}`);
      return list.length;
    } catch (err) {
      logError('scraper', `could not parse source file ${file}`, err);
      return 0;
    }
  };

  addFrom(BUILTIN_FILE);

  // user recipes: each file may override a built-in by id
  try {
    const dir = cfg.sources.dir;
    if (dir && fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        addFrom(path.join(dir, file));
      }
    }
  } catch (err) {
    log.warn('scraper', 'could not scan the user source directory', { dir: cfg.sources.dir, error: String(err?.message || err) });
  }

  for (const custom of cfg.scraper.customSources || []) {
    if (custom?.id) byId.set(custom.id, { kind: 'browser', enabled: true, ...custom });
  }

  // Recipes stored in /config/sources (or added by hand) predate DASH/HLS
  // media detection and may be missing fields entirely. Fold the current
  // patterns in so an old recipe cannot be the reason a `.mpd` player is
  // invisible to the sniffer.
  let upgradedRecipes = 0;
  const sources = [...byId.values()].map((raw) => {
    const { site, upgraded } = browser.upgradeRecipe(raw);
    if (upgraded) upgradedRecipes += 1;
    return {
      id: site.id,
      name: site.name || site.id,
      home: site.home || '',
      enabled: site.enabled !== false,
      kind: site.kind || 'browser',
      notes: site.notes || '',
      match: site.match || [],
      search: site.search || null,
      resolve: site.resolve || { kind: 'browser' },
      mediaPatterns: site.mediaPatterns || null,
      mediaPatternsVersion: site.mediaPatternsVersion || null,
    };
  });
  if (upgradedRecipes) {
    log.debug('scraper', `upgraded ${upgradedRecipes} source recipe(s) to media-detection v${browser.RECIPE_SCHEMA_VERSION}`, {
      version: browser.RECIPE_SCHEMA_VERSION,
    });
  }

  for (const id of cfg.sources.disabled || []) {
    const s = sources.find((x) => x.id === id);
    if (s) s.enabled = false;
  }
  if ((cfg.sources.enabled || []).length) {
    for (const s of sources) s.enabled = cfg.sources.enabled.includes(s.id);
  }

  cache = sources;
  log.info('scraper', `source registry ready: ${sources.length} sites (${sources.filter((s) => s.enabled).length} enabled)`,
    { sites: sources.map((s) => s.id).join(',') });
  return sources;
}

export function listSources() {
  return loadSources().map((s) => ({
    ...s,
    health: healthOf(s.id),
  }));
}

export function getSource(id) {
  return loadSources().find((s) => s.id === id) || null;
}

export function matchSourceByUrl(url) {
  if (!url) return null;
  return loadSources().find((s) => (s.match || []).some((m) => String(url).includes(m))) || null;
}

/* ---------------- health bookkeeping (shown on the dashboard) ---------------- */

const health = new Map();
/**
 * Failure classification — only "hard" outages (captcha blocks, parked sites,
 * TLS reset across all hosts) trip the circuit breaker; a normal zero-results
 * response or transient HTTP 5xx just increments `failures` without backing off.
 */
const CIRCUIT_BREAK_ERR_PATTERNS = [
  /just a moment|security verification|verify you are human|captcha|cloudflare/i,
  /blocked by bot protection/i,
  /redirected off-site|pop-under\/ad/i,
  /FlareSolverr/i,
  /visitor-login failed.*TLS|all hosts closed the connection/i,
];
const BACKOFF_SCHEDULE_MS = [0, 0, 60_000, 5 * 60_000, 30 * 60_000]; // failures → cooldown
const CIRCUIT_COOLDOWN_RESET_MS = 15 * 60_000; // reset failure count after 15 min of quiet
function shouldTripCircuit(message) {
  const text = String(message || '');
  return CIRCUIT_BREAK_ERR_PATTERNS.some((re) => re.test(text));
}
function noteHealth(id, ok, message) {
  const prev = health.get(id) || { id, ok: null, checks: 0, failures: 0, cooldownUntil: 0, lastFailureAt: 0 };
  const now = Date.now();
  let failures = ok ? 0 : prev.failures + 1;
  // Reset failure count if the source was healthy again for long enough.
  if (!ok && prev.lastFailureAt && now - prev.lastFailureAt > CIRCUIT_COOLDOWN_RESET_MS) failures = 1;
  const tripped = !ok && shouldTripCircuit(message);
  const tier = Math.min(failures, BACKOFF_SCHEDULE_MS.length - 1);
  const cooldownMs = tripped ? BACKOFF_SCHEDULE_MS[tier] : 0;
  const cooldownUntil = tripped ? now + cooldownMs : 0;
  health.set(id, {
    ...prev,
    ok,
    message: message || (ok ? 'ok' : prev.message),
    checks: prev.checks + 1,
    failures,
    tripped,
    cooldownUntil,
    backoffSeconds: cooldownMs ? Math.round(cooldownMs / 1000) : 0,
    lastCheck: new Date().toISOString(),
    lastFailureAt: ok ? prev.lastFailureAt : now,
    lastSuccessAt: ok ? now : prev.lastSuccessAt || null,
  });
}
/** Returns true when a source is currently in its circuit-breaker cooldown. */
export function isSourceCoolingDown(id) {
  const h = health.get(id);
  return Boolean(h?.cooldownUntil && Date.now() < h.cooldownUntil);
}
export function healthOf(id) {
  const h = health.get(id);
  if (!h) return { id, ok: null, checks: 0, failures: 0, message: 'not used yet', coolingDown: false };
  return { ...h, coolingDown: Boolean(h.cooldownUntil && Date.now() < h.cooldownUntil) };
}
/** Manually reset a source's circuit breaker (called from the UI / /api/health reset). */
export function resetSourceHealth(id = null) {
  if (id) health.delete(id);
  else health.clear();
}

/* ---------------- search ---------------- */

function firstMappedField(item, map, key, aliases = []) {
  const hasValue = (value) => value != null && value !== '' && (!Array.isArray(value) || value.length > 0);
  const mapped = pickPath(item, map?.[key]);
  if (hasValue(mapped)) return mapped;
  for (const alias of aliases) {
    const value = pickPath(item, alias);
    if (hasValue(value)) return value;
  }
  return null;
}

/**
 * Search one source. Returns normalised result rows.
 * @param {object} source recipe
 * @param {string} query
 */
export async function searchSource(source, query, { signal = null, detailed = false } = {}) {
  const started = Date.now();
  const finish = (results, error = null) => detailed ? { results, error } : results;
  try {
    if (signal?.aborted) throw Object.assign(new Error('search aborted'), { name: 'AbortError' });
    if (source.search?.kind === 'api') {
      const search = source.search;
      const url = String(search.url).replace(/\{(?:query|q)\}/g, encodeURIComponent(query));
      const res = await request(url, {
        method: search.method || 'GET',
        headers: search.headers || {},
        json: true,
        allowFailure: true,
        retries: 1,
        signal,
      });
      if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`);
      const items = pickPath(res.data, search.items) || [];
      const rows = (Array.isArray(items) ? items : []).map((item) => {
        const map = search.map || {};
        const rawKind = String(pickPath(item, map.kind) || item.type || item.mediaType || '');
        const kind = /tv|serie|show/i.test(rawKind) ? 'series' : 'movie';
        const typeMap = search.typeMap || {};
        const mappedType = typeMap[rawKind.toLowerCase()] ?? rawKind;
        const id = pickPath(item, map.id) ?? item.id ?? item.subjectId ?? '';
        const values = { ...item, id, type: mappedType, mediaType: rawKind, kind };
        const urlTemplate = search.resultUrl;
        const rawUrl = urlTemplate
          ? String(urlTemplate).replace(/\{([\w.-]+)\}/g, (_match, key) => encodeURIComponent(String(pickPath(values, key) ?? '')))
          : pickPath(item, map.url) || item.url || '';
        const rawPoster = pickPath(item, map.poster) || item.poster || null;
        const poster = rawPoster
          ? /^https?:\/\//i.test(String(rawPoster))
            ? String(rawPoster)
            : resolveUrl(`${String(search.posterBaseUrl || source.home).replace(/\/?$/, '/')}`, String(rawPoster).replace(/^\/+/, ''))
          : null;
        const rawReleaseDate = firstMappedField(item, map, 'releaseDate', [
          'release_date', 'first_air_date', 'releaseDate', 'air_date', 'airDate',
        ]);
        const metadata = normalizeSearchMetadata({
          rating: firstMappedField(item, map, 'rating', ['vote_average', 'voteAverage', 'rating', 'imdbRatingValue', 'score']),
          genres: firstMappedField(item, map, 'genres', ['genres', 'genre_names', 'genreNames', 'genre', 'categories', 'genre_ids', 'genreIds']),
          runtime: firstMappedField(item, map, 'runtime', ['runtime', 'duration', 'runtimeMinutes']),
          description: firstMappedField(item, map, 'description', ['overview', 'description', 'plot', 'summary']),
          releaseDate: rawReleaseDate,
          language: firstMappedField(item, map, 'language', ['original_language', 'originalLanguage', 'language']),
        });
        const rawYear = pickPath(item, map.year) || item.year || rawReleaseDate;
        const year = Number(rawYear) || Number(/\b((?:19|20)\d{2})\b/.exec(String(rawYear || ''))?.[1])
          || Number(metadata.releaseDate?.slice(0, 4)) || null;
        return {
          title: pickPath(item, map.title) || item.title || item.name || '',
          year,
          kind,
          poster,
          url: rawUrl ? resolveUrl(source.home, rawUrl) : '',
          sourceId: source.id,
          sourceName: source.name,
          ...metadata,
        };
      }).filter((r) => r.url && r.title);
      noteHealth(source.id, rows.length > 0, rows.length ? `${rows.length} results` : 'no results');
      log.info('scraper', `${source.id}: api search → ${rows.length} results`, { ms: Date.now() - started });
      return finish(rows);
    }

    // browser search
    const searchUrl = source.search?.url || `${source.home}/search/{query}`;
    const res = await browser.searchSite({
      baseUrl: source.home,
      searchUrl,
      query,
      linkSelector: source.search?.linkSelector,
      linkPattern: source.search?.linkPattern,
      signal,
    });
    const rows = (res.results || []).map((r) => {
      const metadata = normalizeSearchMetadata(r, `${r.text || ''} ${r.cardText || ''}`);
      return {
        title: r.title,
        year: Number(r.year || metadata.releaseDate?.slice(0, 4) || (/(19|20)\d{2}/.exec(r.title) || [])[0]) || null,
        kind: r.kind || (/(season|s\d{1,2}e\d{1,2}|series)/i.test(r.title) ? 'series' : 'movie'),
        poster: r.poster || null,
        url: r.url,
        sourceId: source.id,
        sourceName: source.name,
        ...metadata,
      };
    });
    noteHealth(source.id, rows.length > 0, res.error || (rows.length ? `${rows.length} results` : 'search page returned no links'));
    log.info('scraper', `${source.id}: browser search → ${rows.length} results`, { ms: Date.now() - started, error: res.error });
    return finish(rows, res.error || null);
  } catch (err) {
    if (signal?.aborted) throw err;
    const message = errorText(err);
    noteHealth(source.id, false, message);
    logError('scraper', `${source.id}: search failed`, err, { query });
    return finish([], message);
  }
}

function posterTitleKey(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Strip a trailing parenthesised year (e.g. "Unabomber (2022)") from a title so
 * that a site returning the title with the year and one returning it without
 * land in the same grouping bucket. Also strips common quality/edition tags
 * (HD, 4K, "free", etc.) that sites append to titles.
 */
export function canonicalTitleKey(value) {
  let t = posterTitleKey(value);
  // posterTitleKey strips parens to spaces → "unabomber (2022)" becomes
  // "unabomber 2022". Strip a trailing 4-digit year with or without parens.
  t = t.replace(/\s+(?:19|20)\d{2}\s*$/, '').trim();
  t = t.replace(/\s+(?:hd|4k|uhd|1080p|720p|480p|free|online|watch|movie|series)$/, '').trim();
  return t;
}

function normalizedPosterUrl(result) {
  if (!result?.poster) return '';
  try {
    const base = /^https?:/i.test(String(result.url || '')) ? result.url : undefined;
    const url = new URL(String(result.poster), base);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch { return ''; }
}

/**
 * Reuse poster artwork across equivalent results from different sources. Many
 * sites omit poster metadata even when another enabled source has it.
 */
export function fillMissingPosters(results) {
  const exact = new Map();
  const byTitleKind = new Map();
  const sourceRank = (sourceId) => sourceId === 'overlook' ? 3 : sourceId === 'moviebox' ? 2 : 1;
  const add = (map, key, poster, rank) => {
    if (!key) return;
    const candidates = map.get(key) || [];
    if (!candidates.some((candidate) => candidate.poster === poster)) candidates.push({ poster, rank });
    map.set(key, candidates);
  };

  for (const result of results) {
    const title = posterTitleKey(result.title);
    const kind = String(result.kind || '').toLowerCase();
    const poster = normalizedPosterUrl(result);
    if (!title || !poster) continue;
    const rank = sourceRank(result.sourceId);
    add(exact, `${title}|${result.year || ''}|${kind}`, poster, rank);
    add(byTitleKind, `${title}|${kind}`, poster, rank);
  }

  const bestPoster = (candidates) => candidates?.slice().sort((a, b) => b.rank - a.rank)[0]?.poster || '';
  return results.map((result) => {
    if (normalizedPosterUrl(result)) return result;
    const title = posterTitleKey(result.title);
    const kind = String(result.kind || '').toLowerCase();
    const exactCandidates = exact.get(`${title}|${result.year || ''}|${kind}`);
    const titleCandidates = byTitleKind.get(`${title}|${kind}`) || [];
    const uniqueTitlePosters = [...new Set(titleCandidates.map((candidate) => candidate.poster))];
    const poster = bestPoster(exactCandidates)
      || (uniqueTitlePosters.length === 1 ? uniqueTitlePosters[0] : '');
    return poster ? { ...result, poster } : result;
  });
}

/** Fill absent metadata from an exact title/year/type match on another source. */
export function fillMissingMetadata(results) {
  const byExactTitle = new Map();
  const byCanonicalTitle = new Map();
  const sourceRank = (sourceId) => sourceId === 'overlook' ? 3 : sourceId === 'moviebox' ? 2 : 1;
  const fields = ['rating', 'genres', 'runtime', 'description', 'releaseDate', 'language'];
  const hasValue = (result, field) => field === 'genres'
    ? Array.isArray(result[field]) && result[field].length > 0
    : result[field] != null && result[field] !== '';
  const hasYear = (r) => Number.isFinite(Number(r?.year)) && Number(r.year) > 1800;

  for (const result of results) {
    const title = posterTitleKey(result.title);
    const canon = canonicalTitleKey(result.title);
    const kind = String(result.kind || '').toLowerCase();
    if (title) {
      const exactKey = `${title}|${result.year || ''}|${kind}`;
      const exact = byExactTitle.get(exactKey) || [];
      exact.push(result);
      byExactTitle.set(exactKey, exact);
    }
    if (canon) {
      const canonKey = `${canon}|${kind}`;
      const c = byCanonicalTitle.get(canonKey) || [];
      c.push(result);
      byCanonicalTitle.set(canonKey, c);
    }
  }

  // Best year per canonical title+kind: pick the most common numeric year so
  // that a year-less "Unabomber" from site A inherits 2022 from site B/C/D.
  const inferredYear = new Map(); // canonKey → best year
  for (const [key, rows] of byCanonicalTitle) {
    const yearCounts = new Map();
    for (const r of rows) {
      if (!hasYear(r)) continue;
      const y = String(r.year);
      yearCounts.set(y, (yearCounts.get(y) || 0) + 1);
    }
    if (!yearCounts.size) continue;
    const best = [...yearCounts.entries()].sort((a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0]))[0][0];
    inferredYear.set(key, Number(best));
  }

  return results.map((result) => {
    const title = posterTitleKey(result.title);
    const canon = canonicalTitleKey(result.title);
    const kind = String(result.kind || '').toLowerCase();
    const exactKey = `${title}|${result.year || ''}|${kind}`;
    const canonKey = `${canon}|${kind}`;
    const matches = (byExactTitle.get(exactKey) || []).slice().sort((a, b) => sourceRank(b.sourceId) - sourceRank(a.sourceId));
    const enriched = { ...result };

    // Propagate missing year from same-title+kind consensus.
    if (!hasYear(enriched)) {
      const consensusYear = inferredYear.get(canonKey);
      if (consensusYear) enriched.year = consensusYear;
    }

    if (!matches.length) return enriched;
    for (const field of fields) {
      if (hasValue(result, field)) continue;
      const value = matches.find((candidate) => hasValue(candidate, field))?.[field];
      if (value == null) continue;
      enriched[field] = field === 'genres' ? [...value] : value;
    }
    return enriched;
  });
}

/**
 * Sort results so that the same movie/series appears as a contiguous block
 * regardless of which source returned first. Group order:
 *   1. Kind (series before movies when the user has no filter, or vice-versa?
 *      We put movies first, then series — matches most user expectations).
 *   2. Canonical title (case/diacritic/punctuation-insensitive).
 *   3. Year (ascending — older remakes first, newest last).
 *   4. Source preference (Overlook → MovieBox → others) — so the "best"
 *      metadata/poster is always the first row the frontend picks as primary.
 *   5. Original position (stable) to keep results within a source predictable.
 */
export function sortResultsForDisplay(results) {
  const sourceRank = (sourceId) => sourceId === 'overlook' ? 0 : sourceId === 'moviebox' ? 1 : 2;
  const kindRank = (k) => String(k || '').toLowerCase() === 'series' ? 1 : 0;
  return [...results].map((r, idx) => ({ r, idx })).sort((a, b) => {
    const ka = kindRank(a.r.kind);
    const kb = kindRank(b.r.kind);
    if (ka !== kb) return ka - kb;
    const ta = canonicalTitleKey(a.r.title);
    const tb = canonicalTitleKey(b.r.title);
    if (ta !== tb) return ta.localeCompare(tb);
    const ya = Number(a.r.year) || 0;
    const yb = Number(b.r.year) || 0;
    if (ya !== yb) return ya - yb;
    const sa = sourceRank(a.r.sourceId);
    const sb = sourceRank(b.r.sourceId);
    if (sa !== sb) return sa - sb;
    return a.idx - b.idx;
  }).map(({ r }) => r);
}

/** Search every enabled source (plus MovieBox). Runs with a small pool to spare the NAS. */
export async function searchAll(query, {
  sources = null, type = null, limitPerSource = 12, includeMoviebox = true,
  signal = null, detailed = false,
} = {}) {
  const all = loadSources().filter((s) => s.enabled);
  const chosen = sources == null ? all : all.filter((s) => sources.includes(s.id));
  log.info('scraper', `searching ${chosen.length} source(s) for "${query}"`, { sources: chosen.map((s) => s.id).join(',') });

  const results = [];
  const providerErrors = [];
  const jobs = chosen.map((source) => async () => {
    if (isSourceCoolingDown(source.id)) {
      const h = healthOf(source.id);
      const msg = `${source.name} is in cooldown for another ${Math.max(0, Math.round((h.cooldownUntil - Date.now()) / 1000))}s after ${h.failures} consecutive failures (${h.message || 'unknown error'})`;
      log.warn('scraper', `skipping ${source.name} (circuit breaker open)`, { backoffSeconds: h.backoffSeconds });
      providerErrors.push({ sourceId: source.id, sourceName: source.name, error: msg, skipped: true });
      return;
    }
    const outcome = await searchSource(source, query, { signal, detailed: true });
    results.push(...outcome.results);
    if (outcome.error) providerErrors.push({ sourceId: source.id, sourceName: source.name, error: outcome.error });
  });
  const pool = 3;
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(pool, jobs.length) }, async () => {
    while (idx < jobs.length) {
      if (signal?.aborted) throw Object.assign(new Error('search aborted'), { name: 'AbortError' });
      const myIndex = idx++;
      await jobs[myIndex]();
    }
  }));

  if (includeMoviebox) {
    if (isSourceCoolingDown('moviebox')) {
      const h = healthOf('moviebox');
      const waitSec = Math.max(0, Math.round((h.cooldownUntil - Date.now()) / 1000));
      log.warn('scraper', 'skipping MovieBox (circuit breaker open)', { backoffSeconds: waitSec });
      providerErrors.push({ sourceId: 'moviebox', sourceName: 'MovieBox', error: `MovieBox is in cooldown for another ${waitSec}s after ${h.failures} consecutive failures (${h.message || 'unknown error'})`, skipped: true });
    } else {
      try {
        const rows = await moviebox.search(query, { perPage: limitPerSource, signal });
        noteHealth('moviebox', rows.length > 0, rows.length ? `${rows.length} results` : 'no results');
        for (const r of rows) {
          const metadata = normalizeSearchMetadata(r);
          results.push({
            title: r.title,
            year: r.year || Number(metadata.releaseDate?.slice(0, 4)) || null,
            kind: r.kind,
            poster: r.poster,
            movieboxSubjectId: r.subjectId,
            url: `moviebox://subject/${encodeURIComponent(r.subjectId)}`,
            sourceId: 'moviebox',
            sourceName: 'MovieBox',
            ...metadata,
          });
        }
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw err;
        const message = errorText(err);
        noteHealth('moviebox', false, message);
        providerErrors.push({ sourceId: 'moviebox', sourceName: 'MovieBox', error: message });
        logError('scraper', 'MovieBox search failed', err);
      }
    }
  }

  const enriched = fillMissingMetadata(fillMissingPosters(results));
  const filtered = type && type !== 'both' ? enriched.filter((r) => r.kind === type) : enriched;
  const deduped = sortResultsForDisplay(dedupeResults(filtered));
  const withPosters = deduped.filter((r) => Boolean(normalizedPosterUrl(r))).length;
  log.info('scraper', `search total: ${deduped.length} results from ${new Set(deduped.map((r) => r.sourceId)).size} sources`, {
    withPosters, withoutPosters: deduped.length - withPosters,
    providerErrors: providerErrors.length,
  });
  const limitedResults = deduped.slice(0, 60);
  return detailed ? { results: limitedResults, providerErrors } : limitedResults;
}

function dedupeResults(list) {
  const out = [];
  const seen = new Set();
  for (const r of list) {
    const key = `${String(r.title).toLowerCase()}|${r.year || ''}|${r.kind}|${r.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/* ---------------- resolve ---------------- */

export function parseMovieBoxTarget(url) {
  const value = String(url || '');
  const match = /^moviebox:\/\/subject\/([^/?#]+)/i.exec(value);
  if (!match) return null;
  const query = value.split('?')[1]?.split('#')[0] || '';
  const params = new URLSearchParams(query);
  let subjectId = match[1];
  try { subjectId = decodeURIComponent(subjectId); } catch { /* keep the raw identifier */ }
  return {
    subjectId,
    season: Number(params.get('se')) || 0,
    episode: Number(params.get('ep')) || 0,
  };
}

/**
 * Turn a source URL (or a moviebox:// pseudo URL) into playable candidates.
 * @returns {{ ok:boolean, candidates:object[], meta:object, error?:string, logs:object }}
 */
export async function resolveTarget(input) {
  const {
    url, sourceId = null, title = null, year = null, kind = null, season = 0, episode = 0,
    useBrowser = true, signal = null,
  } = input;
  const timeline = {};
  const candidates = [];
  const notes = [];

  const movieboxTarget = parseMovieBoxTarget(url);
  const selectedSeason = Number(season) || movieboxTarget?.season || 0;
  const selectedEpisode = Number(episode) || movieboxTarget?.episode || 0;
  if (movieboxTarget) {
    const { subjectId } = movieboxTarget;
    const t0 = Date.now();
    try {
      const info = await moviebox.playInfo(subjectId, { se: selectedSeason, ep: selectedEpisode, signal });
      candidates.push(...moviebox.releasesFromPlayInfo(info, { season: selectedSeason, episode: selectedEpisode }));
      noteHealth('moviebox', candidates.length > 0, `${candidates.length} candidates`);
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      // Play-info failures are the most common "nothing happens" case: the
      // container may have no internet, or MovieBox rotated its host pool.
      const message = errorText(err);
      notes.push(`MovieBox play-info failed (${message})`);
      noteHealth('moviebox', false, message);
      logError('scraper', 'MovieBox play-info failed', err, { subjectId });
    } finally {
      timeline.moviebox = Date.now() - t0;
    }
  }

  if (url && !/^https?:/i.test(url) && !String(url).startsWith('moviebox://')) {
    // A direct URL/path that is not a web page (file://, a mounted file, an
    // unusual scheme). Sniffing it in a browser makes no sense — offer it as-is.
    log.info('scraper', 'using the supplied URL directly (not an http(s) page)', { url: truncate(url, 120) });
    candidates.push({
      url,
      sourceId: sourceId || 'direct',
      label: 'direct',
      quality: qualityFromUrl(url),
      headers: {},
      kind: streamKind(url) || 'file',
      via: 'direct',
    });
  }

  if (url && /^https?:/i.test(url)) {
    const source = getSource(sourceId) || matchSourceByUrl(url);
    if (useBrowser) {
      const t0 = Date.now();
      // A broken/absent Chromium (crash, OOM on the NAS, missing binary) is a
      // reason to lose *this* layer, not the whole resolve: MovieBox-by-title
      // and the external extractor do not need a browser and may still work.
      let sniff = { ok: false, media: [], error: null, note: null, finalUrl: url, title: null, networkErrors: [] };
      try {
        sniff = await browser.sniff({
          url,
          session: source?.id || 'default',
          playerPathPrefix: source?.resolve?.playerPathPrefix || null,
          timeoutMs: getConfig().scraper.resolveTimeoutMs,
          signal,
        });
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw err;
        const message = errorText(err);
        notes.push(`Headless browser unavailable (${truncate(message, 160)})`);
        logError('scraper', 'headless browser could not run — continuing without the sniffer', err, { url: truncate(url, 120) });
      }
      timeline.browser = Date.now() - t0;
      if (!sniff.ok && (sniff.error || sniff.note)) {
        notes.push(`Browser ${sniff.note || 'scrape failed'}${sniff.error ? ` (${sniff.error})` : ''}`);
      }
      for (const m of sniff.media || []) {
        candidates.push({
          url: m.url,
          sourceId: source?.id || 'browser',
          label: qualityFromUrl(m.url) || 'source',
          quality: qualityFromUrl(m.url),
          headers: {
            ...Object.fromEntries(Object.entries(m.headers || {}).filter(([name]) => {
              const key = name.toLowerCase();
              return !['host', 'connection', 'content-length', 'accept-encoding', 'referer', 'user-agent'].includes(key)
                && !key.startsWith('sec-');
            })),
            Referer: m.referer || url,
            'User-Agent': getConfig().scraper.userAgent,
          },
          kind: ['hls', 'dash'].includes(m.kind) ? m.kind : streamKind(m.url),
          via: m.via,
        });
      }
      if (source) noteHealth(source.id, candidates.length > 0, sniff.error || `${candidates.length} media urls`);
      if (!sniff.ok) log.warn('scraper', 'browser sniff produced no media', {
        url: truncate(url, 120),
        finalUrl: truncate(sniff.finalUrl || '', 160),
        pageTitle: sniff.title,
        note: sniff.note,
        error: sniff.error,
        networkErrors: sniff.networkErrors,
      });
    } else {
      log.info('scraper', 'browser sniff disabled for this request — using the URL directly');
      candidates.push({
        url,
        sourceId: source?.id || 'direct',
        label: qualityFromUrl(url) || 'source',
        quality: qualityFromUrl(url),
        headers: { Referer: url, 'User-Agent': getConfig().scraper.userAgent },
        kind: streamKind(url),
        via: 'direct',
      });
    }
  }

  // MovieBox by title (gives a second, browser-free source for most titles).
  // When the browser already found playable candidates and MovieBox is
  // cooling down (circuit breaker open after repeated TLS failures), skip it
  // — we don't want a 2–3 second dead-host timeout for every resolve.
  const movieboxWorthTrying = !String(url || '').startsWith('moviebox://')
    && title
    && candidates.length === 0   // browser returned nothing → MovieBox might still help
    && !isSourceCoolingDown('moviebox');
  if (movieboxWorthTrying) {
    try {
      const t0 = Date.now();
      const { item, candidates: mb } = await moviebox.findStreamsByTitle(title, {
        year, kind, season: selectedSeason, episode: selectedEpisode, signal,
      });
      timeline.moviebox = Date.now() - t0;
      if (item) {
        for (const c of mb) candidates.push({ ...c, meta: { ...c.meta, movieboxTitle: item.title, poster: item.poster } });
      }
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      const message = errorText(err);
      notes.push(`MovieBox is unreachable (${message})`);
      log.warn('scraper', 'MovieBox title lookup failed (non-fatal)', { error: message });
    }
  } else if (title && !String(url || '').startsWith('moviebox://') && isSourceCoolingDown('moviebox')) {
    const h = healthOf('moviebox');
    log.debug('scraper', 'skipping MovieBox title lookup (circuit breaker open)', { backoffSeconds: h.backoffSeconds });
  }

  // Optional external extractor
  if (external.isConfigured()) {
    const t0 = Date.now();
    const ext = await external.extract({
      url, title, year, kind, season: selectedSeason, episode: selectedEpisode, signal,
    });
    timeline.external = Date.now() - t0;
    candidates.push(...(ext.providers || []));
  }

  const unique = dedupeCandidates(candidates);
  log.info('scraper', `resolve finished: ${unique.length} unique candidate(s)`, {
    timeline, sources: [...new Set(unique.map((c) => c.sourceId))].join(','),
  });

  let error = unique.length ? null : ['no playable stream found', ...notes].join(' — ');

  // Nothing worked. Instead of leaving the operator with a wall of identical
  // `fetch failed` lines, run the reachability probe once (cached for a minute)
  // and say which layer is broken: general egress, DNS filtering, a TLS
  // interception proxy, or the service itself.
  if (!unique.length && error && !signal?.aborted) {
    const diagnosis = await diagnoseReachability({
      hosts: [...(url && /^https?:/i.test(String(url)) ? [url] : []), ...moviebox.HOST_POOL],
      sourceUrl: url || null,
      signal,
    }).catch(() => null);
    if (diagnosis && !error.includes(diagnosis.verdict)) {
      // The MovieBox lane already embeds the verdict in its own error text; do
      // not repeat the same paragraph twice in the UI.
      error += ` — network check: ${diagnosis.verdict} — ${diagnosis.hint}`;
      log.warn('scraper', 'resolve failed — reachability diagnosis', {
        verdict: diagnosis.verdict, summary: diagnosis.summary,
      });
    }
  }
  return { ok: unique.length > 0, candidates: unique, timeline, notes, error };
}

/**
 * Normalise a candidate URL for deduplication.
 *
 * Streaming sites fire the same manifest request multiple times per page load
 * (e.g. two clicks on the play button + a retry), which gives us duplicate
 * media entries with slightly different tokens/signatures in the query string.
 * Naïve string comparison keeps them all and multiplies ffprobe timeouts.
 *
 * We normalise by:
 *   1. stripping the fragment,
 *   2. dropping the obvious one-time token/signature query params
 *      (Policy/Signature/Key-Pair-Id for CloudFront signed cookies; sig, token,
 *      t, exp, s, cb, _, v for generic CDN signatures),
 *   3. keeping everything else (path + remaining query) — that is what
 *      identifies a unique playlist/mirror.
 */
function candidateKey(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return String(rawUrl).split('#')[0]; }
  u.hash = '';
  const DROP = /^(policy|signature|key-pair-id|expires|awsaccesskeyid|sig|signature|token|t|exp|cb|_|v|nonce|ts|timestamp|rnd)$/i;
  for (const key of [...u.searchParams.keys()]) {
    if (DROP.test(key)) u.searchParams.delete(key);
  }
  return u.toString();
}

function dedupeCandidates(list) {
  const seen = new Map(); // key → candidate (we keep the one with richer headers/metadata)
  for (const c of list) {
    if (!c?.url) continue;
    const key = candidateKey(c.url);
    const existing = seen.get(key);
    if (!existing) { seen.set(key, c); continue; }
    // Merge: prefer the candidate that actually has Referer/User-Agent headers
    // (some sniffs see the URL before the response-headers are attached).
    const merged = {
      ...existing,
      ...c,
      headers: { ...(existing.headers || {}), ...(c.headers || {}) },
      meta: { ...(existing.meta || {}), ...(c.meta || {}) },
    };
    seen.set(key, merged);
  }
  return [...seen.values()];
}

export function qualityFromUrl(url = '') {
  const m = /(?:^|[^0-9])(2160|1440|1080|720|576|480|360)p?(?:[^0-9]|$)/i.exec(String(url));
  if (m) return `${m[1]}p`;
  return null;
}

/**
 * Probe candidates (ffprobe) and rank them.
 * Candidates that fail to probe are kept but flagged, so the UI can show why.
 */
/**
 * Quick TCP+TLS connectivity check so we can skip ffprobe on hosts that are
 * not reachable from the container (DNS failure, connection refused, TLS
 * reset). Chromium has its own async DNS resolver and sometimes sees hosts
 * (like onlinevisibilitysystem.site in the redflix logs) that Node/ffprobe
 * running on the container's glibc resolver can't look up at that exact
 * moment. A 3-second preflight saves us a 15-20 second ffprobe hang per
 * dead candidate, which is what turned one successful HLS sniff into a
 * 2-minute probe storm.
 */
async function quickConnectProbe(url, { timeoutMs = 5000 } = {}) {
  try {
    const u = new URL(url);
    const isTls = u.protocol === 'https:';
    const port = Number(u.port) || (isTls ? 443 : 80);
    const res = await request(url, {
      method: 'GET',
      // Range: bytes=0-0 is enough to open a TCP+TLS connection and get a
      // first byte without downloading the manifest body.
      headers: { Range: 'bytes=0-0' },
      timeoutMs,
      retries: 0,
      allowFailure: true,
      // Don't follow redirects off the CDN — we just want to know if it answers.
      redirect: 'manual',
    });
    // Any response that isn't a DNS/TCP/timeout error counts as reachable:
    // CloudFront S3 often returns 403 to a bare byte-range request, but the
    // TCP+TLS connection succeeded. That's enough to say "DNS/TCP works, let
    // ffprobe take its turn".
    const reachable = res.status > 0 || !res.error;
    return { ok: reachable, status: res.status, error: res.error };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Probe candidates (ffprobe) and rank them.
 * Candidates that fail to probe are kept but flagged, so the UI can show why.
 */
export async function probeCandidates(candidates, { limit = null, concurrency = 3, signal = null } = {}) {
  const cfg = getConfig();
  const list = limit ? candidates.slice(0, limit) : candidates;
  if (!cfg.scraper.probeCandidates) {
    log.warn('scraper', 'candidate probing is disabled in settings — VLC may meet dead mirrors');
    return list.map((c) => ({ ...c, ok: c.ok !== false, unverified: true }));
  }
  const binaries = await checkBinaries();
  if (!binaries.ffprobe.ok) {
    log.warn('scraper', 'ffprobe is not installed — offering candidates unverified', { error: binaries.ffprobe.error });
    return rankCandidates(list.map((c) => ({ ...c, ok: c.ok !== false, unverified: true, probe: c.probe || null })));
  }
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (idx < list.length) {
      if (signal?.aborted) throw Object.assign(new Error('candidate probing aborted'), { name: 'AbortError' });
      const myIndex = idx++;
      const cand = list[myIndex];
      const t0 = Date.now();

      // Quick connectivity preflight — if the CDN hostname doesn't resolve or
      // refuses TCP we fail fast instead of letting ffprobe hang for 20s. For
      // HLS we can combine this with the master-playlist fetch we need anyway
      // to expand variants, so we don't waste a round-trip.
      const isHls = streamKind(cand.url) === 'hls';
      let preflightOk = true;
      let variants = [];
      if (isHls) {
        variants = await expandHlsVariants(cand.url, cand.headers || {});
        if (!variants.length) {
          cand.probe = null;
          cand.probeMs = Date.now() - t0;
          cand.ok = false;
          cand.error = 'HLS master playlist unreachable (DNS failure, expired token or geo-block)';
          log.warn('scraper', 'candidate host unreachable — HLS master could not be fetched', {
            url: truncate(cand.url, 120), source: cand.sourceId, ms: cand.probeMs,
          });
          continue;
        }
        cand.variants = variants.map((v) => ({
          ...cand,
          url: v.url,
          quality: v.height ? `${v.height}p` : cand.quality,
          height: v.height || null,
          bandwidth: v.bandwidth || null,
          label: v.name || (v.height ? `${v.height}p` : 'variant'),
        }));
        log.info('scraper', `expanded HLS master into ${variants.length} variant(s)`, { url: truncate(cand.url, 100) });
      } else {
        const reach = await quickConnectProbe(cand.url, { timeoutMs: 4000 });
        if (!reach.ok) {
          preflightOk = false;
          cand.probe = null;
          cand.probeMs = Date.now() - t0;
          cand.ok = false;
          cand.error = `host unreachable (${reach.error || 'no response'}) — DNS/TCP preflight failed`;
          log.warn('scraper', 'candidate host unreachable — skipping ffprobe', {
            url: truncate(cand.url, 120), source: cand.sourceId, error: cand.error,
          });
        }
      }
      if (!preflightOk) continue;

      // HLS manifests don't need a long ffprobe timeout just to detect video
      // (we already fetched the master ourselves above); 8s is enough to open
      // TCP+TLS and read the first segment. Dash/file still gets 20s.
      const probeTimeoutMs = isHls ? 8000 : Math.min(20000, cfg.scraper.resolveTimeoutMs);
      // For HLS: probe only the highest-bandwidth variant. If that works we
      // mark the candidate playable; probing every variant was burning 15–20s
      // per duplicate on DNS failures.
      const probeUrl = isHls && variants.length ? variants[0].url : cand.url;
      let info = await probe(probeUrl, { headers: cand.headers || {}, timeoutMs: probeTimeoutMs });
      if (signal?.aborted) throw Object.assign(new Error('candidate probing aborted'), { name: 'AbortError' });

      cand.probe = info;
      cand.probeMs = Date.now() - t0;
      cand.ok = Boolean(info);
      if (info?.video) {
        cand.height = info.video.height || cand.height;
        cand.width = info.video.width || cand.width;
        cand.fps = info.video.fps;
        cand.codec = info.video.codec;
        cand.quality = cand.height ? `${cand.height}p` : cand.quality;
      }
      if (!info) {
        cand.error = 'probe failed (dead mirror, expired token, geo-block or unsupported container)';
        log.warn('scraper', 'candidate rejected by probe', { url: truncate(cand.url, 120), source: cand.sourceId, ms: cand.probeMs });
      } else {
        log.debug('scraper', 'candidate probed ok', { url: truncate(cand.url, 120), source: cand.sourceId, ms: cand.probeMs });
      }
    }
  });
  await Promise.all(workers);
  return rankCandidates(list);
}

/** Best first: playable → higher resolution → higher bitrate → known source. */
export function rankCandidates(list) {
  return [...list].sort((a, b) => {
    if (Boolean(a.ok) !== Boolean(b.ok)) return a.ok ? -1 : 1;
    const ha = a.height || heightFromQuality(a.quality) || 0;
    const hb = b.height || heightFromQuality(b.quality) || 0;
    if (ha !== hb) return hb - ha;
    const ba = a.probe?.video?.bitrate || a.bandwidth || 0;
    const bb = b.probe?.video?.bitrate || b.bandwidth || 0;
    return bb - ba;
  });
}

export function heightFromQuality(q) {
  const m = /(\d{3,4})/.exec(String(q || ''));
  return m ? Number(m[1]) : null;
}

async function expandHlsVariants(url, headers) {
  try {
    const res = await request(url, { headers, allowFailure: true, retries: 0, timeoutMs: 12000 });
    if (!res.ok) return [];
    return parseHlsMaster(res.text, url);
  } catch (err) {
    log.warn('scraper', 'could not read HLS master playlist', { error: String(err?.message || err) });
    return [];
  }
}

/** small helper: 'a.b.c' path lookup that tolerates missing levels */
function pickPath(obj, dotted) {
  if (!dotted || !obj) return null;
  return String(dotted).split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/* test-only exports (also useful for diagnostics in /api/health) */
export { candidateKey, dedupeCandidates, quickConnectProbe };

export default { loadSources, listSources, getSource, searchAll, searchSource, resolveTarget, probeCandidates, rankCandidates };
