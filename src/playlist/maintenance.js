/**
 * Background maintenance for the saved Playlist.
 *
 * Two loops with different jobs:
 *   \u2022 the scheduled availability check (default every 6 h) sweeps *every*
 *     item, disabled ones included, and repairs what it finds broken;
 *   \u2022 the keep-warm (prewarm) loop below keeps every *enabled* item
 *     continuously proved-playable, re-proving shortly before a proof's
 *     trust window (streams/readiness.js) runs out. That is what lets a zap
 *     on the Enigma2 box start at once: the probe \u2014 and, for a rotted link,
 *     the minutes-long provider re-resolve \u2014 already happened in the
 *     background instead of while the box waits for its first byte.
 */
import { getConfig } from '../core/config.js';
import { log, errorText } from '../core/log.js';
import * as playlist from './index.js';
import { ensureStreamReady } from '../streams/recovery.js';
import * as readiness from '../streams/readiness.js';
import * as relay from '../streams/relay.js';
import { sweepEphemeralStreams } from '../streams/store.js';
import { backfillStoredPlots } from '../metadata/plots.js';

const DEFAULT_INTERVAL_MINUTES = 360;
const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 10_080;
const STARTUP_DELAY_MS = 30_000;
const WORKERS = 2;

const state = {
  started: false,
  running: false,
  timer: null,
  nextRunAt: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastSummary: null,
  lastError: null,
};

function scheduleConfig() {
  const config = getConfig().playlist || {};
  const raw = Number(config.autoCheckIntervalMinutes);
  const intervalMinutes = Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES,
    Math.round(Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MINUTES)));
  return {
    enabled: config.autoCheckEnabled !== false,
    autoRepair: config.autoRepairEnabled !== false,
    intervalMinutes,
  };
}

function cancelTimer() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.nextRunAt = null;
}

function queueNext(delayMs) {
  cancelTimer();
  if (!state.started) return;
  const config = scheduleConfig();
  if (!config.enabled) return;
  state.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  state.timer = setTimeout(async () => {
    state.timer = null;
    state.nextRunAt = null;
    try { await runPlaylistAutoCheck({ reason: 'scheduled', autoRepair: scheduleConfig().autoRepair }); }
    catch (error) {
      state.lastError = errorText(error);
      log.warn('playlist', 'scheduled playlist check failed', { error: state.lastError });
    } finally {
      const next = scheduleConfig();
      if (state.started && next.enabled) queueNext(next.intervalMinutes * 60_000);
    }
  }, Math.max(0, delayMs));
  state.timer.unref?.();
}

/** Run a full playlist check now. Broken items are refreshed in-place by default. */
export async function runPlaylistAutoCheck({ reason = 'scheduled', autoRepair = scheduleConfig().autoRepair } = {}) {
  if (state.running) return { skipped: true, reason: 'a playlist check is already running', summary: state.lastSummary };
  state.running = true;
  state.lastStartedAt = new Date().toISOString();
  state.lastError = null;
  const startedAt = Date.now();
  try {
    const entries = await playlist.entries();
    const results = new Array(entries.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(WORKERS, entries.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= entries.length) return;
        const entry = entries[index];
        try {
          const outcome = await ensureStreamReady(entry.stream, {
            reason,
            forceCheck: true,
            autoRepair,
          });
          results[index] = {
            streamId: entry.stream.id,
            title: entry.stream.title || '',
            sourceId: outcome.stream?.source_id || entry.stream.source_id || '',
            state: outcome.result?.state || (outcome.ok ? 'unverified' : 'dead'),
            repaired: outcome.repaired === true,
            sourceChanged: outcome.result?.sourceChanged === true,
            error: outcome.ok ? null : (outcome.error || outcome.result?.error || 'upstream unavailable'),
          };
        } catch (error) {
          results[index] = {
            streamId: entry.stream.id,
            title: entry.stream.title || '',
            sourceId: entry.stream.source_id || '',
            state: 'unverified',
            repaired: false,
            error: errorText(error),
          };
        }
      }
    });
    await Promise.all(workers);
    const summary = {
      checked: results.length,
      working: results.filter((result) => result?.state === 'working').length,
      repaired: results.filter((result) => result?.repaired).length,
      sourceChanged: results.filter((result) => result?.sourceChanged).length,
      dead: results.filter((result) => result?.state === 'dead').length,
      expired: results.filter((result) => result?.state === 'expired').length,
      unverified: results.filter((result) => result?.state === 'unverified').length,
      skipped: results.filter((result) => result?.state === 'skipped').length,
      failed: results.filter((result) => Boolean(result?.error)).length,
      ms: Date.now() - startedAt,
    };
    state.lastSummary = summary;
    state.lastFinishedAt = new Date().toISOString();
    if (summary.dead || summary.expired || summary.failed) {
      log.warn('playlist', `scheduled check: ${summary.working}/${summary.checked} working, ${summary.repaired} refreshed`, {
        ...summary, reason,
      });
    } else {
      log.info('playlist', `scheduled check: ${summary.working}/${summary.checked} working, ${summary.repaired} refreshed`, {
        ...summary, reason,
      });
    }
    return { skipped: false, summary, results };
  } catch (error) {
    state.lastError = errorText(error);
    state.lastFinishedAt = new Date().toISOString();
    throw error;
  } finally {
    state.running = false;
  }
}

