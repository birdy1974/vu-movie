/** Enigma2 bouquet generation — the exact syntax the receiver parses. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildBouquet, patchBouquetsTv, encodeE2Url, serviceRef, status, testConnection, resetStatusCache, xmlTag,
  cachedStatus, createFtpFileTransport, pushBouquet,
} from '../src/enigma2/index.js';
import { getConfig } from '../src/core/config.js';
import { getRecentLogs } from '../src/core/log.js';
import { buildM3U } from '../src/streams/export.js';
import { slugify, urlsFor } from '../src/streams/store.js';

test('encodeE2Url keeps slashes readable and encodes colons', () => {
  assert.equal(
    encodeE2Url('http://192.168.1.10:8080/s/abc123/dune.ts'),
    'http%3a//192.168.1.10%3a8080/s/abc123/dune.ts',
  );
  assert.equal(encodeE2Url('http://x/y?a=1'), 'http%3a//x/y');
});

test('serviceRef builds a valid 4097 reference', () => {
  const ref = serviceRef({ url: 'http://192.168.1.10:8080/s/tok/x.ts', name: 'Dune Part Two (2024)', type: 4097 });
  // Enigma2 service refs use upper-case hex (e.g. 22C5, 80D) — see the format docs.
  assert.match(ref, /^#SERVICE 4097:0:1:[0-9A-F]{4}:[0-9A-F]{4}:[0-9A-F]{4}:0:0:0:0:http%3a\/\//);
  assert.ok(ref.endsWith(':Dune Part Two (2024)'));
});

test('buildBouquet writes NAME, entries, descriptions and season separators', () => {
  const bouquet = buildBouquet({
    name: 'vu-movie', serviceType: 4097,
    entries: [
      { title: 'Dune Part Two', year: 2024, url: 'http://nas:8080/s/a/x.ts', subtitle: 'nld' },
      { title: 'Shōgun', series: 'Shōgun', season: 1, url: 'http://nas:8080/s/b/e1.ts' },
      { title: 'Shōgun', series: 'Shōgun', season: 1, url: 'http://nas:8080/s/b/e2.ts' },
    ],
  });
  assert.equal(bouquet.entries, 3);
  assert.equal(bouquet.fileName, 'userbouquet.vu-movie.tv');
  assert.ok(bouquet.text.startsWith('#NAME vu-movie (TV)'));
  assert.ok(bouquet.text.includes('#NAME ── Shōgun · Season 1 ──'));
  assert.equal((bouquet.text.match(/#DESCRIPTION/g) || []).length, 3);
  assert.ok(bouquet.bouquetsLine.includes('userbouquet.vu-movie.tv'));
});

test('duplicate service references are disambiguated', () => {
  const same = { title: 'Twin', url: 'http://nas:8080/s/a/x.ts' };
  const bouquet = buildBouquet({ name: 'vu-movie', entries: [same, { ...same, title: 'Twin (copy)' }] });
  const refs = bouquet.text.split('\n').filter((l) => l.startsWith('#SERVICE'));
  assert.equal(refs.length, 2);
  assert.notEqual(refs[0], refs[1], 'Enigma2 silently drops duplicate service refs');
});

test('patchBouquetsTv is idempotent', () => {
  const first = patchBouquetsTv('#NAME User - bouquets (TV)\n#SERVICE 1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "userbouquet.favourites.tv" ORDER BY bouquet\n', 'userbouquet.vu-movie.tv');
  assert.equal(first.changed, true);
  assert.ok(first.text.includes('userbouquet.vu-movie.tv'));
  const second = patchBouquetsTv(first.text, 'userbouquet.vu-movie.tv');
  assert.equal(second.changed, false);
  assert.equal((second.text.match(/userbouquet\.vu-movie\.tv/g) || []).length, 1);
});

test('patchBouquetsTv creates the file when the box has none yet', () => {
  const patched = patchBouquetsTv('', 'userbouquet.vu-movie.tv');
  assert.ok(patched.text.startsWith('#NAME User - bouquets (TV)'));
});

test('buildM3U produces a VLC friendly playlist', () => {
  const m3u = buildM3U([
    { title: 'Dune Part Two (2024)', url: 'http://nas:8080/s/a/x.ts', logo: 'http://img/p.jpg', quality: '1080p', group: 'vu-movie' },
    { title: 'Shōgun S01E01', url: 'http://nas:8080/s/b/y.ts', subtitle: '/downloads/subtitles/shogun.nl.srt' },
  ]);
  const lines = m3u.split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.ok(lines[1].startsWith('#PLAYLIST:'));
  assert.ok(m3u.includes('tvg-logo="http://img/p.jpg"'));
  assert.ok(m3u.includes('Dune Part Two (2024) [1080p]'));
  assert.ok(m3u.includes('#EXTVLCOPT:sub-file=/downloads/subtitles/shogun.nl.srt'));
  assert.ok(m3u.trim().endsWith('http://nas:8080/s/b/y.ts'));
});

test('slugify and urlsFor build safe file/URL names', () => {
  assert.equal(slugify('Shōgun: Part 1/2 (2024)'), 'Shogun-Part-1-2-2024');
  const urls = urlsFor({ id: 'abc', token: 'tok123', title: 'Dune Part Two', year: 2024, profile: { container: 'matroska' } }, 'http://nas:8080/');
  assert.equal(urls.raw, 'http://nas:8080/s/tok123/Dune-Part-Two-2024.mkv');
  assert.equal(urls.ts, 'http://nas:8080/s/tok123/Dune-Part-Two-2024.ts');
  assert.equal(urls.direct, 'http://nas:8080/s/tok123/direct.mp4');
  assert.equal(urls.watch, 'http://nas:8080/watch/tok123');
});

/** OpenWebif's /web/about, as a VU+ Duo2 answers it. */
const ABOUT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<e2abouts>
<e2about>
<e2enigmaversion>2019-11-22-master-0abcdef</e2enigmaversion>
<e2imageversion>6.2</e2imageversion>
<e2webifversion>1.4.5</e2webifversion>
<e2model>Duo\u00b2</e2model>
<e2lanip>192.168.1.20</e2lanip>
</e2about>
</e2abouts>`;

test('xmlTag reads the e2* field names OpenWebif actually returns', () => {
  assert.equal(xmlTag(ABOUT_XML, ['model', 'e2model']), 'Duo\u00b2');
  assert.equal(xmlTag(ABOUT_XML, ['e2enigmaversion', 'e2imageversion', 'image', 'version']), '2019-11-22-master-0abcdef');
  assert.equal(xmlTag('<x><version>1.2</version></x>', ['image', 'version']), '1.2');
  assert.equal(xmlTag(ABOUT_XML, ['nope']), '');
});

test('receiver status reports the model and image version', async (t) => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(ABOUT_XML, { status: 200, headers: { 'content-type': 'text/xml' } });
  };
  const cfg = getConfig().enigma2;
  const saved = { host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password };
  Object.assign(cfg, { host: '192.168.1.20', port: 80, username: '', password: '' });
  resetStatusCache();
  t.after(() => {
    globalThis.fetch = original;
    Object.assign(cfg, saved);
    resetStatusCache();
  });

  const first = await status({ timeoutMs: 1000 });
  assert.equal(first.ok, true);
  assert.equal(first.model, 'Duo\u00b2');
  assert.equal(first.version, '2019-11-22-master-0abcdef', 'the image version used to come back empty');
  assert.equal(calls, 1);

  // A healthcheck/dashboard poll reuses the answer instead of waking the box.
  const second = await status({ timeoutMs: 1000 });
  assert.equal(second.model, 'Duo\u00b2');
  assert.equal(second.cached, true);
  assert.equal(calls, 1, 'the receiver must not be polled on every health check');

  // The UI's "test connection" always asks for real.
  await status({ timeoutMs: 1000, force: true });
  assert.equal(calls, 2);
});

test('testConnection checks unsaved form values and reuses a stored password when left blank', async (t) => {
  const original = globalThis.fetch;
  const cfg = getConfig().enigma2;
  const saved = { host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, ftpEnabled: cfg.ftpEnabled, rootDir: cfg.rootDir };
  Object.assign(cfg, { host: 'saved-host', port: 80, username: 'saved-user', password: 'saved-secret', ftpEnabled: false, rootDir: '/__vu_movie_test_no_e2_mount__' });
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), headers: options.headers };
    return new Response(ABOUT_XML, { status: 200, headers: { 'content-type': 'text/xml' } });
  };
  t.after(() => {
    globalThis.fetch = original;
    Object.assign(cfg, saved);
    resetStatusCache();
  });

  const result = await testConnection({ host: '192.168.1.22', port: 8081, username: 'operator' }, { timeoutMs: 1000 });
  assert.equal(result.ok, false, 'a WebIF connection alone cannot push a bouquet without an upload transport');
  assert.equal(result.upload.configured, false, 'the connection test reports the saved upload mode too');
  assert.match(result.message, /WebIF ok/);
  assert.equal(request.url, 'http://192.168.1.22:8081/web/about');
  assert.equal(request.headers.Authorization, `Basic ${Buffer.from('operator:saved-secret').toString('base64')}`);
  assert.equal(cfg.host, 'saved-host', 'testing must not persist or mutate the receiver settings');
});

test('repeated polls do not spam INFO with an unchanged receiver', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(ABOUT_XML, { status: 200, headers: { 'content-type': 'text/xml' } });
  const cfg = getConfig().enigma2;
  const saved = { host: cfg.host, username: cfg.username };
  Object.assign(cfg, { host: '192.168.1.20', username: '' });
  resetStatusCache();
  t.after(() => {
    globalThis.fetch = original;
    Object.assign(cfg, saved);
    resetStatusCache();
  });

  await status({ timeoutMs: 1000 });
  const afterFirst = getRecentLogs({ component: 'enigma2', level: 'info', search: 'receiver reachable' }).length;
  await status({ timeoutMs: 1000, force: true });
  await status({ timeoutMs: 1000, force: true });
  const afterThree = getRecentLogs({ component: 'enigma2', level: 'info', search: 'receiver reachable' }).length;
  assert.equal(afterThree, afterFirst, 'an unchanged receiver is logged once, not per poll');

  // …but a real change is still reported at INFO/WARN.
  globalThis.fetch = async () => { throw new Error('fetch failed'); };
  await status({ timeoutMs: 1000, force: true });
  const down = getRecentLogs({ component: 'enigma2', level: 'warn', search: 'unreachable' });
  assert.ok(down.length > 0, 'the receiver going away must be logged');
});

test('/api/health never contacts the receiver: cachedStatus() does no request', async (t) => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(ABOUT_XML, { status: 200, headers: { 'content-type': 'text/xml' } });
  };
  const cfg = getConfig().enigma2;
  const saved = { host: cfg.host, username: cfg.username };
  Object.assign(cfg, { host: '192.168.1.20', username: '' });
  resetStatusCache();
  t.after(() => {
    globalThis.fetch = original;
    Object.assign(cfg, saved);
    resetStatusCache();
  });

  // Before any check: an explicit "never checked", not a silent false.
  const fresh = cachedStatus();
  assert.equal(fresh.configured, true);
  assert.equal(fresh.ok, null);
  assert.equal(fresh.checked, false);
  assert.match(fresh.message, /not checked/);
  assert.equal(calls, 0, 'the healthcheck must not wake the receiver');

  // Many "health polls" in a row: still zero requests to the box.
  for (let i = 0; i < 10; i += 1) cachedStatus();
  assert.equal(calls, 0);

  // The operator asks for a real check (Settings → Enigma2 → test connection).
  const forced = await status({ timeoutMs: 1000, force: true });
  assert.equal(forced.ok, true);
  assert.equal(calls, 1);

  // …and the health payload then reports it as a last-known value.
  const afterCheck = cachedStatus();
  assert.equal(afterCheck.ok, true);
  assert.equal(afterCheck.checked, true);
  assert.equal(afterCheck.model, 'Duo\u00b2');
  assert.ok(afterCheck.ageMs >= 0);
  assert.equal(calls, 1, 'reporting the last known state is free');
});

test('no receiver configured reports that, without probing', () => {
  const cfg = getConfig().enigma2;
  const saved = { host: cfg.host };
  cfg.host = '';
  resetStatusCache();
  try {
    const state = cachedStatus();
    assert.equal(state.configured, false);
    assert.match(state.message, /no receiver configured/);
  } finally {
    cfg.host = saved.host;
    resetStatusCache();
  }
});

test('FTP file transport stages files and atomically replaces existing targets', () => {
  const cfg = { host: '192.168.1.50', ftpPort: 21, username: 'root', password: 'boxpw', rootDir: '/etc/enigma2' };
  const files = new Map([['bouquets.tv', '#NAME User - bouquets (TV)\n']]);
  const calls = [];
  let refuseRenameOverExisting = true;
  const ok = (stdout = Buffer.alloc(0)) => ({ status: 0, stdout, stderr: Buffer.alloc(0) });
  const fail = (message) => ({ status: 19, stdout: Buffer.alloc(0), stderr: Buffer.from(`curl: (19) ${message}`) });

  const runCommand = (args) => {
    calls.push([...args]);
    const url = new URL(args.at(-1));
    const remoteName = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || '');
    if (args.includes('--list-only')) return ok(Buffer.from([...files.keys()].join('\r\n')));

    const uploadAt = args.indexOf('--upload-file');
    if (uploadAt >= 0) {
      files.set(remoteName, fs.readFileSync(args[uploadAt + 1], 'utf8'));
      return ok();
    }

    const quoteCommands = [];
    for (let i = 0; i < args.length; i += 1) if (args[i] === '--quote') quoteCommands.push(args[i + 1]);
    if (quoteCommands.length) {
      let from = null;
      for (const command of quoteCommands) {
        const [verb, ...rest] = command.split(' ');
        const name = rest.join(' ').split('/').at(-1);
        if (verb === 'RNFR') from = name;
        else if (verb === 'RNTO') {
          if (refuseRenameOverExisting && files.has(name)) return fail('550 RNTO target already exists');
          if (!from || !files.has(from)) return fail('550 RNFR source does not exist');
          files.set(name, files.get(from));
          files.delete(from);
          from = null;
        } else if (verb === 'DELE') {
          if (!files.has(name)) return fail('550 file does not exist');
          files.delete(name);
          refuseRenameOverExisting = false;
        }
      }
      return ok();
    }

    if (files.has(remoteName)) return ok(Buffer.from(files.get(remoteName), 'utf8'));
    return fail('550 file does not exist');
  };

  const transport = createFtpFileTransport(cfg, { runCommand });
  const names = transport.list();
  assert.equal(transport.read('bouquets.tv', names), '#NAME User - bouquets (TV)\n');
  transport.writeAtomic('bouquets.tv', '#NAME User - bouquets (TV)\n#SERVICE new\n');

  assert.equal(files.get('bouquets.tv'), '#NAME User - bouquets (TV)\n#SERVICE new\n');
  assert.deepEqual([...files.keys()], ['bouquets.tv'], 'the staged remote file is renamed away and no temp file remains');
  const uploaded = calls.filter((args) => args.includes('--upload-file'));
  assert.equal(uploaded.length, 1);
  assert.match(new URL(uploaded[0].at(-1)).pathname, /\.spm-upload-bouquets\.tv-/);
  const renameCalls = calls.filter((args) => args.includes('--quote'));
  assert.ok(renameCalls.some((args) => args.some((arg) => arg.startsWith('RNTO ') && arg.endsWith('/bouquets.tv'))));
  assert.ok(renameCalls.some((args) => args.some((arg) => arg.startsWith('DELE ') && arg.endsWith('/bouquets.tv'))), 'rename-over-existing falls back to delete + rename');
});

test('bouquet push uses FTP for files, preserves bouquets.tv, then reloads through OpenWebif', async (t) => {
  const originalFetch = globalThis.fetch;
  const cfg = getConfig().enigma2;
  const saved = { host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, rootDir: cfg.rootDir, ftpPort: cfg.ftpPort, ftpEnabled: cfg.ftpEnabled };
  Object.assign(cfg, { host: '192.168.1.50', port: 80, username: 'root', password: 'boxpw', rootDir: '/etc/enigma2', ftpPort: 21, ftpEnabled: true });
  const foreign = '#NAME Bouquets (TV)\n#SERVICE 1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "userbouquet.favourites.tv" ORDER BY bouquet\n';
  const files = new Map([['bouquets.tv', foreign], ['userbouquet.favourites.tv', '#NAME Favourites\n']]);
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    requests.push({ url: requestUrl, method: options.method || 'GET' });
    if (requestUrl.endsWith('/web/about')) return new Response(ABOUT_XML, { status: 200 });
    if (requestUrl.includes('servicelistreload')) return new Response('OK', { status: 200 });
    if (requestUrl.includes('/web/getservices')) return new Response('<e2services><e2service>fixture</e2service></e2services>', { status: 200 });
    return new Response('not found', { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    Object.assign(cfg, saved);
    resetStatusCache();
  });

  const fileTransport = {
    via: 'ftp',
    list: () => new Set(files.keys()),
    read: (name, knownNames) => new Set(knownNames).has(name) ? files.get(name) : null,
    writeAtomic: (name, content) => { files.set(name, content); },
  };
  const result = await pushBouquet([
    { title: 'Fixture movie', url: 'http://nas:8080/s/token/fixture.ts' },
  ], { name: 'vu-movie' }, { fileTransport });

  assert.equal(result.ok, true);
  assert.equal(result.transport, 'ftp');
  assert.equal(result.reloadOk, true);
  assert.equal(result.verified, 1);
  assert.equal(files.get('bouquets.tv.spm-backup'), foreign, 'the old index is retained as a restore point');
  assert.ok(files.get('bouquets.tv').includes('userbouquet.favourites.tv'), 'foreign bouquets remain in the index');
  assert.ok(files.get('bouquets.tv').includes('userbouquet.vu-movie.tv'), 'the new bouquet is added');
  assert.ok(files.get('userbouquet.vu-movie.tv').includes('Fixture movie'));
  assert.ok(requests.some(({ url }) => url.includes('/api/servicelistreload?mode=2')));
  assert.ok(requests.some(({ url }) => url.includes('/web/getservices')));
  assert.ok(requests.every(({ method }) => method === 'GET'), 'OpenWebif is never sent an unsupported multipart upload');
  assert.ok(requests.every(({ url }) => !url.includes('/file?action=upload') && !url.endsWith('/web/upload')));
});

test('FTP disabled reports the real upload requirement instead of probing unsupported WebIF endpoints', async (t) => {
  const originalFetch = globalThis.fetch;
  const cfg = getConfig().enigma2;
  const saved = { host: cfg.host, ftpEnabled: cfg.ftpEnabled, rootDir: cfg.rootDir };
  Object.assign(cfg, { host: '192.168.1.50', ftpEnabled: false, rootDir: '/definitely-not-a-mounted-enigma2-share' });
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('unused', { status: 404 }); };
  t.after(() => {
    globalThis.fetch = originalFetch;
    Object.assign(cfg, saved);
  });

  const result = await pushBouquet([{ title: 'Fixture movie', url: 'http://nas:8080/s/token/fixture.ts' }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /Enable FTP/);
  assert.match(result.error, /OpenWebif can reload/);
  assert.equal(calls, 0, 'the obsolete /web/upload and /file?action=upload requests are not made');
});
