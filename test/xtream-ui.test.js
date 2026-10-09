/**
 * The Stream tab's Xtream card — what the user copies into an IPTV app.
 *
 * Xtream apps (OwnTV, SFVIP, TiviMate, IPTV Smarters…) build every URL from
 * the *server address* and append `/player_api.php` themselves. The card used
 * to hand out the full `player_api.php` URL as "the server address", so apps
 * requested `/xtream/<token>/player_api.php/player_api.php` and reported
 * "access denied". These guards keep the card showing the server address
 * (`/xtream/<token>`) as the thing to paste, with the full API URL labelled
 * as such. The browser code cannot run here, so like vlc-handoff.test.js this
 * guards the exact strings in the sources.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const apiJs = fs.readFileSync(path.join(root, 'src', 'playlist', 'api.js'), 'utf8');
const outputsJs = fs.readFileSync(path.join(root, 'src', 'playlist', 'outputs.js'), 'utf8');

test('the Xtream card hands out the server address, not the player_api.php URL', () => {
  const card = appJs.match(/\{ name: 'Xtream Codes',[^\n]*\}/);
  assert.ok(card, 'the Xtream Codes card exists in the Stream tab');
  assert.match(card[0], /url: xtream\.base/, 'the card URL is the server address (/xtream/<token>)');
  assert.doesNotMatch(card[0], /url: xtream\.playerApi/, 'the card URL is not the full player_api.php URL');
  assert.match(card[0], /appends \/player_api\.php itself/, 'the hint says the app appends the endpoint itself');
});

test('the Xtream tooltip no longer calls the player API URL the server address', () => {
  assert.equal(
    appJs.includes('the player API URL above is the server address'),
    false,
    'the old wrong sentence is gone',
  );
  assert.match(appJs, /Most apps append \/player_api\.php themselves, so paste the server address, not the API URL below it/);
});

test('the card still shows the full API URL, labelled as the API URL', () => {
  assert.match(appJs, /API URL \(full, for apps that accept it\): \$\{escapeHtml\(entry\.xtream\.playerApi/);
});

test('the API response exposes both the server address and the player API URL', () => {
  assert.match(apiJs, /const xtream = `\$\{String\(baseUrl \|\| ''\)\.replace\(\/\\\/\$\/, ''\)\}\/xtream\/\$\{token\}`;/);
  assert.match(apiJs, /base: xtream,/);
  assert.match(apiJs, /playerApi: `\$\{xtream\}\/player_api\.php`,/);
});

test('the public pages label the server address as what to enter in the app', () => {
  assert.match(outputsJs, /Xtream server address \(enter this in the app; it appends <code>\/player_api\.php<\/code> itself\)/);
  assert.match(outputsJs, /Server address \(enter this in TiviMate, IPTV Smarters, SFVIP, OwnTV or another Xtream app/);
});
