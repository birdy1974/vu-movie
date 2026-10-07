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

export default { searchTMDB, getTMDBDetails, isConfigured };
