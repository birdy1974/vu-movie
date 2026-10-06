/**
 * vu-movie — HTTP server.
 *
 * Serves three things:
 *   1. the web UI (static files from /app/public)
 *   2. the JSON API (see api.js)
 *   3. the *playable* endpoints:  /s/<token>/<name>.ts|.mkv|.m3u8|.m3u|direct
 *                                 /hls/<token>/index.m3u8 + segments
 *                                 /dl/<token>/<name>   (with Content-Disposition)
 *
 * The playable endpoints are deliberately NOT behind the UI password: VLC and the
 * VU+ Duo2 cannot authenticate comfortably, so access is protected by a random
 * 96-bit token per stream instead (see streams/store.js). Everything that can
 * change state stays on /api/* and *is* password protected when a password is set.
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { log, logError, truncate } from '../core/log.js';
import { getConfig } from '../core/config.js';
import { buildFfmpegArgs, normaliseProfile, hardware, argsToCommand, ffmpegPath, ffmpegEnv } from '../core/media.js';
import { spawn } from 'node:child_process';
import * as store from '../streams/store.js';
import * as relay from '../streams/relay.js';
import * as exporter from '../streams/export.js';
import { upstreamProxyMiddleware } from '../streams/upstream.js';
import apiRouter from './api.js';
import playlistApiRouter from '../playlist/api.js';
import playlistOutputsRouter from '../playlist/outputs.js';
import ffmpegRunRouter from '../playlist/ffmpeg-run.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.resolve(__dirname, '../../public');
const MPEGTS_BROWSER_FILE = path.resolve(__dirname, '../../node_modules/mpegts.js/dist/mpegts.js');

/** Resolve a stream by token and attach it to the relay session. */
async function streamByToken(token) {
  const stream = await store.getStream(token);
  if (!stream) log.warn('http', 'unknown stream token requested', { token: truncate(token, 20) });
  return stream;
}

function extensionOf(reqPath) {
  const m = /\.([a-z0-9]+)$/i.exec(reqPath.split('?')[0]);
  return m ? m[1].toLowerCase() : '';
}

