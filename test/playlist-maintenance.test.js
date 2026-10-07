import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-maintenance-'));
process.env.CONFIG_FILE = path.join(directory, 'vumovie.json');
process.env.LOG_LEVEL = 'error';

const config = await import('../src/core/config.js');
config.loadConfig();
const maintenance = await import('../src/playlist/maintenance.js');

test('playlist maintenance honors Settings and reports its schedule', async () => {
  config.saveConfig({ playlist: {
    autoCheckEnabled: false,
    autoCheckIntervalMinutes: 45,
    autoRepairEnabled: true,
  } });

  try {
    const stopped = maintenance.startPlaylistMaintenance();
    assert.equal(stopped.enabled, false);
    assert.equal(stopped.intervalMinutes, 45);
    assert.equal(stopped.autoRepair, true);
    assert.equal(stopped.nextRunAt, null);

    config.saveConfig({ playlist: { autoCheckEnabled: true } });
    const running = maintenance.reconfigurePlaylistMaintenance();
    assert.equal(running.enabled, true);
    assert.equal(running.intervalMinutes, 45);
    assert.ok(Date.parse(running.nextRunAt) > Date.now());

    const result = await maintenance.runPlaylistAutoCheck({ reason: 'test' });
    assert.equal(result.skipped, false);
    assert.deepEqual(result.summary, {
      checked: 0,
      working: 0,
      repaired: 0,
      sourceChanged: 0,
      dead: 0,
      expired: 0,
      unverified: 0,
      skipped: 0,
      failed: 0,
      ms: result.summary.ms,
    });
  } finally {
    maintenance.stopPlaylistMaintenance();
  }
});
