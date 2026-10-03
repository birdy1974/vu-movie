/**
 * Wire-level parity with the reference client (MovieBox-TUI, MIT OR Apache-2.0).
 *
 * The point of these tests is not "our code runs" — it is "the bytes we put on
 * the wire are the bytes the reference client puts on the wire". Every header
 * under test is compared against what `crypto.rs` / `client.rs` in the
 * reference repository produce for the same input.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as moviebox from '../src/scrapers/moviebox.js';
import { directPlaybackAvailable, urlsFor } from '../src/streams/store.js';
import { looksLikeMedia, upgradeRecipe, RECIPE_SCHEMA_VERSION } from '../src/scrapers/browser.js';

/** Reference: `generate_client_info_and_ua()` — the fields and their value space. */
function assertionsForClientInfo(info) {
  assert.equal(info.package_name, 'com.community.oneroom');
  assert.equal(info.os, 'android');
  assert.equal(info.region, 'US');
  assert.equal(info.sp_code, '40401');
  assert.equal(info['X-Play-Mode'], '2');
  assert.match(info.device_id, /^[0-9a-f]{32}$/);
  assert.match(info.gaid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(['NETWORK_WIFI', 'NETWORK_MOBILE'].includes(info.net));
  assert.ok(['Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'America/New_York', 'Europe/London'].includes(info.timezone));
  assert.match(info.model, /^(23078RKD5C|2201117TY|2201117TG|22101316G|21121210G|M2012K11AG|M2007J20CG)$/);
}

test('the device identity is generated once and the UA/client-info stay consistent', () => {
  moviebox.resetIdentity();
  const first = moviebox.currentIdentity();
  const second = moviebox.currentIdentity();
  assert.strictEqual(first, second, 'a second call must not rotate the fingerprint');
  assert.equal(first, moviebox.currentIdentity(), 'the exported accessor returns the same object');
  assert.match(first.userAgent, /^com\.community\.oneroom\/\d+ \(Linux; U; Android \d+; en_US; [A-Za-z0-9]+; Build\/[A-Za-z0-9.]+; Cronet\/\d+\.\d+\.\d+\.\d+\)$/);
  const versionCode = first.userAgent.match(/^com\.community\.oneroom\/(\d+)/)[1];
  assertionsForClientInfo(JSON.parse(first.clientInfo));
  assert.equal(JSON.parse(first.clientInfo).version_code, Number(versionCode));
  assert.match(first.spoofedIp, /^(\d{1,3}\.){3}\d{1,3}$/);
  // Reset is only for tests/ops; afterwards a *new* identity is allowed.
  moviebox.resetIdentity();
  assert.notStrictEqual(moviebox.currentIdentity(), first);
});

test('every signed request carries the reference header set, and the shared identity survives across calls', async () => {
  const seen = [];
  const fakeFetch = async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    seen.push({ url: String(url), headers, body: init.body, method: init.method });
    const json = (payload) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith('/user-api/visitor-login')) return json({ data: { token: 'visitor-token', uid: 'u-1' } });
    if (String(url).endsWith('/subject-api/search/v2')) return json({ data: { results: [{ subjects: [{ subjectId: '1', title: 'x', subjectType: 1 }] }] } });
    return json({ data: {} });
  };
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  moviebox.resetIdentity();
  moviebox.resetBackoff();
  try {
    await moviebox.search('wire test', { perPage: 1 });
    await moviebox.search('wire test', { perPage: 1 });
  } finally {
    globalThis.fetch = original;
  }

  const login = seen.find((r) => r.url.endsWith('/visitor-login'));
  const searches = seen.filter((r) => r.url.endsWith('/search/v2'));
  assert.ok(login && searches.length >= 2, 'the login and two searches must have been sent');
  const search = searches[0];
  const second = searches[1];

  for (const record of [login, search]) {
    const h = record.headers;
    assert.match(h['x-client-token'], /^\d{13},[0-9a-f]{32}$/, 'x-client-token = ts,md5(reversed ts)');
    const [ts, digest] = h['x-client-token'].split(',');
    assert.equal(digest, crypto.createHash('md5').update(String(ts).split('').reverse().join('')).digest('hex'));
    assert.match(h['x-tr-signature'], /^\d{13}\|2\|[A-Za-z0-9+/=]+$/, 'x-tr-signature = ts|2|base64(hmac-md5)');
    assert.equal(h.accept, 'application/json');
    assert.equal(h['content-type'], 'application/json');
    assert.equal(h['x-client-status'], '0');
    assert.equal(h.connection, 'keep-alive');
    assert.match(h['x-forwarded-for'], /^(\d{1,3}\.){3}\d{1,3}$/);
    assertionsForClientInfo(JSON.parse(h['x-client-info']));
  }
  assert.equal(login.headers.authorization, undefined, 'visitor-login is unauthenticated');
  assert.equal(search.headers.authorization, 'Bearer visitor-token');
  // The identity must not change between requests (that is what an anti-abuse
  // edge fingerprints); the signatures must.
  assert.equal(search.headers['x-client-info'], login.headers['x-client-info']);
  assert.equal(search.headers['user-agent'], login.headers['user-agent']);
  assert.equal(search.headers['x-forwarded-for'], login.headers['x-forwarded-for']);
  assert.equal(second.headers['x-client-info'], login.headers['x-client-info'],
    'the fingerprint is reused for the whole session, not regenerated per request');
  assert.equal(second.headers['user-agent'], search.headers['user-agent']);
  assert.equal(second.headers['x-forwarded-for'], search.headers['x-forwarded-for']);
  // And the body is the reference search payload.
  assert.deepEqual(JSON.parse(search.body), { keyword: 'wire test', page: 1, perPage: 1, subjectType: 0 });
  assert.equal(login.body, '{}');
});

test('the direct (302) upstream link is withheld for sources that need request headers', () => {
  const base = 'http://nas:8080';
  const signedCookie = {
    title: 'MovieBox film', token: 'tok',
    upstream: { url: 'https://sbcdn.example/dash/x/index.mpd', headers: { Cookie: 'Edge-Cache-Cookie=urlprefix=abc', Referer: 'https://sportslive.wine' } },
  };
  const signedHeaders = {
    title: 'Referer-only source', token: 'tok2',
    upstream: { url: 'https://cdn.example/movie.mp4', headers: { Referer: 'https://overlook.cx/movies/1', 'User-Agent': 'UA' } },
  };
  const plain = {
    title: 'Plain CDN', token: 'tok3',
    upstream: { url: 'https://cdn.example/movie.mp4', headers: {} },
  };

  const a = urlsFor(signedCookie, base);
  const b = urlsFor(signedHeaders, base);
  const c = urlsFor(plain, base);

  assert.equal(a.direct, null, 'signed cookie → a 302 would 403');
  assert.match(a.directNote, /signed cookie|request headers/);
  assert.equal(b.direct, 'http://nas:8080/s/tok2/direct', 'a plain Referer is fine: VLC sends its own and the CDN usually ignores it');
  assert.equal(c.direct, 'http://nas:8080/s/tok3/direct');
  assert.equal(c.directNote, null);
  // The relay URL is always the answer for header-dependent sources.
  assert.equal(a.ts, 'http://nas:8080/s/tok/MovieBox-film.ts');

  assert.equal(directPlaybackAvailable(signedCookie), false);
  assert.equal(directPlaybackAvailable(signedHeaders), true);
  assert.equal(directPlaybackAvailable(plain), true);
  assert.equal(directPlaybackAvailable({ upstream: { url: 'https://cdn.example/x.mpd', headers: {} } }), false, 'signed DASH manifests need a fetching proxy, not a redirect');
});

test('an old site recipe inherits the current media-detection patterns', () => {
  assert.ok(RECIPE_SCHEMA_VERSION >= 2);
  const legacy = { id: 'legacy', name: 'Legacy', search: { kind: 'browser', url: 'https://x/search?q={query}' } };
  const { site, upgraded } = upgradeRecipe(legacy);
  assert.equal(upgraded, true);
  assert.equal(site.mediaPatternsVersion, RECIPE_SCHEMA_VERSION);
  assert.ok(site.mediaPatterns.some((p) => p.includes('mpd')), 'DASH must be detectable');
  assert.ok(site.mediaPatterns.some((p) => p.includes('m3u8')), 'HLS must be detectable');
  assert.equal(site.id, 'legacy', 'the rest of the recipe is preserved');
  const current = upgradeRecipe(site);
  assert.equal(current.upgraded, false, 'already-current recipes are left alone');
});

test('per-site patterns promote an extension-less manifest to a real media kind', () => {
  const patterns = [{ re: '/api/stream\\?type=dash', kind: 'dash' }];
  assert.equal(looksLikeMedia('https://site.tld/api/stream?type=dash&id=7', 'application/octet-stream', 'xhr', patterns), true);
  assert.equal(looksLikeMedia('https://site.tld/api/stream?type=dash&id=7', '', 'xhr', patterns), true);
  // Bundle/API noise must not match.
  assert.equal(looksLikeMedia('https://site.tld/api/stream?type=hls&id=7', 'application/json', 'xhr', patterns), false);
});
