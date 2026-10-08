/**
 * The Xtream account is editable from Settings → Xtream Codes.
 *
 * That is one config option on the way in and four on the way out (the player
 * API login, the M3U+ link, the playback path an IPTV app stores, and the
 * Stream tab panel that shows the credentials), so this walks the whole round
 * trip through the real HTTP server instead of checking the config object.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-xtream-account-'));
process.env.CONFIG_FILE = path.join(dir, 'vumovie.json');
process.env.LOG_LEVEL = 'error';
// The account under test comes from the API, not from the shell.
delete process.env.XTREAM_USERNAME;
delete process.env.XTREAM_PASSWORD;

const config = await import('../src/core/config.js');
const store = await import('../src/streams/store.js');
const playlist = await import('../src/playlist/index.js');
const { createApp } = await import('../src/http/server.js');

const MASK = '••••••••';

const server = await new Promise((resolve) => {
  const app = createApp();
  const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
});
const base = `http://127.0.0.1:${server.address().port}`;
const token = playlist.token();
after(() => new Promise((resolve) => server.close(resolve)));

const stream = await store.createStream({
  title: 'Arrival',
  kind: 'movie',
  year: 2026,
  candidate: { url: 'https://cdn.example/Arrival.mkv', sourceId: 'xtream-account-test' },
});
await playlist.saveItems([{ streamId: stream.id, enabled: true }]);

const json = async (url, options = {}) => {
  const res = await fetch(url, options);
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
};
const putConfig = (patch) => json(`${base}/api/config`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(patch),
});
const playerApi = (params) => json(`${base}/xtream/${token}/player_api.php?${new URLSearchParams(params)}`);

test('the default account is “vumovie” with the playlist token as its password', async () => {
  const published = await json(`${base}/api/playlist`);
  assert.equal(published.body.urls.xtream.username, 'vumovie');
  assert.equal(published.body.urls.xtream.password, token, 'an empty password means the token doubles as it');

  const before = await playerApi({ username: 'vumovie', password: token });
  assert.equal(before.status, 200);
  assert.equal(before.body.user_info.auth, 1);
});

test('Settings can set the Xtream account, and every output follows it', async () => {
  const saved = await putConfig({ playlist: { xtreamUsername: 'tivimate', xtreamPassword: 's3cret-pass_1' } });
  assert.equal(saved.status, 200, 'the Settings save is accepted');
  assert.equal(saved.body.config.playlist.xtreamUsername, 'tivimate');
  assert.equal(saved.body.config.playlist.xtreamPassword, MASK, 'the response masks the new password like every other secret');
  assert.equal(config.getConfig().playlist.xtreamPassword, 's3cret-pass_1', 'the running config keeps the real password');
  assert.equal(JSON.parse(fs.readFileSync(process.env.CONFIG_FILE, 'utf8')).playlist.xtreamPassword, 's3cret-pass_1', 'and so does the file a restart reads');

  const published = await json(`${base}/api/playlist`);
  assert.equal(published.body.urls.xtream.username, 'tivimate', 'the Stream tab shows the new account');
  assert.equal(published.body.urls.xtream.password, 's3cret-pass_1', 'the Stream tab keeps showing the password in clear text');
  assert.equal(published.body.urls.xtream.get.includes(`username=tivimate&password=${encodeURIComponent('s3cret-pass_1')}`), true, 'the M3U+ link carries the new account');

  const vod = await playerApi({ action: 'get_vod_streams', username: 'tivimate', password: 's3cret-pass_1' });
  assert.equal(vod.status, 200);
  assert.equal(vod.body[0].direct_source.includes(`/movie/tivimate/${encodeURIComponent('s3cret-pass_1')}/`), true, 'catalogue links are built from the configured account');

  const playback = await fetch(vod.body[0].direct_source, { redirect: 'manual' });
  assert.equal(playback.status, 302, 'the new account plays');

  const stalePassword = await fetch(vod.body[0].direct_source.replace('/s3cret-pass_1/', `/${token}/`), { redirect: 'manual' });
  assert.equal(stalePassword.status, 401, 'the old (token) password stops working');

  const wrongUser = await playerApi({ username: 'vumovie', password: 's3cret-pass_1' });
  assert.equal(wrongUser.body.user_info.auth, 0, 'the previous username is rejected');
});

test('a save that posts the mask back keeps the stored password', async () => {
  // The Settings form sends the whole card, including the masked field it
  // could not display. Writing the mask over the password would lock the
  // account with a password nobody knows.
  const saved = await putConfig({ playlist: { xtreamUsername: 'tivimate', xtreamPassword: MASK } });
  assert.equal(saved.status, 200);
  assert.equal(config.getConfig().playlist.xtreamPassword, 's3cret-pass_1', 'the mask means “unchanged”');
  assert.equal(saved.body.config.playlist.xtreamPassword, MASK);

  const playback = await playerApi({ action: 'get_vod_streams', username: 'tivimate', password: 's3cret-pass_1' });
  assert.equal(playback.body[0].direct_source.includes('/s3cret-pass_1/'), true);
});

test('a password that cannot travel in an URL is rejected before it is saved', async () => {
  for (const bad of ['with space', 'with/slash', 'with%percent', 'with#hash', 'with?query']) {
    const rejected = await putConfig({ playlist: { xtreamPassword: bad } });
    assert.equal(rejected.status, 400, `“${bad}” must be refused`);
    assert.match(rejected.body.error, /Xtream password/);
    assert.equal(config.getConfig().playlist.xtreamPassword, 's3cret-pass_1', `“${bad}” must not be stored`);
  }
  assert.deepEqual(config.validateConfigPatch({ 'playlist.xtreamUsername': 'bad name' }), [
    'Xtream username: cannot contain spaces — IPTV apps put the account in a URL.',
  ], 'the flat dotted spelling is validated too');
  assert.deepEqual(config.validateConfigPatch({ playlist: { xtreamPassword: '' } }), [], 'empty is allowed: the token doubles as the password');
});

test('an environment variable still wins over the saved account', () => {
  process.env.XTREAM_USERNAME = 'env-user';
  process.env.XTREAM_PASSWORD = 'env-pass';
  config.loadConfig();
  assert.equal(config.getConfig().playlist.xtreamUsername, 'env-user');
  assert.equal(config.getConfig().playlist.xtreamPassword, 'env-pass', 'documented precedence: environment → file → defaults');
  delete process.env.XTREAM_USERNAME;
  delete process.env.XTREAM_PASSWORD;
  config.loadConfig();
  assert.equal(config.getConfig().playlist.xtreamUsername, 'tivimate', 'the value saved from Settings survives the reload');
  assert.equal(config.getConfig().playlist.xtreamPassword, 's3cret-pass_1');
});

test('the password can be cleared again, back to the token', async () => {
  const saved = await putConfig({ playlist: { xtreamUsername: 'vumovie', xtreamPassword: '' } });
  assert.equal(saved.status, 200);
  assert.equal(config.getConfig().playlist.xtreamPassword, '');
  const playback = await playerApi({ action: 'get_vod_streams', username: 'vumovie', password: token });
  assert.equal(playback.status, 200);
  assert.equal(playback.body[0].direct_source.includes(`/vumovie/${token}/`), true);
});

test('the settings response never carries the password in clear text', async () => {
  await putConfig({ playlist: { xtreamPassword: 'another-secret' } });
  const res = await fetch(`${base}/api/config`);
  const body = await res.json();
  assert.equal(body.config.playlist.xtreamPassword, MASK);
  assert.equal(JSON.stringify(body).includes('another-secret'), false, 'GET /api/config masked the Xtream password');
  assert.equal(config.getConfig().playlist.xtreamPassword, 'another-secret');
});
