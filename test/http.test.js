import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, shouldProxy } from '../src/scrapers/http.js';
import { errorText, getRecentLogs } from '../src/core/log.js';

test('request supports the json alias, JSON request bodies, and parsed data aliases', async (t) => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ ok: true, items: [1, 2] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await request('https://example.test/api/search', {
    method: 'POST',
    headers: { 'X-Test': '1' },
    body: { keyword: 'Blade Runner' },
    json: true,
    allowFailure: true,
    retries: 0,
  });

  assert.equal(captured.options.body, JSON.stringify({ keyword: 'Blade Runner' }));
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  assert.equal(captured.options.headers.Accept, 'application/json');
  assert.deepEqual(result.data, { ok: true, items: [1, 2] });
  assert.deepEqual(result.json, result.data);
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
});

test('request supports the binary alias and returns a Buffer', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await request('https://example.test/movie', { binary: true, retries: 0 });
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.deepEqual([...result.buffer], [1, 2, 3]);
});

test('request aborts promptly without retrying an obsolete request', async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, { signal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const controller = new AbortController();
  const pending = request('https://example.test/slow', { signal: controller.signal, retries: 3, timeoutMs: 5000 });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(calls, 1, 'an aborted request must not consume retries');
});

test('network error formatting expands AggregateError socket causes', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 203.0.113.7:443'), { code: 'ECONNREFUSED' });
  const dns = Object.assign(new Error('getaddrinfo ENOTFOUND api.example.test'), { code: 'ENOTFOUND' });
  const error = new TypeError('fetch failed', { cause: new AggregateError([refused, dns], 'all connection attempts failed') });
  const message = errorText(error);
  assert.match(message, /ECONNREFUSED/);
  assert.match(message, /ENOTFOUND/);
  assert.match(message, /all connection attempts failed/);
});

test('request failure logs include the nested network cause', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  globalThis.fetch = async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 203.0.113.7:443'), { code: 'ECONNREFUSED' });
    throw new TypeError('fetch failed', { cause });
  };
  console.error = () => {};
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  });

  await assert.rejects(request('https://api6.aoneroom.com/search', { retries: 0 }), /fetch failed/);
  const entries = getRecentLogs({ component: 'http', search: 'ECONNREFUSED', limit: 10 });
  assert.ok(entries.some((entry) => entry.fields?.error?.includes('ECONNREFUSED')));
});

test('a configured proxy carries outbound hosts but never internal service names', () => {
  // Regression: setting MOVIEBOX_PROXY/HTTP_PROXY (recommended for the
  // MovieBox TLS block) used to send the container-to-container FlareSolverr
  // call through the external proxy too, where `flaresolverr` cannot resolve.
  const saved = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY, MOVIEBOX_PROXY: process.env.MOVIEBOX_PROXY };
  process.env.HTTP_PROXY = 'http://proxy.example:3128';
  delete process.env.NO_PROXY;
  delete process.env.MOVIEBOX_PROXY;
  try {
    assert.equal(shouldProxy('https://api6.aoneroom.com/wefeed-mobile-bff/user-api/visitor-login'), true);
    assert.equal(shouldProxy('https://cinevo.nl/search?q=dune'), true);
    assert.equal(shouldProxy('http://flaresolverr:8192/v1'), false, 'compose service names must bypass the proxy');
    assert.equal(shouldProxy('http://db:5432'), false);
    assert.equal(shouldProxy('http://127.0.0.1:8080/api/health'), false);
    assert.equal(shouldProxy('not a url'), false, 'an unparseable target is never proxied');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  // With no proxy configured nothing is proxied at all.
  delete process.env.HTTP_PROXY;
  assert.equal(shouldProxy('https://api6.aoneroom.com/x'), false);
});

test('a request that runs out of its own time is a TimeoutError, not a caller abort', async (t) => {
  // `request()` aborts its internal controller to enforce `timeoutMs`, and fetch
  // surfaces that as an AbortError. Callers used to read that as "the client
  // cancelled" (`err.name === 'AbortError'`) and rethrow — which is how a slow
  // FlareSolverr turned into "cinevo: search failed — browser request aborted".
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, { signal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), { once: true });
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    request('https://solver.test/v1', { timeoutMs: 40, retries: 0 }),
    (error) => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.timedOut, true);
      assert.equal(error.code, 'ETIMEDOUT');
      assert.match(error.message, /solver\.test timed out after 40ms/);
      return true;
    },
  );
  assert.equal(calls, 1);

  // A timeout still consumes retries (it is a failure, not a cancellation).
  await assert.rejects(request('https://solver.test/v1', { timeoutMs: 40, retries: 1 }), (error) => error.timedOut === true);
  assert.equal(calls, 3);
});
