/**
 * vu-movie — subtitle providers and registry.
 *
 * Per your decision (D4) the default set is:
 *   keyless : OpenSubtitles.org (legacy XML-RPC), Podnapisi, TVsubtitles, TVsubs.net
 *   API key : OpenSubtitles.com, SubDL            → enabled as soon as you paste a key
 *   account : Addic7ed                            → enabled as soon as credentials are set
 *   custom  : URL templates you add yourself in the UI (any source you like)
 *
 * Of the six sites in requirements.md, JustSubtitles.com has NO dedicated
 * provider: its search and downloads run entirely in page JavaScript against a
 * Cloudflare-fronted API (api.justsubtitles.com), so there are no server-side
 * endpoints a scraper could call. Cover it with a custom template if you have
 * an endpoint, or use one of the providers below.
 *
 * Every provider reports a *state* (ok / needs-key / needs-credentials / broken) so
 * a dead source never looks like "no subtitles exist for this movie".
 */

import path from 'node:path';
import fs from 'node:fs';
import { log, logError, truncate } from '../core/log.js';
import { getConfig } from '../core/config.js';
import { request, CookieJar } from '../scrapers/http.js';
import {
  decodeSubtitle, cleanSrt, vttToSrt, applyOffset, countCues, scoreResult, normaliseLang,
  extractSubtitleFromBuffer, isZip, isRar,
} from './util.js';

/* ------------------------------------------------------------------ *
 * minimal XML-RPC support (OpenSubtitles.org legacy API)
 * ------------------------------------------------------------------ */

/** Parse one <value> node into JS. Handles the types the legacy API actually uses. */
function parseValue(xml, start = 0) {
  const valueStart = xml.indexOf('<value>', start);
  if (valueStart === -1) return { value: null, end: start };
  let i = valueStart + 7;
  const skipWs = () => { while (i < xml.length && /[\s]/.test(xml[i])) i += 1; };
  skipWs();
  const readText = (tag) => {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    const s = xml.indexOf(open, i);
    if (s === -1) return null;
    const e = xml.indexOf(close, s);
    if (e === -1) return null;
    return { text: xml.slice(s + open.length, e), end: e + close.length };
  };

  if (xml.startsWith('<struct>', i)) {
    const obj = {};
    i += 8;
    while (true) {
      const nameTag = readTextFrom(xml, '<name>', '</name>', i);
      if (!nameTag) break;
      i = nameTag.end;
      const value = parseValue(xml, i);
      i = value.end;
      obj[nameTag.text.trim()] = value.value;
      const structEnd = xml.indexOf('</struct>', i);
      const nextMember = xml.indexOf('<member>', i);
      if (nextMember === -1 || (structEnd !== -1 && nextMember > structEnd)) break;
      i = nextMember;
    }
    const end = xml.indexOf('</struct>', i);
    return { value: obj, end: end === -1 ? i : end + 9 };
  }
  if (xml.startsWith('<array>', i)) {
    const arr = [];
    i += 7;
    while (true) {
      const v = parseValue(xml, i);
      if (v.value === null && !xml.includes('<value>', i)) break;
      arr.push(v.value);
      i = v.end;
      if (!xml.includes('<value>', i)) break;
      const arrayEnd = xml.indexOf('</array>', i);
      const nextValue = xml.indexOf('<value>', i);
      if (arrayEnd !== -1 && nextValue > arrayEnd) break;
    }
    const end = xml.indexOf('</array>', i);
    return { value: arr, end: end === -1 ? i : end + 8 };
  }
  for (const tag of ['string', 'int', 'i4', 'double', 'boolean', 'base64', 'dateTime.iso8601']) {
    const node = readText(tag);
    if (node) {
      let value = node.text;
      if (tag === 'int' || tag === 'i4') value = Number(value);
      if (tag === 'double') value = Number(value);
      if (tag === 'boolean') value = value === '1' || value === 'true';
      if (tag === 'base64') value = Buffer.from(value, 'base64');
      return { value, end: node.end };
    }
  }
  const end = xml.indexOf('</value>', i);
  return { value: xml.slice(i, end === -1 ? i : end), end: end === -1 ? i : end + 8 };
}

function readTextFrom(xml, open, close, from) {
  const s = xml.indexOf(open, from);
  if (s === -1) return null;
  const e = xml.indexOf(close, s);
  if (e === -1) return null;
  return { text: xml.slice(s + open.length, e), end: e + close.length };
}

export function parseXmlRpc(xml) {
  const params = [];
  let i = 0;
  while ((i = xml.indexOf('<param>', i)) !== -1) {
    const v = parseValue(xml, i);
    params.push(v.value);
    i = v.end;
  }
  if (!params.length) {
    const v = parseValue(xml, 0);
    if (v.value !== null && v.value !== '') params.push(v.value);
  }
  return params;
}

