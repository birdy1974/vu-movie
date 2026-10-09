/**
 * Xtream apps build every URL from the server address the operator pastes in,
 * and most append the endpoint themselves (OwnTV: `<server>/player_api.php?…`,
 * `<server>/live/<user>/<pass>/<id>.ts`; SFVIP does the same). An address that
 * already ends in `/player_api.php` — exactly what the Stream tab used to hand
 * out — therefore arrives doubled or wedged in front of the path, and the app
 * reports "access denied". The server collapses the repetition, so every
 * spelling of the server address works.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-xtream-address-'));
process.env.CONFIG_FILE = path.join(dir, 'vumovie.json');
process.env.LOG_LEVEL = 'error';

const store = await import('../src/streams/store.js');
const playlist = await import('../src/playlist/index.js');
const { createApp } = await import('../src/http/server.js');

const stream = await store.createStream({
  title: 'Arrival',
  kind: 'movie',
  year: 2026,
  candidate: { url: 'https://cdn.example/Arrival.mkv', kind: 'file', sourceId: 'xtream-address-test' },
});
await playlist.saveItems([{ streamId: stream.id, enabled: true }]);

const server = await new Promise((resolve) => {
  const listener = createApp().listen(0, '127.0.0.1', () => resolve(listener));
});
const base = `http://127.0.0.1:${server.address().port}`;
const token = playlist.token();
const creds = new URLSearchParams({ username: 'vumovie', password: token });

async function json(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('a server address that already ends in /player_api.php still authenticates (the app appended it)', async () => {
  const doubled = await json(`${base}/xtream/${token}/player_api.php/player_api.php?${creds}`);
  assert.equal(doubled.status, 200);
  assert.equal(doubled.body.user_info.auth, 1);

  const vod = await json(`${base}/xtream/${token}/player_api.php/player_api.php?${creds}&action=get_vod_streams`);
  assert.equal(vod.status, 200);
  assert.deepEqual(vod.body.map((item) => item.name), ['Arrival (2026)']);
});

test('a trailing slash after the endpoint is accepted too', async () => {
  const res = await json(`${base}/xtream/${token}/player_api.php/?${creds}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.user_info.auth, 1);
});

test('the playback URL an app builds from that server address plays', async () => {
  const vod = await json(`${base}/xtream/${token}/player_api.php/player_api.php?${creds}&action=get_vod_streams`);
  const id = vod.body[0].stream_id;
  // OwnTV/SFVIP style: <server address>/live|movie/<user>/<pass>/<id>.ts — with the
  // server address ending in player_api.php, the endpoint segment sits in front.
  const playback = await fetch(`${base}/xtream/${token}/player_api.php/movie/vumovie/${token}/${id}.ts`, { redirect: 'manual' });
  assert.equal(playback.status, 302);
  assert.equal(playback.headers.get('location'), `${base}/s/${stream.token}/Arrival-2026.ts`);
});

test('the M3U+ link an app builds from that server address downloads the playlist', async () => {
  const res = await fetch(`${base}/xtream/${token}/player_api.php/get.php?${creds}&type=m3u_plus`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /#EXTM3U/);
  assert.ok(text.includes('Arrival (2026)'), 'the catalogue entry is in the playlist');
  assert.ok(text.includes(`/s/${stream.token}/Arrival-2026.ts`), 'its relay URL is in the playlist');
});

test('a wrong token is still rejected, doubled path or not', async () => {
  const res = await fetch(`${base}/xtream/not-the-token/player_api.php/player_api.php?${creds}`);
  assert.equal(res.status, 404);
});

test('the canonical single-endpoint path keeps working', async () => {
  const res = await json(`${base}/xtream/${token}/player_api.php?${creds}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.user_info.auth, 1);
});

after(() => {
  server.closeAllConnections?.();
  server.close();
});
