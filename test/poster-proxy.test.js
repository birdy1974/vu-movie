import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPosterImage, posterProxyUrl } from '../src/http/poster-proxy.js';

test('poster proxy only creates same-origin signed URLs for HTTP images', () => {
  const proxy = posterProxyUrl('https://images.example/posters/film.jpg', 'https://catalog.example/film');
  assert.ok(proxy?.startsWith('/api/poster?'));
  const params = new URL(proxy, 'https://vu-movie.example').searchParams;
  assert.equal(params.get('url'), 'https://images.example/posters/film.jpg');
  assert.equal(params.get('ref'), 'https://catalog.example/film');
  assert.ok(params.get('sig'));

  const relative = posterProxyUrl('../artwork/film.jpg', 'https://catalog.example/search/item');
  assert.equal(new URL(relative, 'https://vu-movie.example').searchParams.get('url'), 'https://catalog.example/artwork/film.jpg');
  assert.equal(posterProxyUrl('javascript:alert(1)'), null);
  assert.equal(posterProxyUrl('file:///tmp/poster.jpg'), null);
  assert.equal(posterProxyUrl('https://user:pass@images.example/poster.jpg'), null);
  assert.equal(posterProxyUrl('https://images.example:8443/poster.jpg'), null);
});

test('poster proxy rejects unsigned requests and private-network destinations', async () => {
  const unsigned = await fetchPosterImage({ url: 'https://images.example/poster.jpg', signature: 'wrong' });
  assert.equal(unsigned.status, 403);

  const localProxy = posterProxyUrl('http://127.0.0.1/poster.jpg');
  const localParams = new URL(localProxy, 'https://vu-movie.example').searchParams;
  const local = await fetchPosterImage({
    url: localParams.get('url'),
    referer: localParams.get('ref'),
    signature: localParams.get('sig'),
  });
  assert.equal(local.status, 403);
});