function buildXmlRpc(method, params) {
  const encode = (value) => {
    if (Array.isArray(value)) return `<value><array><data>${value.map(encode).join('')}</data></array></value>`;
    if (value && typeof value === 'object') {
      const members = Object.entries(value)
        .map(([k, v]) => `<member><name>${k}</name>${encode(v)}</member>`).join('');
      return `<value><struct>${members}</struct></value>`;
    }
    if (typeof value === 'number') return `<value><int>${value}</int></value>`;
    if (typeof value === 'boolean') return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
    return `<value><string>${String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string></value>`;
  };
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${
    params.map((p) => `<param>${encode(p)}</param>`).join('')}</params></methodCall>`;
}

/* ------------------------------------------------------------------ *
 * providers
 * ------------------------------------------------------------------ */

class Provider {
  constructor(id, name, { kind = 'api', needs = [], languages = ['nl', 'en'], note = '' } = {}) {
    this.id = id;
    this.name = name;
    this.kind = kind;
    this.needs = needs;
    this.languages = languages;
    this.note = note;
    this.state = { ok: null, message: 'not used yet', checkedAt: null };
  }

  get enabled() {
    if ((getConfig().subtitles.disabledProviders || []).includes(this.id)) return false;
    for (const need of this.needs) {
      const keys = getConfig().subtitles.keys;
      const creds = getConfig().subtitles.credentials;
      if (need === 'subdl' && !keys.subdl) return false;
      if (need === 'opensubtitles-com' && !keys.opensubtitlesCom) return false;
      if (need === 'addic7ed' && !(creds.addic7edUser && creds.addic7edPass)) return false;
    }
    return true;
  }

  setState(ok, message) {
    this.state = { ok, message, checkedAt: new Date().toISOString() };
    const lvl = ok ? 'info' : 'warn';
    log[lvl]('subtitles', `${this.id}: ${message}`);
  }

  async test() {
    try {
      const results = await this.search({ title: 'the matrix', year: 1999, kind: 'movie', languages: ['en'] });
      this.setState(results.length > 0, results.length ? `ok (${results.length} hits for a known movie)` : 'reachable but no hits — layout may have changed');
      return { id: this.id, ok: results.length > 0, count: results.length, message: this.state.message };
    } catch (err) {
      this.setState(false, `failed: ${String(err?.message || err)}`);
      logError('subtitles', `${this.id}: test failed`, err);
      return { id: this.id, ok: false, message: this.state.message };
    }
  }

  describe() {
    return {
      id: this.id, name: this.name, kind: this.kind, needs: this.needs,
      languages: this.languages, enabled: this.enabled, note: this.note, state: this.state,
    };
  }

  /* eslint-disable-next-line no-unused-vars */
  async search(_ctx) { return []; }
  /* eslint-disable-next-line no-unused-vars */
  async download(_result) { throw new Error(`${this.id}: download not implemented`); }
}

/* ---------------- 1. OpenSubtitles.org (legacy XML-RPC, no key) ---------------- */

class OpenSubtitlesOrg extends Provider {
  constructor() {
    super('opensubtitles-org', 'OpenSubtitles.org (legacy)', {
      kind: 'xmlrpc', languages: ['nl', 'en'],
      note: 'Keyless legacy API. Anonymous logins can be rate-limited — add credentials for a stable quota.',
    });
    this.token = null;
  }

  async call(method, params) {
    const body = buildXmlRpc(method, params);
    const res = await request('https://api.opensubtitles.org/xml-rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml', 'User-Agent': 'vu-movie v1.0' },
      body,
      timeoutMs: 25000,
      allowFailure: true,
      retries: 0,
    });
    if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`);
    return parseXmlRpc(res.text);
  }

  async login() {
    if (this.token) return this.token;
    const creds = getConfig().subtitles.credentials;
    const [result] = await this.call('LogIn', [creds.opensubtitlesOrgUser || '', creds.opensubtitlesOrgPass || '', 'en', 'vu-movie v1.0']);
    const status = result?.status;
    if (!result?.token) throw new Error(`login failed (status ${status})`);
    this.token = result.token;
    log.info('subtitles', 'opensubtitles.org login ok', { user: creds.opensubtitlesOrgUser ? 'account' : 'anonymous', status });
    return this.token;
  }

  async search(ctx) {
    const token = await this.login();
    const langs = (ctx.languages || ['nl', 'en']).map((l) => (l === 'nl' ? 'dut' : l === 'en' ? 'eng' : l));
    const queries = [];
    for (const sublanguageid of langs) {
      const q = { sublanguageid, ...(ctx.imdb ? { imdbid: String(ctx.imdb).replace(/^tt/, '') } : { query: ctx.title }) };
      if (ctx.kind === 'series') { q.season = ctx.season || 1; q.episode = ctx.episode || 1; }
      if (ctx.year && ctx.kind !== 'series') q.moviehash = undefined;
      queries.push(q);
    }
    const [result] = await this.call('SearchSubtitles', [token, queries]);
    if (String(result?.status) !== '200') {
      this.setState(false, `status ${result?.status}`);
      throw new Error(`SearchSubtitles failed with status ${result?.status}`);
    }
    const rows = result.data || [];
    this.setState(true, `${rows.length} hits`);
    return rows.map((r) => ({
      providerId: this.id,
      language: normaliseLang(r.SubLanguageID),
      title: r.MovieName,
      release: r.MovieReleaseName || r.SubFileName,
      year: r.MovieYear ? Number(r.MovieYear) : null,
      downloads: Number(r.SubDownloadsCnt || 0),
      rating: r.SubRating ? Number(r.SubRating) : null,
      hashMatch: Boolean(r.MovieHashMatch),
      id: r.IDSubtitleFile,
      url: r.SubDownloadLink,
      format: (r.SubFormat || 'srt').toLowerCase(),
      episodeMatch: Boolean(r.SeriesEpisode),
    }));
  }

  async download(result) {
    // SubDownloadLink points at a .gz
    const res = await request(result.url, { binary: true, retries: 1, timeoutMs: 30000, headers: { 'User-Agent': 'vu-movie v1.0' } });
    const buffer = res.buffer;
    if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
      const { gunzipSync } = await import('node:zlib');
      return { buffer: gunzipSync(buffer), filename: result.release || `${result.title}.srt` };
    }
    return { buffer, filename: result.release || `${result.title}.srt` };
  }
}

/* ---------------- 2. SubDL (REST, free key) ---------------- */

