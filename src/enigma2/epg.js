/** Playlist VOD metadata expressed as synthetic XMLTV events for OpenPLi. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createFtpFileTransport } from './index.js';

export const EPG_DIR = '/etc/epgimport';
export const STATUS_DIR = '/tmp';
export const HELPER_DIR = '/usr/lib/enigma2/python/Plugins/Extensions/VuMovieEpg';
export const SOURCE_NAME = 'vu-movie plot information';
const helperFile = new URL('./receiver/plugin.py', import.meta.url);
const cleanXml = (text) => String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
const escapeXml = (text) => cleanXml(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const timeXml = (date) => `${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)} +0000`;

/** OpenPLi eEPGCache keys events by SID/TSID/ONID, not URL, type or namespace. */
export function epgIdentity(ref) {
  const parts = String(ref).replace(/^#SERVICE\s+/, '').split(':');
  if (parts.length < 10 || parts[1] === '7') return null;
  const values = parts.slice(3, 6);
  if (!values.every((value) => /^[0-9a-f]+$/i.test(value))) return null;
  return values.map((value) => Number.parseInt(value, 16)).join(':');
}

/** A different bouquet with the same EPG identity would receive our plot too. */
export function assertNoExternalEpgCollisions(items, bouquet, receiver) {
  const own = new Map(items.map((item) => [epgIdentity(item.ref), item]));
  const names = receiver.list();
  for (const name of names) {
    if (!/^userbouquet\.[A-Za-z0-9._-]+\.(?:tv|radio)$/.test(name) || name === bouquet.fileName) continue;
    const text = receiver.read(name, names);
    for (const line of String(text || '').split(/\r?\n/)) {
      if (!line.startsWith('#SERVICE ')) continue;
      const key = epgIdentity(line);
      const item = own.get(key);
      if (!item) continue;
      // The same movie added to another bouquet intentionally shares its EPG.
      const externalUrl = line.slice(9).split(':')[10];
      const ownUrl = item.ref.split(':')[10];
      if (externalUrl && externalUrl === ownUrl) continue;
      throw new Error(`EPG identity ${key} is also used by ${name}; refusing to replace another service's EPG`);
    }
  }
}

/** Use the actual generated service references, not a second approximation. */
export function epgItems(entries, bouquet) {
  const refs = bouquet.text.split('\n').filter((line) => line.startsWith('#SERVICE ')).map((line) => line.slice(9));
  const selected = entries.filter((entry) => entry?.url);
  if (refs.length !== selected.length) throw new Error('bouquet and EPG entries do not match');
  const ids = new Set();
  return selected.map((entry, index) => {
    const ref = refs[index];
    const key = epgIdentity(ref);
    if (!key) throw new Error('invalid bouquet service reference for EPG');
    if (ids.has(key)) throw new Error(`duplicate bouquet EPG identity ${key}; EPG mapping cannot be safely published`);
    ids.add(key);
    const id = `vumovie-${crypto.createHash('sha256').update(ref).digest('hex').slice(0, 24)}`;
    return { id, ref: cleanXml(ref), title: cleanXml(`${entry.title || 'Untitled'}${entry.year ? ` (${entry.year})` : ''}`), plot: cleanXml(entry.plot || '').trim().slice(0, 1500) || 'No plot available.' };
  });
}

/** VOD has no schedule: identical, bounded 6-hour slots, not playback time. */
export function buildXmltv(items, now = Date.now()) {
  const day = Math.floor(now / 86400000) * 86400000;
  const start = day - 86400000;
  const end = day + 8 * 86400000;
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="vu-movie">'];
  for (const item of items) {
    lines.push(`<channel id="${escapeXml(item.id)}"><display-name>${escapeXml(item.title)}</display-name></channel>`);
    for (let t = start; t < end; t += 6 * 3600000) {
      lines.push(`<programme channel="${escapeXml(item.id)}" start="${timeXml(new Date(t))}" stop="${timeXml(new Date(t + 6 * 3600000))}"><title>${escapeXml(item.title)}</title><desc>${escapeXml(item.plot)}</desc></programme>`);
    }
  }
  lines.push('</tv>');
  return `${lines.join('\n')}\n`;
}

export function buildChannels(items) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n${items.map((item) => `  <channel id="${escapeXml(item.id)}">${escapeXml(item.ref)}</channel>`).join('\n')}\n</channels>\n`;
}

export function buildSource() {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sources><sourcecat sourcecatname="vu-movie"><source type="gen_xmltv" channels="vumovie.channels.xml" nocheck="1"><description>${SOURCE_NAME}</description><url>${EPG_DIR}/vumovie.xml</url></source></sourcecat></sources>\n`;
}

