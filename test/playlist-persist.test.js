/**
 * The playlist lives in the config file (/config/vumovie.json on the NAS).
 *
 * That file is not always writable — a read-only volume, a container started
 * without the mount, or a throwaway preview environment. Because the playlist
 * token is created lazily and *written back*, `GET /api/playlist` used to fail
 * with `500 {"error":"EACCES: permission denied, mkdir '/config'"}`, which left
 * the entire Playlist tab empty: no items, no Stream-tab summary and no
 * "▶ preview" button anywhere in the UI.
 *
 * The module reads CONFIG_FILE at import time, so the fixture is set up first;
 * `node --test` runs every file in its own process. The unwritable location is
 * a path whose *parent is a file*: mkdir fails with EEXIST for every uid
 * (a chmod-based fixture would not stop a test run as root).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-playlist-test-'));
const blocker = path.join(dir, 'not-a-directory');
fs.writeFileSync(blocker, 'a file, so nothing can be created below it\n');
process.env.CONFIG_FILE = path.join(blocker, 'vumovie.json');
process.env.LOG_LEVEL = 'warn';

const playlist = await import('../src/playlist/index.js');
const { getRecentLogs } = await import('../src/core/log.js');

test('the playlist token is created once and stays valid without a writable config', () => {
  const first = playlist.token();
  assert.match(first, /^[A-Za-z0-9_-]{10,}$/, 'a real (unguessable) token is returned');
  assert.equal(playlist.token(), first, 'the in-memory token is reused instead of regenerating per request');
  assert.equal(playlist.tokenMatches(first), true, 'the /pl/<token>/... outputs accept the in-memory token');
  assert.equal(playlist.tokenMatches('not-the-token'), false);
  assert.equal(playlist.tokenMatches(''), false);
});

test('playlist writes apply in memory and never throw', async () => {
  const items = await playlist.saveItems([{ streamId: 'abc123', enabled: false, templateId: 'tpl-a' }]);
  assert.equal(items.length, 1);
  assert.deepEqual(
    { streamId: items[0].streamId, enabled: items[0].enabled, templateId: items[0].templateId },
    { streamId: 'abc123', enabled: false, templateId: 'tpl-a' },
  );
  // The running config was updated even though the file was not …
  assert.equal(playlist.name().length > 0, true);
  // … and the UI is told, so it can say that the change is memory-only.
  assert.equal(playlist.configWritableNow(), false);
  assert.ok(
    getRecentLogs({ limit: 100 }).some((line) => /not writable/.test(line.message || '')),
    'the operator is warned once that the config file is not writable',
  );
});

test('GET /api/playlist answers 200 (not 500) when the config file cannot be written', async () => {
  const { createApp } = await import('../src/http/server.js');
  const app = createApp();
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/playlist`;
    const res = await fetch(url);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.storage.writable, false, 'the response tells the UI that nothing is persisted');
    assert.ok(body.urls.m3u.includes('/pl/'), 'the public output URLs are built from the in-memory token');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
