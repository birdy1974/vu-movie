/**
 * Stream token lifetime and movie-length learning.
 *
 * - A token lifetime of 0 means the token never expires; a stored expiry from
 *   an older setting is ignored. Ephemeral previews keep their own short TTL.
 * - TOKEN_TTL_MINUTES overrides a value saved in the config file (checked in a
 *   child process so the real config loader runs).
 * - A clean end of ffmpeg is recognised as the real end once the movie's length
 *   is known: the length is probed (injected here) and kept on the stream, and
 *   the playhead of a resumed run counts from the movie's start.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-lifetime-'));
process.env.CONFIG_FILE = path.join(directory, 'vumovie.json');
process.env.LOG_LEVEL = 'error';
delete process.env.TOKEN_TTL_MINUTES;
delete process.env.PROBE_DURATION;

const config = await import('../src/core/config.js');
config.loadConfig();
const { getConfig } = config;
const store = await import('../src/streams/store.js');
const relay = await import('../src/streams/relay.js');

const configUrl = pathToFileURL(path.resolve(here, '../src/core/config.js')).href;

/** The token lifetime a fresh process loads, given a config file and env overrides. */
function ttlInFreshProcess({ file = null, env = {} } = {}) {
  const childEnv = { ...process.env, LOG_LEVEL: 'error' };
  delete childEnv.TOKEN_TTL_MINUTES;
  delete childEnv.PROBE_DURATION;
  childEnv.CONFIG_FILE = file || path.join(directory, `none-${Math.random().toString(36).slice(2)}.json`);
  Object.assign(childEnv, env);
  const script = `const c = await import(${JSON.stringify(configUrl)});`
    + 'c.loadConfig();'
    + 'process.stdout.write(String(c.getConfig().app.tokenTtlMinutes));';
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: childEnv, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return Number(res.stdout.trim());
}