class SubDL extends Provider {
  constructor() {
    super('subdl', 'SubDL', { kind: 'rest', needs: ['subdl'], note: 'Free API key from subdl.com (2 000 requests/day). Includes the old Subscene archive.' });
  }

  async search(ctx) {
    const key = getConfig().subtitles.keys.subdl;
    if (!key) throw new Error('no SubDL API key configured');
    const params = new URLSearchParams({
      api_key: key,
      languages: (ctx.languages || ['nl', 'en']).map((l) => l.toUpperCase()).join(','),
      subs_per_page: '30',
    });
    if (ctx.imdb) params.set('imdb_id', String(ctx.imdb).replace(/^tt/, ''));
    else params.set('film_name', ctx.title);
    if (ctx.kind === 'series') { params.set('type', 'tv'); params.set('season_number', String(ctx.season || 1)); params.set('episode_number', String(ctx.episode || 1)); }
    else params.set('type', 'movie');
    if (ctx.year) params.set('year', String(ctx.year));

    const res = await request(`https://api.subdl.com/api/v1/subtitles?${params}`, { json: true, allowFailure: true, retries: 1 });
    if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`);
    const rows = res.data?.subtitles || [];
    this.setState(true, `${rows.length} hits`);
    return rows.map((r) => ({
      providerId: this.id,
      language: normaliseLang((r.language || r.lang || '').slice(0, 2)),
      title: r.name || r.film_name,
      release: r.release_name || r.name,
      year: r.year ? Number(r.year) : null,
      downloads: Number(r.downloads || 0),
      rating: r.rating ? Number(r.rating) : null,
      id: r.url || r.sd_id,
      url: r.url ? `https://dl.subdl.com${r.url}` : null,
      format: 'srt',
      episodeMatch: Boolean(r.episode),
    })).filter((r) => r.url);
  }

  async download(result) {
    const res = await request(result.url, { binary: true, retries: 1, timeoutMs: 30000 });
    return { buffer: res.buffer, filename: result.release || 'subdl.zip' };
  }
}

/* ---------------- 3. OpenSubtitles.com (REST, key) ---------------- */

class OpenSubtitlesCom extends Provider {
  constructor() {
    super('opensubtitles-com', 'OpenSubtitles.com', { kind: 'rest', needs: ['opensubtitles-com'], note: 'Free API key, 5–20 downloads per day depending on account.' });
  }

  headers() {
    const key = getConfig().subtitles.keys.opensubtitlesCom;
    return { 'Api-Key': key, 'User-Agent': 'vu-movie v1.0', 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  async search(ctx) {
    const params = new URLSearchParams({
      languages: (ctx.languages || ['nl', 'en']).map((l) => l).join(','),
      order_by: 'download_count', order_direction: 'desc',
    });
    if (ctx.imdb) params.set('imdb_id', String(ctx.imdb).replace(/^tt/, ''));
    else if (ctx.tmdb) params.set('tmdb_id', String(ctx.tmdb));
    else params.set('query', ctx.title);
    if (ctx.kind === 'series') { params.set('type', 'episode'); params.set('season_number', String(ctx.season || 1)); params.set('episode_number', String(ctx.episode || 1)); }
    else params.set('type', 'movie');
    if (ctx.year) params.set('year', String(ctx.year));

    const res = await request(`https://api.opensubtitles.com/api/v1/subtitles?${params}`, { headers: this.headers(), json: true, allowFailure: true });
    if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`);
    const rows = res.data?.data || [];
    this.setState(true, `${rows.length} hits`);
    return rows.map((r) => {
      const a = r.attributes || {};
      return {
        providerId: this.id,
        language: normaliseLang(a.language),
        title: a.feature_details?.title || a.release,
        release: a.release,
        year: a.feature_details?.year ? Number(a.feature_details.year) : null,
        downloads: Number(a.download_count || 0),
        rating: a.ratings ? Number(a.ratings) : null,
        fileId: a.files?.[0]?.file_id,
        id: a.files?.[0]?.file_id,
        format: 'srt',
        episodeMatch: Boolean(a.feature_details?.episode_number),
      };
    }).filter((r) => r.fileId);
  }

  async download(result) {
    const res = await request('https://api.opensubtitles.com/api/v1/download', {
      method: 'POST', headers: this.headers(), body: { file_id: result.fileId, sub_format: 'srt' },
      json: true, allowFailure: true, retries: 0,
    });
    if (!res.ok) throw new Error(res.error || `download ticket failed (HTTP ${res.status})`);
    const link = res.data?.link;
    if (!link) throw new Error('no download link in the API answer');
    const file = await request(link, { binary: true, retries: 1, timeoutMs: 30000, headers: { 'User-Agent': 'vu-movie v1.0' } });
    return { buffer: file.buffer, filename: res.data?.file_name || `${result.release || result.title}.srt` };
  }
}

/* ---------------- 4. Podnapisi (keyless, XML + HTML fallback) ---------------- */

class Podnapisi extends Provider {
  constructor() {
    super('podnapisi', 'Podnapisi', { kind: 'scrape', note: 'Keyless. Uses the XML search endpoint; falls back to HTML and reports a layout change when it gets nothing.' });
  }

  async search(ctx) {
    const langs = (ctx.languages || ['nl', 'en']);
    const results = [];
    for (const lang of langs) {
      const form = new URLSearchParams({
        sK: ctx.title || '',
        sJ: lang === 'nl' ? 'nl' : 'en',
        sT: ctx.kind === 'series' ? 'tv-series' : ctx.kind === 'movie' ? 'movie' : '',
        sTS: ctx.season ? String(ctx.season) : '',
        sTE: ctx.episode ? String(ctx.episode) : '',
        sY: ctx.year ? String(ctx.year) : '',
        sXML: '1',
      });
      const res = await request('https://www.podnapisi.net/subtitles/search/old', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
        allowFailure: true, retries: 1, timeoutMs: 20000,
      });
      if (!res.ok) continue;
      const items = [...res.text.matchAll(/<subtitle>([\s\S]*?)<\/subtitle>/g)].map((m) => m[1]);
      for (const item of items) {
        const pick = (tag) => (new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(item) || [])[1];
        const id = pick('id');
        const title = pick('title');
        if (!id) continue;
        results.push({
          providerId: this.id,
          language: normaliseLang(pick('language') || lang),
          title: decodeEntities(title || ctx.title),
          release: decodeEntities(pick('release') || title || ''),
          year: Number(pick('year')) || null,
          downloads: Number(pick('downloads') || 0),
          rating: Number(pick('rating')) || null,
          id,
          url: `https://www.podnapisi.net/subtitles/${id}/download`,
          format: 'srt',
        });
      }
    }
    if (!results.length) {
      // Fall back to the HTML page so the user sees a real "layout changed" signal
      // instead of a silent empty list.
      const res = await request(`https://www.podnapisi.net/subtitles/search/advanced?keywords=${encodeURIComponent(ctx.title)}&movie_type=movie&language=${langs[0]}`, { allowFailure: true, retries: 0 });
      const htmlHits = res.ok ? [...res.text.matchAll(/href="\/subtitles\/(\d+)\/download"/g)].length : 0;
      this.setState(htmlHits > 0, htmlHits > 0 ? `html fallback found ${htmlHits} links` : 'no results — Podnapisi may have changed its page layout');
      if (htmlHits > 0) {
        for (const m of res.text.matchAll(/href="\/subtitles\/(\d+)\/download"[^>]*>([^<]*)</g)) {
          results.push({
            providerId: this.id, language: normaliseLang(langs[0]), title: decodeEntities(m[2] || ctx.title),
            release: decodeEntities(m[2] || ''), downloads: 0, id: m[1],
            url: `https://www.podnapisi.net/subtitles/${m[1]}/download`, format: 'srt',
          });
        }
      }
    } else {
      this.setState(true, `${results.length} hits`);
    }
    return results;
  }

  async download(result) {
    const res = await request(result.url, { binary: true, retries: 1, timeoutMs: 25000 });
    return { buffer: res.buffer, filename: result.release || 'podnapisi.srt' };
  }
}

