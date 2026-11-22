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
import { normalizeText, queryTerms, termCoverage } from '../scrapers/search-relevance.js';

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

/* ------------------------------------------------------------------ *
 * timing facts: what the video is, what the provider says, what the file says
 * ------------------------------------------------------------------ */

/** "01:47:44", "01:47:44,123", "1:47:44.5" → milliseconds (null when unreadable). */
export function parseTimestampMs(stamp) {
  const m = /(\d{1,3}):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/.exec(String(stamp || ''));
  if (!m) return null;
  const ms = ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + (m[4] ? Number(m[4].padEnd(3, '0')) : 0);
  return Number.isFinite(ms) ? ms : null;
}

const fmtClock = (ms) => {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

/**
 * The frame-rate pairs that explain a subtitle running a few percent too fast
 * or too slow: a file timed on a PAL (25 fps) release played on a 23.976 fps
 * encode drifts linearly by 4.3 % — 25 s at 10 minutes, almost two minutes by
 * the end of an episode. The ratio (subtitle length ÷ video length) names the
 * pair; multiplying every timestamp by `scale` undoes it.
 */
const FRAME_RATES = [23.976, 24, 25, 29.97, 30];
export const FRAME_RATE_FACTORS = (() => {
  const out = [];
  for (const from of FRAME_RATES) {
    for (const to of FRAME_RATES) {
      if (from === to) continue;
      const ratio = to / from;             // observed: subtitle timed at `from`, video runs at `to`
      if (Math.abs(ratio - 1) < 0.01) continue;  // 23.976↔24 is 0.1 % — not detectable from lengths
      out.push({ from, to, ratio, scale: from / to, label: `${from}→${to} fps` });
    }
  }
  return out;
})();

/** The frame-rate pair whose length ratio matches `ratio`, or null. */
export function frameRateFactorFor(ratio, tolerance = 0.006) {
  if (!Number.isFinite(ratio)) return null;
  let best = null;
  for (const f of FRAME_RATE_FACTORS) {
    const diff = Math.abs(ratio - f.ratio);
    if (diff <= tolerance && (!best || diff < best.diff)) best = { ...f, diff };
  }
  return best;
}

/** Do two frame rates name the same timing (23.976 vs 23.98 vs 24)? */
export function sameFrameRate(a, b, tolerance = 0.002) {
  const x = Number(a);
  const y = Number(b);
  if (!(x > 0) || !(y > 0)) return null;
  return Math.abs(x / y - 1) <= tolerance;
}

/** Start/end of every cue in an SRT (milliseconds), in file order. */
export function parseCueTimes(srtText) {
  const out = [];
  const re = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/g;
  for (const m of String(srtText || '').matchAll(re)) {
    const start = parseTimestampMs(m[1]);
    const end = parseTimestampMs(m[2]);
    if (start === null || end === null) continue;
    out.push({ start, end });
  }
  return out;
}

const HI_LINE = /^\s*(?:[-–]\s*)?(?:[\[(][^\])]{1,60}[\])]|[A-Z][A-Z0-9 .'&-]{1,30}:)\s*$/;

/**
 * What a downloaded subtitle file looks like, measured — the facts the
 * assessment below reasons about. Pure; no video needed.
 */
export function inspectSrt(srtText) {
  const text = String(srtText || '');
  const cues = parseCueTimes(text);
  let overlaps = 0;
  for (let i = 1; i < cues.length; i += 1) if (cues[i].start < cues[i - 1].end - 1) overlaps += 1;
  const lines = text.split('\n').filter((l) => l.trim() && !/-->/.test(l) && !/^\d+\s*$/.test(l));
  const hiLines = lines.filter((l) => HI_LINE.test(l)).length;
  const firstMs = cues.length ? cues[0].start : null;
  const lastMs = cues.length ? Math.max(...cues.map((c) => c.end)) : null;
  return {
    cues: cues.length,
    firstMs,
    lastMs,
    spanMs: cues.length ? lastMs - firstMs : 0,
    textLines: lines.length,
    hiLines,
    hiShare: lines.length ? hiLines / lines.length : 0,
    overlaps,
  };
}

/**
 * Judge a downloaded subtitle against the video it is meant for.
 *
 * `video` = { durationSec, fps } from ffprobe (both optional); `meta` = the
 * provider's own facts about the file ({ fps } — the frame rate of the video
 * the subtitle was timed on).
 *
 * Returns { verdict, reasons, penalty, lengthRatio, suggestedScale, confidence }:
 *   verdict        good | suspect | bad | unknown (no video length to compare)
 *   penalty        points to take off the search score (0 for good)
 *   suggestedScale multiply every timestamp by this to undo a frame-rate
 *                  mismatch, or null; `confidence` says how sure that is:
 *                  'high' only when the file runs *past* the end of the video
 *                  (no credits can explain that) or the provider's fps
 *                  confirms the same pair. Credits without dialogue make a
 *                  correct file end 3–8 % early, so an early end alone is never
 *                  "fixed" — it is only ranked below a file that fits.
 */
export function assessSubtitle(inspection, video = {}, meta = {}) {
  const reasons = [];
  let penalty = 0;
  let verdict = 'unknown';
  let suggestedScale = null;
  let confidence = null;
  let lengthRatio = null;
  const bump = (points, reason) => { penalty += points; reasons.push(reason); };

  if (!inspection || inspection.cues < 5) {
    return { verdict: 'bad', reasons: ['almost no cues — not a usable subtitle'], penalty: 100, lengthRatio, suggestedScale, confidence };
  }

  const durationMs = Number(video.durationSec) > 0 ? Number(video.durationSec) * 1000 : null;
  if (durationMs && inspection.lastMs) {
    lengthRatio = inspection.lastMs / durationMs;
    const factor = frameRateFactorFor(lengthRatio);
    const fpsPairConfirmed = factor && meta.fps > 0 && video.fps > 0
      && sameFrameRate(meta.fps, factor.from, 0.01) && sameFrameRate(video.fps, factor.to, 0.01);
    const ends = `ends at ${fmtClock(inspection.lastMs)} of ${fmtClock(durationMs)}`;
    if (lengthRatio >= 0.85 && lengthRatio <= 1.015) {
      if (fpsPairConfirmed) {
        // Ends early by exactly the pair the provider's fps predicts: that is
        // drift, not credits.
        verdict = 'suspect';
        suggestedScale = factor.scale;
        confidence = 'high';
        bump(20, `${ends} — ${factor.label} drift (provider fps confirms)`);
      } else {
        verdict = 'good';
        reasons.push('length fits the video');
      }
    } else if (lengthRatio > 1.015 && lengthRatio <= 1.08) {
      verdict = 'suspect';
      if (factor) {
        suggestedScale = factor.scale;
        confidence = 'high';
        bump(20, `${ends} — ${factor.label} drift (runs past the end)`);
      } else bump(15, `${ends} — runs past the end of the video`);
    } else if (lengthRatio > 1.08) {
      verdict = 'bad';
      bump(40, `${ends} — much longer than the video (different cut?)`);
    } else if (lengthRatio >= 0.6) {
      verdict = 'suspect';
      if (factor) {
        suggestedScale = factor.scale;
        confidence = fpsPairConfirmed ? 'high' : 'low';
        bump(fpsPairConfirmed ? 20 : 10, `${ends} — ${fpsPairConfirmed ? `${factor.label} drift (provider fps confirms)` : `could be ${factor.label} drift`}`);
      } else bump(10, `${ends} — ends early`);
    } else {
      verdict = 'bad';
      bump(40, `${ends} — covers only part of the video (CD 1 of 2?)`);
    }
  }

  // Density: a feature film with two cues a minute is a forced/foreign-parts
  // track, not dialogue. Judged against the subtitle's own span so it works
  // without a probe too.
  const spanMin = inspection.spanMs / 60000;
  if (spanMin >= 20 && inspection.cues / spanMin < 2) {
    if (verdict !== 'bad') verdict = 'suspect';
    bump(20, `only ${inspection.cues} cues in ${Math.round(spanMin)} min — forced / foreign-parts track?`);
  }
  if (inspection.hiShare > 0.25) {
    bump(3, 'hearing-impaired (SDH) captions');
  }
  if (inspection.overlaps > inspection.cues * 0.2) {
    if (verdict !== 'bad') verdict = 'suspect';
    bump(8, `${inspection.overlaps} overlapping cues`);
  }
  return { verdict, reasons, penalty, lengthRatio, suggestedScale, confidence };
}

/** Multiply every timestamp by `factor` (1.0427 = 25 fps timing onto a 23.976 fps video). */
export function applyScale(srtText, factor) {
  const f = Number(factor);
  if (!Number.isFinite(f) || f <= 0 || Math.abs(f - 1) < 1e-6) return srtText;
  const fmt = (totalMs) => {
    const clamped = Math.max(0, Math.round(totalMs));
    const h = String(Math.floor(clamped / 3600000)).padStart(2, '0');
    const m = String(Math.floor((clamped % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((clamped % 60000) / 1000)).padStart(2, '0');
    const msec = String(clamped % 1000).padStart(3, '0');
    return `${h}:${m}:${s},${msec}`;
  };
  return String(srtText).replace(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/g, (full, a, b) => {
    const start = parseTimestampMs(a);
    const end = parseTimestampMs(b);
    if (start === null || end === null) return full;
    return `${fmt(start * f)} --> ${fmt(end * f)}`;
  });
}

/* ------------------------------------------------------------------ *
 * is this hit even about the film we asked for?
 * ------------------------------------------------------------------ */

/** The release year named in a release string ("Heat.1995.1080p" → 1995; 1080p/2160p are not years). */
export function yearInRelease(text) {
  for (const m of String(text || '').matchAll(/(?<![\d])((?:19|20)\d{2})(?![\dp])/gi)) {
    const year = Number(m[1]);
    if (year >= 1900 && year <= new Date().getFullYear() + 1) return year;
  }
  return null;
}

/** "S02E05" in a release string → { season: 2, episode: 5 }, or null. */
export function episodeInRelease(text) {
  const m = /(?:^|[^a-z0-9])s(\d{1,2})\s*[ex](\d{1,3})(?![0-9])/i.exec(String(text || ''))
    || /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9])/i.exec(String(text || ''));
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null;
}

/**
 * Looser spellings of a title to search with when the exact one finds
 * nothing, loosest last and none equal to the original:
 *   "Léon: The Professional (Director's Cut)"
 *     → "Leon The Professional"   (no brackets, accents or punctuation)
 *     → "Leon"                     (the part before the colon / dash)
 *   "Mission: Impossible – Dead Reckoning Part One"
 *     → "Mission Impossible Dead Reckoning Part One"
 *     → "Mission Impossible Dead Reckoning"   (no "Part One")
 *     → "Mission Impossible"
 * Providers index titles differently — with or without the subtitle after
 * the colon, with "and" for "&", without the accents — and a strict query
 * string finds none of those spellings.
 */
export function relaxedTitles(title) {
  const raw = String(title || '').trim();
  if (!raw) return [];
  const out = [];
  const seen = new Set([raw.toLowerCase()]);
  const push = (text) => {
    const words = normalizeText(text).split(' ').filter(Boolean);
    // Title case for readability in the UI note; providers do not care.
    const spelled = words.map((w) => (w.length > 1 && !/^\d+$/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
    if (!spelled || seen.has(spelled.toLowerCase())) return;
    seen.add(spelled.toLowerCase());
    out.push(spelled);
  };
  const noBrackets = raw.replace(/\s*[([{][^)\]}]*[)\]}]/g, '').trim() || raw;
  push(noBrackets);
  const noPart = noBrackets.replace(/[\s:,-]*\b(?:part|chapter|vol(?:ume)?)\s+(?:one|two|three|four|five|i{1,3}|iv|v|\d{1,2})\b.*$/i, '').trim();
  if (noPart) push(noPart);
  // The part before the *last* colon / dash: "Mission: Impossible – Dead
  // Reckoning" → "Mission: Impossible", not the lone "Mission".
  const pieces = noPart.split(/\s*(?::|\s[-–—|]\s)\s*/).map((piece) => piece.trim()).filter(Boolean);
  if (pieces.length > 1) {
    const head = pieces.slice(0, -1).join(' ');
    if (queryTerms(head).length) push(head);
  }
  return out;
}

