/**
 * vu-movie — TMDB metadata provider
 *
 * Uses TMDB API v3. Requires TMDB_API_KEY in config.metadata.tmdbApiKey
 * or env TMDB_API_KEY. No extra dependencies — uses global fetch.
 *
 * Endpoints:
 *   /search/movie?query=&year=&language=
 *   /search/tv?query=&first_air_date_year=&language=
 *   /movie/{id}?language=&append_to_response=credits,external_ids,videos
 *   /tv/{id}?language=&append_to_response=credits,external_ids,videos
 *   /find/{imdb_id}?external_source=imdb_id&language=
 *   /trending/{all|movie|tv}/{day|week}
 *   /movie|tv/top_rated and /movie|tv/{id}/recommendations
 */

import { getConfig } from '../core/config.js';
import { log } from '../core/log.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p';

function apiKey() {
  const cfg = getConfig();
  return cfg.metadata?.tmdbApiKey || process.env.TMDB_API_KEY || '';
}

function language() {
  const cfg = getConfig();
  return cfg.metadata?.language || 'en-US';
}

async function tmdbFetch(path, params = {}) {
  const key = apiKey();
  if (!key) throw new Error('TMDB API key not configured (Settings → Metadata)');
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set('api_key', key);
  url.searchParams.set('language', language());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TMDB ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function searchTMDB({ title, year, type = 'movie', imdbId = null, tmdbId = null } = {}) {
  if (!title && !imdbId && !tmdbId) throw new Error('title, imdbId or tmdbId required');

  // Direct ID lookup
  if (tmdbId) {
    const kind = type === 'series' || type === 'tv' ? 'tv' : 'movie';
    try {
      const details = await tmdbFetch(`/${kind}/${tmdbId}`, { append_to_response: 'credits,external_ids,videos' });
      return { results: [normalizeDetails(details, kind)], source: 'tmdb-id' };
    } catch (err) {
      log.warn('metadata', `TMDB direct lookup failed for ${tmdbId}`, { error: err.message });
    }
  }

  // IMDb -> TMDB via find
  if (imdbId) {
    try {
      const data = await tmdbFetch(`/find/${imdbId}`, { external_source: 'imdb_id' });
      const all = [...(data.movie_results || []), ...(data.tv_results || [])];
      if (all.length) {
        const first = all[0];
        const kind = first.media_type === 'tv' ? 'tv' : 'movie';
        const details = await tmdbFetch(`/${kind}/${first.id}`, { append_to_response: 'credits,external_ids,videos' });
        return { results: [normalizeDetails(details, kind)], source: 'imdb-find' };
      }
    } catch (err) {
      log.warn('metadata', `TMDB find by IMDb ${imdbId} failed`, { error: err.message });
    }
  }

  // Text search
  const kind = type === 'series' || type === 'tv' ? 'tv' : 'movie';
  const searchPath = kind === 'tv' ? '/search/tv' : '/search/movie';
  const params = { query: title };
  if (year) {
    if (kind === 'tv') params.first_air_date_year = year;
    else params.year = year;
  }
  const data = await tmdbFetch(searchPath, params);
  const results = (data.results || []).slice(0, 5).map((r) => normalizeSearchResult(r, kind));
  return { results, source: 'search' };
}

export async function getTMDBDetails({ tmdbId, type = 'movie' } = {}) {
  if (!tmdbId) throw new Error('tmdbId required');
  const kind = type === 'series' || type === 'tv' ? 'tv' : 'movie';
  const details = await tmdbFetch(`/${kind}/${tmdbId}`, { append_to_response: 'credits,external_ids,videos' });
  return normalizeDetails(details, kind);
}

/** Trending titles, normalized into the same movie/series shape as title search. */
export async function getTrendingTMDB({ type = 'all', window = 'week', page = 1 } = {}) {
  const media = type === 'movie' ? 'movie' : type === 'series' || type === 'tv' ? 'tv' : 'all';
  const timeframe = window === 'day' ? 'day' : 'week';
  const data = await tmdbFetch(`/trending/${media}/${timeframe}`, { page });
  return (data.results || []).filter((item) => item.adult !== true).map((item) => {
    const kind = media === 'all'
      ? (item.media_type === 'tv' || item.first_air_date ? 'tv' : 'movie')
      : media;
    return normalizeSearchResult(item, kind);
  }).filter((item) => item.title);
}

/** Top-rated movies, series, or a combined top ten. */
export async function getTopRatedTMDB({ type = 'all', limit = 10 } = {}) {
  const media = type === 'movie' ? 'movie' : type === 'series' || type === 'tv' ? 'tv' : 'all';
  const kinds = media === 'all' ? ['movie', 'tv'] : [media];
  const pages = await Promise.all(kinds.map(async (kind) => {
    const data = await tmdbFetch(`/${kind}/top_rated`, { page: 1 });
    return (data.results || []).filter((item) => item.adult !== true).map((item) => normalizeSearchResult(item, kind));
  }));
  const minVotes = media === 'all' ? 100 : 50;
  const items = pages.flat().filter((item) => Number(item.votes || 0) >= minVotes);
  items.sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0) || Number(b.votes || 0) - Number(a.votes || 0));
  const count = Math.max(1, Math.min(50, Number(limit) || 10));
  return items.slice(0, count);
}