/* ---------------- 5. TVsubtitles.net (keyless, series) ---------------- */

class Tvsubtitles extends Provider {
  constructor() {
    super('tvsubtitles', 'TVsubtitles.net', { kind: 'scrape', languages: ['nl', 'en'], note: 'Series only. Simple HTML pages, keyless.' });
  }

  async search(ctx) {
    if (ctx.kind !== 'series') return [];
    const search = await request(`http://www.tvsubtitles.net/search.php?q=${encodeURIComponent(ctx.title)}`, { allowFailure: true, retries: 1 });
    if (!search.ok) throw new Error(`search page failed (${search.error || search.status})`);
    const show = /<a href="\/tvshow-(\d+)\.html"[^>]*>([^<]+)</.exec(search.text);
    if (!show) {
      this.setState(false, 'no show match — page layout may have changed');
      return [];
    }
    const showId = show[1];
    const episodePage = `http://www.tvsubtitles.net/tvshow-${showId}-${ctx.season || 1}.html`;
    const eps = await request(episodePage, { allowFailure: true, retries: 1 });
    if (!eps.ok) throw new Error('episode list failed');
    const epRegex = new RegExp(`<a href="(/subtitle-${showId}-([0-9x]+)\\.html)"[^>]*>([^<]*)<`, 'g');
    let epId = null;
    for (const m of eps.text.matchAll(epRegex)) {
      const epNum = String(m[2]).split('x')[1];
      if (Number(epNum) === Number(ctx.episode || 1)) { epId = m[1]; break; }
    }
    if (!epId) {
      this.setState(false, `episode S${ctx.season}E${ctx.episode} not listed`);
      return [];
    }
    const sub = await request(`http://www.tvsubtitles.net${epId}`, { allowFailure: true, retries: 1 });
    if (!sub.ok) throw new Error('subtitle page failed');
    const results = [];
    for (const m of sub.text.matchAll(/<a href="(\/download-\d+\.html)"[^>]*>[\s\S]*?<\/a>/g)) {
      const langMatch = /flags\/([a-z]{2})\.gif/.exec(m[0]);
      results.push({
        providerId: this.id,
        language: normaliseLang(langMatch ? langMatch[1] : 'en'),
        title: ctx.title,
        release: `${ctx.title} S${String(ctx.season).padStart(2, '0')}E${String(ctx.episode).padStart(2, '0')}`,
        url: `http://www.tvsubtitles.net${m[1]}`,
        downloads: 0,
        id: m[1],
        format: 'srt',
        episodeMatch: true,
      });
    }
    this.setState(results.length > 0, `${results.length} hits`);
    return results;
  }

  async download(result) {
    const page = await request(result.url, { allowFailure: true, retries: 1 });
    if (!page.ok) throw new Error('download page failed');
    const zip = /href="(\/download-\d+\.html|\.\.\/[^"]+\.zip)"/.exec(page.text);
    const target = zip ? new URL(zip[1], result.url).toString() : result.url;
    const res = await request(target, { binary: true, retries: 1, timeoutMs: 25000, headers: { Referer: result.url } });
    return { buffer: res.buffer, filename: `${result.title}-${result.language}.zip` };
  }
}

/* ---------------- 6. Addic7ed (series, free account) ---------------- */

