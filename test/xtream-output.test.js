/** Xtream publishes the enabled playlist in order and every catalogue URL plays. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-xtream-test-'));
process.env.CONFIG_FILE = path.join(dir, 'vumovie.json');
process.env.LOG_LEVEL = 'error';

const store = await import('../src/streams/store.js');
const playlist = await import('../src/playlist/index.js');
const { createApp } = await import('../src/http/server.js');

async function makeStream({ title, kind = 'movie', season = null, episode = null }) {
  return store.createStream({
    title,
    kind,
    season,
    episode,
    year: kind === 'movie' ? 2026 : null,
    candidate: { url: `https://cdn.example/${encodeURIComponent(title)}.mkv`, sourceId: 'xtream-test' },
  });
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('Xtream exposes the full enabled playlist, series, and usable playback paths', async (t) => {
  const first = await makeStream({ title: 'Arrival' });
  const disabled = await makeStream({ title: 'Hidden entry' });
  const second = await makeStream({ title: 'Dune: Part Two' });
  const ep2 = await makeStream({ title: 'The Expanse S01E02', kind: 'series', season: 1, episode: 2 });
  const ep1 = await makeStream({ title: 'The Expanse S01E01', kind: 'series', season: 1, episode: 1 });
  await playlist.saveItems([
    { streamId: second.id, enabled: true },
    { streamId: disabled.id, enabled: false },
    { streamId: first.id, enabled: true },
    { streamId: ep2.id, enabled: true },
    { streamId: ep1.id, enabled: true },
  ]);

  const server = await listen(createApp());
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = playlist.token();
  const api = `${base}/xtream/${token}/player_api.php`;
  const query = (params) => new URLSearchParams({ username: 'vumovie', password: token, ...params });

  const apiInfoResponse = await fetch(`${api}?${query({})}`);
  assert.equal(apiInfoResponse.status, 200);
  const apiInfo = await apiInfoResponse.json();
  assert.equal(apiInfo.user_info.auth, 1);
  assert.deepEqual(apiInfo.user_info.allowed_output_formats, ['m3u8', 'ts', 'mkv']);

  const vodResponse = await fetch(`${api}?${query({ action: 'get_vod_streams' })}`);
  const vod = await vodResponse.json();
  assert.deepEqual(vod.map((item) => item.name), ['Dune: Part Two (2026)', 'Arrival (2026)']);
  assert.deepEqual(vod.map((item) => item.stream_type), ['movie', 'movie']);
  assert.equal(vod[0].direct_source.includes(`/movie/vumovie/${token}/`), true);
  assert.ok(vod[0].stream_id > 0);
  assert.equal(vod.some((item) => item.name.includes('Hidden entry')), false, 'disabled items never leak into the API');

  const seriesResponse = await fetch(`${api}?${query({ action: 'get_series' })}`);
  const series = await seriesResponse.json();
  assert.equal(series.length, 1);
  assert.equal(series[0].name, 'The Expanse');

  const detailsResponse = await fetch(`${api}?${query({ action: 'get_series_info', series_id: String(series[0].series_id) })}`);
  const details = await detailsResponse.json();
  assert.deepEqual(details.seasons.map((season) => season.season_number), [1]);
  assert.deepEqual(details.episodes['1'].map((episode) => episode.episode_num), [1, 2], 'episode playback is ordered by season/episode number');
  assert.ok(details.episodes['1'].every((episode) => episode.direct_source.includes(`/series/vumovie/${token}/`)));

  const liveResponse = await fetch(`${api}?${query({ action: 'get_live_streams' })}`);
  const live = await liveResponse.json();
  assert.deepEqual(live.map((item) => item.name), ['Dune: Part Two (2026)', 'Arrival (2026)']);
  assert.ok(live.every((item) => item.direct_source.includes(`/live/vumovie/${token}/`)));

  const m3uResponse = await fetch(`${base}/xtream/${token}/get.php?${query({ type: 'm3u_plus' })}`);
  assert.equal(m3uResponse.status, 200);
  assert.match(m3uResponse.headers.get('content-type'), /mpegurl/);
  const m3u = await m3uResponse.text();
  const firstTitle = m3u.indexOf('Dune: Part Two (2026)');
  const secondTitle = m3u.indexOf('Arrival (2026)');
  const seriesTitle = m3u.indexOf('The Expanse S01E02');
  assert.ok(firstTitle >= 0 && secondTitle > firstTitle && seriesTitle > secondTitle, 'M3U+ keeps the complete enabled playlist order');
  assert.equal(m3u.includes('Hidden entry'), false, 'M3U+ excludes disabled entries');

  const playback = await fetch(vod[0].direct_source, { redirect: 'manual' });
  assert.equal(playback.status, 302);
  assert.match(playback.headers.get('location'), new RegExp(`/s/${second.token}/`));
  assert.equal(playback.headers.get('location').endsWith('.ts'), true);

  const wrongPassword = await fetch(vod[0].direct_source.replace(`/vumovie/${token}/`, '/vumovie/wrong-password/'), { redirect: 'manual' });
  assert.equal(wrongPassword.status, 401, 'playback links enforce the configured Xtream account password');
  const disabledPlayback = await fetch(`${base}/xtream/${token}/movie/vumovie/${token}/${Number.parseInt(disabled.id, 16)}.ts`, { redirect: 'manual' });
  assert.equal(disabledPlayback.status, 404, 'a disabled item cannot be played from a stale Xtream stream URL');

  const publicPlaylist = await fetch(`${base}/api/playlist`);
  const publicPlaylistBody = await publicPlaylist.json();
  assert.equal(publicPlaylistBody.urls.xtream.get.includes('/get.php?'), true, 'the Stream UI receives a complete M3U+ URL');
  assert.equal(publicPlaylistBody.urls.xtream.get.includes('type=m3u_plus'), true);
});