export function createApp() {
  const app = express();
  const cfg = getConfig();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb' }));

  // ---- request logging (debug level: keeps the log page usable at info) ----
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
      log[level]('http', `${req.method} ${req.originalUrl} → ${res.statusCode}`, {
        ms, ip: req.ip, bytes: res.getHeader('content-length') || undefined,
      });
    });
    next();
  });

  // ---- optional password on the UI/API (stream endpoints stay token-only) ----
  app.use((req, res, next) => {
    const { username, password } = cfg.app;
    if (!username) return next();
    // The stream endpoints and the playlist outputs are token-protected
    // (/s/<token>/…, /pl/<token>/…, /xtream/<token>/…): VLC, the VU+ and IPTV
    // apps cannot send a password, so they carry an unguessable path instead.
    if (req.path.startsWith('/s/') || req.path.startsWith('/hls/') || req.path.startsWith('/dl/') || req.path.startsWith('/up/')
      || req.path.startsWith('/pl/') || req.path.startsWith('/xtream/') || req.path === '/api/health') return next();
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
      if (user === username && pass === password) return next();
    }
    log.warn('http', 'unauthorised request rejected', { path: req.path, ip: req.ip });
    res.set('WWW-Authenticate', 'Basic realm="vu-movie"');
    return res.status(401).send('vu-movie: authentication required');
  });

  // Browser MPEG-TS → MediaSource transmuxer. It is installed from npm and
  // served locally so the preview player works on an offline LAN and never
  // depends on a third-party CDN.
  app.get('/vendor/mpegts.js', (req, res) => {
    if (!fs.existsSync(MPEGTS_BROWSER_FILE)) return res.status(404).type('text').send('mpegts.js is not installed');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(MPEGTS_BROWSER_FILE);
  });

  // ---- chunked upstream proxy (/up/<secret>/…) — the loopback input for ----
  // ---- ffmpeg when a session fetches its source in ranged chunks      ----
  app.use(upstreamProxyMiddleware);

  // ---- playlist outputs (token-protected, no password) ----
  // /pl/<token>/… (m3u, m3u8, json, userbouquet.tv) and
  // /xtream/<token>/… (player_api.php, get.php, xmltv.php).
  app.use(playlistOutputsRouter);

  // ---- playlist + live FFmpeg test API (before the main router) ----
  app.use('/api/playlist', playlistApiRouter);
  app.use('/api/ffmpeg', ffmpegRunRouter);

  app.use('/api', apiRouter);

  // ---- HLS segments produced by an "hls" container session ----
  app.get('/hls/:token/:file', async (req, res) => {
    const cfgNow = getConfig();
    const dir = path.join(cfgNow.storage.tmp, 'hls', req.params.token);
    const file = path.basename(req.params.file);
    const full = path.join(dir, file);
    if (!full.startsWith(dir) || !fs.existsSync(full)) {
      return res.status(404).send('not found');
    }
    if (file.endsWith('.m3u8')) res.type('application/vnd.apple.mpegurl');
    else res.type('video/mp2t');
    res.setHeader('Cache-Control', 'no-cache');
    log.debug('http', 'serving HLS file', { file });
    return res.sendFile(full);
  });

  /* ---------------- playable endpoints ---------------- */

  app.get('/s/:token/:name', async (req, res) => {
    const stream = await streamByToken(req.params.token);
    if (!stream) return res.status(404).send('vu-movie: unknown or expired stream token');
    const ext = extensionOf(req.params.name);

    // The Enigma2 / Duo2 receiver hits a `.ts` URL by way of its service-ref,
    // but the bouquet builder encodes the URL with `encodeE2Url` which strips
    // the query string. We therefore use a path suffix that survives the
    // service-ref encoding: the receiver fetches `{slug}.ts.enigma2`, which
    // Express matches as `name = {slug}.ts.enigma2`. The relay still serves
    // mpegts bytes; the suffix only tells the relay which template slot to
    // bind. The `?enigma2=1` query parameter is also honoured for callers
    // that do pass queries through (and for the diagnostic / test paths).
    const pathOutputType = store.outputTypeForPath(req.path);
    const queryIsEnigma2 = store.outputTypeForEnigma2Request(req) === 'enigma2';
    const baseOutputType = pathOutputType === 'enigma2' ? 'vlcTs' : pathOutputType;
    const isEnigma2 = pathOutputType === 'enigma2' || queryIsEnigma2;
    const outputType = isEnigma2 ? 'enigma2' : baseOutputType;

    // direct redirect (hybrid mode from decision D2) — zero load on the NAS.
    // Only valid for sources that need no request headers: a 302 cannot carry
    // the signed Cookie/Referer that MovieBox and friends demand, so those URLs
    // are refused with an explanation instead of sending VLC into a 403.
    if (ext === 'direct' || req.path.endsWith('/direct')) {
      if (!store.directPlaybackAvailable(stream)) {
        log.warn('http', 'direct redirect refused — the source needs request headers', { stream: stream.id });
        return res.status(409).json({
          ok: false,
          error: 'this source needs request headers (signed cookie / referer) that a 302 redirect cannot replay',
          hint: `use ${store.urlsFor(stream, baseUrlFrom(req, cfg)).ts} — the relay replays the headers`,
        });
      }
      log.info('http', `redirecting to upstream (direct mode)`, { stream: stream.id });
      return res.redirect(302, stream.upstream?.url);
    }

    // playlist files
    if (ext === 'm3u' || ext === 'm3u8') {
      const urls = store.urlsFor(stream, baseUrlFrom(req, cfg));
      if (ext === 'm3u8' && (stream.profile?.container === 'hls')) {
        const session = await relay.ensureSession(stream, { container: 'hls', outputType: outputType || 'm3u8' });
        if (session.kind === 'hls') {
          log.info('http', 'client asked for the HLS playlist', { stream: stream.id });
          return res.redirect(302, `/hls/${stream.token}/index.m3u8`);
        }
      }
      // Pick the right per-output URL for the embedded stream entry. .m3u and
      // .m3u8 themselves never carry audio/video; the link inside them does.
      // The Enigma2 build sends the receiver there, so it gets the .ts that
      // has the Enigma2-specific template bound (if any).
      const innerUrl = isEnigma2 ? urls.forBox : urls.ts;
      const csv = exporter.buildM3U([{
        title: `${stream.title}${stream.year ? ` (${stream.year})` : ''}`,
        url: innerUrl,
        logo: stream.poster,
        quality: stream.upstream?.quality,
        group: 'vu-movie',
        subtitle: stream.profile?.subtitlePath && fs.existsSync(stream.profile.subtitlePath) ? stream.profile.subtitlePath : undefined,
      }], { name: stream.title });
      res.type(ext === 'm3u8' ? 'application/vnd.apple.mpegurl' : 'audio/x-mpegurl');
      log.info('http', `serving playlist for "${stream.title}"`, { ext });
      return res.send(csv);
    }

    // `.ts.enigma2` lands here with `ext === 'enigma2'`. Treat it as a `.ts`
    // mpegts request — only the outputType differs.
    const effectiveExt = (ext === 'enigma2' || pathOutputType === 'enigma2') ? 'ts' : ext;
    if (!['ts', 'mkv', 'mp4', 'mpegts', 'matroska'].includes(effectiveExt)) {
      log.warn('http', 'unsupported stream extension requested', { ext, name: req.params.name });
      return res.status(400).send(`vu-movie: unsupported extension ".${ext}" (use .ts, .mkv, .m3u8 or .m3u)`);
    }

    const container = effectiveExt === 'mkv' || effectiveExt === 'matroska' ? 'matroska' : 'mpegts';
    // Bounded wait so a slow GPU self-test cannot hold a playback request open.
    const hw = await hardware({ waitMs: 15000 });
    let session;
    try {
      session = await relay.ensureSession(stream, { container, outputType });
    } catch (err) {
      logError('http', 'could not start the stream session', err, { stream: stream.id });
      return res.status(500).send(`vu-movie: could not start ffmpeg (${err.message})`);
    }

    res.setHeader('Content-Type', container === 'matroska' ? 'video/x-matroska' : 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    if (req.method === 'HEAD') return res.end();

    log.info('http', `client is playing "${stream.title}"`, {
      ip: req.ip, ua: truncate(req.headers['user-agent'], 60),
      mode: session.mode, encoder: session.encoder, container, hw: hw.available ? 'vaapi' : 'software',
      outputType, isEnigma2,
    });
    const { finish } = relay.attachClient(session, req, res);
    res.on('close', () => finish('socket closed'));
    return undefined;
  });

  /* ---------------- download endpoint (attachment, single client) ---------------- */

  app.get('/dl/:token/:name', async (req, res) => {
    const stream = await streamByToken(req.params.token);
    if (!stream) return res.status(404).send('vu-movie: unknown or expired stream token');
    const ext = extensionOf(req.params.name);
    const container = ext === 'mkv' ? 'matroska' : 'mpegts';
    const hw = await hardware({ waitMs: 15000 });
    const profile = normaliseProfile({ ...(stream.profile || {}), container }, stream.upstream?.probe || null);
    const args = buildFfmpegArgs({
      source: {
        url: stream.upstream?.url, headers: stream.upstream?.headers || {},
        kind: stream.upstream?.kind || undefined, container: stream.upstream?.probe?.container || null,
      },
      profile, hw, mode: 'file', output: { container, target: 'pipe:1' },
    });
    log.info('http', `download started for "${stream.title}"`, { container, command: truncate(argsToCommand(args), 300) });
    res.setHeader('Content-Disposition', `attachment; filename="${store.slugify(`${stream.title}-${stream.year || ''}`)}.${ext}"`);
    res.setHeader('Content-Type', container === 'matroska' ? 'video/x-matroska' : 'video/mp2t');
    const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: ffmpegEnv(hw) });
    child.stdout.pipe(res);
    child.stderr.on('data', (d) => log.debug('http', `download ffmpeg: ${truncate(String(d).trim(), 160)}`));
    child.on('error', (err) => {
      logError('http', 'download ffmpeg failed to start', err);
      if (!res.headersSent) res.status(500).end();
    });
    child.on('close', (code) => {
      log.info('http', 'download finished', { stream: stream.id, code });
      res.end();
    });
    req.on('close', () => {
      log.warn('http', 'download cancelled by the client', { stream: stream.id });
      child.kill('SIGTERM');
    });
  });

  /* ---------------- watch page (tiny player for the browser) ---------------- */

  app.get('/watch/:token', async (req, res) => {
    const stream = await streamByToken(req.params.token);
    if (!stream) return res.status(404).send('vu-movie: unknown or expired stream token');
    const urls = store.urlsFor(stream, baseUrlFrom(req, cfg));
    const tsUrlJson = JSON.stringify(urls.ts).replace(/</g, '\\u003c');
    const rawUrlJson = JSON.stringify(urls.raw).replace(/</g, '\\u003c');
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(stream.title)} — vu-movie</title>
<style>body{background:#0b0f16;color:#e6edf7;font:14px system-ui;margin:0;padding:24px}
video{width:100%;max-width:1100px;background:#000;border-radius:12px}#status{color:#94a3b8;margin:10px 0}
a{color:#38bdf8}code{background:#151d2c;padding:2px 6px;border-radius:6px}</style>
<script src="/vendor/mpegts.js"></script></head>
<body><h1>${escapeHtml(stream.title)}${stream.year ? ` (${stream.year})` : ''}</h1>
<video id="video" controls autoplay playsinline></video><div id="status">starting the MPEG-TS relay…</div>
<p>Stream link: <code>${escapeHtml(urls.ts)}</code> · <a href="${urls.playlist}">.m3u playlist</a> · <a href="${urls.download}">download</a></p>
<script>(()=>{const video=document.getElementById('video');const status=document.getElementById('status');const ts=${tsUrlJson};
if(window.mpegts&&window.mpegts.isSupported()){const player=window.mpegts.createPlayer({type:'mpegts',isLive:true,url:ts},{enableWorker:true,lazyLoad:false,liveBufferLatencyChasing:true});player.attachMediaElement(video);player.on(window.mpegts.Events.ERROR,(type,detail,info)=>{status.textContent='Playback failed: '+(info&&info.msg||detail||type)+'. Try VLC or an H.264/AAC template.'});player.load();player.play().catch(()=>{status.textContent='ready — press Play to start'});video.addEventListener('playing',()=>{status.textContent='playing'},{once:true});window.addEventListener('beforeunload',()=>{try{player.destroy()}catch{}})}else{video.src=${rawUrlJson};status.textContent='native browser playback fallback';video.play().catch(()=>{})}})();</script>
</body></html>`);
  });

  /* ---------------- static UI ---------------- */

  if (!fs.existsSync(PUBLIC_DIR)) {
    log.error('http', `public directory ${PUBLIC_DIR} is missing — the UI will not be available`, {});
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  }
  if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    log.warn('http', `no index.html in ${PUBLIC_DIR} — serving a placeholder page instead of failing`, {
      hint: 'the repository ships public/index.html; a missing file means a broken checkout or a bad COPY in the Dockerfile',
    });
  } else {
    log.info('http', `serving static UI from ${PUBLIC_DIR}`);
  }

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '5m' }));
  app.get('/', (req, res) => {
    const index = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(index)) return res.sendFile(index);
    return res.type('html').send('<h1>vu-movie</h1><p>The web UI is not installed in this container (public/index.html missing).</p>');
  });

  // ---- 404 + error handling ----
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: `no such endpoint: ${req.method} ${req.path}` });
    log.debug('http', 'not found', { path: req.path });
    return res.status(404).send('vu-movie: not found');
  });

  app.use((err, req, res, next) => {
    logError('http', `unhandled error on ${req.method} ${req.originalUrl}`, err);
    if (res.headersSent) return next(err);
    return res.status(err.status || 500).json({ ok: false, error: err.message });
  });

  return app;
}

function baseUrlFrom(req, cfg) {
  if (cfg.app.baseUrl) return String(cfg.app.baseUrl).replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function startServer() {
  const cfg = getConfig();
  const app = createApp();
  const server = http.createServer(app);

  // Long-lived streams: never let a proxy or the socket timeout kill playback.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      logError('http', `server could not listen on ${cfg.app.host}:${cfg.app.port}`, err);
      reject(err);
    });
    server.listen(cfg.app.port, cfg.app.host, () => {
      const addr = server.address();
      log.info('http', `vu-movie listening on http://${cfg.app.host}:${addr.port}`, {
        publicDir: PUBLIC_DIR,
        baseUrl: cfg.app.baseUrl || '(derived from the request Host header)',
        auth: cfg.app.username ? 'basic auth enabled' : 'open on the LAN (no password set)',
      });
      resolve(server);
    });
  });
}

export default { createApp, startServer };
