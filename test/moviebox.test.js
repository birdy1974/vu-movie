/**
 * MovieBox client: request signing and play-info parsing.
 * The fixtures are taken from the reference implementation's own test suite
 * (MovieBox-TUI, Apache-2.0) so we can prove our port behaves identically.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  generateXClientToken, generateXTrSignature, canonicalUrl, buildCanonicalString,
  dashManifestFromSignCookie, cookieHeaderFromSignCookie, releasesFromPlayInfo,
  releasesFromResources, parseJwtClaims, sessionIsValid, findStreamsByTitle, search,
  buildSearchRequest, mapSearchResults, loginWithHostFailover, requestHostPool, retryDelayMs,
  classifyFetchError, HOST_POOL, getHostPool,
  h5ClientToken, tokenFromXUser, mapH5SearchResults, releasesFromH5Streams, transportMode,
  H5_API_BASES, H5_SITE_BASES,
} from '../src/scrapers/moviebox.js';

test('canonicalUrl sorts query parameters like the reference client', () => {
  assert.equal(canonicalUrl('https://api6.aoneroom.com/x/y?b=2&a=1'), '/x/y?a=1&b=2');
  assert.equal(canonicalUrl('https://api6.aoneroom.com/wefeed-mobile-bff/subject-api/get?subjectId=42'), '/wefeed-mobile-bff/subject-api/get?subjectId=42');
});

test('MovieBox searches request all subject types and map the reference subjects envelope', () => {
  assert.deepEqual(buildSearchRequest('Dune', { page: 2, perPage: 8 }), {
    keyword: 'Dune', page: 2, perPage: 8, subjectType: 0,
  });
  const results = mapSearchResults({ data: { results: [{ subjects: [
    {
      subjectId: 'series-42', title: 'Dune: Prophecy', subjectType: 2,
      releaseDate: '2024-11-17', cover: { url: 'https://images.example/dune.jpg' },
      season: 1, imdbRatingValue: '7.2', genreList: [{ name: 'Sci-Fi' }],
    },
    { subjectId: 'movie-42', title: 'Dune', subjectType: 1, releaseDate: '2021-09-03' },
  ] }] } });
  assert.equal(results.length, 2);
  assert.equal(results[0].kind, 'series');
  assert.equal(results[0].subjectType, 2);
  assert.equal(results[0].poster, 'https://images.example/dune.jpg');
  assert.equal(results[0].rating, 7.2);
  assert.deepEqual(results[0].genres, ['Sci-Fi']);
  assert.equal(results[1].kind, 'movie');
  assert.equal(results[1].subjectType, 1);
  assert.equal(results[1].year, 2021);
});

test('visitor login fails over transport and authentication failures, requiring a token to succeed', async () => {
  const attempted = [];
  const outcome = await loginWithHostFailover({
    hosts: ['api-a', 'api-b', 'api-c'],
    requestHost: async (host) => {
      attempted.push(host);
      if (host === 'api-a') throw new Error('fetch failed');
      if (host === 'api-b') return { ok: false, status: 401, error: 'unauthorized' };
      return { ok: true, status: 200, data: { data: { token: 'visitor-token', uid: 'u-1' } } };
    },
  });
  assert.deepEqual(attempted, ['api-a', 'api-b', 'api-c']);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.session.token, 'visitor-token');
  assert.equal(outcome.result.session.uid, 'u-1');
  assert.equal(outcome.index, 2);

  const missingToken = await loginWithHostFailover({
    hosts: ['api-no-token'],
    requestHost: async () => ({ ok: true, status: 200, data: { data: {} } }),
  });
  assert.equal(missingToken.ok, false);
  assert.match(missingToken.error.message, /no token/i);
});

test('request host pool advances after thrown transport errors and returns the first successful host', async () => {
  const attempts = [];
  const outcome = await requestHostPool({
    hosts: ['one', 'two', 'three'],
    requestHost: async (host) => {
      attempts.push(host);
      if (host === 'one') throw new Error('fetch failed');
      if (host === 'two') return { ok: false, status: 503, error: 'unavailable' };
      return { ok: true, data: 'response' };
    },
  });
  assert.deepEqual(attempts, ['one', 'two', 'three']);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.index, 2);
  assert.equal(outcome.result.data, 'response');
});

test('x-client-token is timestamp + md5 of the reversed timestamp', () => {
  const ts = 1700000000000;
  const reversed = String(ts).split('').reverse().join('');
  const expected = crypto.createHash('md5').update(reversed).digest('hex');
  assert.equal(generateXClientToken(ts), `${ts},${expected}`);
});

test('x-tr-signature has the documented shape and is stable for fixed input', () => {
  const url = 'https://api6.aoneroom.com/wefeed-mobile-bff/subject-api/search/v2';
  const body = JSON.stringify({ keyword: 'dune', page: 1, perPage: 15 });
  const sig = generateXTrSignature({ method: 'POST', url, body, timestampMs: 1700000000000 });
  const [ts, version, mac] = sig.split('|');
  assert.equal(ts, '1700000000000');
  assert.equal(version, '2');
  assert.ok(mac.length > 20, 'hmac-md5 base64 payload');
  assert.equal(sig, generateXTrSignature({ method: 'POST', url, body, timestampMs: 1700000000000 }), 'signature must be deterministic');
  assert.notEqual(sig, generateXTrSignature({ method: 'GET', url, body, timestampMs: 1700000000000 }), 'method is part of the signature');
});

test('canonical string contains method, accept, body length, body hash and url', () => {
  const canonical = buildCanonicalString({
    method: 'POST', url: 'https://api6.aoneroom.com/x?a=1',
    body: '{"a":1}', timestampMs: 1700000000000,
  });
  const lines = canonical.split('\n');
  assert.equal(lines[0], 'POST');
  assert.equal(lines[1], 'application/json');
  assert.equal(lines[2], 'application/json');
  assert.equal(lines[3], '7');
  assert.equal(lines[4], '1700000000000');
  assert.equal(lines[5], crypto.createHash('md5').update('{"a":1}').digest('hex'));
  assert.equal(lines[6], '/x?a=1');
});

test('Edge-Cache-Cookie urlprefix decodes to the DASH manifest', () => {
  const signCookie = 'Edge-Cache-Cookie=urlprefix=aHR0cHM6Ly9zYmNkbjMuaGFrdW5heW1hdGF0YS5jb20vZGFzaC8zMjY0NzcyNTg4MzMzMTU3NDI0XzBfMF8xMDgwX2gyNjVfNTYwLw:sign=f1a522f7bf4c548c981ad6efa88925ad:t=1789908742';
  assert.equal(
    dashManifestFromSignCookie(signCookie),
    'https://sbcdn3.hakunaymatata.com/dash/3264772588333157424_0_0_1080_h265_560/index.mpd',
  );
});

test('CloudFront policy cookies also yield a manifest URL', () => {
  const policy = Buffer.from(JSON.stringify({
    Statement: [{ Resource: 'https://sacdn.hakunaymatata.com/dash/abc123/*', Condition: {} }],
  })).toString('base64');
  const cookie = `CloudFront-Policy=${policy};CloudFront-Signature=abc;CloudFront-Key-Pair-Id=K1`;
  assert.equal(dashManifestFromSignCookie(cookie), 'https://sacdn.hakunaymatata.com/dash/abc123/index.mpd');
  assert.equal(dashManifestFromSignCookie(''), null);
});

test('cookie value is cleaned for reuse as a Cookie header', () => {
  assert.equal(
    cookieHeaderFromSignCookie('Edge-Cache-Cookie=urlprefix=aGk:sign=x:t=1;'),
    'Edge-Cache-Cookie=urlprefix=aGk:sign=x:t=1',
  );
});

test('play-info payload becomes ranked 1080p/720p/480p candidates', () => {
  const payload = {
    code: 0,
    data: {
      title: 'Ek Deewane Ki Deewaniyat',
      displayResolutions: '1080,720,480',
      streams: [{
        id: '1849447804066746512',
        format: 'MP4',
        codecName: 'hevc',
        resolutions: '1080,720,480',
        size: '1682353414',
        duration: 8372,
        url: 'https://macdn.aoneroom.com/other/2026/09/04/b164fbfb4347792950bdfbfb563d39d9.mp4',
        signCookie: 'Edge-Cache-Cookie=urlprefix=aHR0cHM6Ly9zYmNkbjMuaGFrdW5heW1hdGF0YS5jb20vZGFzaC8zMjY0NzcyNTg4MzMzMTU3NDI0XzBfMF8xMDgwX2gyNjVfNTYwLw:sign=f1a522f7bf4c548c981ad6efa88925ad:t=1789908742',
      }],
    },
  };
  const releases = releasesFromPlayInfo(payload, { userAgent: 'TestAgent/1.0' });
  assert.equal(releases.length, 3);
  assert.equal(releases[0].quality, '1080p');
  assert.equal(releases[1].quality, '720p');
  assert.equal(releases[2].quality, '480p');
  assert.equal(releases[0].url, 'https://sbcdn3.hakunaymatata.com/dash/3264772588333157424_0_0_1080_h265_560/index.mpd');
  assert.equal(releases[0].codec, 'hevc');
  assert.equal(releases[0].headers.Referer, 'https://sportslive.wine');
  assert.ok(releases[0].headers.Cookie.startsWith('Edge-Cache-Cookie=urlprefix='));
  assert.ok(releases[0].sizeBytes >= releases[1].sizeBytes, 'smaller renditions get a scaled size estimate');
});

test('placeholder/notice URLs are skipped exactly like the reference client', () => {
  const payload = {
    data: {
      streams: [
        // macdn's `/other/` bucket is where MovieBox puts its "not available"
        // clips — the reference client filters the whole bucket out.
        { id: '1', url: 'https://macdn.aoneroom.com/other/x.mp4' },
        { id: '2', url: 'https://macdn.aoneroom.com/dash/realmovie.mp4' },
        { id: '3', url: 'https://cdn.example/notice.mp4' },
        // A real file whose *name* happens to contain "notice" must survive:
        // the old regex `deprecat|notice|unavailable` dropped these.
        { id: '4', url: 'https://cdn.example/notices-from-the-court.mp4' },
      ],
    },
  };
  const releases = releasesFromPlayInfo(payload);
  const byUrl = new Set(releases.map((r) => r.url));
  assert.ok(!byUrl.has('https://macdn.aoneroom.com/other/x.mp4'), 'macdn /other/ is a placeholder');
  assert.ok(!byUrl.has('https://cdn.example/notice.mp4'), '/notice.mp4 is a placeholder');
  assert.ok(byUrl.has('https://macdn.aoneroom.com/dash/realmovie.mp4'), 'a real stream survives');
  assert.ok(byUrl.has('https://cdn.example/notices-from-the-court.mp4'), 'a real title containing “notice” survives');
  // One candidate per advertised resolution (default 1080/720/480) per stream,
  // exactly like the reference client; the registry dedupes by URL afterwards.
  assert.deepEqual([...new Set(releases.map((r) => r.quality))], ['1080p', '720p', '480p']);
  assert.equal(releases.filter((r) => r.url === 'https://cdn.example/notices-from-the-court.mp4').length, 3);
});

test('resource items map to candidates with the reference field fallbacks', () => {
  const releases = releasesFromResources({ data: { list: [
    {
      fileName: 'The Runner 2025 1080p', resourceId: 'res-1', resolution: 1080, codecName: 'h264',
      size: '1682353414', resourceLink: 'https://cdn.example/dash/abc/index.mp4', uploadBy: 'Cloud', se: 0, ep: 0,
    },
    {
      fileName: 'The Runner 720p', id: 42, resolution: '720', codec: 'hevc', size: 900000,
      url: 'https://cdn.example/hls/master.m3u8', source: 'Server-2',
    },
    { fileName: 'placeholder', resourceId: 'res-3', resourceLink: 'https://macdn.aoneroom.com/other/9a0461bc39da389663bf3dbb17091d3f.mp4' },
  ] } }, {});
  assert.equal(releases.length, 2, 'placeholder links are dropped');
  assert.equal(releases[0].url, 'https://cdn.example/dash/abc/index.mp4');
  assert.equal(releases[0].quality, '1080p');
  assert.equal(releases[0].height, 1080);
  assert.equal(releases[0].sizeBytes, 1682353414);
  assert.equal(releases[0].label, 'Cloud 1080p');
  assert.equal(releases[1].meta.resourceId, '42', 'resourceId falls back to id');
  assert.equal(releases[1].kind, 'hls');
  assert.equal(releases[1].label, 'Server-2 720p');
});

test('resource listings are filtered to the requested episode', () => {
  const payload = { data: { list: [
    { fileName: 'S01E01', resourceId: 'a', resolution: 1080, resourceLink: 'https://cdn.example/e1.mp4', se: 1, ep: 1 },
    { fileName: 'S01E02', resourceId: 'b', resolution: 1080, resourceLink: 'https://cdn.example/e2.mp4', se: 1, ep: 2 },
  ] } };
  assert.deepEqual(releasesFromResources(payload, { season: 1, episode: 2 }).map((r) => r.url), ['https://cdn.example/e2.mp4']);
  // No season/episode requested → everything is offered (movies have se=ep=0).
  assert.equal(releasesFromResources(payload, {}).length, 2);
});

test('visitor JWTs decide session validity (exp claim, then a 7-day ceiling)', () => {
  const future = Buffer.from(JSON.stringify({ userId: 'u-9', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const past = Buffer.from(JSON.stringify({ userId: 'u-9', exp: Math.floor(Date.now() / 1000) - 5 })).toString('base64url');
  const claims = parseJwtClaims(`header.${future}.sig`);
  assert.equal(claims.userId, 'u-9');
  assert.ok(claims.exp > Math.floor(Date.now() / 1000));
  assert.equal(parseJwtClaims('not-a-jwt').exp, null);
  assert.equal(sessionIsValid({ token: `header.${future}.sig`, expiresAt: claims.exp }), true);
  assert.equal(sessionIsValid({ token: `header.${past}.sig`, expiresAt: parseJwtClaims(`header.${past}.sig`).exp }), false);
  assert.equal(sessionIsValid({ token: 'opaque', savedAt: new Date().toISOString() }), true);
  assert.equal(sessionIsValid({ token: 'opaque', savedAt: new Date(Date.now() - 8 * 24 * 3600_000).toISOString() }), false);
  assert.equal(sessionIsValid({ token: '' }), false);
});

test('findStreamsByTitle unions play-info and resource listings and dedupes by manifest path', async () => {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method || 'GET' });
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    });
    if (path.endsWith('/user-api/visitor-login')) return json({ data: { token: 'visitor', uid: 'u-1' } });
    if (path.endsWith('/subject-api/search/v2')) {
      return json({ data: { results: [{ subjects: [{ subjectId: '42', title: 'The Runner', subjectType: 1, releaseDate: '2025-01-01' }] }] } });
    }
    if (path.endsWith('/subject-api/play-info/v2')) {
      return json({ data: { title: 'The Runner', streams: [{
        id: 's1', format: 'MP4', codecName: 'hevc', resolutions: '1080',
        signCookie: `Edge-Cache-Cookie=urlprefix=${Buffer.from('https://cdn.example/dash/42_1080/').toString('base64')}:sign=x:t=1`,
      }] } });
    }
    if (path.endsWith('/subject-api/resource')) {
      return json({ data: { list: [
        // Same manifest as play-info (must be deduped) + one extra mirror.
        { fileName: 'dup', resourceId: 'd', resolution: 1080, resourceLink: 'https://cdn.example/dash/42_1080/index.mpd' },
        { fileName: 'mirror', resourceId: 'e', resolution: 480, resourceLink: 'https://cdn.example/dash/42_480/index.mpd' },
      ] } });
    }
    return json({ error: 'unexpected path' }, 404);
  };
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const { item, candidates } = await findStreamsByTitle('The Runner', { year: 2025, kind: 'movie' });
    assert.equal(item.subjectId, '42');
    const urls = candidates.map((c) => c.url).sort();
    assert.deepEqual(urls, ['https://cdn.example/dash/42_1080/index.mpd', 'https://cdn.example/dash/42_480/index.mpd']);
    assert.ok(calls.some((c) => c.path.endsWith('/subject-api/play-info/v2')), 'play-info is queried');
    assert.ok(calls.some((c) => c.path.endsWith('/subject-api/resource')), 'resource listing is queried too');
    // The play-info candidate keeps the signed-cookie headers; the resource one has none.
    const signed = candidates.find((c) => c.url.includes('42_1080'));
    assert.ok(signed.headers.Cookie.startsWith('Edge-Cache-Cookie=urlprefix='));
    assert.equal(candidates.find((c) => c.url.includes('42_480')).headers.Cookie, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('a 200 with a non-JSON body is a host failure, not an empty result', async () => {
  const attempted = [];
  const fakeFetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    attempted.push(new URL(url).host);
    if (path.endsWith('/user-api/visitor-login')) {
      return new Response(JSON.stringify({ data: { token: 'visitor' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Host 1 answers with a WAF/HTML page and a 2xx status — the reference
    // client treats an unparseable body as a host failure and moves on.
    if (new URL(url).host.startsWith('api6.')) return new Response('<html>Just a moment…</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(JSON.stringify({ data: { results: [{ subjects: [{ subjectId: '7', title: 'Ok', subjectType: 1 }] }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const results = await search('ok');
    assert.equal(results.length, 1);
    assert.ok(attempted.some((h) => h.startsWith('api6.')), 'the primary host was tried first');
    assert.ok(attempted.some((h) => !h.startsWith('api6.')), 'a later host was used after the parse failure');
  } finally {
    globalThis.fetch = original;
  }
});

test('classifyFetchError distinguishes DNS, TLS, reset and timeout failures', () => {
  const dns = classifyFetchError({ message: 'fetch failed', cause: { code: 'ENOTFOUND', hostname: 'api6sg.aoneroom.com', message: 'getaddrinfo ENOTFOUND api6sg.aoneroom.com' } });
  assert.equal(dns.kind, 'dns');
  const tls = classifyFetchError({ message: 'fetch failed', cause: { message: 'Client network socket disconnected before secure TLS connection was established' } });
  assert.equal(tls.kind, 'tls');
  const reset = classifyFetchError({ message: 'fetch failed', cause: { code: 'ECONNRESET', message: 'read ECONNRESET' } });
  assert.equal(reset.kind, 'connection-reset');
  const timeout = classifyFetchError({ message: 'fetch failed', cause: { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' } });
  assert.equal(timeout.kind, 'timeout');
});

test('a 429 pauses for Retry-After before the next host, and the cap is 3 s', async () => {
  // The delay computation is the reference client's, cap included.
  assert.equal(retryDelayMs({ headers: { 'retry-after': '30' } }), 3000);
  assert.equal(retryDelayMs({ headers: { 'retry-after': '1' } }), 1000);
  assert.equal(retryDelayMs({ headers: {} }), 400);
  assert.equal(retryDelayMs(null), 400);

  const attempts = [];
  const started = Date.now();
  const outcome = await requestHostPool({
    hosts: ['api-a', 'api-b'],
    requestHost: async (host) => {
      attempts.push(host);
      if (host === 'api-a') return { ok: false, status: 429, headers: { 'retry-after': '0.25' }, error: 'rate limited' };
      return { ok: true, status: 200, data: { ok: true } };
    },
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(attempts, ['api-a', 'api-b']);
  assert.ok(Date.now() - started >= 240, 'the hop waited for Retry-After before retrying');
});

test('the dead api6sg host has been removed from the host pool', () => {
  assert.ok(Array.isArray(HOST_POOL) && HOST_POOL.length > 0, 'HOST_POOL should be a non-empty array');
  assert.ok(!HOST_POOL.some((h) => h.includes('api6sg')), 'api6sg.aoneroom.com was DNS-dead and must be removed');
  assert.ok(HOST_POOL.includes('https://api6.aoneroom.com'), 'primary hosts must remain');
  assert.ok(HOST_POOL.includes('https://api.inmoviebox.com'), 'legacy fallback must remain');
});


test('the host pool is the reference client pool: only the mobile-BFF hosts', () => {
  // MovieBox-TUI uses api6/5/4/4sg/3 + api.inmoviebox.com (api6sg no longer
  // resolves). The H5/web hostnames were removed from it: they answer 404 to
  // /wefeed-mobile-bff because they are a *different* BFF, not extra mirrors.
  const pool = getHostPool();
  assert.deepEqual(pool, [
    'https://api6.aoneroom.com',
    'https://api5.aoneroom.com',
    'https://api4.aoneroom.com',
    'https://api4sg.aoneroom.com',
    'https://api3.aoneroom.com',
    'https://api.inmoviebox.com',
  ]);
  for (const host of ['h5-api.aoneroom.com', 'h5.aoneroom.com', 'api.aoneroom.com', 'i-api.aoneroom.com', 'apii.inmoviebox.com']) {
    assert.ok(!pool.some((h) => h.includes(host)), `${host} must not be in the mobile-BFF pool`);
  }
  assert.deepEqual(HOST_POOL, pool);
});

test('the web (H5) BFF signs X-Client-Token in seconds, not milliseconds', () => {
  const now = Date.UTC(2026, 9, 3, 20, 15, 30);
  const seconds = Math.floor(now / 1000);
  const token = h5ClientToken(now);
  assert.equal(token.split(',')[0], String(seconds));
  assert.equal(token, `${seconds},${crypto.createHash('md5').update(String(seconds).split('').reverse().join('')).digest('hex')}`);
  assert.notEqual(h5ClientToken(now), h5ClientToken(now + 1000), 'the token must change every second');
});

test('the web BFF hands the anonymous JWT back in the x-user header', () => {
  const jwt = 'header.eyJ1aWQiOjQyfQ.signature';
  assert.equal(tokenFromXUser({ 'x-user': JSON.stringify({ token: jwt, uid: '42' }) }), jwt);
  assert.equal(tokenFromXUser({ 'X-User': JSON.stringify({ token: jwt }) }), jwt);
  assert.equal(tokenFromXUser(new Headers({ 'x-user': JSON.stringify({ token: jwt }) })), jwt);
  assert.equal(tokenFromXUser({}), null);
  assert.equal(tokenFromXUser(null), null);
  assert.equal(tokenFromXUser({ 'x-user': 'not json' }), null);
  assert.equal(tokenFromXUser({ 'x-user': JSON.stringify({ token: '   ' }) }), null);
});

test('web (H5) search rows keep the detailPath the web BFF addresses titles by', () => {
  const rows = mapH5SearchResults({
    data: {
      items: [
        {
          subjectId: '12345', detailPath: 'dune-part-two-Akh5Nrwl7o', title: 'Dune: Part Two',
          subjectType: 1, releaseDate: '2024-02-27', duration: 10008,
          cover: { url: 'https://images.example/dune2.jpg' },
          genre: 'Action, Adventure', imdbRatingValue: '8.5', description: 'Paul Atreides.',
        },
        { subjectId: '999', title: 'Dune: Prophecy', subjectType: 2, detailPath: 'dune-prophecy-Xy1' },
      ],
      pager: { totalCount: 2, hasMore: false },
    },
  });
  assert.equal(rows.length, 2);
  const [movie, series] = rows;
  assert.equal(movie.subjectId, '12345');
  assert.equal(movie.detailPath, 'dune-part-two-Akh5Nrwl7o');
  assert.equal(movie.title, 'Dune: Part Two');
  assert.equal(movie.year, 2024);
  assert.equal(movie.kind, 'movie');
  assert.equal(movie.poster, 'https://images.example/dune2.jpg');
  assert.equal(movie.rating, 8.5);
  assert.equal(movie.transport, 'h5');
  assert.equal(series.kind, 'series');
  // A row without an identifier is not a result we can play.
  assert.equal(mapH5SearchResults({ data: { items: [{ title: 'no id' }] } }).length, 0);
  assert.equal(mapH5SearchResults(null).length, 0);
});

test('web (H5) streams become candidates and VIP-locked rows are dropped', () => {
  const candidates = releasesFromH5Streams({
    data: {
      streams: [
        { url: 'https://cdn.example/dune/1080.mpd', resolutions: '1080', size: 4294967296, codecName: 'h264', duration: 10008 },
        { url: 'https://cdn.example/dune/720.mp4', resolutions: '720', size: 2147483648 },
        { url: 'https://cdn.example/dune/4k.mpd', resolutions: '2160', vipLocked: true },
        { url: '', resolutions: '480' },
      ],
      downloads: [{ url: 'https://cdn.example/dune/360.mp4', resolution: 360, size: 1073741824 }],
    },
  }, { season: 1, episode: 2, detailPath: 'dune-part-two-Akh5Nrwl7o', title: 'Dune: Part Two' });

  assert.deepEqual(candidates.map((c) => c.quality), ['1080p', '720p', '360p']);
  assert.equal(candidates[0].via, 'moviebox-h5');
  assert.equal(candidates[0].kind, 'dash');
  assert.equal(candidates[0].height, 1080);
  assert.equal(candidates[0].sizeBytes, 4294967296);
  assert.equal(candidates[2].height, 360, 'download rows expose `resolution`, not `resolutions`');
  // The CDN checks the play-page Referer the browser would send.
  assert.equal(candidates[0].headers.Referer, 'https://movieboxonline.net/play/dune-part-two-Akh5Nrwl7o');
  assert.equal(candidates[0].meta.season, 1);
  assert.equal(candidates[0].meta.episode, 2);
  assert.equal(candidates[0].meta.transport, 'h5');
  assert.equal(releasesFromH5Streams({ data: { streams: [{ url: 'https://cdn.example/x.mp4', vipLocked: true }] } }).length, 0);
  assert.equal(releasesFromH5Streams(null).length, 0);
});

test('transport selection honours MOVIEBOX_TRANSPORT and defaults to auto', () => {
  assert.equal(transportMode('auto'), 'auto');
  assert.equal(transportMode('h5'), 'h5');
  assert.equal(transportMode('mobile'), 'mobile');
  assert.equal(transportMode('H5'), 'h5');
  assert.equal(transportMode(null, ), transportMode(process.env.MOVIEBOX_TRANSPORT));
  // The web BFF lives on hosts that are not the filtered api* edge.
  assert.deepEqual(H5_API_BASES, ['https://h5-api.aoneroom.com']);
  assert.ok(H5_SITE_BASES.every((base) => !base.includes('aoneroom')), 'site mirrors are ordinary website domains');
});
