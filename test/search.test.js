import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { normalizeSearchRows, playerUrlWithPrefix } from '../src/scrapers/browser.js';
import { getSource, searchSource } from '../src/scrapers/registry.js';

test('player-route fallback prefixes a detail route once and preserves query parameters', () => {
  assert.equal(
    playerUrlWithPrefix('https://cinejoy.pk/movie/1377237-runner-2026?lang=en', '/watch'),
    'https://cinejoy.pk/watch/movie/1377237-runner-2026?lang=en',
  );
  assert.equal(playerUrlWithPrefix('https://cinejoy.pk/watch/movie/123', '/watch'), null);
  assert.equal(playerUrlWithPrefix('not a URL', '/watch'), null);
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
  assert.equal(results[0].url, 'https://flixhub.studio/watch.html?type=movie&id=1377237');
  assert.equal(results[1].title, 'Lovely Runner');
  assert.equal(results[1].kind, 'series');
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
      { id: 1377237, t: 'Runner', y: '2026', mediaType: 'movie', posterPath: '/runner.jpg' },
      { id: 230923, t: 'Lovely Runner', y: '2024', mediaType: 'tv', posterPath: '/series.jpg' },
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
      map: { id: 'id', title: 't', year: 'y', kind: 'mediaType', poster: 'posterPath' },
    },
  }, 'Runner & Co');

  assert.equal(requestUrl.searchParams.get('q'), 'Runner & Co');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, `${baseUrl}/movies/1377237`);
  assert.equal(rows[0].poster, 'https://image.tmdb.org/t/p/w500/runner.jpg');
  assert.equal(rows[0].year, 2026);
  assert.equal(rows[0].kind, 'movie');
  assert.equal(rows[1].url, `${baseUrl}/shows/230923`);
  assert.equal(rows[1].kind, 'series');
});

test('updated browser source recipes use their active query-string search routes', () => {
  assert.equal(getSource('cinevo').search.url, 'https://cinevo.nl/search?q={query}');
  assert.equal(getSource('flixhub').search.url, 'https://flixhub.studio/search?q={query}');
  assert.equal(getSource('redflix').search.url, 'https://redflix.club/browse?q={query}');
  assert.equal(getSource('flex1').search.url, 'https://www.1flex.org/search?q={query}');
  assert.equal(getSource('cinezo').search.url, 'https://cinezo.st/search?q={query}');
});
