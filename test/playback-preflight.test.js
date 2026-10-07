import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-preflight-'));
process.env.CONFIG_FILE = path.join(directory, 'vumovie.json');
process.env.LOG_LEVEL = 'error';

const config = await import('../src/core/config.js');
config.loadConfig();
config.saveConfig({ playlist: { autoRepairEnabled: false } });
const store = await import('../src/streams/store.js');
const playlist = await import('../src/playlist/index.js');
const { createApp } = await import('../src/http/server.js');

test('unavailable streams are rejected before relay or download starts', async () => {
  const stream = await store.createStream({
    title: 'Missing upstream',
    sourceId: 'test',
    candidate: { url: '', sourceId: 'test', kind: 'hls' },
  });
  await playlist.addItems([stream.id]);

  const server = await new Promise((resolve) => {
    const instance = createApp().listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const requests = [
      ['POST', `/api/streams/${stream.id}/session`, {}],
      ['POST', `/api/playlist/items/${stream.id}/session`, {}],
      ['POST', `/api/streams/${stream.id}/download`, {}],
      ['POST', `/api/playlist/items/${stream.id}/download`, {}],
      ['GET', `/s/${stream.token}/missing.ts`, undefined],
      ['GET', `/dl/${stream.token}/missing.ts`, undefined],
    ];

    for (const [method, pathname, body] of requests) {
      const response = await fetch(`${base}${pathname}`, {
        method,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 503, `${method} ${pathname} must fail its preflight`);
      if (method === 'POST') {
        const json = await response.json();
        assert.equal(json.ok, false);
        assert.match(json.error, /unavailable|no upstream URL/i);
      } else {
        assert.match(await response.text(), /unavailable/);
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
