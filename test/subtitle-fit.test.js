/**
 * Picking the subtitle that fits the video, not just the one that ranked first.
 *
 *   1. metadata ranking — provider facts (fps, last timestamp, CD count, HI,
 *      machine translation, moviehash match) against the ffprobe facts
 *   2. download-and-verify — the file's own cues measured against the video
 *      length; a certain frame-rate drift is corrected, a wrong cut is skipped
 *   3. moviehash — computed from two Range requests, abandoned on a server
 *      that ignores Range
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-subtitle-fit-'));
process.env.CONFIG_FILE = path.join(tempDir, 'vumovie.json');
process.env.LOG_LEVEL = 'error';
process.env.TMP_DIR = path.join(tempDir, 'tmp');
process.env.DOWNLOADS_DIR = path.join(tempDir, 'downloads');

const {
  parseTimestampMs, parseCueTimes, inspectSrt, assessSubtitle, applyScale, rankResult, scoreResult, frameRateFactorFor,
  matchesTarget, relaxedTitles, yearInRelease, episodeInRelease,
} = await import('../src/subtitles/util.js');
const { movieHashFromBuffer, movieHashFromChunks, fetchMovieHash, cachedMovieHash, resetMovieHashCache, CHUNK } = await import('../src/subtitles/moviehash.js');
const { saveConfig, getConfig } = await import('../src/core/config.js');
const subs = await import('../src/subtitles/index.js');

/* ------------------------------------------------------------------ helpers */

/** An SRT with `count` cues spread evenly up to `lastSec` (dialogue every few seconds). */
function makeSrt(lastSec, count = 400) {
  const fmt = (sec) => {
    const ms = Math.round(sec * 1000);
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
  };
  const step = lastSec / count;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const start = step * i + 1;
    const end = Math.min(start + 1.5, step * (i + 1) + 0.9);
    out.push(`${i + 1}\n${fmt(start)} --> ${fmt(end)}\nLine ${i + 1}\n`);
  }
  // Make the last cue end exactly at lastSec.
  out[count - 1] = `${count}\n${fmt(lastSec - 2)} --> ${fmt(lastSec)}\nThe end\n`;
  return out.join('\n');
}

/* ------------------------------------------------------------------ 1. parsing */

test('timestamps and cue tables are parsed from SRT text', () => {
  assert.equal(parseTimestampMs('01:47:44'), 6464000);
  assert.equal(parseTimestampMs('00:00:01,500'), 1500);
  assert.equal(parseTimestampMs('0:00:01.5'), 1500);
  assert.equal(parseTimestampMs('nope'), null);
  const cues = parseCueTimes('1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:05,000 --> 00:00:06,500\nB\n');
  assert.deepEqual(cues, [{ start: 1000, end: 2000 }, { start: 5000, end: 6500 }]);
  const info = inspectSrt(makeSrt(6000, 300));
  assert.equal(info.cues, 300);
  assert.equal(info.lastMs, 6000000);
  assert.ok(info.hiShare < 0.05);
});

test('SDH captions are recognised by their bracketed sound lines', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\n[door slams]\n\n2\n00:00:03,000 --> 00:00:04,000\n(sighs)\n\n3\n00:00:05,000 --> 00:00:06,000\nJOHN: Hello there.\n\n4\n00:00:07,000 --> 00:00:08,000\nHi.\n';
  const info = inspectSrt(srt);
  assert.equal(info.cues, 4);
  assert.ok(info.hiShare >= 0.5, `hiShare ${info.hiShare}`);
});

/* ------------------------------------------------------------------ 2. assessment */

test('a file whose last cue sits near the end of the video fits', () => {
  const check = assessSubtitle(inspectSrt(makeSrt(6150)), { durationSec: 6300 });
  assert.equal(check.verdict, 'good');
  assert.equal(check.penalty, 0);
  assert.equal(check.suggestedScale, null);
});

