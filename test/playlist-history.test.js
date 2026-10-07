import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-add-history-'));
const configFile = path.join(directory, 'vumovie.json');
process.env.CONFIG_FILE = configFile;
process.env.LOG_LEVEL = 'warn';

const playlist = await import('../src/playlist/index.js');
const store = await import('../src/streams/store.js');

test('playlist-add history records each addition and survives removal and stream deletion', async () => {
  const stream = await store.createStream({
    id: 'history-stream-1',
    title: 'Arrival',
    year: 2016,
    kind: 'movie',
    poster: 'https://image.example/arrival.jpg',
    description: 'An alien contact story.',
    sourceId: 'history-test',
    candidate: { url: 'https://cdn.example/arrival.m3u8', kind: 'hls' },
  });

  // Legacy/new stream reconciliation counts as a playlist addition too.
  await playlist.entries();
  let history = await playlist.additionHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].title, 'Arrival');
  assert.equal(history[0].year, 2016);
  assert.equal(history[0].streamId, stream.id);

  await playlist.reorder([stream.id]);
  assert.equal((await playlist.additionHistory()).length, 1, 'reordering is not a new addition');

  await playlist.removeItem(stream.id);
  assert.deepEqual(await playlist.entries(), [], 'removed library streams are not silently re-added');
  history = await playlist.additionHistory();
  assert.equal(history.length, 1, 'removing the playlist item does not erase its history');

  await playlist.addItems([stream.id]);
  history = await playlist.additionHistory();
  assert.equal(history.length, 2, 'explicitly adding it again creates a second addition event');
  assert.ok(history.every((event) => event.title === 'Arrival'));

  await store.removeStream(stream.id);
  assert.deepEqual(await playlist.entries(), [], 'deleting the stream removes it only from the live playlist');
  history = await playlist.additionHistory();
  assert.equal(history.length, 2, 'deleting the stream keeps both recommendation events');
  assert.equal(history[0].title, 'Arrival');

  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(saved.playlist.additionHistory.length, 2, 'the no-Postgres fallback is durable in config');
  assert.deepEqual(saved.playlist.removedStreamIds, [stream.id]);
});

test('a direct playlist-add request stores a title snapshot without relying on the current stream list', async () => {
  const stream = await store.createStream({
    id: 'history-stream-2',
    title: 'Severance',
    year: 2022,
    kind: 'series',
    candidate: { url: 'https://cdn.example/severance.m3u8', kind: 'hls' },
  });
  await playlist.addItems([stream.id]);
  await store.removeStream(stream.id);
  const history = await playlist.additionHistory();
  const severance = history.filter((event) => event.title === 'Severance');
  assert.equal(severance.length, 1);
  assert.equal(severance[0].kind, 'series');
  await store.removeStream('history-stream-2');
});