function savedConfigWithTtl(minutes) {
  const file = path.join(directory, `saved-${minutes}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ app: { tokenTtlMinutes: minutes } }));
  return file;
}

const candidate = (extra = {}) => ({ url: 'https://cdn.example/movie.mp4', sourceId: 'cinejoy', kind: 'file', quality: '1080p', headers: { Cookie: 'sig=1' }, ...extra });
const longAgo = () => new Date(Date.now() - 3 * 24 * 3600e3).toISOString();

/* ------------------------------------------------------------ token lifetime */

test('the default token lifetime is 0: tokens never expire', () => {
  assert.equal(ttlInFreshProcess(), 0);
});

test('TOKEN_TTL_MINUTES overrides a value saved in the config file; a blank value does not', () => {
  const file = savedConfigWithTtl(4320);
  assert.equal(ttlInFreshProcess({ file }), 4320, 'the saved setting applies when the env var is absent');
  assert.equal(ttlInFreshProcess({ file, env: { TOKEN_TTL_MINUTES: '0' } }), 0, 'the env var wins over the file');
  assert.equal(ttlInFreshProcess({ file, env: { TOKEN_TTL_MINUTES: '' } }), 4320, 'a blank env var is ignored');
});

test('with lifetime 0 a stored past expiry is ignored, so an old stream keeps playing', async () => {
  getConfig().app.tokenTtlMinutes = 0;
  const rec = await store.createStream({ title: 'Old Stream', year: 2024, candidate: candidate(), expires_at: longAgo() });
  const loaded = await store.getStream(rec.id);
  assert.equal(loaded.expired, undefined, 'not flagged as expired');
  assert.equal(store.tokenExpiresAt(loaded), null, 'no expiry applies');
});

test('a positive lifetime still expires a stored token, as before', async () => {
  getConfig().app.tokenTtlMinutes = 4320;
  const expiry = longAgo();
  const rec = await store.createStream({ title: 'Three Day Stream', year: 2024, candidate: candidate(), expires_at: expiry });
  const loaded = await store.getStream(rec.id);
  assert.equal(loaded.expired, true);
  assert.equal(store.tokenExpiresAt(loaded), expiry);
  getConfig().app.tokenTtlMinutes = 0;
});

test('ephemeral previews keep their own expiry whatever the token lifetime', async () => {
  getConfig().app.tokenTtlMinutes = 0;
  const expiry = longAgo();
  const preview = await store.createStream({ title: 'Preview', year: 2024, candidate: candidate(), ephemeral: true, expires_at: expiry });
  const loaded = await store.getStream(preview.id);
  assert.equal(loaded.expired, true);
  assert.equal(store.tokenExpiresAt(loaded), expiry);
});

/* ------------------------------------------------------ movie length learning */

test('the movie length is taken from the learned value first, then the candidate probe', () => {
  assert.equal(relay.knownDurationSec({ upstream: { durationSec: 90.07 } }), 90.07);
  assert.equal(relay.knownDurationSec({ upstream: { probe: { durationSec: 120 } } }), 120);
  assert.equal(relay.knownDurationSec({ upstream: { durationSec: 90, probe: { durationSec: 120 } } }), 90);
  assert.equal(relay.knownDurationSec({ upstream: {} }), null);
  assert.equal(relay.knownDurationSec(null), null);
});

test('a resumed run counts the playhead from the start of the movie', () => {
  // ffmpeg restarted at 88 s and has played 2 s since: the movie is at 90 s.
  const session = { resumeSeconds: 88, stats: { outTimeMs: 2000 } };
  assert.equal(relay.playheadSeconds(session), 90);
  // Without the offset the end of a 90-second movie is never recognised.
  assert.equal(relay.decideRestart({ clients: 1, restarts: 1, code: 0, outTimeMs: 2000, durationSec: 90.07 }).restart, true);
  const genuine = relay.decideRestart({ clients: 1, restarts: 1, code: 0, outTimeMs: relay.playheadSeconds(session) * 1000, durationSec: 90.07 });
  assert.equal(genuine.restart, false);
  assert.match(genuine.reason, /genuine end/);
});

test('a movie length is learned only for a clean end that someone watches, and only when unknown', () => {
  const watching = { clients: new Set([1]), restarts: 0, stream: { upstream: {} } };
  getConfig().transcode.probeDuration = true;
  assert.equal(relay.shouldLearnDuration(watching, { code: 0, signal: null }), true);
  assert.equal(relay.shouldLearnDuration(watching, { code: 1, signal: null }), false, 'a failure restarts without a probe');
  assert.equal(relay.shouldLearnDuration(watching, { code: null, signal: 'SIGTERM' }), false, 'a deliberate stop');
  assert.equal(relay.shouldLearnDuration({ ...watching, clients: new Set() }, { code: 0 }), false, 'nobody is watching');
  assert.equal(relay.shouldLearnDuration({ ...watching, stream: { upstream: { durationSec: 90 } } }, { code: 0 }), false, 'already known');
  assert.equal(relay.shouldLearnDuration({ ...watching, restarts: 3 }, { code: 0 }), false, 'no restart would follow');
  getConfig().transcode.probeDuration = false;
  assert.equal(relay.shouldLearnDuration(watching, { code: 0 }), false, 'PROBE_DURATION=false skips the probe');
  getConfig().transcode.probeDuration = true;
});

test('learnMovieDuration probes the upstream with its headers and keeps the length on the stream', async () => {
  getConfig().app.tokenTtlMinutes = 0;
  const rec = await store.createStream({ title: 'Probe Me', year: 2024, candidate: candidate({ probe: null }) });
  const calls = [];
  const session = { id: 'up-test', stream: rec, upProxy: null };
  const learned = await relay.learnMovieDuration(session, {
    probe: async (url, opts) => { calls.push({ url, opts }); return { durationSec: 90.0734 }; },
  });
  assert.equal(learned, 90.07, "rounded to centiseconds");
  assert.equal(calls[0].url, 'https://cdn.example/movie.mp4');
  assert.equal(calls[0].opts.headers.Cookie, 'sig=1', 'the upstream headers are replayed');
  assert.equal(session.stream.upstream.durationSec, 90.07, 'this session uses it at once');
  const stored = await store.getStream(rec.id);
  assert.equal(relay.knownDurationSec(stored), 90.07, 'and it is kept for later plays');
  assert.equal(stored.upstream.probe, null, 'the candidate probe itself is not touched');
});

test('learnMovieDuration probes the proxied input when a proxy serves the movie', async () => {
  const rec = await store.createStream({ title: 'Via Proxy', year: 2024, candidate: candidate({ probe: null }) });
  const calls = [];
  const session = { id: 'up-proxy', stream: rec, upProxy: { inputUrl: 'http://127.0.0.1:1/up/abc/f' } };
  await relay.learnMovieDuration(session, { probe: async (url, opts) => { calls.push({ url, opts }); return { durationSec: 600 }; } });
  assert.equal(calls[0].url, 'http://127.0.0.1:1/up/abc/f');
  assert.deepEqual(calls[0].opts.headers, {}, 'the local proxy needs no CDN headers');
});

test('when the length cannot be learned nothing is stored and the restart rule stays as it was', async () => {
  const rec = await store.createStream({ title: 'Unprobeable', year: 2024, candidate: candidate({ probe: null }) });
  const learned = await relay.learnMovieDuration({ id: 'up-none', stream: rec, upProxy: null }, { probe: async () => null });
  assert.equal(learned, null);
  const stored = await store.getStream(rec.id);
  assert.equal(relay.knownDurationSec(stored), null);
});
