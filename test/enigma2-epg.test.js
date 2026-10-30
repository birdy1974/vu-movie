import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildBouquet } from '../src/enigma2/index.js';
import { epgItems, buildXmltv, buildChannels, buildSource, pushPlaylistEpg, readPlaylistEpgStatus, assertNoExternalEpgCollisions, epgIdentity, EPG_DIR, HELPER_DIR, STATUS_DIR } from '../src/enigma2/epg.js';
import { enrichEpgPlots } from '../src/enigma2/epg-metadata.js';

const entries = [
  { title: 'Amélie & Co', year: 2001, url: 'http://nas:8080/s/a/a.ts.enigma2', plot: 'A <plot> & a café' },
  { title: 'Other', url: 'http://nas:8080/s/b/b.ts.enigma2', plot: '' },
];
const bouquet = buildBouquet({ name: 'vu-movie', serviceType: 5002, entries });

test('XMLTV maps exact 5002 bouquet references, escapes metadata, covers now and has a fallback plot', () => {
  const items = epgItems(entries, bouquet);
  assert.equal(items.length, 2);
  assert.equal(items[0].ref, bouquet.text.split('\n').find((line) => line.startsWith('#SERVICE ')).slice(9));
  assert.match(buildChannels(items), /<channel id="vumovie-.*">5002:0:1:/);
  assert.match(buildChannels(items), /Amélie &amp; Co/);
  const xml = buildXmltv(items, Date.UTC(2026, 9, 30, 12));
  assert.match(xml, /A &lt;plot&gt; &amp; a café/);
  assert.match(xml, /No plot available/);
  assert.match(xml, /20261030120000 \+0000/);
  assert.match(buildSource(), /vumovie\.channels\.xml/);
  assert.match(buildSource(), /\/etc\/epgimport\/vumovie.xml/);
  assert.equal((xml.match(/<programme /g) || []).length, 72);
  const parser = spawnSync('python3', ['-c', 'import sys,xml.etree.ElementTree as E; E.fromstring(sys.stdin.read())'], { input: xml, encoding: 'utf8' });
  assert.equal(parser.status, 0, parser.stderr);
});

test('EPG identity collisions are rejected rather than attaching a plot to the wrong service', () => {
  const lines = bouquet.text.split('\n');
  const first = lines.find((line) => line.startsWith('#SERVICE '));
  const indices = lines.map((line, i) => line.startsWith('#SERVICE ') ? i : -1).filter((i) => i >= 0);
  lines[indices[1]] = first;
  assert.throws(() => epgItems(entries, { text: lines.join('\n') }), /duplicate bouquet EPG identity/);
});


test('EPG collisions ignore service type and namespace, and never overwrite another bouquet', () => {
  const items = epgItems(entries, bouquet);
  const parts = items[0].ref.split(':');
  parts[0] = '4097'; parts[6] = 'ABCD0000'; parts[10] = 'http%3a//other/stream';
  const external = `#SERVICE ${parts.join(':')}`;
  assert.equal(epgIdentity(external), epgIdentity(items[0].ref));
  const files = new Map([['userbouquet.other.tv', external]]);
  const receiver = { list: () => new Set(files.keys()), read: (name) => files.get(name) };
  assert.throws(() => assertNoExternalEpgCollisions(items, bouquet, receiver), /refusing to replace another service/);
  parts[10] = items[0].ref.split(':')[10];
  files.set('userbouquet.other.tv', `#SERVICE ${parts.join(':')}`);
  assert.doesNotThrow(() => assertNoExternalEpgCollisions(items, bouquet, receiver));
});

function fakeReceiver() {
  const files = new Map([['/etc/enigma2', new Map()], [EPG_DIR, new Map()], [HELPER_DIR, new Map()], [STATUS_DIR, new Map()]]);
  const writes = [];
  const transportFor = (_cfg, directory) => ({
    list: () => new Set(files.get(directory).keys()),
    read: (name, known) => (known || files.get(directory)).has(name) ? files.get(directory).get(name) : null,
    writeAtomic: (name, content) => { writes.push([directory, name]); files.get(directory).set(name, content); },
  });
  return { files, writes, transportFor };
}

