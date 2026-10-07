/**
 * Configuration loader — the traps that made a correct-looking
 * /config/vumovie.json do nothing (and leak secrets while doing it).
 *
 * The module reads CONFIG_FILE at import time, so this file writes its fixture
 * first and then imports the module. `node --test` runs each test file in its
 * own process, so no other suite sees this file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-config-test-'));
const CONFIG = path.join(dir, 'vumovie.json');

/** The real-world file that produced the boot warning being debugged. */
const REAL_WORLD = {
  app: { logLevel: 'debug' },
  db: { url: 'postgres://vu-movie:vubirdy@db:5432/vumovie' },
  'db.url': 'postgres://vu-movie:vubirdy@db:5432/vumovie',
  scraper: { flaresolverrUrl: '# e.g. http://flaresolverr:8191 (profile: cf)' },
  'scraper.flaresolverrUrl': 'http://flaresolverr:8192',
  'transcode.container': 'matroska',
  'not.an.option': 1,
  subtitles: { keys: { subdl: 'P2NOQnzMvm7vgltyWG1ye7qdsrb7Om7F' } },
  'subtitles.keys.subdl': 'P2NOQnzMvm7vgltyWG1ye7qdsrb7Om7F',
};

fs.writeFileSync(CONFIG, JSON.stringify(REAL_WORLD, null, 2));
process.env.CONFIG_FILE = CONFIG;
// Independent of the shell the tests run in …
for (const name of ['FLARESOLVERR_URL', 'DATABASE_URL', 'LOG_LEVEL', 'DEFAULT_CONTAINER', 'SUBDL_API_KEY', 'PLAYLIST_AUTO_CHECK', 'PLAYLIST_CHECK_INTERVAL_MINUTES', 'PLAYLIST_AUTO_REPAIR']) delete process.env[name];
// … except this one, which docker-compose always sets (and which used to lose
// against the config file: the documented precedence is env → file → defaults).
process.env.FLARESOLVERR_URL = 'http://flaresolverr:8192';

const config = await import('../src/core/config.js');

test('flat dotted keys never survive into the effective configuration', () => {
  const cfg = config.getConfig();
  for (const key of Object.keys(cfg)) assert.ok(!key.includes('.'), `flat key leaked into the config: ${key}`);
  assert.equal(cfg['db.url'], undefined);
  assert.equal(cfg['subtitles.keys.subdl'], undefined);
  // The dotted "transcode.container" had no nested counterpart → it applied.
  assert.equal(cfg.transcode.container, 'matroska');
});

test('an environment variable really overrides the value from the file', () => {
  // The file says the FlareSolverr URL is a stale comment; FLARESOLVERR_URL is
  // set (compose does it by default) and must win. envOverrides() used to write
  // the flat "scraper.flaresolverrUrl" key instead of the nested option, so the
  // file's value survived and the solver stayed unusable.
  assert.equal(config.getConfig().scraper.flaresolverrUrl, 'http://flaresolverr:8192');
});

test('a dotted key applies when the nested spot is empty, nested wins when both exist', () => {
  // "transcode.container" has no nested counterpart in the fixture → applied.
  assert.equal(config.getConfig().transcode.container, 'matroska');
  // The nested comment is present → it wins, and the dotted duplicate is
  // reported instead of silently changing or silently disappearing.
  const folded = config.foldDottedKeys({
    scraper: { flaresolverrUrl: '# comment' },
    'scraper.flaresolverrUrl': 'http://flaresolverr:8192',
    'transcode.container': 'matroska',
    'not.an.option': 1,
  });
  assert.equal(folded.config.scraper.flaresolverrUrl, '# comment');
  assert.deepEqual(folded.ignored, ['scraper.flaresolverrUrl']);
  assert.deepEqual(folded.applied, ['transcode.container']);
  assert.deepEqual(folded.unknown, ['not.an.option']);
});

test('a dotted branch key merges into its branch without overwriting', () => {
  const folded = config.foldDottedKeys({
    subtitles: { keys: { opensubtitlesCom: 'nested' } },
    'subtitles.keys': { opensubtitlesCom: 'flat', subdl: 'flat-2' },
  });
  assert.equal(folded.config.subtitles.keys.opensubtitlesCom, 'nested');
  assert.equal(folded.config.subtitles.keys.subdl, 'flat-2');
  assert.deepEqual(folded.applied, ['subtitles.keys']);
});

