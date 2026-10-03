/** Enigma2 bouquet generation — the exact syntax the receiver parses. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBouquet, patchBouquetsTv, encodeE2Url, serviceRef, status, resetStatusCache, xmlTag,
} from '../src/enigma2/index.js';
import { getConfig } from '../src/core/config.js';
import { getRecentLogs } from '../src/core/log.js';
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

/** OpenWebif's /web/about, as a VU+ Duo2 answers it. */
const ABOUT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<e2abouts>
<e2about>
<e2enigmaversion>2019-11-22-master-0abcdef</e2enigmaversion>
<e2imageversion>6.2</e2imageversion>
<e2webifversion>1.4.5</e2webifversion>
<e2model>Duo\u00b2</e2model>
<e2lanip>192.168.1.20</e2lanip>
</e2about>
</e2abouts>`;

test('xmlTag reads the e2* field names OpenWebif actually returns', () => {
  assert.equal(xmlTag(ABOUT_XML, ['model', 'e2model']), 'Duo\u00b2');
  assert.equal(xmlTag(ABOUT_XML, ['e2enigmaversion', 'e2imageversion', 'image', 'version']), '2019-11-22-master-0abcdef');
  assert.equal(xmlTag('<x><version>1.2</version></x>', ['image', 'version']), '1.2');
  assert.equal(xmlTag(ABOUT_XML, ['nope']), '');
});

test('receiver status reports the model and image version', async (t) => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(ABOUT_XML, { status: 200, headers: { 'content-type': 'text/xml' } });
  };
  const cfg = getConfig().enigma2;
  const saved = { host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password };
  Object.assign(cfg, { host: '192.168.1.20', port: 80, username: '', password: '' });
  resetStatusCache();
  t.after(() => {
    globalThis.fetch = original;
    Object.assign(cfg, saved);
    resetStatusCache();
  });

  const first = await status({ timeoutMs: 1000 });
  assert.equal(first.ok, true);
  assert.equal(first.model, 'Duo\u00b2');
  assert.equal(first.version, '2019-11-22-master-0abcdef', 'the image version used to come back empty');
  assert.equal(calls, 1);

  // A healthcheck/dashboard poll reuses the answer instead of waking the box.
  const second = await status({ timeoutMs: 1000 });
  assert.equal(second.model, 'Duo\u00b2');
  assert.equal(second.cached, true);
  assert.equal(calls, 1, 'the receiver must not be polled on every health check');

  // The UI's "test connection" always asks for real.
  await status({ timeoutMs: 1000, force: true });
  assert.equal(calls, 2);
});

test('repeated polls do not spam INFO with an unchanged receiver', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(ABOUT_XML, { status: 200, headers: { 'content-type': 'text/xml' } });
  const cfg = getConfig().enigma2;
  const saved = { host: cfg.host, username: cfg.username };
  Object.assign(cfg, { host: '192.168.1.20', username: '' });
  resetStatusCache();
  t.after(() => {
    globalThis.fetch = original;
    Object.assign(cfg, saved);
    resetStatusCache();
  });

  await status({ timeoutMs: 1000 });
  const afterFirst = getRecentLogs({ component: 'enigma2', level: 'info', search: 'receiver reachable' }).length;
  await status({ timeoutMs: 1000, force: true });
  await status({ timeoutMs: 1000, force: true });
  const afterThree = getRecentLogs({ component: 'enigma2', level: 'info', search: 'receiver reachable' }).length;
  assert.equal(afterThree, afterFirst, 'an unchanged receiver is logged once, not per poll');

  // …but a real change is still reported at INFO/WARN.
  globalThis.fetch = async () => { throw new Error('fetch failed'); };
  await status({ timeoutMs: 1000, force: true });
  const down = getRecentLogs({ component: 'enigma2', level: 'warn', search: 'unreachable' });
  assert.ok(down.length > 0, 'the receiver going away must be logged');
});
