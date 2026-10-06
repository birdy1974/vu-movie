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

test('a playlist item can be switched between soft, burn, push and no subtitles', async (t) => {
  const receiverDir = path.join(tempDir, 'receiver-movie');
  fs.mkdirSync(receiverDir, { recursive: true });
  // FTP off + a "mount" that exists = the copy path uploadSubtitleToReceiver
  // uses on a NAS that mounts the Duo2's media directory.
  config.saveConfig({
    subtitles: { autoSearch: false, receiverDir },
    enigma2: { autoPush: false, ftpEnabled: false },
  });

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

test('“copy to the box” stores the choice, touches no profile and needs no transcoding', async (t) => {
  const receiverDir = path.join(tempDir, 'receiver-push');
  fs.mkdirSync(receiverDir, { recursive: true });
  config.saveConfig({
    subtitles: { autoSearch: false, receiverDir },
    enigma2: { autoPush: false, ftpEnabled: false },
  });

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/playlist', (await import('../src/playlist/api.js')).default);
  const server = http.createServer(app);
  const base = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
  });

  const stream = await store.createStream({
    title: 'Push Mode', year: 2026, kind: 'movie',
    candidate: { url: 'https://cdn.example.test/x.mp4', kind: 'file', headers: {} },
    profile: { container: 'mpegts', subtitles: 'burn' },
  });
  await playlist.addItems([stream.id]);
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nHallo\n';
  await playlist.attachSubtitle(stream.id, { srt, language: 'nl' });

  const res = await requestJson(base, `/playlist/items/${stream.id}`, { method: 'PATCH', body: { subtitleMode: 'push' } });
  assert.equal(res.response.status, 200);
  assert.equal(res.json.item.subtitleMode, 'push');
  assert.equal(res.json.item.pushedSubtitle.via, 'mount');
  // The file landed on the "receiver", named after the movie (that is what
  // Enigma2/EMC match a recording against).
  const copied = fs.readdirSync(receiverDir);
  assert.deepEqual(copied, ['Push-Mode-2026.nld.srt']);
  assert.equal(fs.readFileSync(path.join(receiverDir, copied[0]), 'utf8'), srt);
  // Nothing is muxed for this mode — burn-in had to be switched off.
  assert.equal((await store.getStream(stream.id)).profile.subtitles, 'none');
});

test('“copy to the box” reports a missing receiver instead of pretending', async (t) => {
  config.saveConfig({
    subtitles: { autoSearch: false, receiverDir: path.join(tempDir, 'not-mounted') },
    enigma2: { autoPush: false, ftpEnabled: false },
  });
  const stream = await store.createStream({
    title: 'No Receiver', kind: 'movie',
    candidate: { url: 'https://cdn.example.test/y.mp4', kind: 'file', headers: {} },
    profile: { container: 'mpegts' },
  });
  await playlist.addItems([stream.id]);
  await playlist.attachSubtitle(stream.id, { srt: '1\n00:00:01,000 --> 00:00:02,000\nx\n', language: 'nl' });

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/playlist', (await import('../src/playlist/api.js')).default);
  const server = http.createServer(app);
  const base = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
  });

  const res = await requestJson(base, `/playlist/items/${stream.id}`, { method: 'PATCH', body: { subtitleMode: 'push' } });
  assert.equal(res.response.status, 502);
  assert.match(res.json.error, /enable Enigma2 FTP or mount the receiver directory/);
});
