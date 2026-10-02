/**
 * vu-movie — subtitle plumbing that has nothing to do with any specific provider:
 * text decoding, SRT cleaning, timing offsets, WEBVTT→SRT, archive extraction and
 * the ranking of search hits. All pure functions → covered by test/subtitles.test.js.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { log } from '../core/log.js';

export const LANGUAGE_NAMES = {
  nl: 'Nederlands', en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español',
};

/** Language codes used by the different providers. */
export const LANG_ALIASES = {
  nl: ['nl', 'dut', 'nld', 'dutch', 'nederlands', 'nl-nl', 'dutch (nl)'],
  en: ['en', 'eng', 'english', 'en-us', 'en-gb'],
  de: ['de', 'ger', 'deu', 'german', 'deutsch'],
};

export function normaliseLang(value) {
  const v = String(value || '').toLowerCase().trim();
  for (const [code, aliases] of Object.entries(LANG_ALIASES)) {
    if (aliases.includes(v)) return code;
  }
  return v.slice(0, 2);
}

/**
 * Decode a downloaded subtitle buffer. Subtitles are famously in CP1252 when they
 * are older or Windows-made, and VLC on the Duo2 shows garbage when we get it wrong.
 * Strategy: honour a BOM, then try strict UTF-8, then fall back to CP1252.
 */
export function decodeSubtitle(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  }
  const utf8 = buf.toString('utf8');
  // U+FFFD replacement chars mean it was NOT valid UTF-8 → likely Windows-1252.
  if (!utf8.includes('\uFFFD')) return { text: utf8, encoding: 'utf-8' };
  const decoder = new TextDecoder('windows-1252', { fatal: false });
  const text = decoder.decode(buf);
  log.debug('subtitles', 'subtitle was not UTF-8 — decoded as windows-1252');
  return { text, encoding: 'windows-1252' };
}

/** Strip SRT features that some players choke on. */
export function cleanSrt(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF/, '')
    .replace(/\{\\[^}]*\}/g, '')   // {\an8}, {\i1} …
    .replace(/<font[^>]*>/gi, '').replace(/<\/font>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

export function countCues(srtText) {
  return (String(srtText).match(/^\d+\s*$/gm) || []).length;
}

/** Very small WEBVTT → SRT converter (enough for the vtt tracks sites embed). */
export function vttToSrt(vtt) {
  const blocks = String(vtt).replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const out = [];
  let index = 1;
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    if (!lines.length) continue;
    if (/^WEBVTT/.test(lines[0]) || /^NOTE/.test(lines[0])) continue;
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;
    const timeLine = lines[timeIdx].replace(/\.(\d{3})/g, ',$1').replace(/(\d),(\d{3})\s*$/, '$1,$2');
    const text = lines.slice(timeIdx + 1).join('\n');
    out.push(`${index++}\n${timeLine}\n${text}\n`);
  }
  return out.join('\n');
}

/** Shift every cue by offsetMs (positive = subtitles later). */
export function applyOffset(srtText, offsetMs) {
  const ms = Number(offsetMs) || 0;
  if (!ms) return srtText;
  const fmt = (totalMs) => {
    const clamped = Math.max(0, totalMs);
    const h = String(Math.floor(clamped / 3600000)).padStart(2, '0');
    const m = String(Math.floor((clamped % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((clamped % 60000) / 1000)).padStart(2, '0');
    const msec = String(Math.round(clamped % 1000)).padStart(3, '0');
    return `${h}:${m}:${s},${msec}`;
  };
  const parse = (stamp) => {
    const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(stamp);
    if (!m) return null;
    return ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + Number(m[4].padEnd(3, '0'));
  };
  return String(srtText).replace(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/g, (full, a, b) => {
    const start = parse(a);
    const end = parse(b);
    if (start === null || end === null) return full;
    return `${fmt(start + ms)} --> ${fmt(end + ms)}`;
  });
}

/** Turn "Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.x264" into tokens for matching. */
export function releaseTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !['the', 'a', 'of', 'and', 'x264', 'x265', 'h264', 'h265', 'aac', 'web', 'dl'].includes(t));
}

/**
 * Score a subtitle hit. Higher is better.
 * `target` = { title, year, release, season, episode, language }
 */
export function scoreResult(result, target = {}) {
  let score = 0;
  const lang = normaliseLang(result.language);
  const wanted = (target.languages || ['nl', 'en']).map(normaliseLang);
  const langRank = wanted.indexOf(lang);
  if (langRank >= 0) score += 40 - langRank * 10;   // language preference dominates

  const relTokens = releaseTokens(target.release || '');
  const hitTokens = releaseTokens(result.release || result.title || '');
  if (relTokens.length && hitTokens.length) {
    const overlap = hitTokens.filter((t) => relTokens.includes(t)).length;
    score += Math.min(30, Math.round((overlap / Math.max(6, relTokens.length)) * 30));
  }
  if (target.title && result.title) {
    const t = String(target.title).toLowerCase();
    const r = String(result.title).toLowerCase();
    if (r.includes(t) || t.includes(r)) score += 15;
  }
  if (target.year && result.year && Math.abs(Number(result.year) - Number(target.year)) <= 1) score += 8;
  if (result.hashMatch) score += 25;
  if (result.downloads) score += Math.min(10, Math.log10(Number(result.downloads) + 1) * 4);
  if (result.rating) score += Math.max(0, Math.min(8, (Number(result.rating) - 5) * 1.5));
  if (result.episodeMatch) score += 10;
  return Math.round(score * 10) / 10;
}