test('no secret leaks through publicConfig(), whatever shape the file used', () => {
  const pub = config.publicConfig();
  // The exact leak from the boot banner: a flat "db.url" bypassed the masking.
  for (const secret of ['vubirdy', 'P2NOQnzMvm7vgltyWG1ye7qdsrb7Om7F']) {
    assert.ok(!JSON.stringify(pub).includes(secret), `publicConfig() leaked ${secret}`);
  }
  assert.equal(pub.db.url, 'postgres://vu-movie:***@db:5432/vumovie', 'shape is kept, password masked');
  assert.equal(pub.subtitles.keys.subdl, '••••••••');
  assert.equal(pub['db.url'], undefined, 'the flat key is gone, not just masked');
  config.saveConfig({ playlist: { additionHistory: [{ eventId: 'test', streamId: 'test', title: 'History item' }], removedStreamIds: ['test'] } });
  assert.equal(config.publicConfig().playlist.additionHistory, undefined, 'unbounded recommendation history is served only by its dedicated endpoint');
  assert.equal(config.publicConfig().playlist.removedStreamIds, undefined, 'playlist reconciliation internals do not leak into Settings responses');
  // The live config does keep the secret (it has to connect / search) …
  assert.equal(config.getConfig().db.url, 'postgres://vu-movie:vubirdy@db:5432/vumovie');
  // … and a dotted API patch is folded, so it cannot create a flat key at all.
  const patched = config.saveConfig({ 'db.url': 'postgres://u:topsecret@host/db' });
  assert.equal(patched['db.url'], undefined);
  assert.equal(patched.db.url, 'postgres://u:topsecret@host/db');
  assert.equal(config.publicConfig().db.url, 'postgres://u:***@host/db');
});

test('saveConfig() folds dotted patches and never writes a flat key to disk', () => {
  const next = config.saveConfig({ scraper: {}, 'scraper.flaresolverrUrl': 'http://solver:8192' });
  assert.equal(next.scraper.flaresolverrUrl, 'http://solver:8192');
  assert.equal(next['scraper.flaresolverrUrl'], undefined);

  // The file the next boot will read must be in the nested shape: an older
  // build persisted the env-override layer, which is how a real
  // /config/vumovie.json ended up with "app.logLevel", "db.url", … in it.
  const onDisk = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.deepEqual(Object.keys(onDisk).filter((key) => key.includes('.')), []);
  assert.equal(onDisk.scraper.flaresolverrUrl, 'http://solver:8192');
});

test('hand-edited strings are coerced to the type of the option', () => {
  const coerced = config.coerceConfigValues({
    app: { port: '8080' },
    db: { required: 'true' },
    transcode: { hardware: 'false', resolution: '720', fps: 'source' },
    scraper: { customSources: [] },
  });
  assert.equal(coerced.app.port, 8080);
  assert.equal(coerced.db.required, true);
  assert.equal(coerced.transcode.hardware, false);
  assert.equal(coerced.transcode.resolution, 720);
  assert.equal(coerced.transcode.fps, 'source', 'a string option stays a string');
  assert.equal(config.getConfig().app.logLevel, 'debug', 'the file value is used when no env override exists');
});

test('knownOptionPaths() describes the writable surface and every secret path exists', () => {
  const paths = config.knownOptionPaths();
  assert.ok(paths.includes('scraper.flaresolverrUrl'));
  assert.ok(paths.includes('transcode.container'));
  assert.ok(paths.includes('subtitles.keys.subdl'));
  assert.ok(!paths.some((p) => p.startsWith('_')), 'comment helpers are not options');
});

test('the search render budget has a documented default and is env-overridable', () => {
  // The flixer clones need a long wait (they fetch their cards after hydration);
  // SEARCH_WAIT_MS is the global budget, a recipe's search.waitMs overrides it.
  assert.equal(config.getConfig().scraper.searchWaitMs, 12000);
  assert.ok(config.knownOptionPaths().includes('scraper.searchWaitMs'));
  const patched = config.saveConfig({ scraper: { searchWaitMs: 20000 } });
  assert.equal(patched.scraper.searchWaitMs, 20000);
  config.saveConfig({ scraper: { searchWaitMs: 12000 } });
});

test('playlist schedule and recovery settings are known options and environment-overridable', () => {
  const keys = ['autoCheckEnabled', 'autoCheckIntervalMinutes', 'autoRepairEnabled'];
  for (const key of keys) assert.ok(config.knownOptionPaths().includes(`playlist.${key}`));
  process.env.PLAYLIST_AUTO_CHECK = 'false';
  process.env.PLAYLIST_CHECK_INTERVAL_MINUTES = '45';
  process.env.PLAYLIST_AUTO_REPAIR = 'false';
  try {
    config.loadConfig();
    assert.equal(config.getConfig().playlist.autoCheckEnabled, false);
    assert.equal(config.getConfig().playlist.autoCheckIntervalMinutes, 45);
    assert.equal(config.getConfig().playlist.autoRepairEnabled, false);
  } finally {
    delete process.env.PLAYLIST_AUTO_CHECK;
    delete process.env.PLAYLIST_CHECK_INTERVAL_MINUTES;
    delete process.env.PLAYLIST_AUTO_REPAIR;
    config.loadConfig();
  }
});
