/**
 * vu-movie — public outputs of the playlist.
 *
 * Everything in here is reachable *without* the /api password, exactly like the
 * per-stream /s/<token>/ URLs: VLC, a Kodi box, the VU+ Duo2 and an IPTV app
 * cannot log in, so access is guarded by the unguessable playlist token in the
 * path instead. Anyone who has an URL is already on the LAN and can play the
 * streams anyway.
 *
 *   GET /pl/<token>/                    info page: every output URL, clickable
 *   GET /pl/<token>/playlist.m3u        the enabled items, in playlist order
 *   GET /pl/<token>/playlist.m3u8       same list, .m3u8 extension (IPTV apps)
 *   GET /pl/<token>/vlc.m3u             same list (what the VLC button copies)
 *   GET /pl/<token>/kodi.m3u            same list, Kodi-friendly naming
 *   GET /pl/<token>/playlist.json       machine-readable list (title/url/logo)
 *   GET /pl/<token>/userbouquet.tv      the Enigma2 bouquet file
 *   GET /xtream/<token>/player_api.php  Xtream catalogue/API
 *   GET /xtream/<token>/get.php         complete enabled-playlist M3U_plus
 *   GET /xtream/<token>/<type>/…        token + account protected playback relay
 *   GET /xtream/<token>/xmltv.php       (empty) EPG, so clients stop retrying
 */

import express from 'express';
import crypto from 'node:crypto';
import { log } from '../core/log.js';
import { getConfig } from '../core/config.js';
import * as store from '../streams/store.js';
import * as playlist from './index.js';

const router = express.Router();

/** The URL a request arrived on (honours the configured base URL). */
function baseUrlFrom(req) {
  const configured = getConfig().app.baseUrl;
  if (configured) return String(configured).replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

/** Reject a wrong token without saying which part was wrong. */
function requireToken(req, res) {
  if (playlist.tokenMatches(req.params.token)) return true;
  log.warn('playlist', 'output request with an unknown playlist token', {
    path: req.path, ip: req.ip,
  });
  res.status(404).type('text/plain').send('vu-movie: unknown playlist token');
  return false;
}

function xtreamExpectedCredentials(token = playlist.token()) {
  const cfg = getConfig().playlist;
  return {
    username: cfg.xtreamUsername || 'vumovie',
    password: cfg.xtreamPassword || token,
  };
}

function xtreamAuthorised(req) {
  const expected = xtreamExpectedCredentials(req.params.token);
  const user = req.query.username || req.query.user || '';
  const pass = req.query.password || req.query.pass || '';
  // The playlist token in the route is itself a secret, so Xtream clients that
  // omit redundant query credentials are still allowed. Supplied credentials
  // must match; this keeps a typo visible instead of silently accepting it.
  if (user && user !== expected.username) {
    log.warn('playlist', 'xtream request with an unexpected username', { user: String(user).slice(0, 40) });
    return false;
  }
  if (pass && pass !== expected.password) {
    log.warn('playlist', 'xtream request with a wrong password');
    return false;
  }
  return true;
}

function xtreamPathAuthorised(req) {
  const expected = xtreamExpectedCredentials(req.params.token);
  if (String(req.params.username || '') !== expected.username) {
    log.warn('playlist', 'xtream stream request with an unexpected username', { user: String(req.params.username || '').slice(0, 40) });
    return false;
  }
  if (String(req.params.password || '') !== expected.password) {
    log.warn('playlist', 'xtream stream request with a wrong password');
    return false;
  }
  return true;
}

/** Stable numeric Xtream IDs: reordering the playlist does not change a stream URL. */
function xtreamStreamId(stream) {
  const value = String(stream?.id || '');
  if (/^[a-f0-9]{1,13}$/i.test(value)) {
    const numeric = Number.parseInt(value, 16);
    if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;
  }
  return crypto.createHash('sha256').update(value).digest().readUIntBE(0, 6) || 1;
}

function xtreamExtension(stream) {
  return stream.profile?.container === 'matroska' ? 'mkv' : 'ts';
}

function xtreamStreamUrl(baseUrl, token, stream, type = 'live') {
  const { username, password } = xtreamExpectedCredentials(token);
  const root = `${String(baseUrl || '').replace(/\/$/, '')}/xtream/${encodeURIComponent(token)}`;
  return `${root}/${type}/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${xtreamStreamId(stream)}.${xtreamExtension(stream)}`;
}

function xtreamItem(entry, index, baseUrl, token, type = 'live') {
  const stream = entry.stream;
  const urls = store.urlsFor(stream, baseUrl);
  const ext = xtreamExtension(stream);
  const streamUrl = xtreamStreamUrl(baseUrl, token, stream, type);
  return {
    num: index + 1,
    name: `${stream.title}${stream.year ? ` (${stream.year})` : ''}`,
    stream_type: type === 'movie' ? 'movie' : 'live',
    stream_id: xtreamStreamId(stream),
    stream_icon: stream.poster || '',
    epg_channel_id: null,
    added: stream.created_at ? String(Math.floor(new Date(stream.created_at).getTime() / 1000)) : '',
    category_id: '1',
    custom_sid: '',
    tv_archive: 0,
    direct_source: streamUrl,
    tv_archive_duration: 0,
    // Extra fields (ignored by strict clients, useful in the info page):
    vu_movie_id: stream.id,
    vu_movie_url: urls.ts,
    container_extension: ext,
  };
}

/** Series are stored as one playlist stream per selected episode. */
function xtreamSeriesGroups(entries = []) {
  const groups = new Map();
  for (const entry of entries) {
    const stream = entry?.stream;
    if (!stream || stream.kind !== 'series') continue;
    const title = String(stream.title || 'Untitled series');
    const name = title.replace(/\s+S\d{1,3}E\d{1,3}.*$/i, '').trim() || title;
    const key = name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, name, episodes: [] });
    groups.get(key).episodes.push(entry);
  }
  return [...groups.values()];
}

