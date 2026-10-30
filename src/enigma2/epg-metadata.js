/** Fill missing plot text from configured metadata providers without holding a bouquet push indefinitely. */
import crypto from 'node:crypto';
import { repo } from '../core/db.js';
import { getConfig } from '../core/config.js';
import * as tmdb from '../metadata/tmdb.js';
import * as omdb from '../metadata/omdb.js';

export async function enrichEpgPlots(entries, { timeoutMs = 10000, lookup = lookupPlot, cache = repo } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let next = 0;
  const result = entries.map((entry) => ({ ...entry }));
  const language = getConfig().metadata?.language || 'en-US';
  await Promise.all(Array.from({ length: Math.min(4, result.length) }, async () => {
    while (next < result.length && !signal.aborted) {
      const entry = result[next++];
      if (String(entry.plot || '').trim()) continue;
      const key = `epg-plot:v1:${crypto.createHash('sha256').update(JSON.stringify([entry.title, entry.year, entry.kind, entry.imdbId, entry.tmdbId, language])).digest('hex')}`;
      const cached = await cache.cacheGet(key);
      if (cached?.plot) { entry.plot = cached.plot; continue; }
      if (signal.aborted) break;
      try {
        const plot = String(await lookup(entry, signal) || '').trim();
        if (plot && plot !== 'N/A') {
          entry.plot = plot;
          await cache.cacheSet(key, { plot }, 30 * 86400);
        }
      } catch { /* Missing metadata must not prevent the bouquet push. */ }
    }
  }));
  return result;
}

function titleKey(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function matchesTitle(entry, candidate) {
  if (entry.tmdbId || entry.imdbId) return true;
  const wanted = titleKey(entry.title);
  const names = [candidate?.title, candidate?.originalTitle].map(titleKey);
  const yearMatches = !entry.year || !candidate?.year || Math.abs(Number(entry.year) - Number(candidate.year)) <= 1;
  return Boolean(wanted && names.includes(wanted) && yearMatches);
}

async function lookupPlot(entry, signal) {
  const query = { title: entry.title, year: entry.year, type: entry.kind, imdbId: entry.imdbId, tmdbId: entry.tmdbId, signal };
  if (tmdb.isConfigured()) {
    try {
      const results = await tmdb.searchTMDB(query);
      const plot = results.results?.find((item) => matchesTitle(entry, item))?.overview;
      if (plot) return plot;
    } catch (error) { if (signal.aborted) throw error; }
  }
  if (omdb.isConfigured() && !signal.aborted) {
    const result = await omdb.searchOMDB(query);
    if (matchesTitle(entry, result)) return result.plot;
  }
  return '';
}