/**
 * Does a search hit belong to the title we searched for?
 *
 * Keyword providers (OpenSubtitles full-text, Podnapisi, the scrapers) answer
 * "Heat" with Heat Wave, Dead Heat and every episode that mentions heat, so
 * the hit's own name — its title *or* its release string — must carry the
 * words of the wanted title (all of them for one- and two-word titles, 60 %
 * for longer ones: "Mission: Impossible – Dead Reckoning Part One" is
 * usually released without the "Part One"). When both sides name a year
 * they must agree within one year (a 1995 film and its 2022 remake share a
 * title, not subtitles); series skip the year because the show's year and
 * the episode's year differ, and compare SxxEyy instead. An exact-file hash
 * match is kept whatever its name says — it *is* this file.
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
export function matchesTarget(result, target = {}) {
  if (!result) return { ok: false, reason: 'empty' };
  if (result.hashMatch) return { ok: true };
  const wanted = String(target.title || '').trim();
  const texts = [result.title, result.release, result.filename].filter(Boolean).map(String);
  if (wanted) {
    const terms = queryTerms(wanted);
    const required = terms.length <= 2 ? 1 : 0.6;
    const covered = texts.some((text) => termCoverage(terms, text) >= required - 1e-9);
    if (!covered) return { ok: false, reason: `"${texts[0] || '?'}" does not name "${wanted}"` };
  }
  const series = target.kind === 'series' || Number(target.season) > 0;
  if (series) {
    const wantedEp = Number(target.season) > 0 && Number(target.episode) > 0
      ? { season: Number(target.season), episode: Number(target.episode) } : null;
    const named = wantedEp ? texts.map(episodeInRelease).find(Boolean) : null;
    if (wantedEp && named && (named.season !== wantedEp.season || named.episode !== wantedEp.episode)) {
      return { ok: false, reason: `S${String(named.season).padStart(2, '0')}E${String(named.episode).padStart(2, '0')} is not the wanted episode` };
    }
    return { ok: true };
  }
  const wantedYear = Number(target.year) || 0;
  const year = Number(result.year) || texts.map(yearInRelease).find(Boolean) || 0;
  if (wantedYear && year && Math.abs(year - wantedYear) > 1) return { ok: false, reason: `${year} is not ${wantedYear}` };
  // "Heat" is in "Heat Wave" and "Dead Heat" too. A hit whose *title* says
  // more than we asked for is another film unless its year vouches for it
  // (release strings always say more — 1080p BluRay — so only the title
  // field is held to this).
  if (wanted && result.title) {
    const asked = new Set(queryTerms(wanted));
    const extra = queryTerms(String(result.title)).filter((term) => !asked.has(term) && !/^(?:19|20)\d{2}$/.test(term));
    const vouched = wantedYear && year && Math.abs(year - wantedYear) <= 1;
    if (extra.length && !vouched) return { ok: false, reason: `"${result.title}" is more than "${wanted}"${year ? '' : ' and names no year'}` };
  }
  return { ok: true };
}

/**
 * Rank a subtitle hit against what we know about the video. Higher is better.
 * `target` = { title, year, release, season, episode, languages,
 *              durationSec, fps }   (the last two from the stream's ffprobe)
 *
 * Returns { score, notes }: `notes` are the short, user-facing reasons behind
 * the metadata part of the score ("timed for 25 fps, video is 23.976").
 */