function xtreamSeriesId(group) {
  return xtreamStreamId({ id: `series:${group.key}` });
}

function xtreamSeriesInfo(group, index) {
  const first = group.episodes[0]?.stream || {};
  return {
    num: index + 1,
    name: group.name,
    series_id: xtreamSeriesId(group),
    cover: first.poster || '',
    cover_big: first.poster || '',
    plot: first.description || '',
    cast: '',
    director: '',
    genre: '',
    releaseDate: first.year ? String(first.year) : '',
    last_modified: first.created_at ? String(Math.floor(new Date(first.created_at).getTime() / 1000)) : '',
    rating: '0',
    rating_5based: 0,
    backdrop_path: first.poster ? [first.poster] : [],
    youtube_trailer: '',
    episode_run_time: '0',
    category_id: '1',
  };
}

/* ------------------------------------------------------------------ *
 * /pl/<token>/…
 * ------------------------------------------------------------------ */

/** The landing page: every output URL of this playlist, ready to copy. */
router.get('/pl/:token', async (req, res) => {
  if (!requireToken(req, res)) return;
  const baseUrl = baseUrlFrom(req);
  const items = await playlist.entries({ baseUrl });
  const enabled = items.filter((item) => item.enabled);
  const root = `${baseUrl}/pl/${req.params.token}`;
  const cfgPlaylist = getConfig().playlist;
  const rows = enabled.map((entry, index) => {
    const urls = store.urlsFor(entry.stream, baseUrl);
    return `<tr><td>${index + 1}</td><td>${escapeHtml(entry.stream.title)}${entry.stream.year ? ` (${entry.stream.year})` : ''}</td>
      <td class="mono">${escapeHtml(entry.stream.upstream?.quality || '—')}</td>
      <td class="mono">${escapeHtml(entry.templateId || entry.stream.profile?.ffmpegTemplateName || 'guided')}</td>
      <td><a href="${escapeHtml(urls.ts)}">.ts</a> · <a href="${escapeHtml(urls.playlist)}">.m3u</a> · <a href="${escapeHtml(urls.watch)}">watch</a> · <a href="${escapeHtml(urls.web)}" title="browser preview: no subtitles, codecs from the browser">browser</a></td></tr>`;
  }).join('');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>vu-movie playlist</title>
<style>body{background:#0b0f16;color:#e6edf7;font:14px/1.5 system-ui;margin:0;padding:22px}
a{color:#38bdf8}code{background:#151d2c;padding:2px 6px;border-radius:6px;word-break:break-all}
table{width:100%;border-collapse:collapse;margin-top:10px}td,th{border-bottom:1px solid #243149;padding:7px 9px;text-align:left;font-size:13px}
.mono{font-family:ui-monospace,monospace}h1{font-size:19px}h2{font-size:14px;margin:22px 0 6px;color:#8ea0bd;text-transform:uppercase;letter-spacing:.6px}
li{margin:4px 0}</style></head><body>
<h1>${escapeHtml(playlist.name())} — playlist</h1>
<p>${enabled.length} of ${items.length} item(s) enabled.</p>
<h2>Playlist</h2><ul>
<li>M3U: <code>${escapeHtml(`${root}/playlist.m3u`)}</code></li>
<li>VLC: <code>${escapeHtml(`${root}/vlc.m3u`)}</code></li>
<li>Enigma2 bouquet: <code>${escapeHtml(`${root}/userbouquet.tv`)}</code></li>
<li>Xtream API: <code>${escapeHtml(`${baseUrl}/xtream/${req.params.token}/player_api.php`)}</code> (user <code>${escapeHtml(cfgPlaylist.xtreamUsername || 'vumovie')}</code>)</li>
<li>Xtream M3U+: <code>${escapeHtml(`${baseUrl}/xtream/${req.params.token}/get.php?username=${encodeURIComponent(cfgPlaylist.xtreamUsername || 'vumovie')}&password=${encodeURIComponent(cfgPlaylist.xtreamPassword || req.params.token)}&type=m3u_plus`)}</code></li>
</ul>
<h2>Items</h2>
<table><thead><tr><th>#</th><th>Title</th><th>Quality</th><th>FFmpeg template</th><th>Links</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5">the playlist is empty</td></tr>'}</tbody></table>
</body></html>`);
});

router.get('/pl/:token/:file', async (req, res) => {
  if (!requireToken(req, res)) return;
  const baseUrl = baseUrlFrom(req);
  const file = String(req.params.file || '').toLowerCase();
  if (file.endsWith('.json')) {
    const items = await playlist.entries({ baseUrl });
    return res.json({
      ok: true,
      name: playlist.name(),
      generatedAt: new Date().toISOString(),
      items: items.filter((item) => item.enabled).map((entry) => {
        const urls = store.urlsFor(entry.stream, baseUrl);
        return {
          streamId: entry.stream.id,
          title: entry.stream.title,
          year: entry.stream.year,
          quality: entry.stream.upstream?.quality || null,
          template: entry.templateId || entry.stream.profile?.ffmpegTemplateName || null,
          subtitle: entry.stream.profile?.subtitlePath || null,
          poster: entry.stream.poster || null,
          url: urls.ts,
          urls: { ts: urls.ts, web: urls.web, mkv: urls.mkv, hls: urls.hls, playlist: urls.playlist, watch: urls.watch },
        };
      }),
    });
  }
  if (file.endsWith('.tv')) {
    const built = await playlist.bouquet(baseUrl);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${built.fileName}"`);
    log.info('playlist', `enigma2 bouquet served for ${built.count} item(s)`);
    return res.send(built.text);
  }
  if (file.endsWith('.m3u') || file.endsWith('.m3u8')) {
    const built = await playlist.playlistText(baseUrl, { hls: file.endsWith('.m3u8') });
    res.setHeader('Content-Type', file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'audio/x-mpegurl');
    res.setHeader('Content-Disposition', `inline; filename="${playlist.name()}${file.endsWith('.m3u8') ? '.m3u8' : '.m3u'}"`);
    log.info('playlist', `playlist served for ${built.count} item(s)`, { file });
    return res.send(built.text);
  }
  return res.status(404).type('text/plain').send('vu-movie: use playlist.m3u, playlist.m3u8, playlist.json or userbouquet.tv');
});

/* ------------------------------------------------------------------ *
 * /xtream/<token>/…  — Xtream Codes compatible catalogue
 * ------------------------------------------------------------------ */

function xtreamInfo(baseUrl, token) {
  const { username, password } = xtreamExpectedCredentials(token);
  const url = new URL(baseUrl);
  return {
    user_info: {
      username,
      password,
      message: 'vu-movie',
      auth: 1,
      status: 'Active',
      exp_date: null,
      is_trial: '0',
      active_cons: 0,
      created_at: String(Math.floor(Date.now() / 1000)),
      max_connections: '0',
      allowed_output_formats: ['m3u8', 'ts', 'mkv'],
    },
    server_info: {
      url: url.hostname,
      port: String(url.port || (url.protocol === 'https:' ? 443 : 80)),
      https_port: url.protocol === 'https:' ? String(url.port || 443) : '443',
      server_protocol: url.protocol.replace(':', ''),
      rtmp_port: '0',
      timezone: 'Europe/Amsterdam',
      timestamp_now: Math.floor(Date.now() / 1000),
      time_now: new Date().toISOString().slice(0, 19).replace('T', ' '),
      process: true,
    },
  };
}

function xtreamEpisode(entry, index, baseUrl, token) {
  const stream = entry.stream;
  const season = Number(stream.upstream?.season) || 1;
  const episode = Number(stream.upstream?.episode) || index + 1;
  const date = stream.created_at ? String(Math.floor(new Date(stream.created_at).getTime() / 1000)) : '';
  return {
    id: xtreamStreamId(stream),
    episode_num: episode,
    title: stream.title,
    container_extension: xtreamExtension(stream),
    info: {
      movie_image: stream.poster || '',
      plot: stream.description || '',
      releasedate: stream.year ? String(stream.year) : '',
      rating: '0',
      duration_secs: 0,
      duration: '00:00:00',
      bitrate: 0,
    },
    season,
    added: date,
    direct_source: xtreamStreamUrl(baseUrl, token, stream, 'series'),
  };
}

function xtreamSeriesDetails(group, baseUrl, token) {
  const orderedEpisodes = group.episodes.map((entry, index) => xtreamEpisode(entry, index, baseUrl, token));
  const bySeason = new Map();
  for (const episode of orderedEpisodes) {
    if (!bySeason.has(episode.season)) bySeason.set(episode.season, []);
    bySeason.get(episode.season).push(episode);
  }
  for (const episodes of bySeason.values()) episodes.sort((a, b) => a.episode_num - b.episode_num);
  const episodes = Object.fromEntries([...bySeason.entries()].map(([season, values]) => [String(season), values]));
  const seasons = [...bySeason.entries()].map(([season, values]) => ({
    air_date: '',
    episode_count: values.length,
    id: xtreamStreamId({ id: `series:${group.key}:season:${season}` }),
    name: `Season ${season}`,
    overview: '',
    season_number: season,
    cover: values[0]?.info?.movie_image || '',
    cover_big: values[0]?.info?.movie_image || '',
  }));
  return { episodes, seasons, info: xtreamSeriesInfo(group, 0) };
}

router.all('/xtream/:token/player_api.php', async (req, res) => {
  if (!requireToken(req, res)) return;
  if (!xtreamAuthorised(req)) return res.status(401).json({ user_info: { auth: 0, status: 'Invalid credentials' } });
  const action = String(req.query.action || '');
  const baseUrl = baseUrlFrom(req);
  const entries = (await playlist.entries({ baseUrl })).filter((entry) => entry.enabled);
  const movies = entries.filter((entry) => entry.stream.kind !== 'series');
  const series = xtreamSeriesGroups(entries);
  switch (action) {
    case 'get_live_categories':
    case 'get_vod_categories':
    case 'get_series_categories':
      return res.json([{ category_id: '1', category_name: playlist.name(), parent_id: 0 }]);
    case 'get_live_streams':
      // This app's catalogue is on-demand; exposing its movies here as well
      // keeps older clients that only query the live action working.
      return res.json(movies.map((entry, index) => xtreamItem(entry, index, baseUrl, req.params.token, 'live')));
    case 'get_vod_streams':
      return res.json(movies.map((entry, index) => xtreamItem(entry, index, baseUrl, req.params.token, 'movie')));
    case 'get_series':
      return res.json(series.map((group, index) => xtreamSeriesInfo(group, index)));
    case 'get_series_info': {
      const wanted = Number(req.query.series_id);
      const group = series.find((item) => xtreamSeriesId(item) === wanted);
      return res.json(group ? xtreamSeriesDetails(group, baseUrl, req.params.token) : {});
    }
    case 'get_short_epg':
    case 'get_simple_data_table':
      return res.json([]);
    case 'get_epg':
      return res.json({ epg_listings: [] });
    default:
      return res.json(xtreamInfo(baseUrl, req.params.token));
  }
});

/** Xtream clients play catalogue entries through the familiar /live/... URL. */
router.get('/xtream/:token/:type/:username/:password/:streamId.:ext', async (req, res) => {
  if (!requireToken(req, res)) return;
  if (!xtreamPathAuthorised(req)) return res.status(401).type('text/plain').send('Invalid credentials');
  const type = String(req.params.type || '').toLowerCase();
  const ext = String(req.params.ext || '').toLowerCase();
  if (!['live', 'movie', 'series'].includes(type) || !['ts', 'mkv', 'm3u8'].includes(ext)) {
    return res.status(404).type('text/plain').send('Unknown Xtream stream');
  }
  const id = Number(req.params.streamId);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(404).type('text/plain').send('Unknown Xtream stream');
  const baseUrl = baseUrlFrom(req);
  const entries = (await playlist.entries({ baseUrl })).filter((entry) => entry.enabled);
  const entry = entries.find((item) => xtreamStreamId(item.stream) === id);
  if (!entry || (type === 'series') !== (entry.stream.kind === 'series')) {
    return res.status(404).type('text/plain').send('Unknown Xtream stream');
  }
  const urls = store.urlsFor(entry.stream, baseUrl);
  const target = ext === 'mkv' ? urls.mkv : ext === 'm3u8' ? urls.hls : urls.ts;
  return res.redirect(302, target);
});

router.all('/xtream/:token/get.php', async (req, res) => {
  if (!requireToken(req, res)) return;
  if (!xtreamAuthorised(req)) return res.status(401).type('text/plain').send('Invalid credentials');
  const baseUrl = baseUrlFrom(req);
  const built = await playlist.playlistText(baseUrl, { hls: String(req.query.type || '').includes('m3u8') });
  log.info('playlist', `xtream m3u download by ${req.ip}`, { items: built.count, type: req.query.type || 'm3u_plus' });
  res.setHeader('Content-Type', 'audio/x-mpegurl');
  res.setHeader('Content-Disposition', `attachment; filename="${playlist.name()}.m3u"`);
  res.send(built.text);
});

router.all('/xtream/:token/xmltv.php', async (req, res) => {
  if (!requireToken(req, res)) return;
  res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="vu-movie"></tv>\n');
});

router.get('/xtream/:token/', async (req, res) => {
  if (!requireToken(req, res)) return;
  const baseUrl = baseUrlFrom(req);
  const root = `${baseUrl}/xtream/${req.params.token}`;
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>vu-movie xtream</title>
<style>body{background:#0b0f16;color:#e6edf7;font:14px system-ui;padding:22px}a{color:#38bdf8}code{background:#151d2c;padding:2px 6px;border-radius:6px;word-break:break-all}</style></head>
<body><h1>Xtream Codes compatible endpoint</h1>
<p>Server URL: <code>${escapeHtml(baseUrl)}</code><br>Port: <code>${escapeHtml(new URL(baseUrl).port || (new URL(baseUrl).protocol === 'https:' ? '443' : '80'))}</code><br>
Username: <code>${escapeHtml(getConfig().playlist.xtreamUsername || 'vumovie')}</code><br>
Password: <code>${escapeHtml(getConfig().playlist.xtreamPassword || req.params.token)}</code></p>
<p>player_api.php: <code>${escapeHtml(`${root}/player_api.php`)}</code><br>
complete M3U+: <code>${escapeHtml(`${root}/get.php?username=${encodeURIComponent(getConfig().playlist.xtreamUsername || 'vumovie')}&password=${encodeURIComponent(getConfig().playlist.xtreamPassword || req.params.token)}&type=m3u_plus`)}</code></p></body></html>`);
});

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default router;