/* ---------------- keep-warm (prewarm): ready before play is pressed ---------------- */

const PREWARM_TICK_MS = 60_000;
/** Re-prove this long before a proof stops being trusted, so there is no gap. */
const PREWARM_LEAD_MS = 60_000;

const prewarmState = {
  started: false,
  running: false,
  timer: null,
  nextTickAt: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastSummary: null,
  lastError: null,
};

/** A stream somebody is watching is never re-proved: a repair would stop its session. */
function isPlaying(streamId) {
  const session = relay.getSession(streamId);
  return Boolean(session && (session.alive || (session.clients?.size || 0) > 0));
}

/**
 * Prove every enabled playlist item that is due (no proof, proof about to
 * stop being trusted, or signed URL about to expire) and repair the dead
 * ones in place. Serial by default: a repair can mean a Chromium provider
 * search, and background work must never fight a playing movie for the NAS.
 *
 * This is the workhorse for the ticker, for the manual "prepare" endpoints
 * (which pass `force`/`streamIds`) and for tests (which inject
 * `prober`/`searchSource`/`searchAll`/`resolveTarget`, forwarded to
 * ensureStreamReady). It deliberately ignores `prewarmEnabled` — that
 * setting gates the *ticker*, never an explicit prepare.
 */
export async function runPlaylistPrewarmOnce({
  reason = 'prewarm',
  force = false,
  streamIds = null,
  concurrency = 1,
  now = () => Date.now(),
  prober, searchSource, searchAll, resolveTarget, signal = null,
} = {}) {
  if (prewarmState.running) {
    return { skipped: true, reason: 'a prewarm run is already in progress', summary: prewarmState.lastSummary };
  }
  prewarmState.running = true;
  prewarmState.lastStartedAt = new Date().toISOString();
  prewarmState.lastError = null;
  const startedAt = Date.now();
  try {
    const wanted = Array.isArray(streamIds) && streamIds.length ? new Set(streamIds.map(String)) : null;
    const entries = (await playlist.entries())
      .filter((entry) => entry.enabled !== false)
      .filter((entry) => !wanted || wanted.has(String(entry.stream.id)));
    const at = now();
    const due = [];
    let alreadyReady = 0;
    let skippedPlaying = 0;
    let skippedBackoff = 0;
    for (const entry of entries) {
      const stream = entry.stream;
      if (isPlaying(stream.id)) { skippedPlaying += 1; continue; }
      if (!force && readiness.cachedProof(stream, { now: at })
        && !readiness.isDue(stream, { now: at, leadMs: PREWARM_LEAD_MS })) { alreadyReady += 1; continue; }
      if (!force && !readiness.isDue(stream, { now: at, leadMs: PREWARM_LEAD_MS })) {
        // Not due and not trusted-ready: a failed repair inside its backoff.
        skippedBackoff += 1;
        continue;
      }
      due.push(entry);
    }

    const results = new Array(due.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), due.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= due.length) return;
        const entry = due[index];
        try {
          const outcome = await ensureStreamReady(entry.stream, {
            reason,
            forceCheck: true,
            autoRepair: scheduleConfig().autoRepair,
            prober, searchSource, searchAll, resolveTarget, signal,
          });
          results[index] = {
            streamId: entry.stream.id,
            title: entry.stream.title || '',
            ready: outcome.ok === true,
            repaired: outcome.repaired === true,
            error: outcome.ok ? null : (outcome.error || outcome.result?.error || 'upstream unavailable'),
          };
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          results[index] = { streamId: entry.stream.id, title: entry.stream.title || '', ready: false, repaired: false, error: errorText(error) };
        }
      }
    });
    await Promise.all(workers);

    const summary = {
      considered: entries.length,
      due: due.length,
      ready: results.filter((result) => result?.ready).length + alreadyReady,
      warmed: results.filter((result) => result?.ready).length,
      repaired: results.filter((result) => result?.repaired).length,
      failed: results.filter((result) => result && !result.ready).length,
      alreadyReady,
      skippedPlaying,
      skippedBackoff,
      ms: Date.now() - startedAt,
    };
    prewarmState.lastSummary = summary;
    prewarmState.lastFinishedAt = new Date().toISOString();
    if (due.length) {
      log[summary.failed ? 'warn' : 'info']('playlist',
        `pre-warm: ${summary.ready}/${summary.considered} enabled stream(s) ready to play instantly`, { ...summary, reason });
    } else {
      log.debug('playlist', 'pre-warm: nothing due', { ...summary, reason });
    }
    return { skipped: false, summary, results };
  } catch (error) {
    prewarmState.lastError = errorText(error);
    prewarmState.lastFinishedAt = new Date().toISOString();
    throw error;
  } finally {
    prewarmState.running = false;
  }
}

