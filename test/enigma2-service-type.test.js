/**
 * The receiver's service type — which player on the box opens a bouquet entry —
 * and the container that player can actually demux.
 *
 * The bouquet cannot rename its link: the service-ref encoding strips query
 * strings, so every entry points at `{slug}.ts.enigma2`. Whether Matroska bytes
 * on that reference play at all is therefore decided by the service type:
 * 5002 (ServiceApp exteplayer3) carries its own demuxers and is the only player
 * that also shows a soft subtitle track, while GStreamer (4097 / 5001) shows a
 * black screen and leaves the movie again — which the relay logs as "receiver
 * left" and which looks exactly like a relay bug.
 *
 * This file covers the whole path that keeps those two settings honest:
 *   1. the service type is a validated choice (config + bouquet + Settings UI);
 *   2. `matroskaOnBoxAdvice` answers the same question everywhere it is asked;
 *   3. the relay's container-mismatch line names the template and the player,
 *      and is only a warning when the box cannot play the result;
 *   4. the APIs that bind a template to the Enigma2 output answer `warnings`,
 *      so the operator hears it while saving instead of while zapping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-e2-service-type-'));
process.env.CONFIG_FILE = path.join(tempDir, 'vumovie.json');
process.env.TMP_DIR = path.join(tempDir, 'tmp');
process.env.LOG_LEVEL = 'error';

const config = await import('../src/core/config.js');
const enigma2 = await import('../src/enigma2/index.js');
const { default: api } = await import('../src/http/api.js');
const { default: playlistApi } = await import('../src/playlist/api.js');
const relay = await import('../src/streams/relay.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

async function requestJson(base, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, json: await response.json() };
}

/* ---------------- the service type itself ---------------- */

test('the four service types are described, and only they are accepted', () => {
  assert.equal(config.describeEnigma2ServiceType(4097).player, 'gstreamer');
  assert.equal(config.describeEnigma2ServiceType(5001).player, 'gstreamer');
  assert.equal(config.describeEnigma2ServiceType(5002).player, 'exteplayer3');
  assert.equal(config.describeEnigma2ServiceType(5002).matroska, true,
    'exteplayer3 demuxes Matroska itself — the only way a soft subtitle track shows on the box');
  assert.equal(config.describeEnigma2ServiceType(4097).matroska, false);
  assert.equal(config.describeEnigma2ServiceType(1).player, 'dvb');

  // Settings offers exactly these, and says what each one plays.
  assert.deepEqual(config.ENIGMA2_SERVICE_TYPE_VALUES, [4097, 5001, 5002, 1]);
  for (const type of config.ENIGMA2_SERVICE_TYPE_VALUES) {
    const service = config.describeEnigma2ServiceType(type);
    assert.match(service.label, new RegExp(`^${type} — `), 'the label starts with the number the operator types');
    assert.ok(service.note.length > 10, 'every choice explains what it can play');
  }
});

test('an unknown service type falls back to 4097 instead of reaching the bouquet', () => {
  assert.equal(config.normaliseEnigma2ServiceType('5002'), 5002, 'a string from the environment or a form is a number');
  assert.equal(config.normaliseEnigma2ServiceType(5001), 5001);
  assert.equal(config.normaliseEnigma2ServiceType(4098), 4097, 'a typo does not produce entries Enigma2 refuses to play');
  assert.equal(config.normaliseEnigma2ServiceType(''), 4097);
  assert.equal(config.normaliseEnigma2ServiceType(undefined, 5002), 5002, 'the caller may choose the fallback');
  assert.equal(config.describeEnigma2ServiceType(4098).unknown, true, 'and the fallback is reported as one');
});

test('the Settings save rejects a service type no player answers to', () => {
  assert.deepEqual(config.validateConfigPatch({ enigma2: { serviceType: 4098 } }).length, 1);
  const problem = config.validateConfigPatch({ 'enigma2.serviceType': 'gstreamer' })[0];
  assert.match(problem, /Receiver service type/);
  assert.match(problem, /4097, 5001, 5002, 1/, 'the refusal names every accepted value');
  for (const type of [4097, 5001, 5002, 1]) {
    assert.deepEqual(config.validateConfigPatch({ enigma2: { serviceType: type } }), [], `${type} is accepted`);
    assert.deepEqual(config.validateConfigPatch({ enigma2: { serviceType: String(type) } }), [], `${type} is accepted as the string a form posts`);
  }
  // Untouched means untouched: a Settings save posts the whole form, so an
  // absent/empty value must not be read as a refusal.
  assert.deepEqual(config.validateConfigPatch({ enigma2: { host: '10.0.0.9' } }), []);
  assert.deepEqual(config.validateConfigPatch({ enigma2: { serviceType: '' } }), []);
});

