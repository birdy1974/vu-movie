/** Background maintenance for the saved Playlist. */
import { getConfig } from '../core/config.js';
import { log, errorText } from '../core/log.js';
import * as playlist from './index.js';
import { ensureStreamReady } from '../streams/recovery.js';

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

/** Start the repeating timer; first run is delayed so startup remains light. */
export function startPlaylistMaintenance() {
  state.started = true;
  queueNext(STARTUP_DELAY_MS);
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
  return getPlaylistMaintenanceStatus();
}

export function stopPlaylistMaintenance() {
  state.started = false;
  cancelTimer();
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
  };
}

export default {
  runPlaylistAutoCheck,
  startPlaylistMaintenance,
  reconfigurePlaylistMaintenance,
  stopPlaylistMaintenance,
  getPlaylistMaintenanceStatus,
};
