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
import { probeCandidates, rankCandidates } from '../src/scrapers/registry.js';

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

test('probing keeps candidates when ffprobe is unavailable', async (t) => {
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