test('a file that runs past the end by the 23.976→25 ratio is a certain drift and gets a scale', () => {
  const duration = 5400;                       // 1 h 30 at 25 fps
  const drifted = makeSrt(duration * 25 / 23.976); // timed on the 23.976 release: 1 h 33 min 52
  const check = assessSubtitle(inspectSrt(drifted), { durationSec: duration });
  assert.equal(check.verdict, 'suspect');
  assert.equal(check.confidence, 'high');
  assert.ok(Math.abs(check.suggestedScale - 23.976 / 25) < 1e-3, `scale ${check.suggestedScale}`);
  assert.match(check.reasons.join(' '), /23\.976→25 fps/);
  // Applying the scale puts the last cue back at the end of the video.
  const fixed = inspectSrt(applyScale(drifted, check.suggestedScale));
  assert.ok(Math.abs(fixed.lastMs - duration * 1000) < 50, `last cue ${fixed.lastMs}`);
});

test('a file that ends early by the 25→23.976 ratio passes as credits unless the provider fps confirms the drift', () => {
  const duration = 6300;
  const early = makeSrt(duration * 23.976 / 25);   // could be drift — or four minutes of credits
  const alone = assessSubtitle(inspectSrt(early), { durationSec: duration });
  assert.equal(alone.verdict, 'good', 'an early end alone is credits until proven otherwise');
  assert.equal(alone.suggestedScale, null);
  const confirmed = assessSubtitle(inspectSrt(early), { durationSec: duration, fps: 23.976 }, { fps: 25 });
  assert.equal(confirmed.confidence, 'high');
  assert.ok(Math.abs(confirmed.suggestedScale - 25 / 23.976) < 1e-3);
  assert.ok(confirmed.penalty > alone.penalty);
});

test('half a film, a different cut and a forced track are rejected or marked', () => {
  const half = assessSubtitle(inspectSrt(makeSrt(3000)), { durationSec: 6300 });
  assert.equal(half.verdict, 'bad');
  assert.match(half.reasons.join(' '), /CD 1 of 2/);
  const longer = assessSubtitle(inspectSrt(makeSrt(7500)), { durationSec: 6300 });
  assert.equal(longer.verdict, 'bad');
  const forced = assessSubtitle(inspectSrt(makeSrt(6200, 40)), { durationSec: 6300 });
  assert.equal(forced.verdict, 'suspect');
  assert.match(forced.reasons.join(' '), /forced/);
  const empty = assessSubtitle(inspectSrt('1\n00:00:01,000 --> 00:00:02,000\nHi\n'), { durationSec: 6300 });
  assert.equal(empty.verdict, 'bad');
  const unknown = assessSubtitle(inspectSrt(makeSrt(6000)), {});
  assert.equal(unknown.verdict, 'unknown');
  assert.equal(unknown.penalty, 0);
});

test('frame-rate pairs are recognised from the length ratio and nothing else', () => {
  assert.equal(frameRateFactorFor(25 / 23.976).label, '23.976→25 fps');
  assert.equal(frameRateFactorFor(23.976 / 25).label, '25→23.976 fps');
  assert.equal(frameRateFactorFor(0.93), null);
  assert.equal(frameRateFactorFor(1.0), null);
});

/* ------------------------------------------------------------------ 2b. ranking with metadata */