/**
 * Addic7ed language ids as they appear in the `/updated/<lang>/<file>/<n>`
 * download links. Only ids verified against live pages are mapped; anything
 * else falls back to the language name in the row itself.
 */
const ADDIC7ED_LANG_BY_ID = { 1: 'en', 8: 'fr', 17: 'nl', 18: 'sv' };

/** Language names the site uses, longer names first so "Portuguese (Brazilian)" wins. */
const ADDIC7ED_LANGUAGE_NAMES = [
  ['Portuguese (Brazilian)', 'pt'],
  ['English', 'en'], ['Dutch', 'nl'], ['French', 'fr'], ['German', 'de'],
  ['Spanish', 'es'], ['Italian', 'it'], ['Russian', 'ru'], ['Swedish', 'sv'],
  ['Polish', 'pl'], ['Greek', 'el'], ['Arabic', 'ar'], ['Turkish', 'tr'],
  ['Hungarian', 'hu'], ['Romanian', 'ro'], ['Portuguese', 'pt'],
  ['Catala', 'ca'], ['Euskera', 'eu'], ['Galician', 'gl'], ['Persian', 'fa'],
  ['Czech', 'cs'],
];

function stripHtml(text) {
  return decodeEntities(String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

/**
 * Pure: parse the season table of an Addic7ed show page (what search.php
 * redirects to) into subtitle rows.
 *
 * Every `<tr>` of the table carries: season + episode (first two cells and the
 * /serie/<Show>/<s>/<e>/ link), the episode title, the language name, the
 * release/version and a `/updated/<langId>/<fileId>/<n>` download link.
 * Returns `[{ season, episode, title, language, release, url }]`.
 */
export function parseAddic7edRows(html) {
  const rows = [];
  for (const tr of String(html || '').split(/<tr[\s>]/i).slice(1)) {
    const dl = /href="(?:https?:\/\/[^"/]+)?\/(updated|original)\/(\d+)\/(\d+)\/(\d+)"/i.exec(tr);
    if (!dl) continue;
    const url = `https://www.addic7ed.com/${dl[1].toLowerCase()}/${dl[2]}/${dl[3]}/${dl[4]}`;
    const epLink = /href="(?:[^"]*\/)?serie\/[^"]*?\/(\d+)\/(\d+)\//i.exec(tr);
    const cells = tr.split(/<\/?td[^>]*>/i).map(stripHtml).filter((c) => c && !/^&nbsp;?$/.test(c));
    const season = epLink ? Number(epLink[1]) : Number(cells[0]) || null;
    const episode = epLink ? Number(epLink[2]) : Number(cells[1]) || null;
    const title = cells[2] || '';
    // Language: the first known language name in the row, else the id in the link.
    let language = ADDIC7ED_LANG_BY_ID[Number(dl[2])] || null;
    for (const [name, code] of ADDIC7ED_LANGUAGE_NAMES) {
      if (cells.some((c) => c === name) || tr.includes(`>${name}<`)) { language = code; break; }
    }
    // Release: the cell right after the language cell, unless it is a status word.
    let release = '';
    const langIdx = cells.findIndex((c) => ADDIC7ED_LANGUAGE_NAMES.some(([name]) => name === c));
    if (langIdx >= 0 && cells[langIdx + 1] && !/^(completed|incomplete)$/i.test(cells[langIdx + 1])) {
      release = cells[langIdx + 1];
    }
    rows.push({ season, episode, title, language, release, url });
  }
  return rows;
}

class Addic7ed extends Provider {
  constructor() {
    super('addic7ed', 'Addic7ed', {
      kind: 'scrape', needs: ['addic7ed'],
      note: 'Series only. Uses your free Addic7ed account (ADDIC7ED_USER / ADDIC7ED_PASS); anonymous downloads are throttled to almost nothing.',
    });
    this.jar = new CookieJar('addic7ed');
    this.loggedIn = false;
  }

