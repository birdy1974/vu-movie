/** Subtitle text handling: encodings, cleaning, timing, scoring, providers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  decodeSubtitle, cleanSrt, countCues, vttToSrt, applyOffset, scoreResult,
  normaliseLang, extractSubtitleFromBuffer, isZip,
} from '../src/subtitles/util.js';
import { listProviders, parseAddic7edRows, parseTvsubsSeason, parseTvsubsEpisode } from '../src/subtitles/index.js';


/* ------------------------------------------------------------------ *
 * Minimal ZIP writer for the archive tests (stored + deflate entries).
 * ------------------------------------------------------------------ */
function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.body, 'utf8');
    const data = entry.deflate ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const SRT = `1
00:00:01,000 --> 00:00:03,000
Hello there

2
00:00:04,500 --> 00:00:06,000
<i>General Kenobi</i>
`;

test('decodeSubtitle detects UTF-8 and the CP1252/DOS codepages the subs use', () => {
  const utf8 = decodeSubtitle(Buffer.from('café — déjà vu', 'utf8'));
  assert.equal(utf8.text, 'café — déjà vu');

  // 0xe9 is 'é' in CP1252 but an invalid standalone UTF-8 sequence
  const cp1252 = decodeSubtitle(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  assert.equal(cp1252.text, 'café');
  assert.ok(/1252|iso-8859/.test(cp1252.encoding), `encoding was ${cp1252.encoding}`);

  const bom = decodeSubtitle(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi', 'utf8')]));
  assert.equal(bom.text, 'hi');
  assert.equal(bom.encoding, 'utf-8-bom');
});

test('cleanSrt normalises line endings and strips styling', () => {
  const dirty = '1\r\n00:00:01,000 --> 00:00:02,000\r\n{\\an8}<font color="#fff">Hi</font>\r\n';
  const clean = cleanSrt(dirty);
  assert.ok(!clean.includes('\r'));
  assert.ok(!clean.includes('{\\an8}'));
  assert.ok(!clean.includes('<font'));
  assert.ok(clean.includes('Hi'));
  assert.equal(countCues(clean), 1);
});

test('applyOffset shifts every timestamp and can go negative safely', () => {
  const shifted = applyOffset(SRT, 1000);
  assert.ok(shifted.includes('00:00:02,000 --> 00:00:04,000'));
  const clamped = applyOffset(SRT, -5000);
  const stamps = clamped.split('\n').filter((l) => l.includes('-->'));
  assert.ok(stamps.every((l) => !/(^|\s)-\d/.test(l)), `negative timestamp survived: ${stamps.join(' | ')}`);
  assert.ok(stamps[0].startsWith('00:00:00,000'), `expected clamping to zero, got ${stamps[0]}`);
  assert.equal(applyOffset(SRT, 0), SRT);
});

test('vttToSrt converts a WebVTT track', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n\n00:00:03.000 --> 00:00:04.000\nWorld';
  const srt = vttToSrt(vtt);
  assert.ok(srt.includes('00:00:01,000 --> 00:00:02,000'));
  assert.equal(countCues(srt), 2);
});

test('language preference beats download counts', () => {
  const target = { title: 'Dune Part Two', year: 2024, languages: ['nl', 'en'], release: 'Dune.Part.Two.2024.1080p.WEB-DL' };
  const nl = scoreResult({ language: 'nl', title: 'Dune Part Two', release: 'Dune.Part.Two.2024.1080p.WEB-DL', downloads: 100 }, target);
  const en = scoreResult({ language: 'en', title: 'Dune Part Two', release: 'Dune.Part.Two.2024.1080p.WEB-DL', downloads: 90000 }, target);
  assert.ok(nl > en, `Dutch (${nl}) should beat English (${en}) when Dutch is preferred`);
});

test('matching the release name raises the score', () => {
  const target = { title: 'Oppenheimer', year: 2023, languages: ['en'], release: 'Oppenheimer.2023.2160p.WEB-DL.DDP5.1.HEVC' };
  const good = scoreResult({ language: 'en', title: 'Oppenheimer', release: 'Oppenheimer.2023.2160p.WEB-DL.DDP5.1.HEVC', hashMatch: true }, target);
  const vague = scoreResult({ language: 'en', title: 'Oppenheimer', release: 'random.subs', downloads: 5 }, target);
  assert.ok(good > vague + 20);
});

test('normaliseLang maps the dialects the providers send', () => {
  assert.equal(normaliseLang('dut'), 'nl');
  assert.equal(normaliseLang('Dutch'), 'nl');
  assert.equal(normaliseLang('eng'), 'en');
  assert.equal(normaliseLang('NL-nl'), 'nl');
  assert.equal(normaliseLang('pt-BR'), 'pt');
});

test('subtitle archives are unpacked without external tools', () => {
  const zip = buildZip([{ name: 'movie.nl.srt', body: '1\n00:00:01,000 --> 00:00:02,000\nHallo\n' }]);
  assert.ok(isZip(zip));
  const out = extractSubtitleFromBuffer(zip);
  assert.ok(out, 'expected the srt to be extracted');
  assert.equal(out.filename, 'movie.nl.srt');
  assert.ok(out.text.includes('Hallo'));

  // a deflate-compressed entry (what most provider archives use)
  const deflated = buildZip([{ name: 'movie.en.srt', body: '1\n00:00:01,000 --> 00:00:02,000\nHello\n', deflate: true }]);
  const out2 = extractSubtitleFromBuffer(deflated);
  assert.ok(out2.text.includes('Hello'));

  // an archive without any subtitle is reported, not thrown
  assert.equal(extractSubtitleFromBuffer(buildZip([{ name: 'readme.txt', body: 'nothing here' }])), null);
});

test('provider registry exposes the documented providers', () => {
  const providers = listProviders();
  const ids = providers.map((p) => p.id);
  for (const expected of ['opensubtitles-org', 'opensubtitles-com', 'subdl', 'podnapisi', 'tvsubtitles', 'addic7ed', 'tvsubs']) {
    assert.ok(ids.includes(expected), `missing provider ${expected} (got ${ids.join(', ')})`);
  }
  assert.ok(providers.every((p) => Array.isArray(p.languages) && typeof p.enabled === 'boolean'));
  // Addic7ed is gated on the free-account credentials (anonymous downloads are
  // throttled to nothing), so without credentials it is present but disabled.
  const addic7ed = providers.find((p) => p.id === 'addic7ed');
  assert.equal(addic7ed.enabled, false, 'addic7ed stays off until ADDIC7ED_USER/PASS are set');
  assert.ok(addic7ed.note.includes('account'), 'the note tells the operator what is needed');
});

test('parseAddic7edRows reads the show-page season table', () => {
  // Reconstruction of the live /show/<id> table: one <tr> per subtitle file,
  // season/episode cells + /serie/ link, a language cell, a release cell and
  // the /updated/<langId>/<fileId>/<n> download link.
  const html = `
    <table><tr><td>S</td><td>E</td><td>Title</td><td>Language</td><td>Version</td></tr>
    <tr>
      <td>4</td><td>1</td>
      <td class="NewsTitle"><a href="/serie/True_Detective/4/1/Night_Country">Night Country - Part 1</a></td>
      <td class="language">English</td><td class="re_version">HMAX-NTb</td><td>Completed</td>
      <td>&nbsp;</td><td>&nbsp;</td>
      <td class="download"><a href="/updated/1/187824/0">Download</a></td>
    </tr>
    <tr>
      <td>4</td><td>1</td>
      <td class="NewsTitle"><a href="/serie/True_Detective/4/1/Night_Country">Night Country - Part 1</a></td>
      <td class="language">Dutch</td><td class="re_version">1080p.WEB.h264-ETHEL</td><td>Completed</td>
      <td class="download"><a href="/updated/17/187824/4">Download</a></td>
    </tr>
    <tr><td>no download link here — a layout row, must be skipped</td></tr>
    </table>`;
  const rows = parseAddic7edRows(html);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    season: 4, episode: 1, title: 'Night Country - Part 1', language: 'en',
    release: 'HMAX-NTb', url: 'https://www.addic7ed.com/updated/1/187824/0',
  });
  assert.equal(rows[1].language, 'nl', 'the language name wins over guessing');
  assert.equal(rows[1].release, '1080p.WEB.h264-ETHEL');
  assert.equal(rows[1].url, 'https://www.addic7ed.com/updated/17/187824/4');
});