test('provider facts about the file move it up or down the ranking', () => {
  const target = { title: 'Heat', year: 1995, languages: ['nl'], durationSec: 10200, fps: 23.976 };
  const base = { language: 'nl', title: 'Heat', release: 'Heat.1995.1080p.BluRay', downloads: 500 };
  const plain = rankResult(base, target);
  const fits = rankResult({ ...base, fps: 23.976, lastTimestampMs: 10050000 }, target);
  const drift = rankResult({ ...base, fps: 25, lastTimestampMs: 9780000 }, target);
  const twoCd = rankResult({ ...base, cds: 2 }, target);
  const forced = rankResult({ ...base, foreignPartsOnly: true }, target);
  const machine = rankResult({ ...base, machineTranslated: true }, target);
  const hash = rankResult({ ...base, hashMatch: true }, target);
  assert.ok(fits.score > plain.score, 'matching fps + length should add points');
  assert.ok(drift.score < plain.score - 15, `a 25 fps file on a 23.976 video should lose points (${drift.score} vs ${plain.score})`);
  assert.ok(twoCd.score < plain.score && forced.score < plain.score && machine.score < plain.score);
  assert.ok(hash.score > fits.score, 'an exact file match outranks a merely fitting file');
  assert.deepEqual(fits.notes.map((n) => n.tone), ['ok', 'ok']);
  assert.match(drift.notes.map((n) => n.text).join(' | '), /timed for 25 fps, video is 23\.976/);
  assert.match(hash.notes[0].text, /exact file match/);
  assert.equal(scoreResult(base, target), plain.score);
});

test('an exact file match never outranks the preferred language', () => {
  const target = { title: 'Heat', languages: ['nl', 'en'] };
  const nl = rankResult({ language: 'nl', title: 'Heat' }, target).score;
  const enHash = rankResult({ language: 'en', title: 'Heat', hashMatch: true }, target).score;
  assert.ok(nl > enHash - 30, 'hash adds less than the language gap plus release matching');
  assert.ok(enHash > rankResult({ language: 'en', title: 'Heat' }, target).score + 30);
});

/* ------------------------------------------------------------------ 3. moviehash */

test('the moviehash is size + sum of the 64-bit words of the first and last 64 KiB', () => {
  const zeros = Buffer.alloc(200000);
  assert.equal(movieHashFromBuffer(zeros), (200000).toString(16).padStart(16, '0'));
  // Independent reference: fold the same bytes by hand.
  const file = Buffer.alloc(300000);
  for (let i = 0; i < file.length; i += 1) file[i] = (i * 31 + 7) & 0xff;
  let ref = BigInt(file.length);
  const fold = (buf) => { for (let i = 0; i + 8 <= buf.length; i += 8) ref += buf.readBigUInt64LE(i); };
  fold(file.subarray(0, CHUNK));
  fold(file.subarray(file.length - CHUNK));
  ref &= 0xFFFFFFFFFFFFFFFFn;
  assert.equal(movieHashFromBuffer(file), ref.toString(16).padStart(16, '0'));
  assert.equal(movieHashFromChunks(file.length, file.subarray(0, CHUNK), file.subarray(file.length - CHUNK)), movieHashFromBuffer(file));
  // A file smaller than 128 KiB: head and tail overlap, like the reference implementations.
  const small = Buffer.from('abcdefgh'.repeat(100));
  assert.equal(movieHashFromBuffer(small).length, 16);
});

/** A tiny CDN: honours Range when `ranges` is true, otherwise streams the whole file. */
function cdn(file, { ranges = true } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.headers.range || '(none)');
    const m = ranges ? /bytes=(\d+)-(\d+)/.exec(req.headers.range || '') : null;
    if (m) {
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), file.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${file.length}`, 'Content-Length': end - start + 1 });
      res.end(file.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'Content-Length': file.length });
    res.end(file);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/movie.mkv`,
    hits,
    close: () => new Promise((r) => server.close(r)),
  })));
}

test('fetchMovieHash reads exactly two 64 KiB windows of a Range-capable file', async () => {
  const file = Buffer.alloc(1_000_000);
  for (let i = 0; i < file.length; i += 1) file[i] = (i * 13) & 0xff;
  const site = await cdn(file);
  try {
    const got = await fetchMovieHash(site.url, { headers: { Referer: 'https://example.test/' } });
    assert.deepEqual(got, { hash: movieHashFromBuffer(file), size: file.length });
    assert.deepEqual(site.hits, [`bytes=0-${CHUNK - 1}`, `bytes=${file.length - CHUNK}-${file.length - 1}`]);
    // The cache answers the second call without touching the server.
    resetMovieHashCache();
    await cachedMovieHash(site.url);
    await cachedMovieHash(site.url);
    assert.equal(site.hits.length, 4);
  } finally {
    await site.close();
  }
});