/** Extract .srt out of a downloaded archive using the CLI tools in the image. */
export function extractSubtitleFromArchive(filePath, outDir) {
  const tools = [
    { cmd: '7z', args: ['x', '-y', '-o' + outDir, filePath] },
    { cmd: 'unzip', args: ['-o', '-j', filePath, '-d', outDir] },
    { cmd: 'unrar', args: ['x', '-y', filePath, outDir] },
  ];
  for (const tool of tools) {
    const res = spawnSync(tool.cmd, tool.args, { encoding: 'utf8', timeout: 30000 });
    if (res.error) {
      log.debug('subtitles', `${tool.cmd} not available`, { error: String(res.error.message) });
      continue;
    }
    if (res.status === 0) {
      const files = fs.readdirSync(outDir).filter((f) => /\.(srt|sub|ass|vtt)$/i.test(f));
      log.info('subtitles', `archive extracted with ${tool.cmd}`, { files: files.join(',') });
      if (files.length) return path.join(outDir, files.sort((a, b) => scoreExtension(a) - scoreExtension(b))[0]);
    } else {
      log.warn('subtitles', `${tool.cmd} could not extract the archive`, { stderr: String(res.stderr || '').slice(0, 200) });
    }
  }
  return null;
}

function scoreExtension(f) {
  if (/\.srt$/i.test(f)) return 0;
  if (/\.vtt$/i.test(f)) return 1;
  return 2;
}

/** Look for a subtitle file inside an HTTP response body (some providers return zip). */
export function isZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}
export function isRar(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 7 && buffer[0] === 0x52 && buffer[1] === 0x61;
}

/**
 * Read the entries of a ZIP file without any external tool.
 *
 * Subtitle providers hand out .zip archives, and most of them are stored or
 * deflate compressed — both are handled here with node's zlib. This means the
 * NAS image does not need unzip/7z for the common case (the CLI tools are still
 * used for .rar/.7z, which are common enough to keep the apt packages).
 *
 * @returns {{filename:string, data:Buffer}[]}
 */
export function readZipEntries(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const entries = [];
  // End Of Central Directory: scan the last 64 KB for the signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return entries;
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && offset + 46 <= buf.length; n += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    try {
      const data = method === 0 ? Buffer.from(raw)
        : method === 8 ? zlib.inflateRawSync(raw)
          : null;
      if (data) entries.push({ filename: name, data });
    } catch (err) {
      log.warn('subtitles', `could not decompress ${name} inside the zip: ${err.message}`);
    }
  }
  return entries;
}

/**
 * Extract the best subtitle text out of an archive buffer.
 * Pure JS for ZIP; falls back to the CLI tools (7z/unrar) for everything else.
 *
 * @param {Buffer} buffer
 * @param {string} [tmpDir] needed for the CLI fallback
 * @returns {{text:string, filename:string, encoding:string}|null}
 */
export function extractSubtitleFromBuffer(buffer, tmpDir = null) {
  if (isZip(buffer)) {
    const entries = readZipEntries(buffer);
    const subs = entries.filter((e) => /\.(srt|vtt|sub|ass|ssa)$/i.test(e.filename));
    if (!subs.length) {
      log.warn('subtitles', `zip archive held ${entries.length} file(s) but no subtitle`, { files: entries.map((e) => e.filename).slice(0, 5) });
      return null;
    }
    subs.sort((a, b) => scoreExtension(a.filename) - scoreExtension(b.filename) || b.data.length - a.data.length);
    const chosen = subs[0];
    const { text, encoding } = decodeSubtitle(chosen.data);
    log.info('subtitles', `extracted ${chosen.filename} from the archive in-process`, { encoding, bytes: chosen.data.length });
    return { text, filename: chosen.filename, encoding };
  }
  if (tmpDir) {
    const dir = path.join(tmpDir, `sub-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, isRar(buffer) ? 'sub.rar' : 'sub.bin');
    fs.writeFileSync(file, buffer);
    const extracted = extractSubtitleFromArchive(file, dir);
    if (extracted) {
      const { text, encoding } = decodeSubtitle(fs.readFileSync(extracted));
      return { text, filename: path.basename(extracted), encoding };
    }
  }
  return null;
}

export default {
  decodeSubtitle, cleanSrt, countCues, vttToSrt, applyOffset, scoreResult,
  normaliseLang, releaseTokens, extractSubtitleFromArchive, extractSubtitleFromBuffer,
  readZipEntries, isZip, isRar,
};