  /** POST the configured credentials once; anonymous is fine for searching. */
  async login() {
    if (this.loggedIn) return true;
    const creds = getConfig().subtitles.credentials;
    if (!creds.addic7edUser || !creds.addic7edPass) return false;
    const form = new URLSearchParams({ username: creds.addic7edUser, password: creds.addic7edPass });
    const res = await request('https://www.addic7ed.com/login.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://www.addic7ed.com/login.php' },
      body: form.toString(),
      jar: this.jar, allowFailure: true, retries: 0, timeoutMs: 25000,
    });
    // A logged-in page swaps the Login link for Logout; a failure shows the form again.
    this.loggedIn = res.ok && /logout\.php|href="\/logout/i.test(res.text || '');
    this.jar.save();
    log.info('subtitles', `addic7ed login ${this.loggedIn ? 'ok' : 'failed — continuing anonymously'}`);
    return this.loggedIn;
  }

  async search(ctx) {
    if (ctx.kind !== 'series') return [];
    await this.login();
    const season = Number(ctx.season || 1);
    const episode = Number(ctx.episode || 1);
    const langs = (ctx.languages || ['nl', 'en']).map(normaliseLang);

    const res = await request(`https://www.addic7ed.com/search.php?search=${encodeURIComponent(ctx.title)}&submit=Search`, {
      jar: this.jar, allowFailure: true, retries: 1, timeoutMs: 25000,
      headers: { Referer: 'https://www.addic7ed.com/' },
    });
    if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`);

    // search.php redirects straight to /show/<id> on a hit; otherwise it lists
    // candidate shows and we pick the best label match.
    let html = res.text || '';
    if (!/\/show\/\d+/.test(res.url || '')) {
      const links = [...html.matchAll(/href="(\/show\/\d+)"[^>]*>([\s\S]*?)<\/a>/g)]
        .map((m) => ({ url: m[1], label: stripHtml(m[2]) }));
      if (!links.length) {
        this.setState(false, 'no show match — Addic7ed may have changed its page layout');
        return [];
      }
      const wanted = String(ctx.title).toLowerCase();
      const pick = links.find((l) => l.label.toLowerCase().includes(wanted)) || links[0];
      const page = await request(`https://www.addic7ed.com${pick.url}`, {
        jar: this.jar, allowFailure: true, retries: 1, timeoutMs: 25000,
        headers: { Referer: 'https://www.addic7ed.com/' },
      });
      if (!page.ok) throw new Error(page.error || `HTTP ${page.status}`);
      html = page.text || '';
    }

    const rows = parseAddic7edRows(html)
      .filter((r) => r.season === season && r.episode === episode && r.language && langs.includes(r.language))
      .map((r) => ({
        providerId: this.id,
        language: r.language,
        title: r.title || ctx.title,
        release: r.release || `${ctx.title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`,
        downloads: 0,
        id: r.url,
        url: r.url,
        referer: `https://www.addic7ed.com${(/\/show\/\d+/.exec(res.url) || [])[0] || ''}`,
        format: 'srt',
        episodeMatch: true,
      }));
    this.setState(rows.length > 0, rows.length ? `${rows.length} hits` : `nothing for S${season}E${episode} in ${langs.join('/')} — check the account quota`);
    return rows;
  }

  async download(result) {
    await this.login();
    const res = await request(result.url, {
      binary: true, jar: this.jar, retries: 0, timeoutMs: 30000,
      headers: { Referer: result.referer || 'https://www.addic7ed.com/' },
    });
    const buffer = res.buffer;
    // Over the daily quota Addic7ed answers with an HTML error page instead of a file.
    if (!buffer?.length || buffer.subarray(0, 32).toString('latin1').trimStart().startsWith('<')) {
      throw new Error('Addic7ed refused the download (daily limit reached or layout change)');
    }
    return { buffer, filename: `${result.release}.${result.language}.srt` };
  }
}

/* ---------------- 7. TVsubs.net (keyless, series) ---------------- */

/**
 * Pure: pick the episode/lang links out of a tvsubs.net season page.
 * Returns `{ episodes: Map(episodeNumber → epId), langs: Map(epId → [lang,…]) }`.
 */
export function parseTvsubsSeason(html) {
  const text = String(html || '');
  const episodes = new Map();
  // "01. <a href="/episode-107732.html">…title…" — the number and the plain
  // episode anchor sit a few characters apart. The lookbehind keeps digit runs
  // inside other ids ("subtitle-289726.html") from posing as episode numbers.
  for (const m of text.matchAll(/(?<![\d.])(\d{1,3})\.[\s\S]{0,160}?href="(?:[^"]*\/)?episode-(\d+)\.html"/g)) {
    const num = Number(m[1]);
    if (num >= 1 && !episodes.has(num)) episodes.set(num, m[2]);
  }
  const langs = new Map();
  for (const m of text.matchAll(/href="(?:[^"]*\/)?episode-(\d+)-([a-z]{2})\.html"/g)) {
    if (!langs.has(m[1])) langs.set(m[1], []);
    const list = langs.get(m[1]);
    if (!list.includes(m[2])) list.push(m[2]);
  }
  return { episodes, langs };
}

/** Pure: list the subtitle entries of a tvsubs.net episode-language page. */
export function parseTvsubsEpisode(html) {
  const entries = [];
  for (const m of String(html || '').matchAll(/<a[^>]+href="(?:[^"]*\/)?subtitle-(\d+)\.html"[^>]*>([\s\S]*?)<\/a>/g)) {
    const release = stripHtml(m[2]);
    if (!release) continue;
    entries.push({ id: m[1], release });
  }
  return entries;
}

class Tvsubs extends Provider {
  constructor() {
    super('tvsubs', 'TVsubs.net', {
      kind: 'scrape', languages: ['nl', 'en'],
      note: 'Series only. Keyless; a different catalogue than TVsubtitles.net. Files arrive as ZIP archives.',
    });
  }

