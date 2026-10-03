import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../src/scrapers/http.js';
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
