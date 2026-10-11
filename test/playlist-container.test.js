/**
 * The playlist hands a player a link, but the relay decides what that link
 * really delivers: an FFmpeg template bound to an output slot writes its own
 * container, whatever the URL promised. Matroska bytes labelled `video/mp2t`
 * cost an afternoon to diagnose — VLC reads the label, fails to demux, sweeps
 * its seek bar and then sits at 00:00 without ever showing a frame.
 *
 * Two promises have to hold, and this file checks both:
 *
 *   1. the response is labelled with what ffmpeg really writes (Content-Type
 *      from the finished command, not from the URL), so a link an operator
 *      already saved in VLC keeps working;
 *   2. the playlist publishes the link whose extension matches (`.mkv` instead
 *      of `.ts`), so players that trust the extension do not mis-detect either.
 *
 * A stub ffmpeg writes the magic bytes of the container it was told to write,
 * so this runs without a real ffmpeg and without a CDN.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-playlist-container-'));
const argvLog = path.join(tempDir, 'ffmpeg-argv.log');
process.env.CONFIG_FILE = path.join(tempDir, 'vumovie.json');
process.env.TMP_DIR = path.join(tempDir, 'tmp');
process.env.LOG_LEVEL = 'error';

const stub = path.join(tempDir, 'ffmpeg-stub.sh');
fs.writeFileSync(stub, [
  '#!/bin/sh',
  `printf '%s\\n' "$*" >> '${argvLog}'`,
  'if [ "$1" = "-version" ]; then echo "ffmpeg version 7.0-test"; exit 0; fi',
  // The container the command was told to write decides the magic bytes: that
  // is the only thing the tests read back, and it is what a player sniffs.
  'FMT=mpegts; PREV=""',
  'for A in "$@"; do if [ "$PREV" = "-f" ]; then FMT="$A"; fi; PREV="$A"; done',
  'case "$FMT" in',
  `  matroska) printf '\\032\\105\\337\\243' ;;`,
  `  mp4) printf '\\000\\000\\000\\040ftypisom' ;;`,
  `  *) printf '\\107\\107\\107\\107' ;;`,
  'esac',
  'exec sleep 3600',
  '',
].join('\n'), { mode: 0o755 });
process.env.FFMPEG_PATH = stub;
process.env.FFPROBE_PATH = stub;

const config = await import('../src/core/config.js');
config.loadConfig();
// Hermetic: no probing (the pre-flight check would dial a CDN), no hardware
// self-test, and no upstream proxy — the stub never reads its input.
config.saveConfig({
  transcode: { hardware: false, upstreamProxy: false },
  scraper: { probeCandidates: false },
  subtitles: { autoSearch: false },
  enigma2: { autoPush: false },
});

const store = await import('../src/streams/store.js');
const relay = await import('../src/streams/relay.js');
const playlist = await import('../src/playlist/index.js');
const { createApp } = await import('../src/http/server.js');

const server = await new Promise((resolve) => {
  const listener = createApp().listen(0, '127.0.0.1', () => resolve(listener));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  for (const id of relay.listSessions().map((s) => s.streamId)) relay.stopSession(id, 'tests done');
  await new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
});

/** The operator's own template: a Matroska file, which a player can seek in. */
const MKV_TEMPLATE = {
  id: 'mkv-copy',
  name: 'MKV copy',
  enabled: true,
  container: 'matroska',
  command: 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -c:v copy -c:a copy -f matroska pipe:1',
};
const probe = { durationSec: 5520, video: 'h264 1920x1080', audio: 'aac', container: 'mp4' };

const setTemplates = ({ templates = [], defaultId = '', defaults = {} } = {}) => config.saveConfig({
  transcode: { ffmpegTemplates: templates, defaultFfmpegTemplateId: defaultId, ffmpegDefaults: defaults },
});

