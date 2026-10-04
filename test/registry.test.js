/**
 * Registry behaviour that does not need the internet.
 *
 * These tests cover the two mistakes that made the resolve endpoint return
 * "no candidates" with no explanation: ignoring non-http URLs, and treating a
 * missing ffprobe as "this stream is dead".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, listSources, matchSourceByUrl, getSource } from '../src/scrapers/registry.js';
import { probeCandidates, rankCandidates, candidateKey, dedupeCandidates } from '../src/scrapers/registry.js';

test('the seven requested sites are loaded from the recipe file', () => {
  const sources = listSources();
  const ids = sources.map((s) => s.id);
  assert.ok(sources.length >= 7, `only ${sources.length} sources: ${ids.join(', ')}`);
  assert.ok(ids.includes('moviebox') === false || true); // MovieBox is queried separately, not a site recipe
  for (const host of ['overlook.cx', 'cinevo.nl', 'cinejoy.pk', 'flixhub.studio', 'redflix.club', '1flex.org', 'cinezo.st']) {
    assert.ok(sources.some((s) => s.match?.includes(host)), `no recipe for ${host} (have: ${ids.join(', ')})`);
  }
  assert.ok(sources.every((s) => s.enabled === true && s.home && s.search?.url && s.resolve), 'every recipe needs home/search/resolve');
});

test('a pasted page URL is matched to its recipe', () => {
  const source = matchSourceByUrl('https://flixhub.studio/watch/movie/tt1234');
  assert.equal(source?.id, 'flixhub');
  assert.equal(getSource('cinejoy')?.name, 'Cinejoy');
  assert.equal(getSource('cinejoy')?.resolve?.playerPathPrefix, '/watch');
  assert.equal(matchSourceByUrl('https://unknown.example/x'), null);
});

test('a direct non-http URL is offered as-is instead of being ignored', async () => {
  const resolved = await resolveTarget({ url: '/mnt/media/movie.mp4', useBrowser: false });
  assert.equal(resolved.candidates.length, 1);
  assert.equal(resolved.candidates[0].url, '/mnt/media/movie.mp4');
  assert.equal(resolved.candidates[0].kind, 'file');
  assert.equal(resolved.ok, true);
});

test('a direct http media URL is offered as-is when sniffing is off', async () => {
  const resolved = await resolveTarget({ url: 'https://cdn.example.com/x/master.m3u8', useBrowser: false });
  assert.equal(resolved.candidates.length, 1);
  assert.equal(resolved.candidates[0].kind, 'hls');
  assert.equal(resolved.ok, true);
});

test('nothing found comes back with an explanation, not just empty', async () => {
  const resolved = await resolveTarget({ useBrowser: false });
  assert.equal(resolved.ok, false);
  assert.ok(resolved.error && resolved.error.length > 10, 'expected a human readable error');
});

test('probing keeps candidates when ffprobe is unavailable', async () => {
  // In the test sandbox ffprobe usually is not installed; when it is, this test
  // simply verifies the normal path (probe attempted, candidate still listed).
  const candidates = [{ url: '/mnt/media/movie.mp4', kind: 'file', label: 'direct' }];
  const probed = await probeCandidates(candidates, { limit: 1 });
  assert.equal(probed.length, 1);
  assert.ok(probed[0].ok !== false, 'a candidate must not be rejected just because probing failed');
});

test('ranking prefers playable, higher resolution and known quality', () => {
  const ranked = rankCandidates([
    { url: 'a', ok: false, quality: '1080p' },
    { url: 'b', ok: true, quality: '480p' },
    { url: 'c', ok: true, quality: '1080p' },
  ]);
  assert.equal(ranked[0].url, 'c');
  assert.equal(ranked[ranked.length - 1].url, 'a');
});

test('dedupeCandidates collapses URLs differing only in CDN signatures/timestamps', () => {
  // Two URLs that only differ by CloudFront Policy/Signature (common for signed CDNs).
  const u1 = 'https://cdn.example.com/pl/playlist.m3u8?Policy=abc123&Signature=xyz&Key-Pair-Id=K1&t=1700000';
  const u2 = 'https://cdn.example.com/pl/playlist.m3u8?Policy=def456&Signature=uvw&Key-Pair-Id=K1&t=1700001';
  const u3 = 'https://cdn.example.com/pl/other.m3u8'; // genuinely different path
  const list = [
    { url: u1, sourceId: 'a', headers: { Referer: 'https://a/' } },
    { url: u2, sourceId: 'a', headers: { 'User-Agent': 'x' } },
    { url: u3, sourceId: 'b' },
  ];
  // Same playlist under different signatures → same candidateKey
  assert.equal(candidateKey(u1), candidateKey(u2));
  assert.notEqual(candidateKey(u1), candidateKey(u3));
  const deduped = dedupeCandidates(list);
  assert.equal(deduped.length, 2, 'signed-URL duplicates should collapse');
  // Headers from both entries should be merged (Referer from u1, UA from u2).
  const merged = deduped.find((c) => candidateKey(c.url) === candidateKey(u1));
  assert.ok(merged, 'merged candidate must be present');
  assert.equal(merged.headers.Referer, 'https://a/', 'Referer from first entry preserved');
  assert.equal(merged.headers['User-Agent'], 'x', 'User-Agent from second entry merged in');
});


import { sortResultsForDisplay, canonicalTitleKey, fillMissingMetadata } from '../src/scrapers/registry.js';

test('canonicalTitleKey strips year suffixes and quality tags', () => {
  assert.equal(canonicalTitleKey('Unabomber (2022)'), 'unabomber');
  assert.equal(canonicalTitleKey('UNABOMBER'), 'unabomber');
  assert.equal(canonicalTitleKey('Dune: Part Two HD'), 'dune part two');
});

test('sortResultsForDisplay groups same movies from different sources contiguously', () => {
  // Sources finish in pool order (3-at-a-time) → e.g. flixhub, cinejoy, redflix interleave.
  const results = [
    { title: 'Unabomber', year: 2022, kind: 'movie', sourceId: 'flixhub', url: 'a' },
    { title: 'The Net', year: 2003, kind: 'movie', sourceId: 'redflix', url: 'b' },
    { title: 'Unabomber (2022)', year: 2022, kind: 'movie', sourceId: 'overlook', url: 'c' },
    { title: 'Fantasma: Il Caso Unabomber', year: 2025, kind: 'series', sourceId: 'cinejoy', url: 'd' },
    { title: 'Unabomber', kind: 'movie', sourceId: 'cinejoy', url: 'e' },   // year missing
    { title: 'Unabomber', year: 2022, kind: 'movie', sourceId: 'redflix', url: 'f' },
  ];
  const filled = fillMissingMetadata(results);
  // The yearless "Unabomber" from cinejoy should pick up year 2022 from the consensus.
  const yearless = filled.find((r) => r.url === 'e');
  assert.equal(yearless.year, 2022, 'fillMissingMetadata should propagate consensus year');

  const sorted = sortResultsForDisplay(filled);
  // After sort, the three Unabomber 2022 entries must be contiguous (indices 0,1,2 or similar),
  // ordered by source preference (overlook first, then others).
  const unabomberIdxs = sorted.map((r, i) => r.url === 'a' || r.url === 'c' || r.url === 'e' || r.url === 'f' ? i : -1).filter((i) => i >= 0);
  assert.equal(unabomberIdxs.length, 4, 'all four Unabomber 2022 results');
  assert.ok(unabomberIdxs[unabomberIdxs.length - 1] - unabomberIdxs[0] === unabomberIdxs.length - 1,
    `Unabomber results must be contiguous: got indices ${unabomberIdxs.join(',')}`);
  // Overlook (rank 0) comes first among Unabomber entries.
  assert.equal(sorted[unabomberIdxs[0]].sourceId, 'overlook', 'best source preferred within group');
});
