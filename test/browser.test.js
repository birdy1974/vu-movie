import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isNetworkNavigationError, isSameSiteNavigation, flaresolverrEndpoint, parseFlareSolverrResult, looksLikeMedia,
  describeFlareSolverrError, sanitizeSolverUrl, flaresolverrConfigIssue, describeSolverNotUsable,
  DEFAULT_FLARESOLVERR_URL,
} from '../src/scrapers/browser.js';

test('browser navigation reachability errors are recognized as terminal', () => {
  assert.equal(isNetworkNavigationError('page.goto: net::ERR_CONNECTION_REFUSED at https://overlook.cx/movies/123'), true);
  assert.equal(isNetworkNavigationError('net::ERR_NAME_NOT_RESOLVED'), true);
  assert.equal(isNetworkNavigationError('net::ERR_CONNECTION_TIMED_OUT'), true);
});

test('ordinary page and Playwright timeouts are not classified as connection errors', () => {
  assert.equal(isNetworkNavigationError('Timeout 30000ms exceeded.'), false);
  assert.equal(isNetworkNavigationError('HTTP 403: Forbidden'), false);
});

test('media detection ignores fonts with generic binary MIME types', () => {
  assert.equal(looksLikeMedia('https://cdn.example/fa-solid-900.woff2', 'application/octet-stream', 'font'), false);
  assert.equal(looksLikeMedia('https://cdn.example/fa-solid-900.woff2', 'application/octet-stream'), false);
  assert.equal(looksLikeMedia('https://cdn.example/no-extension', 'application/octet-stream', 'fetch'), false);
  assert.equal(looksLikeMedia('https://cdn.example/no-extension', 'application/octet-stream', 'media'), true);
  assert.equal(looksLikeMedia('https://cdn.example/stream/master.m3u8', 'application/octet-stream', 'fetch'), true);
  assert.equal(looksLikeMedia('https://cdn.example/font', 'video/mp4', 'font'), false);
});

test('search navigation stays on the source site but permits www and subdomains', () => {
  assert.equal(isSameSiteNavigation('https://www.cinevo.nl/search?q=dune', 'https://cinevo.nl/'), true);
  assert.equal(isSameSiteNavigation('https://cdn.cinevo.nl/assets/app.js', 'https://cinevo.nl/'), true);
  assert.equal(isSameSiteNavigation('https://www.youtube.com/watch?v=123', 'https://www.1flex.org/'), false);
  assert.equal(isSameSiteNavigation('javascript:alert(1)', 'https://cinevo.nl/'), false);
});

test('FlareSolverr endpoint and solved page responses are validated', () => {
  assert.equal(flaresolverrEndpoint('http://flaresolverr:8192'), 'http://flaresolverr:8192/v1');
  assert.equal(flaresolverrEndpoint('http://solver:9000/api/v1/'), 'http://solver:9000/api/v1');
  assert.equal(flaresolverrEndpoint('file:///tmp/solver'), null);

  const result = parseFlareSolverrResult({
    status: 'ok',
    solution: {
      url: 'https://cinevo.nl/search?q=dune', status: 200,
      response: '<html><title>Dune</title></html>', cookies: [{ name: 'cf_clearance', value: 'ok' }],
    },
  }, 'https://cinevo.nl/search?q=dune');
  assert.equal(result.status, 200);
  assert.equal(result.url, 'https://cinevo.nl/search?q=dune');
  assert.equal(result.html, '<html><title>Dune</title></html>');
  assert.equal(result.cookies.length, 1);
  assert.throws(() => parseFlareSolverrResult({
    status: 'ok', solution: { url: 'https://youtube.com/', response: '<html></html>' },
  }, 'https://cinevo.nl/search?q=dune'), /redirected the search off-site/i);
  assert.throws(() => parseFlareSolverrResult({ status: 'error', message: 'blocked' }, 'https://cinevo.nl/'), /blocked/);
});