test('a server that ignores Range gets no hash and is not downloaded whole', async () => {
  const file = Buffer.alloc(3_000_000, 7);
  const site = await cdn(file, { ranges: false });
  try {
    const got = await fetchMovieHash(site.url);
    assert.equal(got, null);
    assert.equal(site.hits.length, 1, 'one request is enough to learn that Range is ignored');
  } finally {
    await site.close();
  }
  const dead = await fetchMovieHash('http://127.0.0.1:9/nothing.mkv', { timeoutMs: 1500 });
  assert.equal(dead, null);
});

/* ------------------------------------------------------------------ 2c. autoFetch end to end */

/** A fake subtitle site: a JSON search answer and the .srt files behind it. */
async function subtitleSite(files) {
  const downloads = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/search') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        subtitles: Object.keys(files).map((name) => ({ url: `/files/${name}.srt`, title: 'Heat', release: name, language: 'nl' }))
          // Unrelated hits a keyword provider throws in for "heat".
          .concat([
            { url: '/files/x-heatwave.srt', title: 'Heat Wave', release: 'Heat.Wave.2022.1080p.WEB', language: 'nl' },
            { url: '/files/x-deadheat.srt', title: 'Dead Heat', release: 'Dead.Heat.1988.BluRay', language: 'nl' },
            { url: '/files/x-casino.srt', title: 'Casino', release: 'Casino.1995.1080p', language: 'nl' },
          ]),
      }));
      return;
    }
    const m = /^\/files\/(.+)\.srt$/.exec(url.pathname);
    if (m && files[m[1]]) {
      downloads.push(m[1]);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(files[m[1]]);
      return;
    }
    res.statusCode = 404;
    res.end('no');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, downloads, close: () => new Promise((r) => server.close(r)) };
}

function useOnlyFakeProvider(base) {
  const builtIn = subs.listProviders().map((p) => p.id).filter((id) => id !== 'fake');
  saveConfig({
    subtitles: {
      disabledProviders: builtIn,
      verifyCandidates: 3,
      autoRescale: true,
      customProviders: [{
        id: 'fake', name: 'Fake', searchUrl: `${base}/search?q={query}`, baseUrl: base,
        parse: { kind: 'json', items: 'subtitles', map: { url: 'url', title: 'title', release: 'release', language: 'language' } },
      }],
    },
  });
}

let site;
before(async () => {
  const duration = 6300;
  site = await subtitleSite({
    // Ranked first (alphabetical tie-break is irrelevant: equal scores keep
    // provider order), but it is half a film.
    'a-half': makeSrt(3100),
    // Timed on the 23.976 release, played on a 25 fps video: runs past the end.
    'b-drift': makeSrt(duration * 25 / 23.976),
    // Fits as delivered.
    'c-good': makeSrt(6180),
  });
  useOnlyFakeProvider(site.base);
});
after(async () => { await site?.close(); });

test('autoFetch skips a half-film file, keeps looking past a rescaled one, and attaches the file that fits', async () => {
  site.downloads.length = 0;
  const target = { title: 'Heat', year: 1995, kind: 'movie', languages: ['nl'], durationSec: 6300, fps: 25 };
  const got = await subs.autoFetch(target);
  assert.ok(got, 'a subtitle is attached');
  assert.equal(got.result.release, 'c-good');
  assert.equal(got.check.verdict, 'good');
  assert.equal(got.adjustment, null);
  assert.deepEqual(site.downloads, ['a-half', 'b-drift', 'c-good'], 'candidates are measured in rank order until one fits');
  assert.equal(got.alternatives.length, 2);
});

