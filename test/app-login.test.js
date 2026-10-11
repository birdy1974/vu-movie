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

test('a username without a password is “no login”, not a locked one', async () => {
  // From a fresh install the operator types a username into an empty password
  // field. Enforcing that would lock the UI behind a password nobody can type,
  // so the pair is saved as entered and simply stays switched off.
  await putConfig({ app: { username: '', password: '' } }, null);

  const saved = await putConfig({ app: { username: 'birdy' } }, null);
  assert.equal(saved.status, 200, 'the save is accepted — nothing is wrong with it');
  assert.deepEqual(config.validateConfigPatch({ app: { username: 'birdy' } }), [], 'and it is not reported as a problem');
  assert.equal(config.getConfig().app.username, 'birdy', 'the username is kept as typed');
  assert.equal(config.getConfig().app.password, '');
  assert.equal(await status('/api/config', null), 200, 'the UI stays open instead of locking everybody out');
  assert.equal(await status('/', null), 200, 'including the web interface itself');

  // Adding the password is what switches the same username on.
  const on = await putConfig({ app: { username: 'birdy', password: 's3cret' } }, null);
  assert.equal(on.status, 200);
  assert.equal(await status('/api/config', null), 401);
  login = 'birdy:s3cret';
  assert.equal(await status('/api/config'), 200);

  // …and emptying it switches the login off again, keeping the username.
  const off = await putConfig({ app: { username: 'birdy', password: '' } });
  assert.equal(off.status, 200);
  assert.equal(config.getConfig().app.username, 'birdy', 'the username survives');
  assert.equal(await status('/api/config', null), 200, 'no password, no login');

  // The same rule through the flat dotted spelling an API client may use, and
  // for a password that has no username to go with it.
  assert.deepEqual(config.validateConfigPatch({ 'app.username': 'birdy' }), []);
  assert.deepEqual(config.validateConfigPatch({ app: { password: 'orphan' } }), []);
  assert.equal(await status('/api/config', null), 200, 'a password without a username is no login either');
});

test('authState() is the single rule the middleware and the boot log share', async () => {
  const { authState } = await import('../src/http/server.js');
  const of = (username, password) => authState({ app: { username, password } });

  assert.deepEqual(of('', ''), { login: false, text: 'open on the LAN (no username set)' });
  assert.deepEqual(of('birdy', ''), { login: false, text: 'open on the LAN (a username is set but no password, so no login is asked for)' });
  assert.deepEqual(of('', 's3cret'), { login: false, text: 'open on the LAN (no username set)' });
  assert.equal(of('birdy', 's3cret').login, true);
  assert.match(of('birdy', 's3cret').text, /basic auth enabled/);
});