test('FlareSolverr failures are translated into a cause plus a fix', () => {
  // The crash loop from `docker compose logs flaresolverr`: FlareSolverr tests
  // its own Chromium on boot and exits when the test fails, so every request
  // afterwards fails. Naming the fix (shm_size / memory) is the whole point.
  const bootFailure = describeFlareSolverrError(
    'Error getting browser User-Agent. HTTPConnectionPool(host=\'localhost\', port=43339): Read timed out. (read timeout=120)',
    { endpoint: 'http://flaresolverr:8192/v1' },
  );
  assert.match(bootFailure, /Chromium did not start/);
  assert.match(bootFailure, /crash-looping/);
  assert.match(bootFailure, /shm_size: 512m/);
  assert.match(bootFailure, /flaresolverr:8192/);

  assert.match(describeFlareSolverrError('Message: session not created: cannot connect to chrome at 127.0.0.1:39814'), /Chromium did not start/);
  assert.match(describeFlareSolverrError('Message: Can not connect to the Service /app/chromedriver'), /Chromium did not start/);

  // A solver that is up but slow is a different problem with a different fix.
  const timeout = describeFlareSolverrError('Error solving the challenge. Timeout after 30.0 seconds.');
  assert.match(timeout, /timed out solving the challenge/);
  assert.doesNotMatch(timeout, /crash-looping/);

  // Transport vs HTTP: "is the container up" vs "is the URL right".
  assert.match(describeFlareSolverrError('connect ECONNREFUSED 172.20.0.4:8192'), /not reachable/);
  assert.match(describeFlareSolverrError('HTTP 500'), /HTTP 500/);
  assert.match(describeFlareSolverrError('HTTP 500'), /logs flaresolverr/);
  assert.match(describeFlareSolverrError('HTTP 404'), /FLARESOLVERR_URL/);

  // FlareSolverr's own message field is used when present, and an empty
  // failure still produces a sentence rather than `undefined`.
  assert.match(describeFlareSolverrError({ message: 'Error: Sorry, FlareSolverr has crashed' }), /FlareSolverr failed/);
  assert.match(describeFlareSolverrError(null), /without returning a reason/);
});

test('a FlareSolverr URL copied from .env with its inline comment still works', () => {
  // docker compose only strips an inline `# …` in some versions, so a verbatim
  // copy of .env.example can deliver the comment as part of the value. That
  // used to throw inside `new URL()` — and a thrown parse was reported as
  // "FlareSolverr is not configured" even though the operator *had* set it.
  assert.equal(
    flaresolverrEndpoint('http://flaresolverr:8192   # container-to-container address, not the host port'),
    'http://flaresolverr:8192/v1',
  );
  assert.equal(flaresolverrEndpoint('http://flaresolverr:8192 # comment'), 'http://flaresolverr:8192/v1');
  assert.equal(sanitizeSolverUrl('  "http://flaresolverr:8192"  '), 'http://flaresolverr:8192');
  assert.equal(flaresolverrEndpoint(''), null);
  assert.equal(flaresolverrEndpoint(null), null);
  assert.equal(flaresolverrEndpoint('file:///tmp/solver'), null);
  assert.equal(flaresolverrEndpoint('flaresolverr:8192'), null, 'a bare host:port is not a URL');
});

test('"not configured" and "set but unusable" are reported as different problems', () => {
  assert.equal(flaresolverrConfigIssue('  ').kind, 'empty');
  assert.equal(flaresolverrConfigIssue(null).kind, 'empty');
  const unusable = flaresolverrConfigIssue('not a url');
  assert.equal(unusable.kind, 'unusable');
  assert.match(unusable.message, /not a usable URL/);
  assert.match(unusable.message, /\.env/);
  assert.equal(flaresolverrConfigIssue('http://flaresolverr:8192'), null);
  assert.equal(flaresolverrConfigIssue('http://flaresolverr:8192   # comment'), null);
});

test('the operator message names which of the three situations this is', () => {
  // 1. the container is up but the variable is empty.
  const runningButUnset = describeSolverNotUsable({ configured: false, defaultReachable: true, defaultUrl: DEFAULT_FLARESOLVERR_URL }, 'cinevo.nl');
  assert.match(runningButUnset, /cinevo\.nl is showing a Cloudflare \/ bot challenge/);
  assert.match(runningButUnset, /already answering at http:\/\/flaresolverr:8192/);
  assert.match(runningButUnset, /FLARESOLVERR_URL=http:\/\/flaresolverr:8192/);
  // 2. the value is broken. (An inline .env comment no longer lands here —
  //    `sanitizeSolverUrl` strips it, which is the fix above.)
  const broken = describeSolverNotUsable({ configured: false, issue: flaresolverrConfigIssue('not a url') }, 'cinevo.nl');
  assert.match(broken, /not a usable URL/);
  // 3. nothing is running at all.
  const absent = describeSolverNotUsable({ configured: false, defaultReachable: false, issue: flaresolverrConfigIssue('') }, 'cinevo.nl');
  assert.match(absent, /start the flaresolverr service/);
  assert.doesNotMatch(absent, /already answering/);
  assert.equal(DEFAULT_FLARESOLVERR_URL, 'http://flaresolverr:8192');
});
