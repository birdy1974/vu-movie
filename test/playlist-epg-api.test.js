import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vumovie-epg-api-'));
process.env.CONFIG_FILE = path.join(tmp, 'config.json');
process.env.LOG_LEVEL = 'error';
const config = await import('../src/core/config.js');
const store = await import('../src/streams/store.js');
const { default: playlistApi } = await import('../src/playlist/api.js');

const boxDir = path.join(tmp, 'box');
fs.mkdirSync(boxDir);
fs.writeFileSync(path.join(boxDir, 'bouquets.tv'), '#NAME Bouquets\n');
config.saveConfig({ enigma2: { host: 'fake-box.test', rootDir: boxDir, ftpEnabled: false, serviceType: 5002 }, scraper: { probeCandidates: false }, playlist: { prewarmEnabled: false } });

const app = express();
app.use(express.json());
app.use('/api/playlist', playlistApi);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).includes('fake-box.test')) {
    if (String(url).includes('/web/about')) return new Response('<e2model>Duo2</e2model>', { status: 200 });
    if (String(url).includes('servicelistreload')) return new Response('OK', { status: 200 });
    if (String(url).includes('getservices')) return new Response('<e2service>ok</e2service>', { status: 200 });
  }
  return originalFetch(url, options);
};
async function push(body) {
  const res = await originalFetch(`${base}/api/playlist/enigma2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

test('playlist API keeps bouquet success separate from an EPG installation failure and dry runs write nothing', async (t) => {
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await store.createStream({ title: 'Movie', description: 'A plot', candidate: { url: 'http://cdn.test/movie.mp4', kind: 'file' } });
  const dry = await push({ action: 'push', dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.epg, null);
  assert.deepEqual(fs.readdirSync(boxDir), ['bouquets.tv']);
  const result = await push({ action: 'push' });
  assert.equal(result.ok, true);
  assert.equal(result.reloadOk, true);
  assert.equal(result.epg.state, 'error');
  assert.match(result.epg.message, /EPG installation needs FTP/);
  assert.match(fs.readFileSync(path.join(boxDir, 'userbouquet.vu-movie.tv'), 'utf8'), /5002:0:1:/);
});

test('bouquet + EPG pushes cannot interleave, and a failure does not block later pushes', async () => {
  const { serialPlaylistPush } = await import('../src/playlist/api.js');
  const order = [];
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const first = serialPlaylistPush(async () => { order.push('first bouquet'); await hold; order.push('first EPG'); });
  const second = serialPlaylistPush(async () => { order.push('second bouquet'); order.push('second EPG'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first bouquet']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first bouquet', 'first EPG', 'second bouquet', 'second EPG']);
  await assert.rejects(serialPlaylistPush(async () => { throw new Error('broken FTP'); }), /broken FTP/);
  assert.equal(await serialPlaylistPush(async () => 'still works'), 'still works');
});