function ftpFor(cfg, rootDir) {
  if (!cfg.ftpEnabled) throw new Error('EPG installation needs FTP access to /etc/epgimport and the Enigma2 plugin directory; a bouquet-only mount is not sufficient');
  return createFtpFileTransport({ ...cfg, rootDir }, { createDirs: rootDir === HELPER_DIR });
}

/** Called only after a successful, reloaded playlist bouquet push. */
export function pushPlaylistEpg(entries, bouquet, cfg, { transportFor = ftpFor, now = Date.now(), requestId = crypto.randomUUID() } = {}) {
  const items = epgItems(entries, bouquet);
  const receiver = transportFor(cfg, cfg.rootDir || '/etc/enigma2');
  assertNoExternalEpgCollisions(items, bouquet, receiver);
  const epg = transportFor(cfg, EPG_DIR);
  // Fail before creating a plugin when EPGImport's directory is not accessible.
  epg.list();
  const helper = transportFor(cfg, HELPER_DIR);
  const plugin = fs.readFileSync(helperFile, 'utf8');
  let previous = null;
  try { previous = helper.read('plugin.py'); } catch { /* first install */ }
  if (previous !== plugin) {
    helper.writeAtomic('__init__.py', '');
    helper.writeAtomic('plugin.py', plugin);
  }
  epg.writeAtomic('vumovie.channels.xml', buildChannels(items));
  epg.writeAtomic('vumovie.sources.xml', buildSource());
  epg.writeAtomic('vumovie.json', JSON.stringify({ version: 1, requestId, bouquetFile: bouquet.fileName, items }));
  epg.writeAtomic('vumovie.xml', buildXmltv(items, now));
  // Commit marker last: the helper must never import a partially published set.
  epg.writeAtomic('vumovie.request.json', JSON.stringify({ id: requestId, at: now }));
  return { state: 'queued', requestId, items: items.length, helperChanged: previous !== plugin,
    message: previous !== plugin ? 'EPG files uploaded; restart the Enigma2 GUI once to load the helper. Import is queued.' : 'EPG files uploaded; import request queued on the receiver.' };
}

export function readPlaylistEpgStatus(cfg, requestId = '', { transportFor = ftpFor } = {}) {
  const epg = transportFor(cfg, EPG_DIR);
  const names = epg.list();
  const request = JSON.parse(epg.read('vumovie.request.json', names) || '{}');
  const statusTransport = transportFor(cfg, STATUS_DIR);
  const statusNames = statusTransport.list();
  const status = JSON.parse(statusTransport.read('vumovie-epg.status.json', statusNames) || '{}');
  if (requestId && request.id !== requestId) return { state: 'superseded', requestId, message: 'A newer EPG push replaced this request.' };
  if (!request.id) return { state: 'not_configured', message: 'No vu-movie EPG request found on the receiver.' };
  if (status.requestId !== request.id || !Number.isFinite(Number(status.heartbeat)) || Date.now() - Number(status.heartbeat) > 45000) {
    return { state: 'queued', requestId: request.id, message: 'Waiting for the receiver helper. If newly installed, restart the Enigma2 GUI; otherwise check that the receiver is running.' };
  }
  return status;
}
