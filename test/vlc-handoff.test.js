/**
 * The "open in VLC" handoff links (public/app.js, public/playlist.js).
 *
 * VLC's protocol handler takes the complete stream URL after the prefix:
 * vlc://http://host/path. The old rewrite replaced "http:" with "vlc:", which
 * produced vlc://host/path — a URL without a scheme. The browser code cannot be
 * run here, so this test guards the exact rewrite expression in the sources.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_REWRITE = "replace(/^https?:/, 'vlc:')";
const NEW_REWRITE = "replace(/^(https?:\\/\\/)/i, 'vlc://$1')";

const sources = {
  'public/app.js': 3,      // stream .ts, playlist-page VLC button, per-stream URL row
  'public/playlist.js': 1, // playlist item "play in VLC"
};

test('VLC handoff links keep the full URL after vlc:// (no scheme dropped)', () => {
  for (const [file, expected] of Object.entries(sources)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(text.split(OLD_REWRITE).length - 1, 0, `${file} still rewrites http: to vlc: (vlc://host/…)`);
    assert.equal(text.split(NEW_REWRITE).length - 1, expected, `${file} uses the vlc://<full url> rewrite ${expected} time(s)`);
  }
});

test('the vlc:// rewrite keeps http and https intact', () => {
  // Same expression as the sources, applied to the URL shapes the app produces.
  const rewrite = (url) => String(url).replace(/^(https?:\/\/)/i, 'vlc://$1');
  assert.equal(rewrite('http://nas:8080/s/tok/Movie-2024.ts'), 'vlc://http://nas:8080/s/tok/Movie-2024.ts');
  assert.equal(rewrite('https://nas.example/pl/tok/vlc.m3u'), 'vlc://https://nas.example/pl/tok/vlc.m3u');
  assert.equal(rewrite('vlc://already'), 'vlc://already');
});
