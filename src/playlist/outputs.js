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
 *   GET /xtream/<token>/player_api.php  Xtream Codes API (what TiviMate/VLC ask)
 *   GET /xtream/<token>/get.php         Xtream M3U_plus download
 *   GET /xtream/<token>/xmltv.php       (empty) EPG, so clients stop retrying
 */

import express from 'express';
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

function xtreamAuthorised(req) {
  const cfg = getConfig().playlist;
  const expectedUser = cfg.xtreamUsername || 'vumovie';
  const expectedPass = cfg.xtreamPassword || playlist.token();
  const user = req.query.username || req.query.user || '';
  const pass = req.query.password || req.query.pass || '';
  // Xtream clients are not always able to send both; the token in the path is
  // already a secret, so a wrong password alone is not a reason to fail — but it
  // is logged so a typo is visible.
  if (user && user !== expectedUser) {
    log.warn('playlist', 'xtream request with an unexpected username', { user: String(user).slice(0, 40) });
    return false;
  }
  if (pass && pass !== expectedPass) {
    log.warn('playlist', 'xtream request with a wrong password');
    return false;
  }
  return true;
}

function xtreamItem(entry, index, baseUrl) {
  const stream = entry.stream;
  const urls = store.urlsFor(stream, baseUrl);
  const ext = stream.profile?.container === 'matroska' ? 'mkv' : 'ts';
  return {
    num: index + 1,
    name: `${stream.title}${stream.year ? ` (${stream.year})` : ''}`,
    stream_type: 'live',
    stream_id: index + 1,
    stream_icon: stream.poster || '',
    epg_channel_id: null,
    added: stream.created_at ? String(new Date(stream.created_at).getTime()).slice(0, 10) : '',
    category_id: '1',
    custom_sid: '',
    tv_archive: 0,
    direct_source: '',
    tv_archive_duration: 0,
    // Extra fields (ignored by strict clients, useful in the info page):
    vu_movie_id: stream.id,
    vu_movie_url: urls.ts,
    container_extension: ext,
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
<li>Xtream: <code>${escapeHtml(`${baseUrl}/xtream/${req.params.token}/player_api.php`)}</code> (user <code>${escapeHtml(cfgPlaylist.xtreamUsername || 'vumovie')}</code>)</li>
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
  const cfg = getConfig().playlist;
  const url = new URL(baseUrl);
  return {
    user_info: {
      username: cfg.xtreamUsername || 'vumovie',
      password: cfg.xtreamPassword || token,
      message: 'vu-movie',
      auth: 1,
      status: 'Active',
      exp_date: null,
      is_trial: '0',
      active_cons: 0,
      created_at: String(Math.floor(Date.now() / 1000)),
      max_connections: '0',
      allowed_output_formats: ['m3u8', 'ts'],
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

router.all('/xtream/:token/player_api.php', async (req, res) => {
  if (!requireToken(req, res)) return;
  if (!xtreamAuthorised(req)) return res.status(401).json({ user_info: { auth: 0, status: 'Invalid credentials' } });
  const action = String(req.query.action || '');
  const baseUrl = baseUrlFrom(req);
  const entries = (await playlist.entries({ baseUrl })).filter((entry) => entry.enabled);
  const streams = entries.map((entry, index) => xtreamItem(entry, index, baseUrl));
  switch (action) {
    case 'get_live_categories':
    case 'get_vod_categories':
    case 'get_series_categories':
      return res.json([{ category_id: '1', category_name: playlist.name(), parent_id: 0 }]);
    case 'get_live_streams':
      return res.json(streams);
    case 'get_vod_streams':
      return res.json(streams.map((item) => ({ ...item, stream_type: 'movie' })));
    case 'get_series':
    case 'get_short_epg':
    case 'get_simple_data_table':
      return res.json([]);
    case 'get_epg':
      return res.json({ epg_listings: [] });
    default:
      return res.json(xtreamInfo(baseUrl, req.params.token));
  }
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
get.php: <code>${escapeHtml(`${root}/get.php?username=&password=&type=m3u_plus`)}</code></p></body></html>`);
});

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default router;