/**
 * Fire a keep-warm pass without waiting for it (a bouquet push, a playlist
 * addition, the Prepare button). Returns at once; readiness is polled
 * through GET /api/playlist/readiness.
 */
export function kickPlaylistPrewarm(options = {}) {
  if (prewarmState.running) return { started: false, running: true };
  runPlaylistPrewarmOnce(options).catch((error) => {
    log.warn('playlist', 'pre-warm pass failed', { error: errorText(error), reason: options.reason || 'prewarm' });
  });
  return { started: true, running: true };
}

function schedulePrewarmTick(delayMs) {
  if (prewarmState.timer) clearTimeout(prewarmState.timer);
  prewarmState.timer = null;
  prewarmState.nextTickAt = null;
  if (!prewarmState.started) return;
  prewarmState.nextTickAt = new Date(Date.now() + delayMs).toISOString();
  prewarmState.timer = setTimeout(async () => {
    prewarmState.timer = null;
    prewarmState.nextTickAt = null;
    try {
      // Read live on every tick: switching keep-warm off in Settings stops
      // the work without a restart (and back on resumes it).
      if (readiness.prewarmConfig().enabled) await runPlaylistPrewarmOnce({ reason: 'keep-warm' });
    } catch (error) {
      prewarmState.lastError = errorText(error);
      log.warn('playlist', 'keep-warm pass failed', { error: prewarmState.lastError });
    } finally {
      schedulePrewarmTick(PREWARM_TICK_MS);
    }
  }, Math.max(0, delayMs));
  prewarmState.timer.unref?.();
}

/** Start the keep-warm ticker; the first pass shares the scheduled check's startup delay. */
export function startPlaylistPrewarm() {
  prewarmState.started = true;
  schedulePrewarmTick(STARTUP_DELAY_MS);
  const config = readiness.prewarmConfig();
  log.info('playlist', config.enabled
    ? `keep-warm on: enabled streams are kept ready to play (a successful check is trusted for ${config.trustMinutes} min)`
    : 'keep-warm is disabled; streams are checked at playback (or with the Prepare button)', {
    enabled: config.enabled, trustMinutes: config.trustMinutes, tickMs: PREWARM_TICK_MS,
  });
  return getPlaylistPrewarmStatus();
}

export function stopPlaylistPrewarm() {
  prewarmState.started = false;
  if (prewarmState.timer) clearTimeout(prewarmState.timer);
  prewarmState.timer = null;
  prewarmState.nextTickAt = null;
}

export function getPlaylistPrewarmStatus() {
  const config = readiness.prewarmConfig();
  return {
    enabled: config.enabled,
    trustMinutes: config.trustMinutes,
    running: prewarmState.running,
    nextTickAt: prewarmState.nextTickAt,
    lastStartedAt: prewarmState.lastStartedAt,
    lastFinishedAt: prewarmState.lastFinishedAt,
    lastSummary: prewarmState.lastSummary,
    lastError: prewarmState.lastError,
  };
}

