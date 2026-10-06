/**
 * Integration test for the web-preview relay session.
 *
 * The unit tests pin the decision; this one runs the real `relay.ensureSession`
 * against a stub ffmpeg and reads the command line it would have executed. That
 * is the only way to test the two claims that matter to the operator:
 *
 *   - a preview session drops every subtitle, while the VLC session for the
 *     same stream still gets the template (and its `-c:s srt`) it was assigned;
 *   - the preview session is its own output slot (`web`, no template id), so no
 *     per-item template can leak into the browser output.
 *
 * The stub can never encode anything, which is fine: only the argv is asserted,
 * and the session is stopped as soon as it is returned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-web-preview-'));
const argvLog = path.join(tempDir, 'ffmpeg-argv.log');
process.env.CONFIG_FILE = path.join(tempDir, 'vumovie.json');
process.env.TMP_DIR = path.join(tempDir, 'tmp');

// A stub "ffmpeg" that records its arguments and exits. It is installed before
// media.js is imported (FFMPEG_PATH is read at import time), so the whole relay
// path is exercised — hardware self-test included, which just fails fast here
// and leaves the session on the software encoder.
const stub = path.join(tempDir, 'ffmpeg-stub.sh');
fs.writeFileSync(stub, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}
if [ "$1" = "-version" ]; then echo "ffmpeg version 9.9-stub"; fi
exit 0
`, { mode: 0o755 });
process.env.FFMPEG_PATH = stub;
process.env.FFPROBE_PATH = stub;

const config = await import('../src/core/config.js');
const { createStream } = await import('../src/streams/store.js');
const relay = await import('../src/streams/relay.js');
const media = await import('../src/core/media.js');

const VLC_TEMPLATE = 'ffmpeg -i <url> -map 0:v:0 -map 1:s:0? -c:v copy -c:a copy -c:s srt -f matroska pipe:1';

/** Give the stub ffmpeg a moment to run before the session is stopped. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

const PROBE_H264_AAC = {
  container: 'matroska,webm',
  durationSec: 7200,
  video: { codec: 'h264', width: 1920, height: 1080, fps: 23.976 },
  audio: [{ codec: 'aac', channels: 2, language: 'eng' }],
  subtitles: [{ codec: 'subrip', language: 'nld' }],
};

async function makeStream(probe, title) {
  return createStream({
    title,
    year: 2021,
    candidate: {
      url: 'https://cdn.example.com/movie.mkv',
      kind: 'file',
      headers: { Referer: 'https://site/' },
      probe,
      meta: { title },
    },
  });
}

test('the web preview session is subtitle-free, template-free and keeps the stream profile settings', async (t) => {
  config.saveConfig({
    transcode: {
      ffmpegTemplates: [{
        id: 'tpl-vlc', name: 'VLC with subtitles', enabled: true, container: 'matroska', command: VLC_TEMPLATE,
      }],
      ffmpegDefaults: { vlcTs: 'tpl-vlc' },
      defaultFfmpegTemplateId: 'tpl-vlc',
    },
  });

  const stream = await makeStream(PROBE_H264_AAC, 'Web preview H264');
  // The item carries the VLC template — that is exactly what must not reach the
  // browser.
  assert.equal(stream.profile.ffmpegTemplateId, 'tpl-vlc');
  // The temp dir (and with it the ffmpeg stub) must outlive every test in this
  // file: the last test reads the argv log and only then deletes it.
  t.after(() => relay.stopAll('test cleanup'));

  const session = await relay.ensureSession(stream, {
    container: 'mpegts',
    outputType: 'web',
    web: { reported: true, videoCodecs: ['avc1'], audioCodecs: ['mp4a'] },
  });

  assert.equal(session.web, true);
  assert.equal(session.outputType, 'web');
  assert.equal(session.templateId, '', 'no per-output template may drive a preview');
  assert.equal(session.container, 'mpegts');
  assert.equal(session.mode, 'copy', 'H.264 + AAC and a browser that plays both is a plain remux');

  const args = session.args;
  assert.ok(args.includes('-sn'), 'the preview never muxes subtitles');
  assert.ok(args.includes('-dn'));
  assert.ok(!args.includes('-c:s'), 'no subtitle codec on the preview command line');
  assert.ok(!args.some((a) => /^0:s/.test(a) || /^1:s/.test(a)), 'no subtitle stream is mapped');
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
  assert.equal(args[args.indexOf('-f') + 1], 'mpegts');
  assert.equal(args[args.length - 1], 'pipe:1');
  assert.ok(session.command.includes('-re'), 'live playback stays paced');

  // The decision is published on the session so the UI can explain it.
  assert.equal(session.webDecisions.subtitles, 'dropped');
  assert.equal(session.webDecisions.video.action, 'copy');
  assert.ok(relay.publicSession(session).web, 'the API exposes the preview flag');

  await settle();
  relay.stopSession(stream.id, 'test done');

  // The same stream on the VLC slot still uses the operator's template, with
  // its subtitle track: the web override is scoped to preview sessions only.
  const vlc = await relay.ensureSession(stream, { container: 'matroska', outputType: 'vlcTs' });
  assert.equal(vlc.web, false);
  assert.equal(vlc.templateId, 'tpl-vlc');
  assert.ok(vlc.command.includes('-c:s srt'), 'the VLC session keeps its subtitle mapping');
  await settle();
  relay.stopSession(stream.id, 'test done');
});

test('a preview replaces a running VLC session instead of inheriting it', async (t) => {
  config.saveConfig({ transcode: { ffmpegTemplates: [], defaultFfmpegTemplateId: '', ffmpegDefaults: {} } });
  const stream = await makeStream(PROBE_H264_AAC, 'Web preview switch');
  t.after(() => relay.stopAll('test cleanup'));

  const vlc = await relay.ensureSession(stream, { container: 'mpegts', outputType: 'vlcTs' });
  assert.equal(vlc.web, false);
  await settle();
  const preview = await relay.ensureSession(stream, {
    container: 'mpegts',
    outputType: 'web',
    web: { reported: true, videoCodecs: ['avc1'], audioCodecs: ['mp4a'] },
  });

  assert.notEqual(preview.id, vlc.id, 'a pipe session cannot change output, so the preview gets its own');
  assert.equal(preview.web, true);
  // The stopped VLC session may still be draining its child; what matters is
  // that it is no longer registered and cannot fan the receiver's stream out to
  // the browser.
  assert.equal(relay.getSession(stream.id).id, preview.id);
  assert.equal(relay.listSessions().filter((s) => s.streamId === stream.id).length, 1,
    'only the preview session is registered for the stream');
  assert.ok(!relay.listSessions().some((s) => s.streamId === stream.id && s.outputType === 'vlcTs'),
    'the VLC session was stopped, not left to race the preview');
  await settle();
  relay.stopSession(stream.id, 'test done');
});

test('a browser without codecs the source uses gets a transcoded preview', async (t) => {
  config.saveConfig({ transcode: { ffmpegTemplates: [], defaultFfmpegTemplateId: '', ffmpegDefaults: {} } });
  const hevc = { ...PROBE_H264_AAC, video: { codec: 'hevc', width: 3840, height: 2160, fps: 23.976 } };
  const stream = await makeStream(hevc, 'Web preview HEVC');
  t.after(() => relay.stopAll('test cleanup'));

  const session = await relay.ensureSession(stream, {
    container: 'mpegts',
    outputType: 'web',
    web: { reported: true, videoCodecs: ['avc1'], audioCodecs: ['mp4a'] },
  });

  assert.equal(session.mode, 'transcode');
  assert.ok(['libx264', 'h264_vaapi'].includes(session.args[session.args.indexOf('-c:v') + 1]));
  assert.ok(session.args.includes('-sn'));
  assert.ok(!session.args.includes('-c:s'));
  assert.equal(session.webDecisions.video.source, 'hevc');
  assert.equal(session.webDecisions.video.target, 'h264');
  await settle();
  relay.stopSession(stream.id, 'test done');
});

test('the stub recorded the preview command lines (test harness sanity)', () => {
  const lines = fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length >= 5, `the stub ffmpeg was actually spawned (${lines.length} calls)`);
  assert.equal(media.ffmpegPath(), stub, 'the stub is the resolved ffmpeg binary');
  // The proof the whole file rests on, read off the real argv vectors: every
  // preview call carried -sn and never a subtitle codec, while the VLC call
  // still carried the template's subtitle mapping.
  const previews = lines.filter((line) => line.includes(' -sn '));
  assert.equal(previews.length, 3, `three preview command lines were recorded (got ${previews.length})`);
  assert.ok(previews.every((line) => !line.includes('-c:s') && !line.includes('0:s') && !line.includes('1:s')),
    'no preview command line ever asked for or mapped a subtitle stream');
  assert.ok(lines.some((line) => line.includes('-c:s srt')), 'the VLC call kept the operator template’s subtitle track');
  assert.ok(lines.some((line) => line.includes('-f matroska')), 'and the VLC call kept the template’s container');
  fs.rmSync(tempDir, { recursive: true, force: true });
});
