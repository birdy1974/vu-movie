/** Enigma2 bouquet generation — the exact syntax the receiver parses. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBouquet, patchBouquetsTv, encodeE2Url, serviceRef } from '../src/enigma2/index.js';
import { buildM3U } from '../src/streams/export.js';
import { slugify, urlsFor } from '../src/streams/store.js';

test('encodeE2Url keeps slashes readable and encodes colons', () => {
  assert.equal(
    encodeE2Url('http://192.168.1.10:8080/s/abc123/dune.ts'),
    'http%3a//192.168.1.10%3a8080/s/abc123/dune.ts',
  );
  assert.equal(encodeE2Url('http://x/y?a=1'), 'http%3a//x/y');
});

test('serviceRef builds a valid 4097 reference', () => {
  const ref = serviceRef({ url: 'http://192.168.1.10:8080/s/tok/x.ts', name: 'Dune Part Two (2024)', type: 4097 });
  // Enigma2 service refs use upper-case hex (e.g. 22C5, 80D) — see the format docs.
  assert.match(ref, /^#SERVICE 4097:0:1:[0-9A-F]{4}:[0-9A-F]{4}:[0-9A-F]{4}:0:0:0:0:http%3a\/\//);
  assert.ok(ref.endsWith(':Dune Part Two (2024)'));
});

test('buildBouquet writes NAME, entries, descriptions and season separators', () => {
  const bouquet = buildBouquet({
    name: 'vu-movie', serviceType: 4097,
    entries: [
      { title: 'Dune Part Two', year: 2024, url: 'http://nas:8080/s/a/x.ts', subtitle: 'nld' },
      { title: 'Shōgun', series: 'Shōgun', season: 1, url: 'http://nas:8080/s/b/e1.ts' },
      { title: 'Shōgun', series: 'Shōgun', season: 1, url: 'http://nas:8080/s/b/e2.ts' },
    ],
  });
  assert.equal(bouquet.entries, 3);
  assert.equal(bouquet.fileName, 'userbouquet.vu-movie.tv');
  assert.ok(bouquet.text.startsWith('#NAME vu-movie (TV)'));
  assert.ok(bouquet.text.includes('#NAME ── Shōgun · Season 1 ──'));
  assert.equal((bouquet.text.match(/#DESCRIPTION/g) || []).length, 3);
  assert.ok(bouquet.bouquetsLine.includes('userbouquet.vu-movie.tv'));
});

test('duplicate service references are disambiguated', () => {
  const same = { title: 'Twin', url: 'http://nas:8080/s/a/x.ts' };
  const bouquet = buildBouquet({ name: 'vu-movie', entries: [same, { ...same, title: 'Twin (copy)' }] });
  const refs = bouquet.text.split('\n').filter((l) => l.startsWith('#SERVICE'));
  assert.equal(refs.length, 2);
  assert.notEqual(refs[0], refs[1], 'Enigma2 silently drops duplicate service refs');
});

test('patchBouquetsTv is idempotent', () => {
  const first = patchBouquetsTv('#NAME User - bouquets (TV)\n#SERVICE 1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "userbouquet.favourites.tv" ORDER BY bouquet\n', 'userbouquet.vu-movie.tv');
  assert.equal(first.changed, true);
  assert.ok(first.text.includes('userbouquet.vu-movie.tv'));
  const second = patchBouquetsTv(first.text, 'userbouquet.vu-movie.tv');
  assert.equal(second.changed, false);
  assert.equal((second.text.match(/userbouquet\.vu-movie\.tv/g) || []).length, 1);
});

test('patchBouquetsTv creates the file when the box has none yet', () => {
  const patched = patchBouquetsTv('', 'userbouquet.vu-movie.tv');
  assert.ok(patched.text.startsWith('#NAME User - bouquets (TV)'));
});

test('buildM3U produces a VLC friendly playlist', () => {
  const m3u = buildM3U([
    { title: 'Dune Part Two (2024)', url: 'http://nas:8080/s/a/x.ts', logo: 'http://img/p.jpg', quality: '1080p', group: 'vu-movie' },
    { title: 'Shōgun S01E01', url: 'http://nas:8080/s/b/y.ts', subtitle: '/downloads/subtitles/shogun.nl.srt' },
  ]);
  const lines = m3u.split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.ok(lines[1].startsWith('#PLAYLIST:'));
  assert.ok(m3u.includes('tvg-logo="http://img/p.jpg"'));
  assert.ok(m3u.includes('Dune Part Two (2024) [1080p]'));
  assert.ok(m3u.includes('#EXTVLCOPT:sub-file=/downloads/subtitles/shogun.nl.srt'));
  assert.ok(m3u.trim().endsWith('http://nas:8080/s/b/y.ts'));
});

test('slugify and urlsFor build safe file/URL names', () => {
  assert.equal(slugify('Shōgun: Part 1/2 (2024)'), 'Shogun-Part-1-2-2024');
  const urls = urlsFor({ id: 'abc', token: 'tok123', title: 'Dune Part Two', year: 2024, profile: { container: 'matroska' } }, 'http://nas:8080/');
  assert.equal(urls.raw, 'http://nas:8080/s/tok123/Dune-Part-Two-2024.mkv');
  assert.equal(urls.ts, 'http://nas:8080/s/tok123/Dune-Part-Two-2024.ts');
  assert.equal(urls.direct, 'http://nas:8080/s/tok123/direct');
  assert.equal(urls.watch, 'http://nas:8080/watch/tok123');
});