test('autoFetch corrects a certain frame-rate drift when nothing fits natively', async () => {
  const only = await subtitleSite({ 'drift': makeSrt(6300 * 25 / 23.976) });
  try {
    useOnlyFakeProvider(only.base);
    const got = await subs.autoFetch({ title: 'Heat', kind: 'movie', languages: ['nl'], durationSec: 6300, fps: 25 });
    assert.ok(got.adjustment, 'the timing was rescaled');
    assert.ok(Math.abs(got.adjustment.scale - 23.976 / 25) < 1e-3, `scale ${got.adjustment.scale}`);
    const after = inspectSrt(got.srt);
    assert.ok(Math.abs(after.lastMs - 6300000) < 50, `last cue now at ${after.lastMs}`);
    assert.match(got.adjustment.label, /23\.976→25 fps/);
  } finally {
    await only.close();
    useOnlyFakeProvider(site.base);
  }
});

test('autoFetch leaves the timing alone when the setting is off, and reports the doubt', async () => {
  const only = await subtitleSite({ 'drift': makeSrt(6300 * 25 / 23.976) });
  try {
    useOnlyFakeProvider(only.base);
    saveConfig({ subtitles: { autoRescale: false } });
    const got = await subs.autoFetch({ title: 'Heat', kind: 'movie', languages: ['nl'], durationSec: 6300 });
    assert.equal(got.adjustment, null);
    assert.equal(got.check.verdict, 'suspect');
    assert.match(got.check.reasons.join(' '), /runs past the end/);
    assert.ok(Math.abs(inspectSrt(got.srt).lastMs - 6300000 * 25 / 23.976) < 50);
  } finally {
    saveConfig({ subtitles: { autoRescale: true } });
    await only.close();
    useOnlyFakeProvider(site.base);
  }
});

test('without a video length the first ranked hit is taken, as before', async () => {
  site.downloads.length = 0;
  const got = await subs.autoFetch({ title: 'Heat', kind: 'movie', languages: ['nl'] });
  assert.equal(got.result.release, 'a-half');
  assert.equal(got.check.verdict, 'unknown');
  assert.deepEqual(site.downloads, ['a-half']);
});

test('the search results carry the video facts and the ranking notes', async () => {
  const results = await subs.searchSubtitles({ title: 'Heat', kind: 'movie', languages: ['nl'], durationSec: 6300, fps: 25 });
  assert.equal(results.length, 3, 'without a year "Heat Wave" and "Dead Heat" are still other films');
  for (const r of results) assert.ok(Array.isArray(r.notes));
  assert.equal(getConfig().subtitles.verifyCandidates, 3);
});

test('videoFactsFor reads the probe and hashes only plain files', async () => {
  const file = Buffer.alloc(400000, 3);
  const cdnSite = await cdn(file);
  try {
    resetMovieHashCache();
    const stream = {
      upstream: {
        url: cdnSite.url, kind: 'file', headers: { Referer: 'https://x.test/' }, label: 'Heat.1995.1080p.WEB-DL',
        probe: { durationSec: 10200.5, video: { fps: 1000, avgFps: 23.976 } },
      },
    };
    const facts = await subs.videoFactsFor(stream);
    assert.equal(facts.durationSec, 10200.5);
    assert.equal(facts.fps, 23.976, 'avg_frame_rate wins over a bogus r_frame_rate');
    assert.equal(facts.release, 'Heat.1995.1080p.WEB-DL');
    assert.equal(facts.moviehash, movieHashFromBuffer(file));
    assert.equal(facts.sizeBytes, file.length);
    assert.deepEqual(cdnSite.hits.length, 2);

    const hls = await subs.videoFactsFor({ upstream: { url: 'https://cdn.test/master.m3u8', probe: { durationSec: 100, video: { fps: 25 } } } });
    assert.deepEqual(hls, { durationSec: 100, fps: 25 });
    const none = await subs.videoFactsFor({ upstream: { url: cdnSite.url, kind: 'file' } }, { hash: false });
    assert.deepEqual(none, {});
    saveConfig({ subtitles: { useMovieHash: false } });
    resetMovieHashCache();
    const off = await subs.videoFactsFor(stream);
    assert.equal(off.moviehash, undefined);
    assert.equal(cdnSite.hits.length, 2, 'no request when the setting is off');
    saveConfig({ subtitles: { useMovieHash: true } });
  } finally {
    await cdnSite.close();
  }
});

