/**
 * vu-movie — series helpers: season/episode discovery + the quality matrix.
 *
 * Two jobs, both pure except the discovery I/O at the bottom:
 *
 *  1. `buildQualityMatrix()` aggregates per-episode candidates into one row
 *     per quality (1080p/720p/…) with episode coverage — the "combine seasons,
 *     episodes, formats to keep the list small" view the Selected-title pane
 *     shows above the per-episode groups.
 *  2. `getSeriesSeasons()` is the auto source chain the picker uses:
 *     MovieBox season-info → TMDB season list → none (the UI falls back to
 *     manual season/episode numbers).
 */

import { log } from '../core/log.js';
import * as moviebox from './moviebox.js';
import * as tmdb from '../metadata/tmdb.js';

/** "1080p" → 1080, "4k"/"2160p" → 2160, anything else → 0 (sorts last). */
export function qualityHeight(quality) {
  const text = String(quality || '').toLowerCase();
  if (/\b4k\b|2160/.test(text)) return 2160;
  const match = /(\d{3,4})\s*p?/.exec(text);
  const height = match ? Number(match[1]) : 0;
  return [240, 360, 480, 576, 720, 1080, 1440, 2160].includes(height) ? height : (height > 200 && height < 5000 ? height : 0);
}

/** Canonical label for a candidate's quality ("1080p", "720p", "source"). */
export function qualityKey(candidate) {
  const raw = String(candidate?.quality || candidate?.label || '').trim();
  const height = Number(candidate?.height) || qualityHeight(raw);
  if (height) return `${height}p`;
  if (raw) return raw.slice(0, 24);
  return 'source';
}

/**
 * Aggregate per-episode candidates into quality-first rows.
 *
 * @param {Array<{season:number, episode:number, candidates:Array}>} episodes
 * @returns {Array<{quality, height, episodes:[{season,episode}], providers:[string], playable:number, total:number}>}
 */
export function buildQualityMatrix(episodes = []) {
  const rows = new Map();
  for (const entry of episodes) {
    const season = Number(entry?.season) || 0;
    const episode = Number(entry?.episode) || 0;
    if (!season && !episode) continue;
    const seenInEpisode = new Set();
    for (const candidate of entry?.candidates || []) {
      const quality = qualityKey(candidate);
      if (!rows.has(quality)) {
        rows.set(quality, {
          quality,
          height: Number(candidate?.height) || qualityHeight(quality),
          episodes: [],
          providers: new Set(),
          playable: 0,
          total: 0,
        });
      }
      const row = rows.get(quality);
      const provider = String(candidate?.sourceId || candidate?._entry?.sourceId || 'unknown');
      row.providers.add(provider);
      row.total += 1;
      if (candidate?.ok !== false) row.playable += 1;
      const key = `${season}:${episode}`;
      if (!seenInEpisode.has(`${quality}|${key}`)) {
        seenInEpisode.add(`${quality}|${key}`);
        row.episodes.push({ season, episode });
      }
    }
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      providers: [...row.providers].sort(),
      episodes: row.episodes.sort((a, b) => a.season - b.season || a.episode - b.episode),
    }))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || a.quality.localeCompare(b.quality));
}

/** "S01E02" label used by episode groups, matrix rows and playlist titles. */
export function seasonEpisodeLabel(season, episode) {
  const s = String(Number(season) || 0).padStart(2, '0');
  const e = String(Number(episode) || 0).padStart(2, '0');
  return `S${s}E${e}`;
}

/**
 * Auto source chain for the season/episode picker.
 *
 *  1. MovieBox `season-info` when a subjectId is known (or can be found via a
 *     title search — one extra request, skipped when `skipMovieBoxSearch`).
 *  2. TMDB `/tv/{id}` + `/tv/{id}/season/{n}` when a TMDB key is configured.
 *  3. Nothing — the caller falls back to manual season/episode inputs.
 */
export async function getSeriesSeasons({
  subjectId = null, title = '', year = null, tmdbId = null, imdbId = null,
  skipMovieBoxSearch = false, signal = null,
} = {}) {
  const errors = [];
  let resolvedSubjectId = subjectId ? String(subjectId) : null;
  let resolvedTmdbId = tmdbId ? String(tmdbId) : null;

  // 1. MovieBox — exact when the selection already carries a subjectId.
  if (resolvedSubjectId) {
    try {
      const raw = await moviebox.seasonInfo(resolvedSubjectId, { signal });
      const seasons = moviebox.normalizeSeasonInfo(raw);
      if (seasons.length) return { source: 'moviebox', seasons, subjectId: resolvedSubjectId, tmdbId: resolvedTmdbId, errors };
      errors.push({ source: 'moviebox', error: 'the title returned no seasons' });
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      errors.push({ source: 'moviebox', error: String(err?.message || err) });
      log.warn('series', `MovieBox season-info failed for ${resolvedSubjectId}`, { error: String(err?.message || err) });
    }
  } else if (title && !skipMovieBoxSearch) {
    try {
      const rows = await moviebox.search(String(title), { perPage: 8, signal });
      const best = rows.find((row) => row.kind === 'series') || rows[0] || null;
      if (best?.subjectId) {
        resolvedSubjectId = String(best.subjectId);
        const raw = await moviebox.seasonInfo(resolvedSubjectId, { signal });
        const seasons = moviebox.normalizeSeasonInfo(raw);
        if (seasons.length) {
          return { source: 'moviebox', seasons, subjectId: resolvedSubjectId, tmdbId: resolvedTmdbId, errors, matchedTitle: best.title };
        }
      }
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      errors.push({ source: 'moviebox', error: String(err?.message || err) });
    }
  }

  // 2. TMDB — needs the TV id; search by title when it is not given.
  if (tmdb.isConfigured()) {
    try {
      if (!resolvedTmdbId && title) {
        const found = await tmdb.searchTMDB({ title: String(title), year, type: 'series', imdbId });
        resolvedTmdbId = found?.results?.[0]?.tmdbId ? String(found.results[0].tmdbId) : null;
      }
      if (resolvedTmdbId) {
        const seasons = await tmdb.getTVSeasonsFull(resolvedTmdbId);
        const usable = seasons.filter((s) => s.episodes?.length);
        if (usable.length) {
          return { source: 'tmdb', seasons: usable, subjectId: resolvedSubjectId, tmdbId: resolvedTmdbId, errors };
        }
        errors.push({ source: 'tmdb', error: 'the TMDB entry lists no episodes' });
      } else if (title) {
        errors.push({ source: 'tmdb', error: `no TMDB series match for "${title}"` });
      }
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      errors.push({ source: 'tmdb', error: String(err?.message || err) });
      log.warn('series', `TMDB season lookup failed for "${title}"`, { error: String(err?.message || err) });
    }
  } else {
    errors.push({ source: 'tmdb', error: 'TMDB API key is not configured (Settings → Metadata)' });
  }

  return { source: 'none', seasons: [], subjectId: resolvedSubjectId, tmdbId: resolvedTmdbId, errors };
}

export default { qualityHeight, qualityKey, buildQualityMatrix, seasonEpisodeLabel, getSeriesSeasons };
