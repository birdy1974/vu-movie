/**
 * The Playlist tab's per-item subtitle mode (none | soft | burn).
 *
 * "soft" is a selectable track inside the Matroska output; "burn" hardcodes the
 * text into the picture and is the only mode an exteplayer3-based receiver
 * (ServiceApp service id 5002) shows reliably, because it has no subtitle menu
 * entry for embedded tracks it cannot enumerate. The mode lives in the stream's
 * profile (profile.subtitles), not in the playlist items file, so this test
 * covers the whole path: PATCH /api/playlist/items/:id → store → public item.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-subtitle-mode-'));
process.env.CONFIG_FILE = path.join(tempDir, 'vumovie.json');
process.env.TMP_DIR = path.join(tempDir, 'tmp');

const config = await import('../src/core/config.js');
const { default: api } = await import('../src/http/api.js');
const { default: playlistApi } = await import('../src/playlist/api.js');
const { default: store } = await import('../src/streams/store.js');
const playlist = await import('../src/playlist/index.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

async function requestJson(base, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, json: await response.json() };
}

test('a playlist item can be switched between soft, burn and no subtitles', async (t) => {
  config.saveConfig({ subtitles: { autoSearch: false }, enigma2: { autoPush: false } });

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', api);
  // The playlist router is mounted by server.js, not by the api router.
  app.use('/api/playlist', playlistApi);
  const server = http.createServer(app);
  const base = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const stream = await store.createStream({
    title: 'Subtitle mode', kind: 'movie',
    candidate: { url: 'https://cdn.example.test/movie.mp4', kind: 'file', headers: {} },
    profile: { container: 'matroska' },
  });
  await playlist.addItems([stream.id]);

  const list = await requestJson(base, '/playlist');
  const item = list.json.items.find((entry) => entry.streamId === stream.id);
  assert.equal(item.subtitleMode, 'soft', 'new profiles default to a soft track (nothing is muxed without an attached .srt)');

  const burned = await requestJson(base, `/playlist/items/${stream.id}`, { method: 'PATCH', body: { subtitleMode: 'burn' } });
  assert.equal(burned.response.status, 200);
  assert.equal(burned.json.item.subtitleMode, 'burn');
  assert.equal((await store.getStream(stream.id)).profile.subtitles, 'burn', 'the stream profile carries what ffmpeg reads');

  const soft = await requestJson(base, `/playlist/items/${stream.id}`, { method: 'PATCH', body: { subtitleMode: 'soft' } });
  assert.equal(soft.json.item.subtitleMode, 'soft');

  const off = await requestJson(base, `/playlist/items/${stream.id}`, { method: 'PATCH', body: { subtitleMode: 'none' } });
  assert.equal(off.json.item.subtitleMode, 'none');

  const bogus = await requestJson(base, `/playlist/items/${stream.id}`, { method: 'PATCH', body: { subtitleMode: 'always' } });
  assert.equal(bogus.response.status, 422);
  assert.match(bogus.json.error, /subtitle mode/);
  assert.equal((await store.getStream(stream.id)).profile.subtitles, 'none', 'a rejected patch changes nothing');
});
