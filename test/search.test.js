import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { normalizeSearchRows, playerUrlWithPrefix } from '../src/scrapers/browser.js';
import { fillMissingMetadata, fillMissingPosters, getSource, searchSource, parseMovieBoxTarget } from '../src/scrapers/registry.js';
import { normalizeSearchMetadata } from '../src/scrapers/metadata.js';

test('MovieBox pseudo URLs retain explicit season and episode values', () => {
  assert.deepEqual(parseMovieBoxTarget('moviebox://subject/subject-42?se=3&ep=7'), {
    subjectId: 'subject-42', season: 3, episode: 7,
  });
  assert.deepEqual(parseMovieBoxTarget('moviebox://subject/42'), {
    subjectId: '42', season: 0, episode: 0,
  });
  assert.equal(parseMovieBoxTarget('https://example.com/title/42'), null);
});

test('search source detailed mode distinguishes provider failure from an empty result list', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'provider maintenance' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const source = {
    id: 'failed-search-test', name: 'Failed Search Test', home: `http://127.0.0.1:${server.address().port}`,
    search: { kind: 'api', url: `http://127.0.0.1:${server.address().port}/search?q={query}`, items: 'results' },
  };
  const outcome = await searchSource(source, 'runner', { detailed: true });
  assert.deepEqual(outcome.results, []);
  assert.match(outcome.error, /provider maintenance/i);
  assert.deepEqual(await searchSource(source, 'runner'), []);
});

test('player-route fallback prefixes a detail route once and preserves query parameters', () => {
  assert.equal(
    playerUrlWithPrefix('https://cinejoy.pk/movie/1377237-runner-2026?lang=en', '/watch'),
    'https://cinejoy.pk/watch/movie/1377237-runner-2026?lang=en',
  );
  assert.equal(playerUrlWithPrefix('https://cinejoy.pk/watch/movie/123', '/watch'), null);
  assert.equal(playerUrlWithPrefix('not a URL', '/watch'), null);
});

test('search metadata normalizes ratings, genres, runtime, dates and synopsis text', () => {
  const metadata = normalizeSearchMetadata({
    rating: null,
    genres: [{ name: 'Drama' }, { title: 'Sci-Fi' }, 18],
    runtime: '2h 06m',
    description: '<p>A long trip &amp; a difficult choice.</p>',
    releaseDate: '2025-04-01T00:00:00.000Z',
    language: 'en',
  }, 'IMDb 8.7 · 128 min');
  assert.equal(metadata.rating, 8.7);
  assert.deepEqual(metadata.genres, ['Drama', 'Sci-Fi']);
  assert.equal(metadata.runtime, 126);
  assert.equal(metadata.description, 'A long trip & a difficult choice.');
  assert.equal(metadata.releaseDate, '2025-04-01');
  assert.equal(metadata.language, 'en');
  assert.deepEqual(normalizeSearchMetadata({ genres: [18, 878] }).genres, ['Drama', 'Science Fiction']);
  const fromCardText = normalizeSearchMetadata({}, 'Runner (2024) ★ 8.1 · 1h 50m');
  assert.equal(fromCardText.rating, 8.1);
  assert.equal(fromCardText.runtime, 110);
});