test('ENIGMA2_SERVICE_TYPE outranks a value saved from Settings, like every other receiver option', () => {
  // The documented precedence is file < environment; without the override in
  // envOverrides() a type saved from the UI silently beat the compose file.
  const source = fs.readFileSync(path.join(import.meta.dirname, '../src/core/config.js'), 'utf8');
  assert.match(source, /set\('enigma2\.serviceType', normaliseEnigma2ServiceType\(process\.env\.ENIGMA2_SERVICE_TYPE/);
});

/* ---------------- the bouquet ---------------- */

test('the bouquet writes the configured service type and says which player that is', () => {
  const entries = [{ title: 'Kraken', year: 2026, url: 'http://nas:8080/s/tok/kraken.ts.enigma2' }];

  const exteplayer = enigma2.buildBouquet({ name: 'vu-movie', serviceType: 5002, entries });
  assert.match(exteplayer.text, /^#NAME vu-movie \(TV\)\n#SERVICE 5002:0:1:/m);
  assert.equal(exteplayer.serviceType, 5002);
  assert.equal(exteplayer.player, 'ServiceApp exteplayer3');

  const builtin = enigma2.buildBouquet({ name: 'vu-movie', serviceType: 4097, entries });
  assert.match(builtin.text, /#SERVICE 4097:0:1:/);
  assert.equal(builtin.player, 'Enigma2 built-in (GStreamer)');

  const typo = enigma2.buildBouquet({ name: 'vu-movie', serviceType: 4098, entries });
  assert.equal(typo.serviceType, 4097, 'a hand-edited config cannot write an unplayable reference');
  assert.match(typo.text, /#SERVICE 4097:0:1:/);

  // serviceRef normalises on its own too: it is exported and used directly.
  assert.match(enigma2.serviceRef({ url: 'http://nas/x.ts', name: 'X', type: 5001 }), /^#SERVICE 5001:0:1:/);
  assert.match(enigma2.serviceRef({ url: 'http://nas/x.ts', name: 'X', type: 1234 }), /^#SERVICE 4097:0:1:/);
});

test('the bouquet preview reports the player and what it can demux', () => {
  config.saveConfig({ enigma2: { serviceType: 5002, autoPush: false } });
  const preview = enigma2.previewBouquet([{ title: 'Kraken', url: 'http://nas:8080/s/tok/kraken.ts.enigma2' }]);
  assert.equal(preview.serviceType, 5002);
  assert.equal(preview.player, 'ServiceApp exteplayer3');
  assert.match(preview.serviceNote, /Matroska/);
  assert.match(preview.text, /#SERVICE 5002:0:1:/);
  config.saveConfig({ enigma2: { serviceType: 4097 } });
});

/* ---------------- the container question ---------------- */

test('Matroska on the Enigma2 output is advised against only when the box cannot play it', () => {
  assert.equal(enigma2.matroskaOnBoxAdvice({ container: 'mpegts', serviceType: 4097 }), null,
    'MPEG-TS plays on every service type');
  assert.equal(enigma2.matroskaOnBoxAdvice({ container: 'matroska', serviceType: 5002 }), null,
    'exteplayer3 demuxes Matroska itself');
  assert.equal(enigma2.matroskaOnBoxAdvice({ container: '', serviceType: 4097 }), null);

  for (const type of [4097, 5001]) {
    const advice = enigma2.matroskaOnBoxAdvice({ container: 'matroska', serviceType: type });
    assert.match(advice, /black screen/, `${type} is GStreamer: the symptom is named`);
    assert.match(advice, /5002/, 'and so is the setting that fixes it');
    assert.match(advice, /MPEG-TS template/, 'as is the other one');
  }
  assert.match(enigma2.matroskaOnBoxAdvice({ container: 'mkv', serviceType: 1 }), /DVB service does not play an HTTP stream/);

  // No explicit type means the configured one — that is how the relay asks.
  config.saveConfig({ enigma2: { serviceType: 5002 } });
  assert.equal(enigma2.matroskaOnBoxAdvice({ container: 'matroska' }), null);
  config.saveConfig({ enigma2: { serviceType: 4097 } });
  assert.match(enigma2.matroskaOnBoxAdvice({ container: 'matroska' }), /service type 4097/);
});

test('the relay’s mismatch line names the template, and its level follows the box’s player', () => {
  const asked = { expectedFormat: 'mpegts', templateName: 'Kraken MKV', templateId: 'mkv-1' };

  assert.equal(relay.containerMismatchNote({ ...asked, actualFormat: 'mpegts', outputType: 'enigma2' }), null,
    'nothing to say when the bytes match the URL');
  assert.equal(relay.containerMismatchNote({ ...asked, actualFormat: '', outputType: 'enigma2' }), null);

  // A GStreamer box: this is the black screen, so it warns and says what to do.
  const gstreamer = relay.containerMismatchNote({ ...asked, actualFormat: 'matroska', outputType: 'enigma2', serviceType: 4097 });
  assert.equal(gstreamer.level, 'warn');
  assert.match(gstreamer.message, /Kraken MKV/, 'the template is named in the message the Logs page shows');
  assert.match(gstreamer.message, /service type 4097/);
  assert.match(gstreamer.message, /5002/);
  assert.equal(gstreamer.fields.player, 'Enigma2 built-in (GStreamer)');
  assert.equal(gstreamer.fields.writes, 'matroska');

  // exteplayer3: the same bytes play, so this is information, not a warning.
  const exteplayer = relay.containerMismatchNote({ ...asked, actualFormat: 'matroska', outputType: 'enigma2', serviceType: 5002 });
  assert.equal(exteplayer.level, 'info');
  assert.match(exteplayer.message, /so this plays/);
  assert.equal(exteplayer.fields.serviceType, 5002);

  // Every other slot keeps the "players are told the truth" wording — a
  // Matroska template on the VLC .ts link is a supported choice, not a fault.
  const vlc = relay.containerMismatchNote({ ...asked, actualFormat: 'matroska', outputType: 'vlcTs' });
  assert.equal(vlc.level, 'warn');
  assert.match(vlc.message, /the vlcTs URL asked for mpegts/);
  assert.match(vlc.message, /labelled matroska, so players are told the truth/);
  assert.equal(vlc.fields.serviceType, undefined, 'a desktop slot has nothing to do with the box’s player');

  // The service type comes from the live config when the caller does not pass it.
  config.saveConfig({ enigma2: { serviceType: 5002 } });
  assert.equal(relay.containerMismatchNote({ ...asked, actualFormat: 'matroska', outputType: 'enigma2' }).level, 'info');
  config.saveConfig({ enigma2: { serviceType: 4097 } });
  assert.equal(relay.containerMismatchNote({ ...asked, actualFormat: 'matroska', outputType: 'enigma2' }).level, 'warn');
});

/* ---------------- the APIs answer before the operator zaps ---------------- */

test('binding a Matroska template to the Enigma2 output is reported at save time', async (t) => {
  config.saveConfig({
    subtitles: { autoSearch: false },
    enigma2: { autoPush: false, ftpEnabled: false, serviceType: 4097 },
    transcode: { ffmpegTemplates: [], defaultFfmpegTemplateId: '', ffmpegDefaults: {} },
  });

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', api);
  // The playlist router is mounted by server.js, not by the api router.
  app.use('/api/playlist', playlistApi);
  const server = http.createServer(app);
  const base = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const mkvTemplate = {
    id: 'mkv-box', name: 'Box Matroska', container: 'matroska',
    command: 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -c:v copy -f matroska pipe:1',
    output: { enigma2: 'mkv-box' },
  };
  const tsTemplate = {
    id: 'ts-box', name: 'Box MPEG-TS', container: 'mpegts',
    command: 'ffmpeg -i <url> -map 0:v:0 -map 0:a:0? -c:v libx264 -preset veryfast -f mpegts pipe:1',
    output: {},
  };

  // The global per-output default: every stream without its own binding runs it.
  const saved = await requestJson(base, '/ffmpeg/templates', {
    method: 'PUT',
    body: { templates: [mkvTemplate, tsTemplate], defaultFfmpegTemplateId: '', ffmpegDefaults: { enigma2: 'mkv-box' } },
  });
  assert.equal(saved.response.status, 200, 'the binding is accepted — ServiceApp may hand 4097 to exteplayer3, which vu-movie cannot see');
  assert.equal(saved.json.warnings.length, 1);
  assert.match(saved.json.warnings[0], /Box Matroska/);
  assert.match(saved.json.warnings[0], /black screen/);

  // The same library with an MPEG-TS template on that slot says nothing.
  const quiet = await requestJson(base, '/ffmpeg/templates', {
    method: 'PUT',
    body: { templates: [mkvTemplate, tsTemplate], defaultFfmpegTemplateId: '', ffmpegDefaults: { enigma2: 'ts-box' } },
  });
  assert.deepEqual(quiet.json.warnings, []);

  // And so does the Matroska binding once the box plays with exteplayer3.
  config.saveConfig({ enigma2: { serviceType: 5002 } });
  const exteplayer = await requestJson(base, '/ffmpeg/templates', {
    method: 'PUT',
    body: { templates: [mkvTemplate, tsTemplate], defaultFfmpegTemplateId: '', ffmpegDefaults: { enigma2: 'mkv-box' } },
  });
  assert.deepEqual(exteplayer.json.warnings, [], '5002 demuxes Matroska: nothing to warn about');
  config.saveConfig({ enigma2: { serviceType: 4097 } });

  // Per-stream: the profile save answers the same advice for its own binding.
  const created = await requestJson(base, '/streams', {
    method: 'POST',
    body: {
      title: 'Kraken',
      candidate: { url: 'https://cdn.example.test/kraken.mp4?sig=ab12&expires=1791117426', kind: 'file', quality: '1080p' },
      profile: {},
    },
  });
  assert.equal(created.response.status, 200);
  const streamId = created.json.stream.id;

  const profile = await requestJson(base, `/streams/${streamId}/profile`, {
    method: 'POST',
    body: { profile: { ...(created.json.stream.profile || {}), outputTemplates: { enigma2: 'mkv-box' } } },
  });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.json.warnings.length, 1);
  assert.match(profile.json.warnings[0], /Box Matroska/);

  // The bouquet preview carries it too, naming the items it concerns, and says
  // which player the entries were written for.
  await requestJson(base, '/playlist/items', { method: 'POST', body: { streamIds: [streamId] } });
  const preview = await requestJson(base, '/playlist/enigma2', { method: 'POST', body: {} });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.json.bouquet.serviceType, 4097);
  assert.equal(preview.json.bouquet.player, 'Enigma2 built-in (GStreamer)');
  assert.equal(preview.json.warnings.length, 1);
  assert.match(preview.json.warnings[0], /Kraken/);
  assert.match(preview.json.warnings[0], /Matroska/);

  // Switching the box to exteplayer3 makes the same playlist play — the advice
  // disappears instead of nagging about a working setup.
  config.saveConfig({ enigma2: { serviceType: 5002 } });
  const exteplayerPreview = await requestJson(base, '/playlist/enigma2', { method: 'POST', body: {} });
  assert.equal(exteplayerPreview.json.bouquet.serviceType, 5002);
  assert.match(exteplayerPreview.json.bouquet.text, /#SERVICE 5002:0:1:/);
  assert.deepEqual(exteplayerPreview.json.warnings, []);

  // The Settings UI lists the same four choices the server validates.
  const ui = fs.readFileSync(path.join(import.meta.dirname, '../public/app.js'), 'utf8');
  for (const type of config.ENIGMA2_SERVICE_TYPE_VALUES) {
    assert.ok(ui.includes(`value: ${type}`), `Settings offers service type ${type}`);
  }
  assert.match(ui, /ENIGMA2_SERVICE_TYPE_OPTIONS/, 'as a labelled choice, not a number to type');
});
