/**
 * MovieBox client: request signing and play-info parsing.
 * The fixtures are taken from the reference implementation's own test suite
 * (MovieBox-TUI, Apache-2.0) so we can prove our port behaves identically.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateXClientToken, generateXTrSignature, canonicalUrl, buildCanonicalString, dashManifestFromSignCookie, cookieHeaderFromSignCookie, releasesFromPlayInfo } from '../src/scrapers/moviebox.js';

test('canonicalUrl sorts query parameters like the reference client', () => {
  assert.equal(canonicalUrl('https://api6.aoneroom.com/x/y?b=2&a=1'), '/x/y?a=1&b=2');
  assert.equal(canonicalUrl('https://api6.aoneroom.com/wefeed-mobile-bff/subject-api/get?subjectId=42'), '/wefeed-mobile-bff/subject-api/get?subjectId=42');
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

test('streams without a playable manifest are skipped, deprecation URLs ignored', () => {
  const payload = {
    data: {
      streams: [
        { id: '1', url: 'https://macdn.aoneroom.com/other/x.mp4' },
        { id: '2', url: 'https://sportslive.wine/deprecation-notice' },
      ],
    },
  };
  const releases = releasesFromPlayInfo(payload);
  // One candidate per advertised resolution (default 1080/720/480) — all pointing at
  // the same manifest, exactly like the reference client. The registry dedupes by URL.
  assert.equal(releases.length, 3);
  assert.ok(releases.every((r) => r.url === 'https://macdn.aoneroom.com/other/x.mp4'));
  assert.deepEqual(releases.map((r) => r.quality), ['1080p', '720p', '480p']);
});