test('browser search accepts current detail URL shapes and normalizes card metadata', () => {
  const results = normalizeSearchRows([
    {
      href: '/watch.html?type=movie&id=1377237',
      title: 'Runner poster',
      titleRank: 2,
      text: 'HD Runner 8.3 2026',
      cardText: 'Runner Movie 2026',
      poster: '/images/runner.jpg',
      rating: 'IMDb 8.3/10',
      genres: ['Action', 'Sci-Fi'],
      runtime: '2h 07m',
      description: 'A courier races to finish one last delivery.',
      releaseDate: '2026-06-14',
      language: 'en',
      hasImage: true,
      cardLike: true,
    },
    {
      href: '/watch.html?type=movie&id=1377237',
      title: 'Runner',
      titleRank: 4,
      text: '2026 • Movie Runner',
      hasImage: true,
    },
    {
      href: '/series/230923',
      title: 'Lovely Runner',
      text: 'Lovely Runner series',
      hasImage: true,
    },
    { href: '/movies', title: 'Movies', text: 'Browse movies' },
    { href: 'https://external.example/movie/runner', title: 'Runner', hasImage: true },
  ], {
    pageUrl: 'https://flixhub.studio/search?q=runner',
    baseUrl: 'https://flixhub.studio/home',
    query: 'runner',
    resultPattern: 'watch\\.html\\?type=|/(movie|film|tv|series?|title|watch)/',
    siteId: 'flixhub',
    siteName: 'FlixHub',
  });

  assert.equal(results.length, 2, 'duplicate cards and navigation/external links are filtered');
  assert.equal(results[0].title, 'Runner');
  assert.equal(results[0].year, 2026);
  assert.equal(results[0].kind, 'movie');
  assert.equal(results[0].poster, 'https://flixhub.studio/images/runner.jpg');
  assert.equal(results[0].rating, 8.3);
  assert.deepEqual(results[0].genres, ['Action', 'Sci-Fi']);
  assert.equal(results[0].runtime, 127);
  assert.equal(results[0].description, 'A courier races to finish one last delivery.');
  assert.equal(results[0].releaseDate, '2026-06-14');
  assert.equal(results[0].language, 'en');
  assert.equal(results[0].url, 'https://flixhub.studio/watch.html?type=movie&id=1377237');
  assert.equal(results[1].title, 'Lovely Runner');
  assert.equal(results[1].kind, 'series');
});