  async search(ctx) {
    if (ctx.kind !== 'series') return [];
    const season = Number(ctx.season || 1);
    const episode = Number(ctx.episode || 1);
    const langs = (ctx.languages || ['nl', 'en']).map(normaliseLang);

    // 1. find the show — search.php lists candidates with /tvshow-<id>-<n>.html links.
    const found = await request(`https://www.tvsubs.net/search.php?q=${encodeURIComponent(ctx.title)}`, { allowFailure: true, retries: 1, timeoutMs: 25000 });
    if (!found.ok) throw new Error(found.error || `HTTP ${found.status}`);
    const shows = [...(found.text || '').matchAll(/href="[^"]*\/tvshow-(\d+)-\d+\.html"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((m) => ({ id: m[1], label: stripHtml(m[2]) }));
    if (!shows.length) {
      this.setState(false, 'no show match — TVsubs.net may have changed its page layout');
      return [];
    }
    const wanted = String(ctx.title).toLowerCase();
    const show = shows.find((s) => s.label.toLowerCase() === wanted)
      || shows.find((s) => s.label.toLowerCase().includes(wanted))
      || shows[0];

    // 2. season page: /tvshow-<id>-<season>.html (the second number IS the season).
    const seasonPage = await request(`https://www.tvsubs.net/tvshow-${show.id}-${season}.html`, { allowFailure: true, retries: 1, timeoutMs: 25000 });
    if (!seasonPage.ok) throw new Error(seasonPage.error || `HTTP ${seasonPage.status}`);
    const { episodes, langs: episodeLangs } = parseTvsubsSeason(seasonPage.text);
    const epId = episodes.get(episode);
    if (!epId) {
      this.setState(false, `episode S${season}E${episode} not listed`);
      return [];
    }

    // 3. one page per (episode, language): /episode-<epId>-<lang>.html
    const results = [];
    for (const lang of episodeLangs.get(epId) || []) {
      if (!langs.includes(lang)) continue;
      const epPage = await request(`https://www.tvsubs.net/episode-${epId}-${lang}.html`, { allowFailure: true, retries: 1, timeoutMs: 25000 });
      if (!epPage.ok) continue;
      for (const entry of parseTvsubsEpisode(epPage.text)) {
        results.push({
          providerId: this.id,
          language: lang,
          title: ctx.title,
          release: entry.release,
          downloads: 0,
          id: entry.id,
          url: `https://www.tvsubs.net/subtitle-${entry.id}.html`,
          format: 'srt',
          episodeMatch: true,
        });
      }
    }
    this.setState(results.length > 0, `${results.length} hits`);
    return results;
  }

  async download(result) {
    // /download-<id>.html serves the packed subtitle directly; if the site
    // answers with an HTML page instead, take the first archive link from it.
    const res = await request(`https://www.tvsubs.net/download-${result.id}.html`, {
      binary: true, retries: 1, timeoutMs: 25000,
      headers: { Referer: result.url },
    });
    let buffer = res.buffer;
    if (buffer?.length && buffer.subarray(0, 32).toString('latin1').trimStart().startsWith('<')) {
      const html = buffer.toString('utf8');
      const link = /href="([^"]+\.(?:zip|rar|srt))"/i.exec(html) || /href="([^"]*download[^"]*)"/i.exec(html);
      if (!link) throw new Error('TVsubs.net download page had no file link — layout may have changed');
      const target = new URL(link[1], `https://www.tvsubs.net/download-${result.id}.html`).toString();
      const file = await request(target, { binary: true, retries: 1, timeoutMs: 25000, headers: { Referer: result.url } });
      buffer = file.buffer;
    }
    if (!buffer?.length) throw new Error('TVsubs.net sent an empty download');
    return { buffer, filename: `${result.release}.${result.language}.zip` };
  }
}

/* ---------------- 8. user-defined template providers ---------------- */

export class CustomProvider extends Provider {
  constructor(config) {
    super(config.id, config.name || config.id, { kind: 'custom', note: config.note || 'user defined' });
    this.config = config;
  }

  get enabled() {
    return this.config.enabled !== false;
  }

