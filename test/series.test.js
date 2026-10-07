/**
 * Series picker: season normalization (MovieBox/TMDB) + the quality matrix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSeasonInfo } from '../src/scrapers/moviebox.js';
import { normalizeSeasonEpisodes } from '../src/metadata/tmdb.js';
import { qualityHeight, qualityKey, buildQualityMatrix, seasonEpisodeLabel } from '../src/scrapers/series.js';

test('MovieBox season-info normalizes array, map and count-only shapes', () => {
  const array = normalizeSeasonInfo([
    { season: 1, episodes: [{ episode: 1 }, { episode: 2, name: 'Two' }] },
    { seasonNumber: 2, episodeCount: 3 },
  ]);
  assert.equal(array.length, 2);
  assert.deepEqual(array[0].episodes.map((e) => e.episode), [1, 2]);
  assert.equal(array[0].episodes[1].name, 'Two');
  assert.deepEqual(array[1].episodes.map((e) => e.episode), [1, 2, 3]);

  const map = normalizeSeasonInfo({ 1: [1, 2], 2: [{ ep: 1 }] });
  assert.deepEqual(map.map((s) => s.season), [1, 2]);
  assert.deepEqual(map[0].episodes.map((e) => e.episode), [1, 2]);
  assert.deepEqual(map[1].episodes.map((e) => e.episode), [1]);

  const envelope = normalizeSeasonInfo({ data: { seasons: [{ se: 1, items: [1] }] } });
  assert.equal(envelope.length, 1);
  assert.equal(envelope[0].season, 1);

  // Garbage in, empty out — never throws the picker off the page.
  assert.deepEqual(normalizeSeasonInfo(null), []);
  assert.deepEqual(normalizeSeasonInfo({}), []);
  assert.deepEqual(normalizeSeasonInfo([{ season: 'x', episodes: [1] }]), []);
});

test('TMDB season episodes normalize to episode rows', () => {
  const rows = normalizeSeasonEpisodes({
    episodes: [
      { episode_number: 2, name: 'Two', air_date: '2024-01-02' },
      { episode_number: 1, name: 'One' },
      { episode_number: 0, name: 'junk' },
    ],
  });
  assert.deepEqual(rows.map((r) => r.episode), [1, 2]);
  assert.equal(rows[1].airDate, '2024-01-02');
  assert.deepEqual(normalizeSeasonEpisodes(null), []);
});

test('quality keys and heights rank 4k above 1080p above source', () => {
  assert.equal(qualityHeight('1080p'), 1080);
  assert.equal(qualityHeight('4K'), 2160);
  assert.equal(qualityHeight('2160p'), 2160);
  assert.equal(qualityHeight('source'), 0);
  assert.equal(qualityKey({ quality: '720p' }), '720p');
  assert.equal(qualityKey({ height: 480 }), '480p');
  assert.equal(qualityKey({}), 'source');
});

test('the quality matrix combines episodes into one row per quality', () => {
  const rows = buildQualityMatrix([
    {
      season: 1, episode: 1,
      candidates: [
        { quality: '1080p', sourceId: 'moviebox', ok: true },
        { quality: '720p', sourceId: 'moviebox', ok: true },
      ],
    },
    {
      season: 1, episode: 2,
      candidates: [
        { quality: '1080p', sourceId: 'overlook', ok: true },
        { quality: '1080p', sourceId: 'overlook', ok: true },
        { quality: '480p', sourceId: 'overlook', ok: false },
      ],
    },
  ]);
  assert.deepEqual(rows.map((r) => r.quality), ['1080p', '720p', '480p']);
  const hd = rows[0];
  assert.equal(hd.episodes.length, 2, '1080p covers both episodes');
  assert.deepEqual(hd.providers, ['moviebox', 'overlook']);
  assert.equal(hd.playable, 3);
  assert.equal(rows[1].episodes.length, 1);
  assert.equal(rows[2].playable, 0);
});

test('season/episode labels are zero-padded', () => {
  assert.equal(seasonEpisodeLabel(1, 2), 'S01E02');
  assert.equal(seasonEpisodeLabel(12, 3), 'S12E03');
});