export function rankResult(result, target = {}) {
  let score = 0;
  const notes = [];
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
  if (result.downloads) score += Math.min(10, Math.log10(Number(result.downloads) + 1) * 4);
  if (result.rating) score += Math.max(0, Math.min(8, (Number(result.rating) - 5) * 1.5));
  if (result.episodeMatch) score += 10;

  // ---- what the provider knows about the file vs. what ffprobe knows ----
  // An exact file match (OpenSubtitles moviehash) is the one signal that
  // practically guarantees sync: subliminal/Bazarr let it override every
  // other criterion. Here it outranks release matching but not language.
  if (result.hashMatch) { score += 35; notes.push({ text: 'exact file match', tone: 'ok' }); }

  const subFps = Number(result.fps) || 0;
  const videoFps = Number(target.fps) || 0;
  if (subFps > 0 && videoFps > 0) {
    const same = sameFrameRate(subFps, videoFps);
    if (same) { score += 10; notes.push({ text: `${subFps} fps ✓`, tone: 'ok' }); }
    else if (!sameFrameRate(subFps, videoFps, 0.02)) {
      score -= 20;
      notes.push({ text: `timed for ${subFps} fps, video is ${videoFps} — drift likely`, tone: 'warn' });
    }
  } else if (subFps > 0) {
    notes.push({ text: `${subFps} fps`, tone: '' });
  }

  const durationMs = Number(target.durationSec) > 0 ? Number(target.durationSec) * 1000 : 0;
  const lastMs = Number(result.lastTimestampMs) || 0;
  if (durationMs && lastMs) {
    const ratio = lastMs / durationMs;
    const factor = frameRateFactorFor(ratio);
    const fpsPairConfirmed = factor && subFps > 0 && videoFps > 0
      && sameFrameRate(subFps, factor.from, 0.01) && sameFrameRate(videoFps, factor.to, 0.01);
    const ends = `ends ${fmtClock(lastMs)} of ${fmtClock(durationMs)}`;
    if (fpsPairConfirmed) { score -= 10; notes.push({ text: `${ends} — ${factor.label} drift pattern`, tone: 'warn' }); }
    else if (ratio >= 0.88 && ratio <= 1.02) { score += 10; notes.push({ text: 'length fits', tone: 'ok' }); }
    else if (factor && ratio > 1) { score -= 20; notes.push({ text: `${ends} — ${factor.label} drift`, tone: 'warn' }); }
    else if (ratio < 0.6) { score -= 25; notes.push({ text: `${ends} — part of a multi-CD set?`, tone: 'warn' }); }
    else if (ratio > 1.08) { score -= 25; notes.push({ text: `${ends} — longer than the video`, tone: 'warn' }); }
    else if (ratio < 0.88) { score -= factor ? 8 : 5; notes.push({ text: `${ends}${factor ? ` — ${factor.label} drift or long credits` : ''}`, tone: 'warn' }); }
    else { score -= 5; notes.push({ text: ends, tone: 'warn' }); }
  }
  const videoMs = Number(result.videoDurationMs) || 0;
  if (durationMs && videoMs) {
    const diff = Math.abs(videoMs / durationMs - 1);
    if (diff <= 0.015) { score += 6; notes.push({ text: `made for a ${fmtClock(videoMs)} video`, tone: 'ok' }); }
    else if (diff > 0.06) { score -= 8; notes.push({ text: `made for a ${fmtClock(videoMs)} video`, tone: 'warn' }); }
  }

  if (Number(result.cds) > 1) { score -= 20; notes.push({ text: `${result.cds}-CD release`, tone: 'warn' }); }
  if (result.foreignPartsOnly) { score -= 30; notes.push({ text: 'foreign parts only', tone: 'warn' }); }
  if (result.machineTranslated) { score -= 25; notes.push({ text: 'machine translated', tone: 'warn' }); }
  else if (result.aiTranslated) { score -= 5; notes.push({ text: 'AI translated', tone: '' }); }
  if (result.hearingImpaired) { score -= 3; notes.push({ text: 'SDH', tone: '' }); }
  if (result.bad) { score -= 30; notes.push({ text: 'flagged as bad', tone: 'warn' }); }
  if (result.trusted) { score += 5; notes.push({ text: 'trusted uploader', tone: 'ok' }); }

  return { score: Math.round(score * 10) / 10, notes };
}

/** The numeric part of rankResult() — kept for callers that only sort. */
export function scoreResult(result, target = {}) {
  return rankResult(result, target).score;
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
  decodeSubtitle, cleanSrt, countCues, vttToSrt, applyOffset, applyScale, scoreResult, rankResult,
  parseTimestampMs, parseCueTimes, inspectSrt, assessSubtitle, frameRateFactorFor, sameFrameRate,
  matchesTarget, relaxedTitles, yearInRelease, episodeInRelease,
  normaliseLang, releaseTokens, extractSubtitleFromArchive, extractSubtitleFromBuffer,
  readZipEntries, isZip, isRar,
};
