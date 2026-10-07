/**
 * vu-movie — metadata aggregation (TMDB + OMDB + IMDb links)
 *
 * Tries TMDB first (richer), falls back to OMDB for IMDb ratings.
 * Returns a unified object for the UI.
 */

import * as tmdb from './tmdb.js';
import * as omdb from './omdb.js';
import { log } from '../core/log.js';

export async function enrichMetadata({ title, year, type = 'movie', imdbId = null, tmdbId = null } = {}) {
  const result = {
    title: title || '',
    year: year || null,
    type,
    tmdb: null,
    omdb: null,
    imdbId: imdbId || null,
    tmdbId: tmdbId || null,
    sources: [],
    errors: [],
  };

  // TMDB
  if (tmdb.isConfigured()) {
    try {
      const search = await tmdb.searchTMDB({ title, year, type, imdbId, tmdbId });
      if (search.results && search.results.length) {
        // If we only got search results (not full details), fetch full details for first hit
        let first = search.results[0];
        if (!first.cast && first.tmdbId) {
          try {
            first = await tmdb.getTMDBDetails({ tmdbId: first.tmdbId, type: first.type || type });
          } catch (e) {
            log.warn('metadata', 'TMDB details fetch failed', { error: e.message });
          }
        }
        result.tmdb = first;
        result.tmdbId = first.tmdbId || tmdbId;
        result.imdbId = first.imdbId || imdbId;
        result.sources.push('tmdb');
      }
    } catch (err) {
      result.errors.push({ source: 'tmdb', error: err.message });
      log.warn('metadata', 'TMDB enrichment failed', { error: err.message, title });
    }
  }

  // OMDB — enrich with IMDb ratings, or as fallback when TMDB not configured
  if (omdb.isConfigured()) {
    try {
      // Prefer IMDb ID if we have it from TMDB
      const omdbResult = await omdb.searchOMDB({
        title: result.tmdb?.title || title,
        year: result.tmdb?.year || year,
        type,
        imdbId: result.imdbId || imdbId,
      });
      result.omdb = omdbResult;
      if (!result.imdbId) result.imdbId = omdbResult.imdbId;
      result.sources.push('omdb');
    } catch (err) {
      result.errors.push({ source: 'omdb', error: err.message });
      log.warn('metadata', 'OMDB enrichment failed', { error: err.message, title });
    }
  }

  // If neither TMDB nor OMDB configured, still return IMDb link if we have ID
  if (!result.tmdb && !result.omdb && result.imdbId) {
    result.sources.push('imdb-link-only');
  }

  if (!tmdb.isConfigured() && !omdb.isConfigured()) {
    result.errors.push({ source: 'config', error: 'No TMDB/OMDB API key configured — add keys in Settings → Metadata (free at themoviedb.org and omdbapi.com)' });
  }

  return result;
}

export function isAnyConfigured() {
  return tmdb.isConfigured() || omdb.isConfigured();
}

export { tmdb, omdb };
export default { enrichMetadata, isAnyConfigured, tmdb, omdb };