test('search normalization accepts matching results that use an id query instead of a title route', () => {
  const results = normalizeSearchRows([
    {
      href: '/?subjectId=12345',
      title: 'Unabomber: The True Story',
      text: 'Unabomber: The True Story 1996 6.1',
      cardText: 'Unabomber: The True Story 1996 6.1',
    },
    {
      href: '/catalog/special-2022',
      title: 'Unabomber: In His Own Words',
      text: 'Unabomber: In His Own Words 2022 6.5',
    },
    {
      href: '/search?q=unabomber',
      title: 'Search for unabomber',
      text: 'Search for unabomber',
    },
  ], {
    pageUrl: 'https://cinejoy.pk/search/unabomber',
    baseUrl: 'https://cinejoy.pk/',
    query: 'unabomber',
    resultPattern: '/(movie|tv|series|watch)/',
    siteId: 'cinejoy',
    siteName: 'Cinejoy',
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'Unabomber: The True Story');
  assert.equal(results[0].url, 'https://cinejoy.pk/?subjectId=12345');
  assert.equal(results[0].year, 1996);
  assert.equal(results[1].title, 'Unabomber: In His Own Words');
  assert.equal(results[1].url, 'https://cinejoy.pk/catalog/special-2022');
  assert.equal(results[1].year, 2022);
});

test('search results inherit poster artwork from matching titles across sources', () => {
  const poster = 'https://image.tmdb.org/t/p/w500/dune.jpg';
  const rows = fillMissingPosters([
    { title: 'Dune: Part Two', year: 2024, kind: 'movie', sourceId: 'overlook', poster },
    { title: 'Dune Part Two', year: 2024, kind: 'movie', sourceId: 'cinevo', poster: null },
  ]);
  assert.equal(rows[1].poster, poster);
});

test('poster inheritance does not guess between ambiguous titles from different years', () => {
  const rows = fillMissingPosters([
    { title: 'The Thing', year: 1982, kind: 'movie', sourceId: 'overlook', poster: 'https://images.example/thing-1982.jpg' },
    { title: 'The Thing', year: 2011, kind: 'movie', sourceId: 'moviebox', poster: 'https://images.example/thing-2011.jpg' },
    { title: 'The Thing', year: null, kind: 'movie', sourceId: 'cinevo', poster: null },
  ]);
  assert.equal(rows[2].poster, null);
});

test('matching results fill missing metadata without crossing title years', () => {
  const enriched = fillMissingMetadata([
    {
      title: 'Arrival', year: 2016, kind: 'movie', sourceId: 'overlook', rating: 7.9,
      genres: ['Drama', 'Sci-Fi'], runtime: 116, description: 'A linguist studies an alien arrival.',
    },
    { title: 'Arrival', year: 2016, kind: 'movie', sourceId: 'cinevo', rating: null, genres: [], runtime: null, description: null },
    { title: 'Arrival', year: 1996, kind: 'movie', sourceId: 'cinezo', rating: null, genres: [], runtime: null, description: null },
  ]);
  assert.equal(enriched[1].rating, 7.9);
  assert.deepEqual(enriched[1].genres, ['Drama', 'Sci-Fi']);
  assert.equal(enriched[1].runtime, 116);
  assert.equal(enriched[1].description, 'A linguist studies an alien arrival.');
  assert.equal(enriched[2].rating, null);
  assert.deepEqual(enriched[2].genres, []);
});

test('Overlook recipe uses its JSON search endpoint and maps results into detail URLs', async (t) => {
  const source = getSource('overlook');
  assert.equal(source.search.kind, 'api');
  assert.equal(source.search.url, 'https://overlook.cx/api/search?q={query}');

  let requestUrl = null;
  const server = createServer((req, res) => {
    requestUrl = new URL(req.url, `http://${req.headers.host}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [
      {
        id: 1377237, t: 'Runner', y: '2026', mediaType: 'movie', posterPath: '/runner.jpg',
        vote_average: 8.4, genres: [{ id: 18, name: 'Drama' }, { id: 878, name: 'Sci-Fi' }],
        overview: 'A courier races across the city.', runtime: 121, release_date: '2026-03-14', original_language: 'en',
      },
      {
        id: 230923, t: 'Lovely Runner', y: '2024', mediaType: 'tv', posterPath: '/series.jpg',
        vote_average: 7.8, genres: [], genre_ids: [18, 10765], first_air_date: '2024-02-01',
        overview: 'A drama about time travel.', original_language: 'ko',
      },
    ] }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const rows = await searchSource({
    id: 'search-api-test',
    name: 'Search API Test',
    home: baseUrl,
    search: {
      kind: 'api',
      url: `${baseUrl}/api/search?q={query}`,
      items: 'results',
      resultUrl: '/{type}/{id}',
      typeMap: { movie: 'movies', tv: 'shows' },
      posterBaseUrl: 'https://image.tmdb.org/t/p/w500/',
      map: {
        id: 'id', title: 't', year: 'y', kind: 'mediaType', poster: 'posterPath',
        rating: 'vote_average', genres: 'genres', description: 'overview', runtime: 'runtime',
        releaseDate: 'release_date', language: 'original_language',
      },
    },
  }, 'Runner & Co');

  assert.equal(requestUrl.searchParams.get('q'), 'Runner & Co');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, `${baseUrl}/movies/1377237`);
  assert.equal(rows[0].poster, 'https://image.tmdb.org/t/p/w500/runner.jpg');
  assert.equal(rows[0].year, 2026);
  assert.equal(rows[0].kind, 'movie');
  assert.equal(rows[0].rating, 8.4);
  assert.deepEqual(rows[0].genres, ['Drama', 'Sci-Fi']);
  assert.equal(rows[0].description, 'A courier races across the city.');
  assert.equal(rows[0].runtime, 121);
  assert.equal(rows[0].releaseDate, '2026-03-14');
  assert.equal(rows[0].language, 'en');
  assert.equal(rows[1].url, `${baseUrl}/shows/230923`);
  assert.equal(rows[1].kind, 'series');
  assert.equal(rows[1].rating, 7.8);
  assert.deepEqual(rows[1].genres, ['Drama', 'Sci-Fi & Fantasy']);
  assert.equal(rows[1].releaseDate, '2024-02-01');
  assert.equal(rows[1].language, 'ko');
});

test('updated browser source recipes use their active query-string search routes', () => {
  assert.equal(getSource('cinevo').search.url, 'https://cinevo.nl/search?q={query}');
  assert.equal(getSource('flixhub').search.url, 'https://flixhub.studio/search?q={query}');
  assert.equal(getSource('redflix').search.url, 'https://redflix.club/browse?q={query}');
  assert.equal(getSource('flex1').search.url, 'https://www.1flex.org/search?q={query}');
  assert.equal(getSource('cinezo').search.url, 'https://cinezo.st/search?q={query}');
});