/** TMDB's per-title recommendations, used as seeds for playlist-based suggestions. */
export async function getTMDBRecommendations({ tmdbId, type = 'movie' } = {}) {
  if (!tmdbId) throw new Error('tmdbId required');
  const kind = type === 'series' || type === 'tv' ? 'tv' : 'movie';
  const data = await tmdbFetch(`/${kind}/${encodeURIComponent(String(tmdbId))}/recommendations`, { page: 1 });
  return (data.results || []).filter((item) => item.adult !== true)
    .map((item) => normalizeSearchResult(item, kind)).filter((item) => item.title);
}

function normalizeSearchResult(item, kind) {
  const title = item.title || item.name || item.original_title || item.original_name || '';
  const year = (item.release_date || item.first_air_date || '').slice(0, 4) || null;
  return {
    tmdbId: item.id,
    imdbId: null,
    title,
    originalTitle: item.original_title || item.original_name || '',
    year: year ? Number(year) : null,
    type: kind === 'tv' ? 'series' : 'movie',
    overview: item.overview || '',
    poster: item.poster_path ? `${IMG_BASE}/w500${item.poster_path}` : null,
    backdrop: item.backdrop_path ? `${IMG_BASE}/w780${item.backdrop_path}` : null,
    rating: item.vote_average || null,
    votes: item.vote_count || null,
    releaseDate: item.release_date || item.first_air_date || null,
    genres: [],
    tmdbUrl: `https://www.themoviedb.org/${kind}/${item.id}`,
  };
}

function normalizeDetails(details, kind) {
  const title = details.title || details.name || details.original_title || details.original_name || '';
  const year = (details.release_date || details.first_air_date || '').slice(0, 4) || null;
  const credits = details.credits || {};
  const cast = (credits.cast || []).slice(0, 10).map((c) => ({
    name: c.name,
    character: c.character,
    profile: c.profile_path ? `${IMG_BASE}/w185${c.profile_path}` : null,
  }));
  const crew = (credits.crew || []).slice(0, 15).map((c) => ({
    name: c.name,
    job: c.job,
    department: c.department,
  }));
  const director = crew.filter((c) => c.job === 'Director').map((c) => c.name);
  const external = details.external_ids || {};
  return {
    tmdbId: details.id,
    imdbId: external.imdb_id || details.imdb_id || null,
    title,
    originalTitle: details.original_title || details.original_name || '',
    year: year ? Number(year) : null,
    type: kind === 'tv' ? 'series' : 'movie',
    overview: details.overview || '',
    tagline: details.tagline || '',
    poster: details.poster_path ? `${IMG_BASE}/w500${details.poster_path}` : null,
    backdrop: details.backdrop_path ? `${IMG_BASE}/w780${details.backdrop_path}` : null,
    rating: details.vote_average || null,
    votes: details.vote_count || null,
    runtime: details.runtime || (details.episode_run_time && details.episode_run_time[0]) || null,
    genres: (details.genres || []).map((g) => g.name),
    releaseDate: details.release_date || details.first_air_date || null,
    status: details.status || null,
    language: details.original_language || null,
    homepage: details.homepage || null,
    cast,
    crew,
    director,
    externalIds: external,
    tmdbUrl: `https://www.themoviedb.org/${kind}/${details.id}`,
    imdbUrl: external.imdb_id ? `https://www.imdb.com/title/${external.imdb_id}/` : null,
    // For UI convenience
    videos: (details.videos?.results || []).slice(0, 5).map((v) => ({
      name: v.name,
      key: v.key,
      site: v.site,
      type: v.type,
      url: v.site === 'YouTube' ? `https://www.youtube.com/watch?v=${v.key}` : null,
    })),
  };
}

