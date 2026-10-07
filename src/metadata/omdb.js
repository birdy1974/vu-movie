/**
 * vu-movie — OMDB metadata provider (fallback / IMDb enrichment)
 *
 * OMDB needs an API key: http://www.omdbapi.com/apikey.aspx
 * Config: metadata.omdbApiKey or env OMDB_API_KEY
 */

import { getConfig } from '../core/config.js';
import { log } from '../core/log.js';

function apiKey() {
  const cfg = getConfig();
  return cfg.metadata?.omdbApiKey || process.env.OMDB_API_KEY || '';
}

export async function searchOMDB({ title, year, type = 'movie', imdbId = null } = {}) {
  const key = apiKey();
  if (!key) throw new Error('OMDB API key not configured (Settings → Metadata)');
  if (!title && !imdbId) throw new Error('title or imdbId required');

  const url = new URL('https://www.omdbapi.com/');
  url.searchParams.set('apikey', key);
  if (imdbId) {
    url.searchParams.set('i', imdbId);
  } else {
    url.searchParams.set('t', title);
    if (year) url.searchParams.set('y', String(year));
    if (type) url.searchParams.set('type', type === 'series' ? 'series' : 'movie');
    url.searchParams.set('plot', 'full');
  }

  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`OMDB failed: HTTP ${res.status}`);
  const data = await res.json();
  if (data.Response === 'False') {
    throw new Error(data.Error || 'OMDB: not found');
  }
  return normalizeOMDB(data);
}

function normalizeOMDB(data) {
  return {
    imdbId: data.imdbID || null,
    title: data.Title || '',
    year: data.Year ? Number(String(data.Year).slice(0, 4)) : null,
    type: data.Type === 'series' ? 'series' : 'movie',
    rated: data.Rated || null,
    runtime: data.Runtime || null,
    genres: data.Genre ? data.Genre.split(',').map((s) => s.trim()) : [],
    director: data.Director ? data.Director.split(',').map((s) => s.trim()) : [],
    writer: data.Writer ? data.Writer.split(',').map((s) => s.trim()) : [],
    actors: data.Actors ? data.Actors.split(',').map((s) => s.trim()) : [],
    plot: data.Plot || '',
    language: data.Language || null,
    country: data.Country || null,
    awards: data.Awards || null,
    poster: data.Poster && data.Poster !== 'N/A' ? data.Poster : null,
    ratings: data.Ratings || [],
    imdbRating: data.imdbRating && data.imdbRating !== 'N/A' ? Number(data.imdbRating) : null,
    imdbVotes: data.imdbVotes || null,
    metascore: data.Metascore || null,
    boxOffice: data.BoxOffice || null,
    imdbUrl: data.imdbID ? `https://www.imdb.com/title/${data.imdbID}/` : null,
  };
}

export function isConfigured() {
  return Boolean(apiKey());
}

export default { searchOMDB, isConfigured };