/** Start the repeating timer; first run is delayed so startup remains light. */
export function startPlaylistMaintenance() {
  state.started = true;
  startPlaylistPrewarm();
  queueNext(STARTUP_DELAY_MS);
  startPlotBackfill(STARTUP_DELAY_MS);
  const config = scheduleConfig();
  log.info('playlist', config.enabled
    ? `scheduled playlist availability checks every ${config.intervalMinutes} minutes`
    : 'scheduled playlist availability checks are disabled', {
    enabled: config.enabled,
    intervalMinutes: config.intervalMinutes,
    autoRepair: config.autoRepair,
  });
  return getPlaylistMaintenanceStatus();
}

/** Apply new Settings → Playlist values without requiring a process restart. */
export function reconfigurePlaylistMaintenance() {
  if (!state.started) return getPlaylistMaintenanceStatus();
  queueNext(STARTUP_DELAY_MS);
  // A trust/prewarm change can make items due right away; a due-only pass is
  // cheap when everything is already proved, so kick one.
  if (readiness.prewarmConfig().enabled) kickPlaylistPrewarm({ reason: 'settings' });
  return getPlaylistMaintenanceStatus();
}

export function stopPlaylistMaintenance() {
  state.started = false;
  cancelTimer();
  stopPlaylistPrewarm();
  stopPlotBackfill();
}

/* ---------------- stored plot backfill ---------------- */

const plotBackfill = { timer: null };

/**
 * Streams saved before plots were stored on the record (or added while the
 * metadata keys were missing) get their plot once, in the background and
 * without the bouquet push deadline, so the next push publishes a complete
 * EPG. Delayed like the other startup chores so startup stays light.
 */
export function startPlotBackfill(delayMs = STARTUP_DELAY_MS) {
  stopPlotBackfill();
  plotBackfill.timer = setTimeout(() => {
    plotBackfill.timer = null;
    backfillStoredPlots({ reason: 'startup' }).catch((error) => {
      log.warn('metadata', 'stored plot backfill failed', { error: errorText(error) });
    });
  }, delayMs);
  plotBackfill.timer.unref?.();
}

export function stopPlotBackfill() {
  if (plotBackfill.timer) clearTimeout(plotBackfill.timer);
  plotBackfill.timer = null;
}

export function getPlaylistMaintenanceStatus() {
  const config = scheduleConfig();
  return {
    enabled: config.enabled,
    autoRepair: config.autoRepair,
    intervalMinutes: config.intervalMinutes,
    running: state.running,
    nextRunAt: state.nextRunAt,
    lastStartedAt: state.lastStartedAt,
    lastFinishedAt: state.lastFinishedAt,
    lastSummary: state.lastSummary,
    lastError: state.lastError,
    prewarm: getPlaylistPrewarmStatus(),
  };
}

/* ---------------- expired preview (ephemeral stream) sweep ---------------- */

const EPHEMERAL_SWEEP_INTERVAL_MS = 15 * 60_000;

const ephemeralSweep = { timer: null, running: false };

async function runEphemeralSweepOnce(reason) {
  if (ephemeralSweep.running) return;
  ephemeralSweep.running = true;
  try {
    await sweepEphemeralStreams();
  } catch (error) {
    log.warn('streams', 'expired preview sweep failed', { error: errorText(error), reason });
  } finally {
    ephemeralSweep.running = false;
  }
}

/**
 * Previews delete their stream when the player modal closes; this timer is the
 * backstop for previews abandoned by closing the browser mid-preview. It also
 * runs once at startup so a restart clears anything left behind.
 */
export function startEphemeralSweep({ intervalMs = EPHEMERAL_SWEEP_INTERVAL_MS } = {}) {
  stopEphemeralSweep();
  runEphemeralSweepOnce('startup').catch(() => {});
  ephemeralSweep.timer = setInterval(() => {
    runEphemeralSweepOnce('scheduled').catch(() => {});
  }, Math.max(60_000, intervalMs));
  ephemeralSweep.timer.unref?.();
  return { running: true, intervalMs: Math.max(60_000, intervalMs) };
}

export function stopEphemeralSweep() {
  if (ephemeralSweep.timer) clearInterval(ephemeralSweep.timer);
  ephemeralSweep.timer = null;
}

export default {
  runPlaylistAutoCheck,
  runPlaylistPrewarmOnce,
  kickPlaylistPrewarm,
  startPlaylistPrewarm,
  stopPlaylistPrewarm,
  getPlaylistPrewarmStatus,
  startPlaylistMaintenance,
  reconfigurePlaylistMaintenance,
  stopPlaylistMaintenance,
  getPlaylistMaintenanceStatus,
  startEphemeralSweep,
  stopEphemeralSweep,
};