test('hits that name another film, year or episode are not search results', () => {
  const heat = { title: 'Heat', year: 1995, kind: 'movie' };
  assert.equal(matchesTarget({ title: 'Heat', release: 'Heat.1995.1080p.BluRay.x264' }, heat).ok, true);
  assert.equal(matchesTarget({ title: 'Heat (1995)' }, heat).ok, true);
  assert.equal(matchesTarget({ title: 'Heat', release: 'Heat.NL.srt' }, heat).ok, true, 'a hit without a year is kept');
  assert.match(matchesTarget({ title: 'Heat Wave', year: 2022 }, heat).reason, /2022 is not 1995/);
  assert.match(matchesTarget({ title: 'Heat Wave' }, heat).reason, /more than "Heat"/);
  assert.match(matchesTarget({ title: 'Heat Wave', year: 2022 }, { title: 'Heat' }).reason, /more than "Heat"/);
  assert.equal(matchesTarget({ title: 'Heat Wave', year: 1996 }, heat).ok, true, 'a year that agrees vouches for a longer title');
  assert.match(matchesTarget({ title: 'Dead Heat', release: 'Dead.Heat.1988' }, heat).reason, /1988 is not 1995/);
  assert.match(matchesTarget({ title: 'Casino', release: 'Casino.1995.1080p' }, heat).reason, /does not name "Heat"/);
  assert.equal(matchesTarget({ title: 'Casino', hashMatch: true }, heat).ok, true, 'the file hash outranks the name');
  // 1080p is not a year; a remaster's year next to the original is tolerated.
  assert.equal(yearInRelease('Heat.1080p.BluRay'), null);
  assert.equal(yearInRelease('Heat.1995.1080p'), 1995);
  assert.equal(matchesTarget({ title: 'Heat', release: 'Heat.1996.DVDRip' }, heat).ok, true);
  // Long titles tolerate a missing "Part One"; a different entry does not pass.
  const mi = { title: 'Mission: Impossible – Dead Reckoning Part One', year: 2023, kind: 'movie' };
  assert.equal(matchesTarget({ title: 'Mission: Impossible - Dead Reckoning', year: 2023 }, mi).ok, true);
  assert.equal(matchesTarget({ title: 'Mission: Impossible - Fallout', year: 2018 }, mi).ok, false);
  // Series: the episode must agree, the year is ignored (the show's year is not the episode's).
  const bb = { title: 'Breaking Bad', kind: 'series', season: 1, episode: 2, year: 2008 };
  assert.deepEqual(episodeInRelease('Breaking.Bad.S01E02.720p'), { season: 1, episode: 2 });
  assert.deepEqual(episodeInRelease('breaking bad 1x02'), { season: 1, episode: 2 });
  assert.equal(matchesTarget({ title: 'Breaking Bad', release: 'Breaking.Bad.S01E02.2009.720p' }, bb).ok, true);
  assert.match(matchesTarget({ title: 'Breaking Bad', release: 'Breaking.Bad.S01E03.720p' }, bb).reason, /S01E03/);
});

test('the search drops the unrelated hits and says how many', async () => {
  const detailed = await subs.searchSubtitlesDetailed({ title: 'Heat', year: 1995, kind: 'movie', languages: ['nl'] });
  assert.deepEqual(detailed.results.map((r) => r.release).sort(), ['a-half', 'b-drift', 'c-good']);
  assert.equal(detailed.dropped, 3);
  assert.equal(detailed.droppedExamples.length, 3);
  assert.equal(detailed.relaxed, null, 'the exact search found hits: no second search');
  assert.equal(detailed.attempts.length, 1);
  assert.match(detailed.droppedExamples.join('\n'), /Heat\.Wave\.2022.*2022 is not 1995/);
  assert.match(detailed.droppedExamples.join('\n'), /Casino.*does not name "Heat"/);
  const plain = await subs.searchSubtitles({ title: 'Heat', year: 1995, kind: 'movie', languages: ['nl'] });
  assert.equal(plain.length, 3);
});

