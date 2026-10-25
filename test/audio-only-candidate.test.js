/**
 * Audio-only upstreams must never be accepted as playable movies.
 *
 * Field failure (Kraken a7fc587dd3 / Tenzing 5f71810efb): a DASH→HLS bridge
 * exposed the audio AdaptationSet as its only HLS variant. ffprobe succeeded
 * with `video:none, audio:1`, the resolver marked the candidate playable, and
 * the relay's mandatory `-map 0:v:0` then killed ffmpeg three times in a row
 * ("Stream map '0:v:0' matches no streams"). A stub ffprobe reproduces the
 * probe answers; a local server reproduces the master/playlist shapes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-audio-only-'));
process.env.CONFIG_FILE = path.join(tempDir, 'vumovie.json');
process.env.LOG_LEVEL = 'error';

const probeLog = path.join(tempDir, 'probe-urls.log');
const stub = path.join(tempDir, 'ffprobe-stub.sh');
// The last argv is the input URL (buildFfprobeArgs puts it last). Rendition
// URLs containing "audio" answer like an audio-only rendition; everything
// else answers with a normal video+audio probe. Every probe is recorded.
fs.writeFileSync(stub, `#!/bin/sh
if [ "$1" = "-version" ]; then
  echo "ffprobe version 5.1.9-0+deb12u1"
  exit 0
fi
for arg do last="$arg"; done
echo "$last" >> "${probeLog}"
case "$last" in
  *audio*)
    cat <<'JSON'
{"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"6000.000000","size":"5000000"},"streams":[{"index":0,"codec_type":"audio","codec_name":"aac","channels":2}]}
JSON
    ;;
  *)
    cat <<'JSON'
{"format":{"format_name":"hls","duration":"6000.000000"},"streams":[{"index":0,"codec_type":"video","codec_name":"hevc","width":1920,"height":1080,"r_frame_rate":"24000/1001"},{"index":1,"codec_type":"audio","codec_name":"aac","channels":2}]}
JSON
    ;;
esac
exit 0
`, { mode: 0o755 });
process.env.FFMPEG_PATH = stub;
process.env.FFPROBE_PATH = stub;

const config = await import('../src/core/config.js');
config.loadConfig();
const { probeCandidates } = await import('../src/scrapers/registry.js');

const VOD_PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:7\n#EXTINF:6.0,\nseg-1.m4s\n#EXTINF:6.0,\nseg-2.m4s\n#EXT-X-ENDLIST\n';

const masters = {
  // The Kraken/Tenzing shape: one rendition, and it is audio-only.
  '/single-audio/master.m3u8': [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"',
    'audio-rendition.m3u8',
    '',
  ].join('\n'),
  // A resolution-less master whose first rendition is audio-only but whose
  // second rendition carries video: the resolver must walk to the second.
  '/mixed/master.m3u8': [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"',
    'audio-rendition.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=4000000,CODECS="hvc1.2.4"',
    'video-rendition.m3u8',
    '',
  ].join('\n'),
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (masters[url]) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end(masters[url]);
  }
  if (url.endsWith('.m3u8')) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end(VOD_PLAYLIST);
  }
  if (url.endsWith('.mp4')) {
    // Correctly-terminated small body: the preflight only needs the connection
    // to answer; the movie-size gate reads format.size from the ffprobe stub.
    const body = Buffer.alloc(1024);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) });
    return res.end(body);
  }
  res.writeHead(404).end('nope');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test('an audio-only HLS rendition is rejected, not offered as a playable movie', async () => {
  const [probed] = await probeCandidates([
    { url: `${base}/single-audio/master.m3u8`, kind: 'hls', label: 'bridge' },
  ]);
  assert.equal(probed.ok, false, 'a probe with no video stream cannot be a movie');
  assert.match(probed.error, /no video stream/);
  assert.equal(probed.probe.video, null);
  assert.equal(probed.probe.audio.length, 1);
});

test('a resolution-less master falls back to a video-bearing rendition', async () => {
  fs.writeFileSync(probeLog, '');
  const [probed] = await probeCandidates([
    { url: `${base}/mixed/master.m3u8`, kind: 'hls', label: 'bridge' },
  ]);
  assert.equal(probed.ok, true, 'the second rendition carries video, so the master is playable');
  assert.ok(probed.probe.video, 'the stored probe is the video-bearing one');
  assert.match(probed.url, /video-rendition\.m3u8$/, 'the candidate points at the verified rendition');
  assert.equal(probed.variants, null, 'an adopted rendition becomes the direct upstream');
  const probedUrls = fs.readFileSync(probeLog, 'utf8').trim().split('\n');
  assert.ok(probedUrls.some((u) => u.includes('audio-rendition')), 'the audio rendition was probed first');
  assert.ok(probedUrls.some((u) => u.includes('video-rendition')), 'the video rendition was probed as fallback');
});

test('a progressive file that probes audio-only is rejected too', async () => {
  const [probed] = await probeCandidates([
    { url: `${base}/file/audio-only.mp4`, kind: 'file', label: 'direct' },
  ]);
  assert.equal(probed.ok, false);
  assert.match(probed.error, /no video stream/);
});
