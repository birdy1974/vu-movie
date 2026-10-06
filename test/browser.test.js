import { test } from 'node:test';
import assert from 'node:assert/strict';
import browser, {
  isNetworkNavigationError, isSameSiteNavigation, flaresolverrEndpoint, parseFlareSolverrResult, looksLikeMedia,
  describeFlareSolverrError, sanitizeSolverUrl, flaresolverrConfigIssue, describeSolverNotUsable,
  DEFAULT_FLARESOLVERR_URL, looksLikeResultLink, planSearchRetry, shouldRetryFlareSolverrFailure,
  normalizeSearchRows, waitForResultLinks,
} from '../src/scrapers/browser.js';

test('browser facade exposes the FlareSolverr status helper used at startup', () => {
  assert.equal(typeof browser.flaresolverrStatus, 'function');
});

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

test('a value that is a copied comment is reported as such, not as "not set"', () => {
  // The real file had `"flaresolverrUrl": "# e.g. http://flaresolverr:8191 (profile: cf)"`
  // while the sidecar answered at the compose default. The operator must be told
  // to fix the value — "FLARESOLVERR_URL is not set" sent them to .env instead.
  const issue = flaresolverrConfigIssue('# e.g. http://flaresolverr:8191 (profile: cf)');
  assert.equal(issue.kind, 'unusable');
  assert.match(issue.message, /is a comment, not a URL/);
  assert.match(issue.message, /"scraper": \{ "flaresolverrUrl": "http:\/\/flaresolverr:8192" \}/);
  assert.match(issue.message, /flat "scraper\.flaresolverrUrl" key is ignored/);

  const hint = describeSolverNotUsable(
    {
      configured: false,
      defaultReachable: true,
      defaultUrl: DEFAULT_FLARESOLVERR_URL,
      issue: flaresolverrConfigIssue('# e.g. http://flaresolverr:8191 (profile: cf)'),
    },
    'cinevo.nl',
  );
  assert.match(hint, /is a comment, not a URL/);
  assert.match(hint, /already answering at http:\/\/flaresolverr:8192/);
});

test('the boot line reports the broken value even when a solver answers at the default', () => {
  // Branch order regression: `defaultReachable` used to be checked before
  // `issue.kind === 'unusable'`, which hid the actionable message.
  const broken = browser.describeSolverBootState({
    configured: false,
    defaultReachable: true,
    defaultUrl: DEFAULT_FLARESOLVERR_URL,
    issue: flaresolverrConfigIssue('# e.g. http://flaresolverr:8191 (profile: cf)'),
  });
  assert.equal(broken.level, 'warn');
  assert.match(broken.message, /misconfigured/);
  assert.match(broken.message, /is a comment, not a URL/);
  assert.equal(broken.fields.answeringAt, DEFAULT_FLARESOLVERR_URL);

  // The other three states keep their own wording.
  const ready = browser.describeSolverBootState({ configured: true, ok: true, url: 'http://flaresolverr:8192', version: '3.3.21' });
  assert.equal(ready.level, 'info');
  assert.match(ready.message, /ready at http:\/\/flaresolverr:8192/);

  const down = browser.describeSolverBootState({ configured: true, ok: false, url: 'http://solver:9000', error: 'ECONNREFUSED' });
  assert.equal(down.level, 'warn');
  assert.match(down.message, /configured at http:\/\/solver:9000 but not answering/);

  const reachableButUnset = browser.describeSolverBootState({ configured: false, defaultReachable: true, defaultUrl: DEFAULT_FLARESOLVERR_URL, issue: flaresolverrConfigIssue('') });
  assert.equal(reachableButUnset.level, 'warn');
  assert.match(reachableButUnset.message, /is not set/);

  const absent = browser.describeSolverBootState({ configured: false, defaultReachable: false, issue: flaresolverrConfigIssue('') });
  assert.equal(absent.level, 'info');
  assert.match(absent.message, /not configured/);
});