export function isConfigured() {
  return Boolean(apiKey());
}

/**
 * List the seasons of a TV show (TMDB id), newest last.
 * Returns [{ season, name, episodeCount, airDate, poster }] — season 0
 * (Specials) is kept when TMDB lists it, the UI decides whether to show it.
 */
export async function getTVSeasons(tmdbId) {
  if (!tmdbId) throw new Error('tmdbId required');
  const details = await tmdbFetch(`/tv/${encodeURIComponent(String(tmdbId))}`);
  const seasons = Array.isArray(details?.seasons) ? details.seasons : [];
  return seasons
    .map((s) => ({
      season: Number(s.season_number),
      name: s.name || `Season ${s.season_number}`,
      episodeCount: Number(s.episode_count) || 0,
      airDate: s.air_date || null,
      poster: s.poster_path ? `${IMG_BASE}/w185${s.poster_path}` : null,
      overview: s.overview || '',
    }))
    .filter((s) => Number.isFinite(s.season))
    .sort((a, b) => a.season - b.season);
}

/**
 * List the episodes of one season: [{ episode, name, airDate, overview,
 * runtime, still }]. Pure normalizer below is unit tested; this does the I/O.
 */
export async function getSeasonEpisodes(tmdbId, seasonNumber) {
  if (!tmdbId) throw new Error('tmdbId required');
  const season = Number(seasonNumber);
  if (!Number.isFinite(season)) throw new Error('seasonNumber required');
  const data = await tmdbFetch(`/tv/${encodeURIComponent(String(tmdbId))}/season/${season}`);
  return normalizeSeasonEpisodes(data);
}

/** Pure: TMDB `/tv/{id}/season/{n}` payload → episode rows. */
export function normalizeSeasonEpisodes(data) {
  const episodes = Array.isArray(data?.episodes) ? data.episodes : [];
  return episodes
    .map((e) => ({
      episode: Number(e.episode_number),
      name: e.name || `Episode ${e.episode_number}`,
      airDate: e.air_date || null,
      overview: e.overview || '',
      runtime: Number(e.runtime) || null,
      still: e.still_path ? `${IMG_BASE}/w300${e.still_path}` : null,
    }))
    .filter((e) => Number.isFinite(e.episode) && e.episode > 0)
    .sort((a, b) => a.episode - b.episode);
}

/**
 * Full series shape for the picker: every season with its episodes.
 * Season detail calls run with a small concurrency so a 20-season show does
 * not fire 20 requests at once; a single failing season keeps its count.
 */
export async function getTVSeasonsFull(tmdbId, { concurrency = 4 } = {}) {
  const seasons = await getTVSeasons(tmdbId);
  const out = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, seasons.length)) }, async () => {
    while (index < seasons.length) {
      const current = seasons[index++];
      try {
        const episodes = await getSeasonEpisodes(tmdbId, current.season);
        out.push({ ...current, episodeCount: episodes.length || current.episodeCount, episodes });
      } catch (err) {
        log.warn('metadata', `TMDB season ${current.season} of ${tmdbId} failed`, { error: err.message });
        const fallback = Array.from({ length: current.episodeCount }, (_, i) => ({
          episode: i + 1, name: `Episode ${i + 1}`, airDate: null, overview: '', runtime: null, still: null,
        }));
        out.push({ ...current, episodes: fallback });
      }
    }
  });
  await Promise.all(workers);
  return out.sort((a, b) => a.season - b.season);
}

export default {
  searchTMDB,
  getTMDBDetails,
  getTrendingTMDB,
  getTopRatedTMDB,
  getTMDBRecommendations,
  getTVSeasons,
  getSeasonEpisodes,
  getTVSeasonsFull,
  normalizeSeasonEpisodes,
  isConfigured,
};
