#!/usr/bin/env node
/**
 * vu-movie — entry point.
 *
 * Boot order matters and is deliberately explicit:
 *   1. configuration (file + env)      — nothing else can be trusted before this
 *   2. directories                     — /downloads, /config, /tmp/vumovie
 *   3. database (lazy pool) + migrations  → tables exist BEFORE we serve traffic
 *   4. ffmpeg/ffprobe + hardware self-test  → know what this NAS can actually do
 *   5. HTTP server (UI + API + streams)
 *
 * Any step that fails logs what happened and what the fallback is; only a failure
 * in step 5 is fatal, because without HTTP there is no product.
 */

import { log, logError, errorText } from './core/log.js';
import { loadConfig, getConfig, ensureDirs, publicConfig } from './core/config.js';
import { initDatabase, closeDatabase } from './core/db.js';
import { checkBinaries, hardware, hardwarePending, hardwareStatus } from './core/media.js';
import { startServer } from './http/server.js';
import relay from './streams/relay.js';
import browser from './scrapers/browser.js';
import { loadSources } from './scrapers/registry.js';

process.env.APP_VERSION = process.env.APP_VERSION || '1.0.0';

const banner = `
                       _                 
 __   ___   _  ______ _(_)___  _____   __
 \\ \\ / / | | |/ / __ \`/ / __ \\/ _ \\ \\ / /
  \\ V /| |_| | / /_/ / / /_/ /  __/\\ V / 
   \\_/  \\__,_|_\\__,_/_/\\____/\\___| \\_/   movie → stream proxy
`;

async function main() {
  console.log(banner);
  const startedAt = Date.now();

  // 1 ── configuration
  loadConfig();
  const cfg = getConfig();
  log.info('app', `vu-movie ${process.env.APP_VERSION} starting`, {
    node: process.version, pid: process.pid, logLevel: cfg.app.logLevel,
    configFile: process.env.CONFIG_FILE || '/config/vumovie.json',
  });
  log.debug('app', 'effective configuration', { config: publicConfig() });

  // 2 ── directories
  ensureDirs();

  // 3 ── database (lazy; memory fallback unless REQUIRE_DB=true)
  let dbInfo = { mode: 'memory' };
  try {
    dbInfo = await initDatabase();
  } catch (err) {
    logError('app', 'database initialisation failed', err);
    if (cfg.db.required) throw err;
    log.warn('app', 'continuing without Postgres (memory mode)');
  }

  // 4 ── binaries + hardware capability, kicked off but NOT awaited.
  //      The vaapi self-test encodes a short test pattern and the binary probe
  //      may be slow on a cold volume; the HTTP server must come up regardless
  //      (its healthcheck has a 10 s timeout) and both results are logged when
  //      they arrive. Everything that needs them awaits the same promises.
  checkBinaries().then((b) => {
    if (b.ffmpeg.ok) return;
    log.error('app', 'ffmpeg is not usable — scanning may work, streaming cannot start yet', {
      kind: b.ffmpeg.kind,
      error: b.ffmpeg.error,
      hint: b.ffmpeg.kind === 'timeout'
        ? 'a timeout is retried automatically in the background — no action needed'
        : 'run "sh scripts/doctor.sh" on the NAS for a full report',
    });
  }).catch((err) => logError('app', 'binary check failed', err));

  hardware().then((hw) => {
    if (!hw.available) {
      log.warn('app', 'hardware transcoding unavailable — software encoding will be used', { reason: hw.reason, attempts: hw.attempts });
    } else {
      log.info('app', 'hardware transcoding ready', {
        encoder: hw.encoder, device: hw.device, driver: hw.libvaDriver, fpsVariant: hw.fpsVariant,
      });
    }
  }).catch((err) => logError('app', 'hardware detection failed', err));

  // sources are loaded eagerly so config errors show up at boot, not on first use
  const sources = loadSources({ force: true });
  log.info('app', `scraper registry: ${sources.filter((s) => s.enabled).length}/${sources.length} sites enabled`);

  // Cloudflare-protected sources (cinevo.nl and friends) fail in a way that
  // looks like "the site has no results", so say out loud at boot whether the
  // solver is actually usable — a misconfigured FLARESOLVERR_URL is the usual
  // reason, and it is invisible until the first challenge otherwise.
  //
  // Which sentence is right (and in which order the cases must be checked) is
  // decided by describeSolverBootState(), so it can be unit-tested: a broken
  // value must be reported as such even when a solver also answers at the
  // default address.
  browser.flaresolverrStatus({ probe: true, maxAgeMs: 300_000 })
    .then((status) => {
      const line = browser.describeSolverBootState(status);
      log[line.level]('app', line.message, line.fields);
    })
    .catch((err) => logError('app', 'FlareSolverr status check failed', err));

  // 5 ── HTTP
  const server = await startServer();
  log.info('app', `ready in ${Date.now() - startedAt} ms`, {
    db: dbInfo.mode,
    hwaccel: hardwarePending() ? 'detecting…' : (hardwareStatus().available ? 'vaapi' : 'software'),
    url: `http://<nas-ip>:${cfg.app.port}`,
  });

  // ---- graceful shutdown ----
  const shutdown = async (signal) => {
    log.info('app', `received ${signal} — shutting down`, { sessions: relay.listSessions().length });
    server.close(() => log.debug('app', 'http server closed'));
    relay.stopAll('shutdown');
    await browser.closeBrowser('shutdown').catch(() => {});
    await closeDatabase().catch(() => {});
    setTimeout(() => process.exit(0), 500).unref();
  };
  ['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => { shutdown(sig).catch(() => process.exit(1)); }));

  process.on('unhandledRejection', (reason) => {
    logError('app', 'unhandled promise rejection (this is a bug — please report it with the log)', reason instanceof Error ? reason : new Error(String(reason)));
  });
  process.on('uncaughtException', (err) => {
    logError('app', 'uncaught exception — the process will keep running, but this is a bug', err);
  });
}

main().catch((err) => {
  logError('app', 'fatal startup error — the container will exit now', err);
  console.error(`\nvu-movie could not start: ${errorText(err)}\n`);
  process.exit(1);
});
