/** The playlist web player: page, data, token reach, and W×H resolutions. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-player-test-'));
process.env.CONFIG_FILE = path.join(dir, 'vumovie.json');
process.env.LOG_LEVEL = 'error';

const store = await import('../src/streams/store.js');
const playlist = await import('../src/playlist/index.js');
const { formatResolution } = await import('../src/core/media.js');
const { createApp } = await import('../src/http/server.js');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('formatResolution shows both dimensions, falling back to the vertical shorthand', () => {
  assert.equal(formatResolution({ width: 1920, height: 1080 }), '1920×1080');
  assert.equal(formatResolution({ width: 1920, height: 800 }), '1920×800', 'a cropped scope frame must not read as full 1080p');
  assert.equal(formatResolution({ probe: { video: { width: 1280, height: 720 } } }), '1280×720');
  assert.equal(formatResolution({ height: 1080, quality: '1080p' }), '1080p', 'height only is still better than nothing');
  assert.equal(formatResolution({ quality: '720p' }), '720p');
  assert.equal(formatResolution({ resolution: '3840×2160' }), '3840×2160');
  assert.equal(formatResolution({}), null);
  assert.equal(formatResolution(null), null);
});

test('a saved stream keeps both dimensions next to its quality', async () => {
  const stream = await store.createStream({
    title: 'Dims probe only', kind: 'movie',
    candidate: {
      url: 'https://cdn.example/dims.mkv', sourceId: 'player-test', quality: '1080p',
      probe: { video: { codec: 'h264', width: 1440, height: 1080 }, durationSec: 3600 },
    },
  });
  const listed = (await store.listStreams()).find((entry) => entry.id === stream.id);
  assert.equal(listed.quality, '1080p', 'the canonical key stays vertical for grouping/sorting');
  assert.equal(listed.width, 1440);
  assert.equal(listed.height, 1080);
  assert.equal(listed.resolution, '1440×1080', 'dimensions from the probe become the display form');
  assert.equal(store.resolutionFor(await store.getStream(stream.id)), '1440×1080');
});

test('the web player serves the enabled playlist via the token link and the admin entry', async (t) => {
  const scope = await store.createStream({
    title: 'Scope Film', year: 2024, kind: 'movie', poster: 'https://img.example/scope.jpg',
    candidate: {
      url: 'https://cdn.example/scope.mkv', sourceId: 'player-test', quality: '1080p', width: 1920, height: 800,
      probe: { video: { codec: 'h264', width: 1920, height: 800 }, audio: [{ codec: 'aac' }], durationSec: 7200 },
    },
  });
  const hidden = await store.createStream({
    title: 'Hidden Film', kind: 'movie',
    candidate: { url: 'https://cdn.example/hidden.mkv', sourceId: 'player-test', quality: '720p' },
  });
  const episode = await store.createStream({
    title: 'The Expanse', kind: 'series', season: 1, episode: 2,
    candidate: {
      url: 'https://cdn.example/expanse.mkv', sourceId: 'player-test', quality: '720p',
      probe: { video: { codec: 'hevc', width: 1280, height: 720 }, durationSec: 2600 },
    },
  });
  await playlist.saveItems([
    { streamId: episode.id, enabled: true },
    { streamId: hidden.id, enabled: false },
    { streamId: scope.id, enabled: true },
  ]);

  const server = await listen(createApp());
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = playlist.token();
  assert.ok(token, 'the playlist has a token once it has items');

  // The token-guarded page and its data.
  const page = await fetch(`${base}/pl/${token}/player`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('/player.js') && html.includes('web player'), 'the shell loads the player script');
  assert.ok(html.includes('/vendor/mpegts.js') && html.includes('/web-codecs.js'), 'and the existing playback stack');

  const wrong = await fetch(`${base}/pl/not-the-token/player`);
  assert.equal(wrong.status, 404, 'a wrong token gets nothing');
  const wrongData = await fetch(`${base}/pl/not-the-token/player.json`);
  assert.equal(wrongData.status, 404);

  const dataResponse = await fetch(`${base}/pl/${token}/player.json`);
  assert.equal(dataResponse.status, 200);
  const data = await dataResponse.json();
  const titles = data.items.map((item) => item.title);
  assert.ok(!titles.includes('Hidden Film'), 'disabled items stay out of the player');
  assert.ok(titles.indexOf('The Expanse') < titles.indexOf('Scope Film'), 'playlist order is preserved');
  const ep = data.items.find((item) => item.title === 'The Expanse');
  const film = data.items.find((item) => item.title === 'Scope Film');
  assert.equal(film.resolution, '1920×800');
  assert.equal(film.quality, '1080p');
  assert.equal(film.videoCodec, 'h264');
  assert.equal(film.durationSec, 7200);
  assert.ok(film.poster.startsWith('/api/poster?'), 'posters ride the signed proxy, never a raw hotlink');
  assert.ok(film.urls.web.endsWith('.ts.web'), 'the browser slot is the play URL');
  assert.ok(film.urls.ts.includes('.ts'), 'the VLC link rides along for subtitles');
  assert.equal(ep.season, 1);
  assert.equal(ep.episode, 2);
  assert.equal(ep.resolution, '1280×720');

  // The playlist API carries the same data plus the player URL (admin mode).
  const apiData = await (await fetch(`${base}/api/playlist`)).json();
  assert.equal(apiData.urls.player, `${base}/pl/${token}/player`);
  const apiFilm = apiData.items.find((item) => item.streamId === scope.id);
  assert.equal(apiFilm.resolution, '1920×800');
  assert.equal(apiFilm.width, 1920);

  // The admin entry is the same shell via the static file.
  const adminPage = await fetch(`${base}/player`);
  assert.equal(adminPage.status, 200);
  assert.ok((await adminPage.text()).includes('/player.js'));

  // The public landing page points at the player and shows full resolutions.
  const landing = await (await fetch(`${base}/pl/${token}/`)).text();
  assert.ok(landing.includes(`${base}/pl/${token}/player`), 'the player is the first link on the page');
  assert.ok(landing.includes('1920×800') && landing.includes('Resolution'));

  // The token link must work when the app login is on: the page itself is
  // token-guarded, its plain script assets must not 401 either, while the
  // admin API still demands the login.
  const save = await fetch(`${base}/api/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: { username: 'birdy', password: 's3cret' } }),
  });
  assert.equal(save.status, 200);
  try {
    assert.equal((await fetch(`${base}/pl/${token}/player`)).status, 200, 'token page needs no login');
    assert.equal((await fetch(`${base}/pl/${token}/player.json`)).status, 200);
    assert.equal((await fetch(`${base}/player.js`)).status, 200, 'the player script is plain client code');
    assert.equal((await fetch(`${base}/web-codecs.js`)).status, 200);
    assert.equal((await fetch(`${base}/api/playlist`)).status, 401, 'the admin API stays behind the login');
    const login = `Basic ${Buffer.from('birdy:s3cret').toString('base64')}`;
    assert.equal((await fetch(`${base}/api/playlist`, { headers: { authorization: login } })).status, 200);
  } finally {
    const login = `Basic ${Buffer.from('birdy:s3cret').toString('base64')}`;
    await fetch(`${base}/api/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', authorization: login },
      body: JSON.stringify({ app: { username: '', password: '' } }),
    });
  }
});