async function newStream(title) {
  const stream = await store.createStream({
    title,
    kind: 'movie',
    year: 2026,
    profile: { mode: 'copy' },
    candidate: { url: 'https://cdn.example/movie.mp4', kind: 'file', headers: {}, probe, sourceId: 'test' },
  });
  await playlist.saveItems([{ streamId: stream.id, enabled: true }]);
  return stream;
}

/**
 * The first bytes of a response plus its headers — what a player sees first.
 *
 * `stream` is stopped first so the request really starts ffmpeg: a second
 * request for a stream whose session is still alive joins that session (which
 * is the whole point of the relay, but it makes the bytes depend on what the
 * previous client already took).
 */
async function openFresh(stream, urlPath, opts) {
  relay.stopSession(stream.id, 'next request');
  return open(`${base}${urlPath}`, opts);
}
async function open(url, { bytes = 4 } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': 'VLC/3.0.20' } });
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  while (got < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
  }
  await reader.cancel().catch(() => {});
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    contentDisposition: res.headers.get('content-disposition'),
    head: Buffer.concat(parts).subarray(0, bytes),
  };
}

const isMatroska = (head) => head.subarray(0, 4).toString('hex') === '1a45dfa3';
const isMpegTs = (head) => head.length > 0 && head[0] === 0x47;

/**
 * The playlist line (the URL) published for one exact entry title — the EXTINF
 * title carries the year and, for the file link, the " (seekable)" suffix.
 */
async function playlistEntryFor(entryTitle) {
  const { text } = await playlist.playlistText('http://nas:8080');
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.startsWith('#EXTINF') && line.endsWith(`,${entryTitle}`));
  return at < 0 ? null : lines[at + 1];
}

/** Every test starts from a clean relay: a live session would be reused. */
const stopAll = () => { for (const id of relay.listSessions().map((s) => s.streamId)) relay.stopSession(id, 'test done'); };

test('without a template the .ts link is MPEG-TS and the playlist publishes .ts', async (t) => {
  t.after(stopAll);
  setTemplates();
  const stream = await newStream('Plain Movie');

  const got = await openFresh(stream, `/s/${stream.token}/Plain-Movie-2026.ts`);
  assert.equal(got.status, 200);
  assert.equal(got.contentType, 'video/mp2t');
  assert.ok(isMpegTs(got.head), `expected an MPEG-TS sync byte, got ${got.head.toString('hex')}`);
  assert.equal(await playlistEntryFor('Plain Movie (2026)'), `http://nas:8080/s/${stream.token}/Plain-Movie-2026.playlist.ts`);
});

test('a Matroska template on the VLC output is served as Matroska — never as MPEG-TS', async (t) => {
  t.after(stopAll);
  // A stream created while an MKV template is the default keeps that template
  // (store.createStream bakes it into the profile), which is exactly how an
  // operator's Matroska choice reaches the `.ts` link.
  setTemplates({ templates: [MKV_TEMPLATE], defaultId: MKV_TEMPLATE.id });
  const stream = await newStream('The Odyssey');

  // The link an operator already saved in VLC: it has to keep working, which
  // means the response must stop claiming to be MPEG-TS.
  const asTs = await openFresh(stream, `/s/${stream.token}/The-Odyssey-2026.ts`);
  assert.equal(asTs.contentType, 'video/x-matroska', 'the player is told what ffmpeg really writes');
  assert.ok(isMatroska(asTs.head), `expected EBML/Matroska magic, got ${asTs.head.toString('hex')}`);

  const asMkv = await openFresh(stream, `/s/${stream.token}/The-Odyssey-2026.mkv`);
  assert.equal(asMkv.contentType, 'video/x-matroska');
  assert.ok(isMatroska(asMkv.head));

  // The session records the same truth the response is labelled with.
  const session = relay.getSession(stream.id);
  assert.equal(session.format, 'matroska');
  assert.equal(session.container, 'matroska');
});

