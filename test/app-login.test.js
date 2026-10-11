/**
 * Settings → Application: the login for the web interface.
 *
 * The credentials are editable while the container is running, so they have to
 * be enforced while it is running too — a password that only becomes real after
 * a `docker compose restart` is a password nobody trusts. This walks the whole
 * round trip through the real HTTP server the way the Settings tab does it (a
 * PUT, then the next request) and checks that
 *
 *   • a login entered in Settings is required from the very next request on,
 *   • the token-protected endpoints (VLC, receiver, IPTV apps, health) stay
 *     reachable without it — those clients cannot send a password,
 *   • changing the password, and clearing the username, apply at once too,
 *   • a username without a password is refused before it can lock the UI.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-app-login-'));
process.env.CONFIG_FILE = path.join(dir, 'vumovie.json');
process.env.LOG_LEVEL = 'error';
// The login under test is entered through the API, not inherited from the shell.
delete process.env.APP_USERNAME;
delete process.env.APP_PASSWORD;

const config = await import('../src/core/config.js');
const playlist = await import('../src/playlist/index.js');
const { createApp } = await import('../src/http/server.js');

const server = await new Promise((resolve) => {
  const listener = createApp().listen(0, '127.0.0.1', () => resolve(listener));
});
const base = `http://127.0.0.1:${server.address().port}`;
const playlistToken = playlist.token();
after(() => new Promise((resolve) => server.close(resolve)));

/** The login the operator has entered so far — every later request carries it. */
let login = null;

const headers = (extra = {}) => {
  const out = { ...extra };
  if (login) out.authorization = `Basic ${Buffer.from(login).toString('base64')}`;
  return out;
};
const status = async (urlPath, as) => {
  const res = await fetch(base + urlPath, { headers: as === null ? {} : headers() });
  return res.status;
};
const putConfig = async (patch, as = login) => {
  const res = await fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(patch),
  });
  assert.ok(!as || res.status !== 401, 'a Settings save with the correct login must not be rejected');
  return res;
};

test('the UI starts open when no username is configured', async () => {
  assert.equal(config.getConfig().app.username, '');
  assert.equal(await status('/api/config'), 200);
});

test('a login entered in Settings is required by the very next request — no restart', async () => {
  // Exactly what Settings → Application sends when both fields are filled in.
  const saved = await putConfig({ app: { username: 'birdy', password: 's3cret' } }, null);
  assert.equal(saved.status, 200);
  login = 'birdy:s3cret';

  assert.equal(await status('/api/config', null), 401, 'the UI/API is closed from here on');
  assert.equal(await status('/api/config'), 200, 'the entered pair is the one that works');
  assert.equal(await status('/api/streams'), 200);

  // A wrong pair is refused even though the browser offers it: the point of
  // the login is that guessing does not get you in.
  const wrong = await fetch(`${base}/api/config`, { headers: { authorization: `Basic ${Buffer.from('birdy:wrong').toString('base64')}` } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('www-authenticate'), 'Basic realm="vu-movie"', 'so the browser shows its own login dialog');
});

test('VLC, the receiver and IPTV apps keep working without the password', async () => {
  // An unknown token answers 404 and a playlist/health request answers 200 —
  // either is fine, what matters is that none of them answers 401: those
  // clients carry an unguessable path instead of a password.
  for (const urlPath of ['/s/no-such-token/Arrival.ts', '/dl/no-such-token/Arrival.ts', '/hls/no-such-token/index.m3u8', '/up/no-such-secret/x']) {
    assert.notEqual(await status(urlPath, null), 401, `${urlPath} must not ask for the login`);
  }
  assert.equal(await status('/api/health', null), 200, 'the container healthcheck cannot authenticate either');
  assert.equal(await status(`/pl/${playlistToken}/playlist.m3u`, null), 200);
  assert.equal(await status(`/xtream/${playlistToken}/get.php`, null), 200);
});

test('changing the password takes effect without a restart too', async () => {
  const saved = await putConfig({ app: { username: 'birdy', password: 'n3w-pass' } });
  assert.equal(saved.status, 200);
  const old = await fetch(`${base}/api/config`, { headers: { authorization: `Basic ${Buffer.from('birdy:s3cret').toString('base64')}` } });
  assert.equal(old.status, 401, 'the old password stops working');
  login = 'birdy:n3w-pass';
  assert.equal(await status('/api/config'), 200);
});

test('clearing the username opens the UI again', async () => {
  // A masked password field is never sent back, so this is the whole patch.
  const saved = await putConfig({ app: { username: '' } });
  assert.equal(saved.status, 200);
  login = null;
  assert.equal(await status('/api/config'), 200, 'no username means no login');
  assert.equal(config.getConfig().app.password, 'n3w-pass', 'the stored password is untouched');
});

test('a username without a password is refused instead of locking the UI', async () => {
  // The lock only happens when there is no password to fall back on: from a
  // fresh install the operator types a username into an empty password field,
  // and the form has no mask to send back.
  const cleared = await putConfig({ app: { username: '', password: '' } }, null);
  assert.equal(cleared.status, 200, 'clearing both switches the login off — that is not a lock');
  assert.equal(config.getConfig().app.password, '', 'an emptied password field really clears it');

  const rejected = await putConfig({ app: { username: 'birdy' } }, null);
  assert.equal(rejected.status, 400, 'the Settings tab has to report it, not save it');
  assert.match((await rejected.json()).error, /password/i);
  assert.equal(config.getConfig().app.username, '', 'the half-login was not applied');
  assert.equal(await status('/api/config', null), 200, 'and the UI stayed reachable');

  // The same rule through the flat dotted spelling an API client may use.
  assert.deepEqual(config.validateConfigPatch({ 'app.username': 'birdy' }), [
    'Application password: a username without a password locks the web interface for everybody, including you — enter a password as well, or clear the username to leave the UI open on the LAN.',
  ]);
  // Both fields together is fine, and so is a username that keeps the stored
  // password — the mask the form sends back means “unchanged”.
  config.saveConfig({ app: { username: 'birdy', password: 's3cret' } });
  assert.deepEqual(config.validateConfigPatch({ app: { username: 'other' } }), []);
  assert.deepEqual(config.validateConfigPatch({ app: { username: 'other', password: '••••••••' } }), []);
  assert.equal(config.validateConfigPatch({ app: { password: '' } }).length, 1, 'emptying the password is a lock too');
  assert.deepEqual(config.validateConfigPatch({ app: { username: '' } }), [], 'clearing the username is always allowed — it switches the login off');
  // …and a login saved directly (an operator's own script) still protects the UI.
  assert.equal(await status('/api/config', null), 401);
});
