/** Normalize the small set of useful metadata shared by search providers. */

export function cleanMetadataText(value, maxLength = 600) {
  if (value == null) return null;
  const text = String(value)
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
  return text ? text.slice(0, maxLength) : null;
}

function ratingNumber(value) {
  if (value && typeof value === 'object') {
    value = value.value ?? value.rating ?? value.average ?? value.score;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = cleanMetadataText(value, 80);
  if (!text) return null;
  const match = /(?:^|\b)(\d{1,2}(?:[.,]\d{1,2})?)(?:\s*\/\s*10)?\s*$/i.exec(text)
    || /(?:imdb|tmdb|rating|score|[★⭐])\s*[:·-]?\s*(\d{1,2}(?:[.,]\d{1,2})?)/i.exec(text)
    || /(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:\/\s*10|(?:imdb|tmdb))\b/i.exec(text);
  if (!match) return null;
  const number = Number(String(match[1]).replace(',', '.'));
  return Number.isFinite(number) && number >= 0 && number <= 10
    ? Math.round(number * 10) / 10
    : null;
}

function ratingFromText(text) {
  const value = cleanMetadataText(text, 1200) || '';
  const patterns = [
    /(?:imdb|tmdb|rating|score)\s*[:·-]?\s*(\d{1,2}(?:[.,]\d{1,2})?)/i,
    /[★⭐]\s*(\d{1,2}(?:[.,]\d{1,2})?)/,
    /(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:\/\s*10|(?:imdb|tmdb))\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match) return ratingNumber(match[1]);
  }
  return null;
}

const TMDB_GENRES = new Map([
  [28, 'Action'], [12, 'Adventure'], [16, 'Animation'], [35, 'Comedy'], [80, 'Crime'],
  [99, 'Documentary'], [18, 'Drama'], [10751, 'Family'], [14, 'Fantasy'], [36, 'History'],
  [27, 'Horror'], [10402, 'Music'], [9648, 'Mystery'], [10749, 'Romance'],
  [878, 'Science Fiction'], [10770, 'TV Movie'], [53, 'Thriller'], [10752, 'War'], [37, 'Western'],
  [10759, 'Action & Adventure'], [10762, 'Kids'], [10763, 'News'], [10764, 'Reality'],
  [10765, 'Sci-Fi & Fantasy'], [10766, 'Soap'], [10767, 'Talk'], [10768, 'War & Politics'],
]);

function normalizeGenres(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const genres = [];
  for (const entry of values) {
    let raw = entry && typeof entry === 'object'
      ? (entry.name ?? entry.title ?? entry.label ?? TMDB_GENRES.get(Number(entry.id)))
      : entry;
    if (typeof raw === 'number' || /^\d+$/.test(String(raw ?? ''))) raw = TMDB_GENRES.get(Number(raw));
    if (raw == null) continue;
    for (const part of String(raw).split(/[,;|•]+/)) {
      let genre = cleanMetadataText(part, 48);
      if (/^\d+$/.test(genre || '')) genre = TMDB_GENRES.get(Number(genre));
      if (!genre || genres.some((existing) => existing.toLowerCase() === genre.toLowerCase())) continue;
      genres.push(genre);
      if (genres.length >= 6) return genres;
    }
  }
  return genres;
}

function normalizeRuntime(value, fallbackText = '') {
  if (value && typeof value === 'object') value = value.minutes ?? value.value ?? value.duration;
  if (typeof value === 'number' || /^\s*\d+\s*$/.test(String(value ?? ''))) {
    const minutes = Number(value);
    return Number.isInteger(minutes) && minutes > 0 && minutes <= 600 ? minutes : null;
  }
  const text = cleanMetadataText(value, 80) || cleanMetadataText(fallbackText, 1200) || '';
  const hours = /\b(\d+)\s*(?:h|hr|hrs|hours?)\b\s*(?:(\d+)\s*(?:m|min|mins|minutes?)\b)?/i.exec(text);
  if (hours) {
    const minutes = Number(hours[1]) * 60 + Number(hours[2] || 0);
    return minutes > 0 && minutes <= 600 ? minutes : null;
  }
  const mins = /\b(\d+)\s*(?:m|min|mins|minutes?)\b/i.exec(text);
  if (mins) {
    const minutes = Number(mins[1]);
    return minutes > 0 && minutes <= 600 ? minutes : null;
  }
  return null;
}

function normalizeReleaseDate(value) {
  const text = cleanMetadataText(value, 40);
  if (!text) return null;
  const isoDate = /\b((?:18|19|20|21)\d{2}-\d{2}-\d{2})/.exec(text);
  if (isoDate) return isoDate[1];
  const match = /\b((?:18|19|20|21)\d{2})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?\b/.exec(text);
  if (!match) return text;
  if (!match[2]) return match[1];
  return `${match[1]}-${String(match[2]).padStart(2, '0')}${match[3] ? `-${String(match[3]).padStart(2, '0')}` : ''}`;
}

/**
 * Return stable search-result metadata. Text parsing only fills rating/runtime
 * when a source exposes those values in its result-card text.
 */
export function normalizeSearchMetadata(input = {}, fallbackText = '') {
  const genres = normalizeGenres(input.genres ?? input.genre ?? input.genre_ids ?? input.genreIds);
  const description = cleanMetadataText(input.description ?? input.overview ?? input.summary ?? input.plot, 700);
  const releaseDate = normalizeReleaseDate(input.releaseDate ?? input.release_date ?? input.first_air_date ?? input.airDate ?? input.air_date);
  const language = cleanMetadataText(input.language ?? input.originalLanguage ?? input.original_language, 32);
  return {
    rating: ratingNumber(input.rating ?? input.vote_average ?? input.voteAverage ?? input.imdbRatingValue) ?? ratingFromText(fallbackText),
    genres,
    runtime: normalizeRuntime(input.runtime ?? input.duration, fallbackText),
    description,
    releaseDate,
    language,
  };
}
