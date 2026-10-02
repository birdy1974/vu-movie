import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../src/scrapers/http.js';

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