test('the playlist publishes the .mkv link when the VLC output writes Matroska', async (t) => {
  t.after(stopAll);
  setTemplates({ templates: [MKV_TEMPLATE], defaultId: MKV_TEMPLATE.id });
  const stream = await newStream('Matroska Movie');
  assert.equal(
    await playlistEntryFor('Matroska Movie (2026)'),
    `http://nas:8080/s/${stream.token}/Matroska-Movie-2026.playlist.mkv`,
    'the extension matches the bytes, and the playlist marker sits in front of it',
  );
  // The seekable entry is the file itself, untouched by the template.
  assert.equal(await playlistEntryFor('Matroska Movie (2026) (seekable)'), `http://nas:8080/s/${stream.token}/direct.mp4`);
});

test('a per-output binding decides per slot, not globally', async (t) => {
  t.after(stopAll);
  setTemplates();
  const stream = await newStream('Bound Movie'); // created without any template
  setTemplates({ templates: [MKV_TEMPLATE], defaults: { vlcTs: MKV_TEMPLATE.id } });

  assert.equal(relay.outputContainerFor(stream, 'vlcTs', { container: 'mpegts' }), 'matroska', 'the bound slot wins');
  assert.equal(relay.outputContainerFor(stream, 'enigma2', { container: 'mpegts' }), 'mpegts', 'an unbound slot keeps what it was asked for');

  const got = await openFresh(stream, `/s/${stream.token}/Bound-Movie-2026.ts`);
  assert.equal(got.contentType, 'video/x-matroska');
  assert.ok(isMatroska(got.head));
});

test('a download is named and labelled for the container ffmpeg writes', async (t) => {
  t.after(stopAll);
  setTemplates({ templates: [MKV_TEMPLATE], defaultId: MKV_TEMPLATE.id });
  const stream = await newStream('Downloaded Movie');
  const mkv = await open(stream && `${base}/dl/${stream.token}/Downloaded-Movie-2026.mkv`);
  assert.equal(mkv.contentType, 'video/x-matroska');
  assert.match(mkv.contentDisposition || '', /\.mkv"/, 'the saved file is named for what it is');
  assert.ok(isMatroska(mkv.head));
  // A .ts download really is MPEG-TS: templates drive live playback, and the
  // label follows the command either way rather than the URL.
  const ts = await open(`${base}/dl/${stream.token}/Downloaded-Movie-2026.ts`);
  assert.equal(ts.contentType, 'video/mp2t');
  assert.match(ts.contentDisposition || '', /\.ts"/);
  assert.ok(isMpegTs(ts.head));
});

test('outputContainerFor() really is the container the relay starts', async (t) => {
  t.after(stopAll);
  setTemplates({ templates: [MKV_TEMPLATE], defaultId: MKV_TEMPLATE.id });
  const stream = await newStream('Predicted Movie');
  for (const outputType of ['vlcTs', 'vlcMkv', 'enigma2', 'download']) {
    const asked = outputType === 'vlcMkv' ? 'matroska' : 'mpegts';
    const predicted = relay.outputContainerFor(stream, outputType, { container: asked });
    const session = await relay.ensureSession(stream, { container: asked, outputType });
    assert.equal(session.container, predicted, `the relay agrees for "${outputType}"`);
    assert.equal(session.format, predicted, `and labels the response for "${outputType}"`);
    relay.stopSession(stream.id, 'next output');
  }
});

test('the seekable link is typed from the file, not from the CDN label', async (t) => {
  t.after(stopAll);
  setTemplates();
  // A CDN that lies about what it serves: octet-stream for an MP4, and
  // video/mp2t for a Matroska file. The player believes the label.
  const files = {
    '/movie.mp4': { type: 'application/octet-stream', bytes: Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(2000)]) },
    '/movie.mkv': { type: 'video/mp2t', bytes: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000)]) },
  };
  const cdn = http.createServer((req, res) => {
    const file = files[req.url.split('?')[0]];
    if (!file) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'Content-Type': file.type,
      'Content-Length': String(file.bytes.length),
      'Accept-Ranges': 'bytes',
    });
    res.end(file.bytes);
  });
  await new Promise((resolve) => cdn.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => cdn.close(resolve)));
  // The direct link only passes through the relay when the source needs the
  // proxy; otherwise the player is redirected to the CDN itself.
  config.saveConfig({ transcode: { upstreamProxy: true } });
  t.after(() => config.saveConfig({ transcode: { upstreamProxy: false } }));

  const cdnPort = cdn.address().port;
  for (const [name, expected, check] of [
    ['/movie.mp4', 'video/mp4', (head) => head.subarray(4, 8).toString('latin1') === 'ftyp'],
    ['/movie.mkv', 'video/x-matroska', isMatroska],
  ]) {
    const stream = await store.createStream({
      title: 'Direct Movie',
      kind: 'movie',
      year: 2026,
      profile: { mode: 'copy' },
      candidate: {
        url: `http://127.0.0.1:${cdnPort}${name}`,
        kind: 'file',
        headers: { Cookie: 'sid=1' }, // keeps the relay in the path
        probe,
        sourceId: 'test',
      },
    });
    // 8 bytes so the MP4 box header ("ftyp" at offset 4) is visible too.
    const got = await openFresh(stream, `/s/${stream.token}/direct${path.extname(name)}`, { bytes: 8 });
    assert.equal(got.status, 200);
    assert.equal(got.contentType, expected, `a ${path.basename(name)} the CDN calls ${files[name].type}`);
    assert.ok(check(got.head), `the file's own bytes came through: ${got.head.toString('hex')}`);
    stopAll();
  }
});

