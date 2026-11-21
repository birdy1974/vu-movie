/**
 * vu-movie — does a search hit have anything to do with the query?
 *
 * A scraped search page is never only the result list: the same markup holds
 * the "trending now" rail, "you may also like" cards and the genre navigation
 * (Comedy, Animation, Crime, …), and all of those link to the same detail
 * routes the recipe pattern matches. Before this module the pattern match
 * alone kept a row, so a title with no hits on a site returned that site's
 * trending rail instead, and genre links arrived as titles.
 *
 * Browser scrapes are therefore filtered strictly: a row must share a query
 * term with its title, its URL slug or its own card text. Structured providers
 * (API recipes, MovieBox) run a real search and are trusted more: their rows
 * are only trimmed when the provider found title matches *and* padded them
 * with unrelated recommendations — a provider that matched nothing by title
 * (an alternative-title or actor search) keeps its answer untouched.
 */

const STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'the', 'to', 'de', 'het', 'een', 'en', 'la', 'le', 'les', 'el', 'der', 'die', 'das']);

/** Navigation routes that share the detail-route prefix but never are a title. */
const NAVIGATION_PATH = /(?:^|\/)(?:genres?|categor(?:y|ies)|countr(?:y|ies)|years?|collections?|tags?|networks?|studios?|languages?|top(?:-|_)?(?:rated|imdb)?|trending|popular|latest|upcoming|new|recent|featured|a-z|az|letter|alphabet)(?:\/|[?#]|$)/i;
const NAVIGATION_QUERY = /(?:^|[?&])(?:genre|genres|category|country|year|sort|order|page|letter)=/i;
/** Genre words that only ever appear as a "title" when a nav link was scraped. */
const GENRE_WORDS = /^(?:action|adventure|animation|anime|biography|comedy|crime|documentary|drama|family|fantasy|film[- ]noir|history|horror|kids|music|musical|mystery|news|reality(?:[- ]tv)?|romance|sci[- ]?fi|science fiction|short|soap|sport|sports|talk|thriller|tv movie|war|western|war & politics|action & adventure|sci-fi & fantasy)$/i;

export function normalizeText(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The words of a query that carry meaning (stop words and lone characters do not). */
export function queryTerms(query) {
  const words = normalizeText(query).split(' ').filter(Boolean);
  const meaningful = words.filter((word) => word.length > 1 && !STOP_WORDS.has(word));
  // "It", "Up", "Her": a query of only stop/short words is still a query.
  return meaningful.length ? meaningful : words;
}

function editDistanceAtMostOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    if (edits) return false;
    edits = 1;
    if (a.length > b.length) i += 1;
    else if (a.length < b.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function termMatches(term, text, tokens) {
  if (term.length <= 3) return tokens.includes(term);
  if (text.includes(term)) return true;
  // One typo ("monolit", "smurfs" vs "smurf") is still the same title.
  return term.length >= 5 && tokens.some((token) => token.length >= 4 && editDistanceAtMostOne(term, token));
}

/**
 * Fraction of query terms found in `text` (0..1). A multi-word query matches
 * when at least half of its words do, so "Dune Part Two" still finds "Dune".
 */
export function termCoverage(query, text) {
  const terms = Array.isArray(query) ? query : queryTerms(query);
  if (!terms.length) return 1;
  const normalized = normalizeText(text);
  if (!normalized) return 0;
  const tokens = normalized.split(' ');
  const hits = terms.filter((term) => termMatches(term, normalized, tokens)).length;
  return hits / terms.length;
}

export function coversQuery(query, text) {
  const terms = Array.isArray(query) ? query : queryTerms(query);
  if (!terms.length) return true;
  return termCoverage(terms, text) >= Math.min(1, Math.max(0.5, 1 / terms.length));
}

/** A title route whose path or query names a genre/category/year listing. */
export function isNavigationUrl(url) {
  let target;
  try { target = url instanceof URL ? url : new URL(String(url), 'http://placeholder.invalid'); } catch { return false; }
  return NAVIGATION_PATH.test(target.pathname) || NAVIGATION_QUERY.test(target.search);
}

export function isGenreTitle(title) {
  return GENRE_WORDS.test(String(title || '').trim());
}

/** The slug part of a detail URL, readable as words. */
export function urlSlugText(url) {
  try {
    const target = url instanceof URL ? url : new URL(String(url), 'http://placeholder.invalid');
    return decodeURIComponent(`${target.pathname} ${[...target.searchParams.values()].join(' ')}`).replace(/[-_/.]+/g, ' ');
  } catch { return ''; }
}

/**
 * Trim a structured provider's answer: drop rows unrelated to the query only
 * when the same provider also returned rows that match it by title.
 */
export function trimUnrelatedResults(results, query, { text = (row) => `${row.title || ''} ${row.originalTitle || ''}` } = {}) {
  const terms = queryTerms(query);
  if (!terms.length || !results.length) return results;
  const flagged = results.map((row) => ({ row, related: coversQuery(terms, text(row)) }));
  if (!flagged.some((entry) => entry.related)) return results;
  return flagged.filter((entry) => entry.related).map((entry) => entry.row);
}

export default { normalizeText, queryTerms, termCoverage, coversQuery, isNavigationUrl, isGenreTitle, urlSlugText, trimUnrelatedResults };