test('looser spellings of a title, loosest last, never the title itself', () => {
  assert.deepEqual(relaxedTitles('Heat'), []);
  assert.deepEqual(relaxedTitles('Léon: The Professional (Director\'s Cut)'), ['Leon The Professional', 'Leon']);
  assert.deepEqual(relaxedTitles('Mission: Impossible – Dead Reckoning Part One'),
    ['Mission Impossible Dead Reckoning Part One', 'Mission Impossible Dead Reckoning', 'Mission Impossible']);
  assert.deepEqual(relaxedTitles('Alien: Romulus'), ['Alien Romulus', 'Alien']);
  assert.deepEqual(relaxedTitles('Fast & Furious 7'), ['Fast And Furious 7']);
  assert.deepEqual(relaxedTitles(''), []);
});

/** A provider that answers only some query strings — what a strict title finds nothing at. */
async function pickySite(answers) {
  const queries = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/search') {
      const q = url.searchParams.get('q') || '';
      queries.push(q);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ subtitles: answers[q] || [] }));
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(makeSrt(6000));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, queries, close: () => new Promise((r) => server.close(r)) };
}

test('an empty search is run again with a looser title until something matches', async (t) => {
  const picky = await pickySite({
    // Only the bare "Leon" is indexed; the hit itself names the film and year.
    Leon: [
      { url: '/files/leon.srt', title: 'Léon: The Professional', release: 'Leon.The.Professional.1994.1080p', language: 'nl' },
      { url: '/files/leon2.srt', title: 'Leon', release: 'Leon.2015.WEB', language: 'nl' },
    ],
  });
  t.after(async () => { useOnlyFakeProvider(site.base); await picky.close(); });
  useOnlyFakeProvider(picky.base);
  const found = await subs.searchSubtitlesDetailed({ title: 'Léon: The Professional', year: 1994, kind: 'movie', languages: ['nl'] });
  assert.deepEqual(picky.queries, ['Léon: The Professional', 'Léon: The Professional', 'Leon The Professional', 'Leon']);
  assert.equal(found.relaxed, 'as "Leon"');
  assert.deepEqual(found.query, { title: 'Leon', year: null });
  assert.equal(found.results.length, 1, 'the title check still applies to the looser search');
  assert.equal(found.results[0].release, 'Leon.The.Professional.1994.1080p');
  assert.equal(found.dropped, 1);
  assert.equal(found.attempts.length, 4);
  assert.deepEqual(found.attempts.map((a) => a.relaxed), [null, 'without the year', 'as "Leon The Professional"', 'as "Leon"']);

  // Last resort for a film: the year is no longer required of the hits.
  picky.queries.length = 0;
  const other = await pickySite({ Heat: [{ url: '/files/h.srt', title: 'Heat', release: 'Heat.DVDRip.2008', language: 'nl' }] });
  t.after(() => other.close());
  useOnlyFakeProvider(other.base);
  const heat = await subs.searchSubtitlesDetailed({ title: 'Heat', year: 1995, kind: 'movie', languages: ['nl'] });
  assert.equal(other.queries.length, 3, 'exact, without the year, year ignored — "Heat" has no looser spelling');
  assert.match(heat.relaxed, /year is no longer required/);
  assert.equal(heat.results.length, 1);
  // A series never gets that step, and nothing found stays nothing found.
  other.queries.length = 0;
  const show = await subs.searchSubtitlesDetailed({ title: 'Cold Case', kind: 'series', season: 1, episode: 1, year: 2003, languages: ['nl'] });
  assert.equal(show.results.length, 0);
  assert.deepEqual(other.queries, ['Cold Case', 'Cold Case'], 'exact and without the year; no year-ignored step for a series');
  assert.equal(show.relaxed, 'without the year');
  assert.equal(show.attempts.length, 2);
});