test('flaresolverrStatus() reports the default address it found', async () => {
  // No FLARESOLVERR_URL is configured in the test process, so nothing is
  // configured — but a solver that answers at the compose default must be
  // reported *with its address*, which is what makes the boot line actionable.
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ status: 'ok', version: '3.3.21' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const status = await browser.flaresolverrStatus({ probe: true, maxAgeMs: 0 });
    assert.equal(status.configured, false);
    assert.equal(status.defaultReachable, true);
    assert.equal(status.defaultUrl, DEFAULT_FLARESOLVERR_URL);
    assert.equal(status.version, '3.3.21');
    assert.deepEqual(seen, [`${DEFAULT_FLARESOLVERR_URL}/health`]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('result-shaped links are recognized from a recipe pattern or the generic detail routes', () => {
  const base = 'https://flixhub.studio/search?q=dune';
  // The recipe pattern is tested against the raw (usually relative) href…
  assert.equal(looksLikeResultLink('/watch.html?type=movie&id=1377237', { pattern: 'watch\\.html\\?type=', baseUrl: base }), true);
  assert.equal(looksLikeResultLink('/play?id=5687&type=tv', { pattern: '/play\\?id=', baseUrl: base }), true);
  assert.equal(looksLikeResultLink('/movie/936108-smurfs-2025', { pattern: '/(movie|tv|series|watch)/', baseUrl: base }), true);
  // …and without a pattern the generic detail-route detection is the fallback.
  assert.equal(looksLikeResultLink('/tv/238955', { baseUrl: base }), true);
  assert.equal(looksLikeResultLink('/browse', { baseUrl: base }), false);
  assert.equal(looksLikeResultLink('/login', { baseUrl: base }), false);
  // Navigator chrome, other sites and non-http schemes are never results.
  assert.equal(looksLikeResultLink('#', { baseUrl: base }), false);
  assert.equal(looksLikeResultLink('javascript:void(0)', { baseUrl: base }), false);
  assert.equal(looksLikeResultLink('https://www.youtube.com/watch?v=123', { baseUrl: base }), false);
  assert.equal(looksLikeResultLink('', { baseUrl: base }), false);
});

test('a search is only retried in a fresh tab when the page was taken over', () => {
  // Results found → never retry.
  assert.equal(planSearchRetry({ attempt: 1, usableResults: 3, blockedOffsiteNavigation: 'https://youtube.com/watch?v=1' }).retry, false);
  // 1flex's pop-under: the tab was redirected to youtube.com.
  const hijacked = planSearchRetry({
    attempt: 1,
    usableResults: 0,
    blockedOffsiteNavigation: 'https://www.youtube.com/watch?v=jy4qYmf3TxA',
    finalUrl: 'https://www.1flex.org/search?q=smurfs',
    searchUrl: 'https://www.1flex.org/search?q=smurfs',
  });
  assert.equal(hijacked.retry, true);
  assert.match(hijacked.reason, /redirect the tab to www\.youtube\.com/);
  // A blank/replaced tab (renderer died, window.close()) is the other retry case.
  const replaced = planSearchRetry({ attempt: 1, usableResults: 0, finalUrl: 'about:blank', searchUrl: 'https://cinejoy.pk/search/smurfs' });
  assert.equal(replaced.retry, true);
  assert.match(replaced.reason, /tab was replaced/);
  // A page that simply had no results is not worth a second 12 s wait.
  const empty = planSearchRetry({ attempt: 1, usableResults: 0, finalUrl: 'https://cinejoy.pk/search/smurfs', searchUrl: 'https://cinejoy.pk/search/smurfs' });
  assert.equal(empty.retry, false);
  // …and the retry budget is finite.
  assert.equal(planSearchRetry({ attempt: 2, maxAttempts: 2, blockedOffsiteNavigation: 'https://www.youtube.com/x' }).retry, false);
});

test('FlareSolverr failures are retried once only when they are fast transport failures', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 172.20.0.4:8192'), { code: 'ECONNREFUSED' });
  assert.equal(shouldRetryFlareSolverrFailure({ error: refused, elapsedMs: 120, attempt: 1 }), true);
  assert.equal(shouldRetryFlareSolverrFailure({ error: new Error('socket hang up'), elapsedMs: 3000, attempt: 1 }), true);
  assert.equal(shouldRetryFlareSolverrFailure({ error: new Error('HTTP 500'), elapsedMs: 800, attempt: 1 }), true);
  // A slow solver (our own transport timeout) is a CPU problem, not a blip:
  // retrying only doubles the wait for a source that will be skipped anyway.
  const timedOut = Object.assign(new Error('POST flaresolverr timed out after 35000ms'), { timedOut: true });
  assert.equal(shouldRetryFlareSolverrFailure({ error: timedOut, elapsedMs: 35_000, attempt: 1 }), false);
  assert.equal(shouldRetryFlareSolverrFailure({ error: new Error('Error solving the challenge. Timeout after 30.0 seconds.'), elapsedMs: 400 }), false);
  // A transport failure that took 8 s to surface is not a startup blip either.
  assert.equal(shouldRetryFlareSolverrFailure({ error: refused, elapsedMs: 8_000, attempt: 1 }), false);
  // One retry, no more.
  assert.equal(shouldRetryFlareSolverrFailure({ error: refused, elapsedMs: 100, attempt: 2, maxAttempts: 2 }), false);
});

test('a transport timeout is reported as a solver timeout, not as a client abort', () => {
  // requestFlareSolverr() feeds its own timeout through this describer, which is
  // what the log/UI show instead of the bare "failed permanently" line.
  const described = describeFlareSolverrError('timed out after 35000 ms', { endpoint: 'http://flaresolverr:8192/v1' });
  assert.match(described, /timed out solving the challenge/);
  assert.match(described, /flaresolverr:8192/);
  assert.doesNotMatch(described, /not reachable/);
});

test('poster-only result cards keep the title, not the alt text', () => {
  // redflix/1flex render `<a href="/play?id=…"><img alt="Poster for The Smurfs">`,
  // so the only text the collector can see is the alt attribute.
  const results = normalizeSearchRows([
    {
      href: '/play?id=5687&type=tv',
      title: 'Poster for The Smurfs',
      titleRank: 2,
      text: '',
      cardText: '',
      hasImage: true,
      poster: 'https://image.tmdb.org/t/p/w185/cezQyM5cO454vUdLiLOkv78K64D.jpg',
    },
    {
      href: '/play?id=936108&type=movie',
      title: 'Still from Smurfs',
      titleRank: 2,
      text: '',
      cardText: '',
      hasImage: true,
    },
  ], {
    pageUrl: 'https://redflix.club/browse?q=smurfs',
    baseUrl: 'https://redflix.club/',
    query: 'smurfs',
    resultPattern: '/play\\?id=|/(movie|film|tv|series?|watch|title)/',
    siteId: 'redflix',
    siteName: 'Redflix',
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'The Smurfs');
  assert.equal(results[1].title, 'Smurfs');
  assert.equal(results[0].kind, 'series');
  assert.equal(results[0].url, 'https://redflix.club/play?id=5687&type=tv');
});

test('the result wait polls until the cards appear, then stops early', async () => {
  // A client-rendered catalogue: nav links first, results a few hundred ms later.
  const script = [
    ['/', '/movies', '/shows', '/login'],
    ['/', '/movies', '/shows', '/login'],
    ['/', '/movies', '/movie/936108-smurfs-2025', '/series/5687-the-smurfs'],
    ['/', '/movies', '/movie/936108-smurfs-2025', '/series/5687-the-smurfs'],
    ['/', '/movies', '/movie/936108-smurfs-2025', '/series/5687-the-smurfs'],
  ];
  let polls = 0;
  const page = {
    $$eval: async () => script[Math.min(polls++, script.length - 1)],
    url: () => 'https://cinejoy.pk/search/smurfs',
  };
  const started = Date.now();
  const wait = await waitForResultLinks(page, {
    pattern: '/(movie|tv|series|watch)/', timeoutMs: 5000, settleMs: 200, pollMs: 40,
  });
  assert.equal(wait.count, 2, 'both result-shaped links are counted, nav links are not');
  assert.equal(wait.last, 2);
  assert.equal(wait.stable, true, 'the wait stops once the count stops growing');
  assert.ok(Date.now() - started < 5000, 'it must not sit out the whole timeout');
});

test('the result wait reports a page that never renders, and survives a wiped DOM', async () => {
  const never = { $$eval: async () => ['/', '/movies', '/login'], url: () => 'https://redflix.club/browse?q=smurfs' };
  const empty = await waitForResultLinks(never, { pattern: '/play\\?id=', timeoutMs: 250, pollMs: 40 });
  assert.equal(empty.count, 0);
  assert.equal(empty.stable, false, 'nothing rendered: the timeout ended the wait');

  // The pop-under case: the cards appear, then the ad script wipes the body.
  const sequence = [
    ['/play?id=5687&type=tv'], ['/play?id=5687&type=tv'], [], [], [],
  ];
  let polls = 0;
  const wiped = { $$eval: async () => sequence[Math.min(polls++, sequence.length - 1)], url: () => 'https://redflix.club/browse?q=smurfs' };
  const wait = await waitForResultLinks(wiped, { pattern: '/play\\?id=', timeoutMs: 2000, settleMs: 150, pollMs: 40 });
  assert.equal(wait.count, 1, 'the best count seen is kept even after the DOM is destroyed');
  assert.equal(wait.last, 0, 'the final poll saw nothing — which is what the log reports');
});

test('the result wait stops immediately when the caller aborts', async () => {
  const page = { $$eval: async () => [], url: () => 'https://redflix.club/browse?q=smurfs' };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    waitForResultLinks(page, { timeoutMs: 5000, signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
});

test('a Chromium launch failure is one actionable line, not Playwright’s banner', () => {
  const playwrightStyle = new Error([
    "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome",
    '╔════════════════════════════════════════════════════════════╗',
    '║ Looks like Playwright was just installed or updated.       ║',
    '║ Please run the following command to download new browsers: ║',
    '║                                                            ║',
    '║     npx playwright install                                 ║',
    '╚════════════════════════════════════════════════════════════╝',
  ].join('\n'));
  const message = browser.browserLaunchError(playwrightStyle).message;
  assert.match(message, /^Chromium could not be started: browserType\.launch: Executable doesn't exist/);
  assert.match(message, /rebuild the image/);
  assert.doesNotMatch(message, /npx playwright install/);
  assert.ok(!message.includes('\n'), 'the provider-error row must stay on one line');

  // A crash on a loaded NAS has its own hint.
  const crashed = browser.browserLaunchError(new Error('Target page, context or browser has been closed'));
  assert.match(crashed.message, /out of memory/);
});
