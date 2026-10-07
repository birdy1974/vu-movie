import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-movie-ephemeral-'));
process.env.CONFIG_FILE = path.join(directory, 'vumovie.json');
process.env.LOG_LEVEL = 'error';

const config = await import('../src/core/config.js');
config.loadConfig();
const store = await import('../src/streams/store.js');
const maintenance = await import('../src/playlist/maintenance.js');

function makeCandidate() {
  return { url: 'https://cdn.example/preview.m3u8', sourceId: 'cinejoy', kind: 'hls', quality: '1080p' };
}

test('ephemeral preview streams are flagged, short-lived and never listed', async () => {
  const before = Date.now();
  const preview = await store.createStream({ title: 'Preview Me', year: 2024, candidate: makeCandidate(), ephemeral: true });
  const saved = await store.createStream({ title: 'Keep Me', year: 2024, candidate: makeCandidate() });

  assert.equal(preview.payload?.meta?.ephemeral, true);
  assert.equal(saved.payload?.meta?.ephemeral, undefined);
  const ttlMs = Date.parse(preview.expires_at) - before;
  assert.ok(ttlMs > 59 * 60_000 && ttlMs <= 60 * 60_000, `ephemeral TTL is 60 minutes, got ${ttlMs}ms`);

  // Playable directly (the player and the relay use getStream), invisible in
  // every listing (playlist, .m3u, bouquet — all read listStreams).
  assert.equal((await store.getStream(preview.id))?.id, preview.id);
  const listed = await store.listStreams();
  assert.ok(listed.some((row) => row.id === saved.id), 'normal stream is listed');
  assert.ok(!listed.some((row) => row.id === preview.id), 'ephemeral stream is not listed');
});

test('sweepEphemeralStreams only removes expired previews', async () => {
  const stale = await store.createStream({
    title: 'Stale Preview', candidate: makeCandidate(), ephemeral: true,
    expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  const fresh = await store.createStream({ title: 'Fresh Preview', candidate: makeCandidate(), ephemeral: true });
  const normal = await store.createStream({ title: 'Normal', candidate: makeCandidate() });

  const { removed } = await store.sweepEphemeralStreams();
  assert.ok(removed >= 1, 'at least the stale preview is swept');
  assert.equal(await store.getStream(stale.id), null);
  assert.equal((await store.getStream(fresh.id))?.id, fresh.id);
  assert.equal((await store.getStream(normal.id))?.id, normal.id);

  // A second sweep right away finds nothing new.
  assert.equal((await store.sweepEphemeralStreams()).removed, 0);
});

test('ephemeral sweep timer starts and stops cleanly', async () => {
  try {
    const status = maintenance.startEphemeralSweep({ intervalMs: 60_000 });
    assert.equal(status.running, true);
    assert.equal(status.intervalMs, 60_000);
    // Restarting must not stack timers.
    maintenance.startEphemeralSweep({ intervalMs: 60_000 });
  } finally {
    maintenance.stopEphemeralSweep();
    maintenance.stopEphemeralSweep();
  }
});