test('push stages helper, mappings and data before the request; status is never claimed on upload', () => {
  const receiver = fakeReceiver();
  const options = { transportFor: receiver.transportFor, requestId: 'one', now: Date.UTC(2026, 9, 30) };
  const result = pushPlaylistEpg(entries, bouquet, {}, options);
  assert.equal(result.state, 'queued');
  assert.equal(result.helperChanged, true);
  assert.deepEqual(receiver.writes.at(-1), [EPG_DIR, 'vumovie.request.json']);
  assert.ok(receiver.files.get(HELPER_DIR).get('plugin.py').includes('WHERE_AUTOSTART'));
  assert.equal(JSON.parse(receiver.files.get(EPG_DIR).get('vumovie.json')).requestId, 'one');
  assert.equal(readPlaylistEpgStatus({}, 'one', { transportFor: receiver.transportFor }).state, 'queued');
  receiver.files.get(STATUS_DIR).set('vumovie-epg.status.json', JSON.stringify({ requestId: 'one', state: 'finished', heartbeat: Date.now(), message: 'done' }));
  assert.equal(readPlaylistEpgStatus({}, 'one', { transportFor: receiver.transportFor }).state, 'finished');
  assert.equal(readPlaylistEpgStatus({}, 'old', { transportFor: receiver.transportFor }).state, 'superseded');
  const again = pushPlaylistEpg(entries, bouquet, {}, { ...options, requestId: 'two' });
  assert.equal(again.helperChanged, false);
  assert.equal(readPlaylistEpgStatus({}, 'two', { transportFor: receiver.transportFor }).state, 'queued');
});

test('missing EPG directory leaves no helper or import request behind', () => {
  const receiver = fakeReceiver();
  assert.throws(() => pushPlaylistEpg(entries, bouquet, {}, { transportFor: (cfg, dir) => {
    if (dir === EPG_DIR) return { list() { throw new Error('permission denied'); } };
    return receiver.transportFor(cfg, dir);
  } }), /permission denied/);
  assert.equal(receiver.files.get(HELPER_DIR).size, 0);
});

test('missing plots use configured lookup and cache without replacing existing plot text', async () => {
  const saved = new Map(); let calls = 0;
  const cache = { cacheGet: async (key) => saved.get(key), cacheSet: async (key, value) => saved.set(key, value) };
  const lookup = async () => { calls += 1; return 'Metadata plot'; };
  const first = await enrichEpgPlots(entries, { cache, lookup });
  assert.equal(first[0].plot, entries[0].plot);
  assert.equal(first[1].plot, 'Metadata plot');
  await enrichEpgPlots(entries, { cache, lookup });
  assert.equal(calls, 1);
});

test('receiver bridge state machine with simulated OpenPLi EPGImport', () => {
  const run = spawnSync('python3', ['test/fixtures/epg_bridge_test.py'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

test('metadata timeouts do not stop the push or invent a plot', async () => {
  const cache = { cacheGet: async () => null, cacheSet: async () => { throw new Error('not reached'); } };
  const lookup = (_entry, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('late result'), 1000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  });
  const result = await enrichEpgPlots([{ title: 'unknown' }], { cache, lookup, timeoutMs: 20 });
  assert.equal(result[0].plot, undefined);
});

test('configured TMDB lookup fills only a matching title and receives an abort signal', async (t) => {
  const { getConfig } = await import('../src/core/config.js');
  const metadata = getConfig().metadata;
  const oldKey = metadata.tmdbApiKey;
  const original = globalThis.fetch;
  metadata.tmdbApiKey = 'fixture-key';
  let receivedSignal;
  globalThis.fetch = async (_url, options) => {
    receivedSignal = options.signal;
    return new Response(JSON.stringify({ results: [{ id: 1, title: 'Different Movie', release_date: '2024-01-01', overview: 'wrong plot' }, { id: 2, title: 'The Movie', release_date: '2024-01-01', overview: 'correct plot' }] }), { status: 200 });
  };
  t.after(() => { metadata.tmdbApiKey = oldKey; globalThis.fetch = original; });
  const cache = { cacheGet: async () => null, cacheSet: async () => {} };
  const [item] = await enrichEpgPlots([{ title: 'The Movie', year: 2024, kind: 'movie' }], { cache });
  assert.equal(item.plot, 'correct plot');
  assert.ok(receivedSignal instanceof AbortSignal);
});
