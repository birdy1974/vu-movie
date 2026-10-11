/**
 * The VLC playlist (playlist.m3u / vlc.m3u) gets a seekable entry for each file
 * movie. The relay entry is a zap URL (still ending in .ts): zapping away stops
 * the session, a pause continues. VLC cannot seek in that live output, so the
 * second entry is the direct link, which VLC can seek. Other kinds (HLS, DASH)
 * get only their own entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-playlist-seekable-'));
process.env.CONFIG_FILE = path.join(directory, 'vumovie.json');
process.env.LOG_LEVEL = 'error';

const config = await import('../src/core/config.js');
config.loadConfig();
config.saveConfig({ playlist: { autoRepairEnabled: false } });
const store = await import('../src/streams/store.js');
const playlist = await import('../src/playlist/index.js');

const BASE = 'http://nas:8080';
const probe = {
  container: 'matroska,webm',
  durationSec: 7200,
  video: { codec: 'h264', width: 1920, height: 1080, fps: 25 },
  audio: [{ codec: 'aac', channels: 2 }],
  subtitles: [],
};

/** The URL of each entry in the playlist text, in order. */
function entryUrls(text) {
  const lines = text.split('\n').map((line) => line.trim());
  const urls = [];
  lines.forEach((line, index) => {
    if (!line.startsWith('#EXTINF')) return;
    const next = lines.slice(index + 1).find((candidate) => candidate && !candidate.startsWith('#'));
    urls.push(next);
  });
  return urls;
}

test('a file movie gets a second, seekable entry on its direct link; the relay entry zaps', async () => {
  const file = await store.createStream({
    title: 'Open file', year: 2020,
    candidate: { url: 'https://cdn.example/open.mp4', kind: 'file', headers: {}, probe },
  });
  const signed = await store.createStream({
    title: 'Signed file',
    candidate: { url: 'https://cdn.example/signed.mp4', kind: 'file', headers: { Cookie: 'sig=abc' }, probe },
  });
  const live = await store.createStream({
    title: 'Live hls',
    candidate: { url: 'https://cdn.example/live.m3u8', kind: 'hls', headers: {}, probe },
  });
  await playlist.addItems([file.id, signed.id, live.id]);

  const { text, count } = await playlist.playlistText(BASE);
  const urls = entryUrls(text);
  const fileUrls = store.urlsFor(file, BASE);
  const signedUrls = store.urlsFor(signed, BASE);
  const liveUrls = store.urlsFor(live, BASE);

  assert.ok(urls.includes(store.zapPlaybackUrl(fileUrls.ts, 'playlist')), 'the playlist entry zaps like the box, and still ends in .ts');
  assert.equal(urls.includes(fileUrls.ts), false, 'the plain VLC link is not what the playlist hands an IPTV app');
  assert.ok(urls.includes(fileUrls.direct), 'the seekable direct entry is there');
  assert.match(fileUrls.direct, /\/direct\.mp4$/, 'the seekable entry advertises a media extension, so IPTV players that classify by extension (SFVIP, OwnTV) accept it');
  assert.match(signedUrls.direct, /\/direct\.mp4$/, 'the relay-served seekable entry carries it too');
  assert.ok(urls.includes(signedUrls.direct), 'a signed file is seekable too (the relay serves it)');
  assert.match(text, /#EXTINF:-1 [^\n]*,Open file \(2020\) \(seekable\)/, 'the seekable entry is labelled');
  assert.equal(urls.includes(liveUrls.direct), false, 'a live (HLS) stream gets no seekable entry');
  assert.ok(urls.includes(store.zapPlaybackUrl(liveUrls.ts, 'playlist')), 'but keeps its own entry');
  assert.equal(count, urls.length, 'the count is the number of entries');
  assert.equal(urls.length, 5, 'two file movies with two entries each, plus the HLS entry');
});