test('parseTvsubsSeason pairs episode numbers with their per-language pages', () => {
  // Reconstruction of the live tvshow-<id>-<season>.html episode list: flag
  // links episode-<epId>-<lang>.html, then "NN. <a href=episode-<epId>.html>".
  const html = `
    <ul>
      <li><a href="episode-107732-en.html"><img src="images/flags/en.gif" /></a>
          <a href="subtitle-289726.html"><img src="images/flags/bg.gif" /></a>
          01. <a href="episode-107732.html"><b>The Great War and Modern Memory</b></a></li>
      <li><a href="episode-107733-en.html"><img src="images/flags/en.gif" /></a>
          <a href="episode-107733-nl.html"><img src="images/flags/nl.gif" /></a>
          02. <a href="episode-107733.html"><b>Kiss Tomorrow Goodbye</b></a></li>
    </ul>`;
  const { episodes, langs } = parseTvsubsSeason(html);
  assert.deepEqual([...episodes.entries()], [[1, '107732'], [2, '107733']]);
  assert.deepEqual(langs.get('107732'), ['en'], 'the bg flag links a subtitle page, not a language page');
  assert.deepEqual(langs.get('107733'), ['en', 'nl']);
});

test('parseTvsubsEpisode lists the subtitle files of an episode-language page', () => {
  const html = `
    <b>English subtitles</b>
    <ul>
      <li><a href="subtitle-247178.html">True.Detective.S03E01.720p.Web-DL.NTb.en.srt</a></li>
      <li><a href="subtitle-247179.html">True.Detective.S03E01.720p.Web-DL.NTb.en.srt <img src="images/hearingimpaired.svg" alt="HI"/></a></li>
    </ul>`;
  const entries = parseTvsubsEpisode(html);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, '247178');
  assert.equal(entries[0].release, 'True.Detective.S03E01.720p.Web-DL.NTb.en.srt');
  assert.equal(entries[1].id, '247179');
});