test('videoSummaryFor reads the probe into one line of facts', () => {
  assert.equal(subs.videoSummaryFor({ upstream: { url: 'http://x/a.mkv' } }), null);
  const summary = subs.videoSummaryFor({
    upstream: {
      url: 'http://x/a.mkv', kind: 'file', label: 'Heat.1995.1080p.BluRay.x264-GRP',
      probe: {
        container: 'matroska,webm', durationSec: 10200.5, sizeBytes: 8e9, bitrate: 6274000,
        video: { codec: 'h264', profile: 'High', width: 1920, height: 1080, fps: 25, avgFps: 23.976, bitrate: 5600000, hdr: false, interlaced: false },
        audio: [{ codec: 'eac3', channels: 6, language: 'eng' }, { codec: 'aac', channels: 2, language: 'nld' }],
        subtitles: [{ codec: 'subrip', language: 'nld' }],
      },
    },
  });
  assert.equal(summary.resolution, '1920×1080');
  assert.equal(summary.videoCodec, 'h264');
  assert.equal(summary.fps, 23.976);
  assert.equal(summary.nominalFps, 25);
  assert.equal(summary.bitrate, 6274000);
  assert.equal(summary.audioCodec, 'eac3');
  assert.equal(summary.audioChannels, 6);
  assert.equal(summary.audioTracks, 2);
  assert.equal(summary.subtitleTracks, 1);
  assert.equal(summary.container, 'matroska,webm');
  assert.equal(summary.durationSec, 10200.5);
  assert.equal(summary.label, 'Heat.1995.1080p.BluRay.x264-GRP');
});

/* ------------------------------------------------------------------ 4. through the HTTP API */

test('the search and attach routes use the stream\'s video facts', async (t) => {
  const store = await import('../src/streams/store.js');
  const { createApp } = await import('../src/http/server.js');
  const file = Buffer.alloc(500000, 9);
  const cdnSite = await cdn(file);
  const app = createApp();
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  t.after(async () => { await new Promise((r) => server.close(r)); await cdnSite.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  resetMovieHashCache();
  const stream = await store.createStream({
    title: 'Heat', year: 1995, kind: 'movie',
    candidate: { url: cdnSite.url, kind: 'file', probe: { durationSec: 6300, video: { codec: 'h264', fps: 25, avgFps: 25 } } },
  });
  const post = async (url, body) => {
    const res = await fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const search = await post('/api/subtitles/search', { streamId: stream.id, languages: ['nl'] });
  assert.equal(search.status, 200);
  assert.equal(search.data.target.durationSec, 6300);
  assert.equal(search.data.target.fps, 25);
  assert.equal(search.data.target.moviehash, movieHashFromBuffer(file));
  assert.equal(search.data.results.length, 3);
  assert.equal(search.data.dropped, 3, 'the Heat Wave / Dead Heat / Casino hits are not offered');
  assert.equal(search.data.video.durationSec, 6300);
  assert.equal(search.data.video.fps, 25);
  assert.equal(search.data.video.videoCodec, 'h264');
  const drift = search.data.results.find((r) => r.release === 'b-drift');
  assert.ok(drift && Array.isArray(drift.notes));

  const attached = await post(`/api/playlist/items/${stream.id}/subtitle`, { result: drift, language: 'nl' });
  assert.equal(attached.status, 200, JSON.stringify(attached.data));
  assert.ok(attached.data.adjustment, 'the drifted file is rescaled on attach');
  assert.ok(Math.abs(attached.data.adjustment.scale - 23.976 / 25) < 1e-3);
  assert.equal(attached.data.check.verdict, 'suspect');
  const half = search.data.results.find((r) => r.release === 'a-half');
  const attachedHalf = await post(`/api/playlist/items/${stream.id}/subtitle`, { result: half, language: 'nl' });
  assert.equal(attachedHalf.data.check.verdict, 'bad');
  assert.equal(attachedHalf.data.adjustment, null);
  assert.match(attachedHalf.data.check.reasons.join(' '), /CD 1 of 2/);
});