/**
 * The Xtream end point hands an IPTV app a URL and a `container_extension`,
 * and those apps build the playback URL from the extension — before a single
 * byte arrives and before any redirect is followed. The complete playlist was
 * fixed to publish the extension the relay really writes; this is the same
 * promise for the Xtream catalogue.
 */
async function xtreamCatalogue(creds = '') {
  const token = playlist.token();
  const res = await fetch(`${base}/xtream/${token}/player_api.php?action=get_live_streams${creds}`);
  assert.equal(res.status, 200, 'the catalogue is served');
  return (await res.json()).filter((item) => item.name?.startsWith('Xtream Movie'));
}

test('the Xtream catalogue names the container the relay really writes', async (t) => {
  t.after(stopAll);
  setTemplates();
  await newStream('Xtream Movie'); // created while nothing was bound …
  // … and the Matroska template is bound to the VLC output afterwards, which
  // is what Settings → per-output templates does to streams that already
  // exist. The stream's own profile still says mpegts, so only the slot knows.
  setTemplates({ templates: [MKV_TEMPLATE], defaults: { vlcTs: MKV_TEMPLATE.id } });

  const [item] = await xtreamCatalogue();
  assert.ok(item, 'the stream is in the catalogue');
  assert.equal(item.container_extension, 'mkv', 'apps build the playback URL from this field');
  assert.match(item.direct_source, /\.mkv$/, 'and play the link it is given');
  assert.match(item.vu_movie_url, /\.mkv$/);

  // Following that link really does hand out Matroska.
  const id = item.stream_id;
  const got = await open(`${base}/xtream/${playlist.token()}/live/vumovie/${playlist.token()}/${id}.mkv`);
  assert.equal(got.status, 200);
  assert.equal(got.contentType, 'video/x-matroska');
  assert.ok(isMatroska(got.head), `expected EBML/Matroska magic, got ${got.head.toString('hex')}`);
});

test('without a template the Xtream catalogue stays on .ts', async (t) => {
  t.after(stopAll);
  setTemplates();
  await newStream('Xtream Movie');

  const [item] = await xtreamCatalogue();
  assert.equal(item.container_extension, 'ts');
  assert.match(item.direct_source, /\.ts$/);
  const got = await open(`${base}/xtream/${playlist.token()}/live/vumovie/${playlist.token()}/${item.stream_id}.ts`);
  assert.equal(got.contentType, 'video/mp2t');
  assert.ok(isMpegTs(got.head));
});