  async search(ctx) {
    const fill = (tpl) => String(tpl || '')
      .replace(/\{query\}/g, encodeURIComponent(ctx.title || ''))
      .replace(/\{title\}/g, ctx.title || '')
      .replace(/\{lang\}/g, (ctx.languages || ['en'])[0])
      .replace(/\{imdb\}/g, String(ctx.imdb || '').replace(/^tt/, ''))
      .replace(/\{tmdb\}/g, String(ctx.tmdb || ''))
      .replace(/\{year\}/g, String(ctx.year || ''))
      .replace(/\{sxx\}/g, String(ctx.season || 1).padStart(2, '0'))
      .replace(/\{exx\}/g, String(ctx.episode || 1).padStart(2, '0'));

    const url = fill(this.config.searchUrl);
    const res = await request(url, {
      method: this.config.searchMethod || 'GET',
      headers: this.config.headers || {},
      json: this.config.parse?.kind === 'json',
      allowFailure: true, retries: 1, timeoutMs: 25000,
    });
    if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`);

    const results = [];
    if (this.config.parse?.kind === 'json') {
      const items = String(this.config.parse.items || '')
        .split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), res.data) || [];
      for (const item of (Array.isArray(items) ? items : [])) {
        const get = (dotted) => (dotted ? String(dotted).split('.').reduce((a, k) => (a == null ? a : a[k]), item) : null);
        const raw = get(this.config.parse.map?.url);
        if (!raw) continue;
        results.push({
          providerId: this.id,
          language: normaliseLang(get(this.config.parse.map?.language) || (ctx.languages || ['en'])[0]),
          title: get(this.config.parse.map?.title) || ctx.title,
          release: get(this.config.parse.map?.release) || get(this.config.parse.map?.title) || ctx.title,
          downloads: Number(get(this.config.parse.map?.downloads) || 0),
          id: raw,
          url: /^https?:/.test(raw) ? raw : new URL(raw, this.config.baseUrl || url).toString(),
          format: (this.config.parse.map?.format && get(this.config.parse.map.format)) || 'srt',
        });
      }
    } else {
      const regex = new RegExp(this.config.parse?.regex || '<a[^>]+href="([^"]+)"[^>]*>([^<]{2,120})<', 'g');
      for (const m of res.text.matchAll(regex)) {
        const groups = m.groups || {};
        const raw = groups.url || m[1];
        if (!raw) continue;
        results.push({
          providerId: this.id,
          language: normaliseLang(groups.lang || (ctx.languages || ['en'])[0]),
          title: decodeEntities(groups.title || m[2] || ctx.title),
          release: decodeEntities(groups.release || groups.title || m[2] || ctx.title),
          downloads: Number(groups.downloads || 0),
          id: raw,
          url: /^https?:/.test(raw) ? raw : new URL(raw, this.config.baseUrl || url).toString(),
          format: groups.format || 'srt',
        });
      }
    }
    this.setState(results.length > 0, `${results.length} hits`);
    return results;
  }

  async download(result) {
    let target = result.url;
    if (this.config.downloadUrl) {
      target = String(this.config.downloadUrl).replace(/\{url\}/g, encodeURIComponent(result.url)).replace(/\{id\}/g, encodeURIComponent(result.id));
    }
    const res = await request(target, { binary: true, retries: 1, timeoutMs: 30000, headers: this.config.headers || {} });
    return { buffer: res.buffer, filename: result.release || 'custom.srt' };
  }
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

/* ------------------------------------------------------------------ *
 * registry
 * ------------------------------------------------------------------ */

const providers = [
  new OpenSubtitlesOrg(),
  new SubDL(),
  new OpenSubtitlesCom(),
  new Podnapisi(),
  new Tvsubtitles(),
  new Addic7ed(),
  new Tvsubs(),
];

export function listProviders() {
  const custom = (getConfig().subtitles.customProviders || []).map((c) => new CustomProvider(c));
  return [...providers, ...custom].map((p) => p.describe());
}

function allProviders() {
  const custom = (getConfig().subtitles.customProviders || []).map((c) => new CustomProvider(c));
  return [...providers, ...custom];
}

export function getProvider(id) {
  return allProviders().find((p) => p.id === id) || null;
}

export async function testProvider(id) {
  const provider = getProvider(id);
  if (!provider) return { ok: false, message: `unknown provider ${id}` };
  return provider.test();
}

/**
 * Search all enabled providers and rank the hits.
 * @param {object} target { title, year, kind, season, episode, imdb, tmdb, release, languages }
 */
export async function searchSubtitles(target) {
  const cfg = getConfig();
  const languages = target.languages?.length ? target.languages : cfg.subtitles.languages;
  const ctx = { ...target, languages };
  const active = allProviders().filter((p) => p.enabled);
  log.info('subtitles', `searching ${active.length} provider(s)`, {
    title: target.title, languages: languages.join(','), providers: active.map((p) => p.id).join(','),
  });

  const settled = await Promise.all(active.map(async (p) => {
    const t0 = Date.now();
    try {
      const hits = await p.search(ctx);
      log.debug('subtitles', `${p.id}: ${hits.length} hits in ${Date.now() - t0} ms`);
      return hits;
    } catch (err) {
      p.setState(false, `search failed: ${String(err?.message || err)}`);
      logError('subtitles', `${p.id}: search failed`, err, { title: target.title });
      return [];
    }
  }));

  const all = settled.flat()
    .map((r) => ({ ...r, score: scoreResult(r, { ...target, languages }) }))
    .sort((a, b) => b.score - a.score);

  log.info('subtitles', `total ${all.length} subtitle candidate(s)`, {
    best: all[0] ? `${all[0].providerId}/${all[0].language} ${all[0].release}` : 'none',
  });
  return all;
}

/**
 * Download a hit and return normalised SRT text.
 * Handles .gz/.zip/.rar archives and VTT responses transparently.
 */
export async function fetchSubtitle(result, { offsetMs = 0 } = {}) {
  const provider = getProvider(result.providerId);
  if (!provider) throw new Error(`unknown provider ${result.providerId}`);
  const t0 = Date.now();
  const { buffer, filename } = await provider.download(result);
  log.info('subtitles', `downloaded from ${provider.id}`, { bytes: buffer?.length || 0, filename, ms: Date.now() - t0 });

  const cfg = getConfig();
  let text = null;
  if (isZip(buffer) || isRar(buffer)) {
    // ZIPs are unpacked in-process (no external tools needed); .rar/.7z fall
    // back to 7z/unrar inside the image.
    const extracted = extractSubtitleFromBuffer(buffer, cfg.storage.tmp);
    if (!extracted) throw new Error('archive contained no subtitle file');
    text = extracted.text;
    if (log.level?.() === 'debug') log.debug('subtitles', `archive entry: ${extracted.filename}`);
  } else {
    const decoded = decodeSubtitle(buffer);
    text = decoded.text;
  }
  if (/^WEBVTT/.test(text.trim())) text = vttToSrt(text);
  let srt = cleanSrt(text);
  if (!/-->/.test(srt)) throw new Error('downloaded file does not look like a subtitle');
  if (offsetMs) srt = applyOffset(srt, offsetMs);
  return {
    srt,
    cues: countCues(srt),
    language: normaliseLang(result.language),
    provider: result.providerId,
    release: result.release || result.title,
    filename: `${result.release || result.title || 'subtitle'}.${normaliseLang(result.language)}.srt`,
  };
}

/** Save SRT text to /downloads/subtitles and return the path. */
export function storeSubtitle(srtText, { slug, language }) {
  const cfg = getConfig();
  const dir = path.join(cfg.storage.downloads, 'subtitles');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}.${language}.srt`);
  fs.writeFileSync(file, srtText, 'utf8');
  log.info('subtitles', 'subtitle stored', { file, cues: countCues(srtText) });
  return file;
}

/** One-shot: search + pick the best hit + download it. */
export async function autoFetch(target, { offsetMs = 0 } = {}) {
  const results = await searchSubtitles(target);
  if (!results.length) {
    log.warn('subtitles', 'no subtitle found', { title: target.title, languages: target.languages });
    return null;
  }
  const best = results[0];
  log.info('subtitles', `auto-selected subtitle`, {
    provider: best.providerId, language: best.language, release: truncate(best.release, 80), score: best.score,
  });
  const fetched = await fetchSubtitle(best, { offsetMs });
  return { ...fetched, result: best, alternatives: results.slice(1, 10) };
}

export default {
  listProviders, searchSubtitles, fetchSubtitle, storeSubtitle, autoFetch, testProvider,
  getProvider, parseXmlRpc, CustomProvider, parseAddic7edRows, parseTvsubsSeason, parseTvsubsEpisode,
};
