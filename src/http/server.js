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
import { buildFfmpegArgs, normaliseProfile, hardware, argsToCommand, ffmpegPath, ffmpegEnv, probeSubtitleList, outputFormatOf } from '../core/media.js';
import { spawn } from 'node:child_process';
import * as store from '../streams/store.js';
import * as relay from '../streams/relay.js';
import { ensureStreamReady } from '../streams/recovery.js';
import * as exporter from '../streams/export.js';
import { upstreamProxyMiddleware, serveDirectFile } from '../streams/upstream.js';
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

/** Verify/refresh the upstream before ffmpeg, a redirect or a download starts. */
async function prepareStreamForPlayback(stream, res, reason = 'stream-start') {
  const ready = await ensureStreamReady(stream, { reason });
  if (ready.ok) return ready.stream;
  const detail = ready.error || ready.result?.repairError || ready.result?.error || 'the upstream did not answer';
  log.warn('http', `playback blocked because "${stream.title}" is unavailable`, { streamId: stream.id, reason, error: detail });
  if (!res.destroyed) res.status(503).type('text/plain').send(`vu-movie: "${stream.title || 'stream'}" is unavailable; automatic refresh failed: ${detail}`);
  return null;
}

function extensionOf(reqPath) {
  const m = /\.([a-z0-9]+)$/i.exec(reqPath.split('?')[0]);
  return m ? m[1].toLowerCase() : '';
}

function requestClosed(req, res) {
  return Boolean(
    req?.destroyed || req?.closed || req?.aborted
    || res?.destroyed || res?.writableEnded || res?.closed
    || req?.socket?.destroyed || res?.socket?.destroyed
  );
}

export function createApp() {
  const app = express();
  // NB: no `const cfg = getConfig()` here on purpose. createApp() runs once at
  // boot, while Settings → Application can change the login, the LAN base URL
  // and the log level while the container is up. Holding on to the boot object
  // meant a username/password entered in Settings only applied after a restart
  // (and clearing it never switched the login off again). Every per-request
  // decision below asks getConfig() — the one exception is the listening
  // socket in startServer(), which cannot change without a restart anyway.
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb' }));

  // ---- request logging (debug level: keeps the log page usable at info) ----
  app.use((req, res, next) => {
    const started = Date.now();
    // Capture the viewer's address before any async preflight runs: if the
    // socket closes during an await, Node clears req.socket.remoteAddress and
    // Express's lazy req.ip getter returns undefined.
    req.clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    res.on('finish', () => {
      const ms = Date.now() - started;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
      log[level]('http', `${req.method} ${req.originalUrl} → ${res.statusCode}`, {
        ms, ip: req.ip || req.clientIp, bytes: res.getHeader('content-length') || undefined,
      });
    });
    next();
  });

  // ---- optional password on the UI/API (stream endpoints stay token-only) ----
  app.use((req, res, next) => {
    // Read the credentials *per request*, not once at boot: the login is
    // edited from Settings → Application, and a password that only becomes
    // real after a container restart is a password nobody trusts. getConfig()
    // returns the current object, so turning the login on, changing it or
    // clearing it takes effect on the very next request.
    const cfgNow = getConfig();
    // Both fields are needed; see authState(). A username without a password
    // is *not* a half-login — an empty password cannot be typed, so enforcing
    // it would lock everybody out of the only screen that can undo it. That
    // state is simply “no login”: the UI stays open on the LAN, and the boot
    // log and the Settings save both say so.
    if (!authState(cfgNow).login) return next();
    const { username, password } = cfgNow.app;
    // The stream endpoints and the playlist outputs are token-protected
    // (/s/<token>/…, /pl/<token>/…, /xtream/<token>/…): VLC, the VU+ and IPTV
    // apps cannot send a password, so they carry an unguessable path instead.
    if (req.path.startsWith('/s/') || req.path.startsWith('/hls/') || req.path.startsWith('/dl/') || req.path.startsWith('/up/')
      || req.path.startsWith('/pl/') || req.path.startsWith('/xtream/') || req.path === '/api/health') return next();
    // The playlist web player (/pl/<token>/player) is token-guarded like the
    // outputs above, but its shell assets live at the root. They are plain
    // client code with nothing secret in them (the data endpoints stay
    // token/login-guarded), and /api/poster is authorised by its per-image
    // HMAC signature — without these three, a token-only visitor with the
    // app login enabled would get the player page but a 401 for its script,
    // the transmuxer and every poster.
    if (['/player.js', '/web-codecs.js', '/vendor/mpegts.js', '/api/poster'].includes(req.path)) return next();
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
  // /xtream/<token>/… (catalogue, complete M3U+, playback, XMLTV).
  app.use(playlistOutputsRouter);

  // ---- playlist + live FFmpeg test API (before the main router) ----
  app.use('/api/playlist', playlistApiRouter);
  app.use('/api/ffmpeg', ffmpegRunRouter);

  app.use('/api', apiRouter);

  // ---- HLS segments produced by an "hls" container session ----
  app.get('/hls/:token/:file', async (req, res) => {
    // HLS is fetched as short playlist/segment requests rather than one long
    // attached response. Renew the no-client idle lease on every poll, including
    // the initial poll while FFmpeg is still creating the first segment.
    relay.touchSessionByToken(req.params.token);
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
    let closed = requestClosed(req, res);
    const markClosed = () => { closed = true; };
    req.once('close', markClosed);
    req.once('aborted', markClosed);
    res.once('close', markClosed);

    let stream = await streamByToken(req.params.token);
    if (!stream) return res.status(404).send('vu-movie: unknown or expired stream token');
    if (closed || requestClosed(req, res)) return undefined;
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
    // Playlist and Xtream links keep a media extension last (`.playlist.ts`,
    // `.xtream.mkv`) so IPTV apps accept them, and the marker tells the relay
    // this client zaps like the Enigma2 box. The template slot stays the VLC
    // one — the marker is not an output type.
    const zapKind = store.zapKindForPath(req.path);
    const receiver = isEnigma2 || Boolean(zapKind);

    // The browser preview (`{slug}.ts.web`, plus `?web=1` for the mini player's
    // fallback) is its own output slot: no subtitles, no per-item template, and
    // codecs chosen from what the browser reported it can play. The codec query
    // parameters are the report — `codecs=1` marks it as present, because an
    // empty list would otherwise look like "the browser supports nothing", and
    // a plain <video src> fallback (no parameters at all) must fall back to the
    // safe H.264/AAC transcode rather than to a blind remux.
    const isWeb = pathOutputType === 'web' || String(req.query.web || '') === '1';
    const webOpts = isWeb ? {
      reported: String(req.query.codecs || '') === '1',
      videoCodecs: req.query.vcodecs || '',
      audioCodecs: req.query.acodecs || '',
    } : null;

    // direct redirect (hybrid mode from decision D2) — zero load on the NAS.
    // Only valid for sources that need no request headers: a 302 cannot carry
    // the signed Cookie/Referer that MovieBox and friends demand, so those URLs
    // are refused with an explanation instead of sending VLC into a 403.
    // The link is published as /s/<token>/direct.<ext> (the file's own
    // extension, so IPTV players recognise it); the bare /s/<token>/direct
    // keeps working for playlists saved before the extension was added.
    if (ext === 'direct' || /\/direct(\.[a-z0-9]+)?$/i.test(req.path)) {
      stream = await prepareStreamForPlayback(stream, res, 'direct-playback-start');
      if (!stream) return;
      if (!store.directPlaybackAvailable(stream)) {
        // A file that needs headers cannot be redirected (a 302 cannot replay the
        // signed Cookie/Referer), but the relay's own proxy can replay them, and
        // it answers Range requests: the player can seek on this link.
        if (store.directProxyAvailable(stream)) {
          log.info('http', 'direct link served through the relay (request headers replayed, seekable)', { stream: stream.id });
          try {
            return await serveDirectFile(stream, req, res);
          } catch (err) {
            logError('http', 'direct link could not be served', err, { stream: stream.id });
            if (!res.headersSent) return res.status(502).send(`vu-movie: the direct link could not be served (${err.message})`);
            return res.end();
          }
        }
        log.warn('http', 'direct redirect refused — the source needs request headers', { stream: stream.id });
        return res.status(409).json({
          ok: false,
          error: 'this source needs request headers (signed cookie / referer) that a 302 redirect cannot replay',
          hint: `use ${store.urlsFor(stream, baseUrlFrom(req)).ts} — the relay replays the headers`,
        });
      }
      log.info('http', `redirecting to upstream (direct mode)`, { stream: stream.id });
      return res.redirect(302, stream.upstream?.url);
    }

    // playlist files
    if (ext === 'm3u' || ext === 'm3u8') {
      const urls = store.urlsFor(stream, baseUrlFrom(req));
      if (ext === 'm3u8' && (stream.profile?.container === 'hls')) {
        stream = await prepareStreamForPlayback(stream, res, 'hls-playback-start');
        if (!stream) return;
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
        quality: store.resolutionFor(stream) || stream.upstream?.quality,
        group: 'vu-movie',
        subtitle: stream.profile?.subtitlePath && fs.existsSync(stream.profile.subtitlePath) ? stream.profile.subtitlePath : undefined,
      }], { name: stream.title });
      res.type(ext === 'm3u8' ? 'application/vnd.apple.mpegurl' : 'audio/x-mpegurl');
      log.info('http', `serving playlist for "${stream.title}"`, { ext });
      return res.send(csv);
    }

    // `.ts.enigma2` lands here with `ext === 'enigma2'`, `.ts.web` with
    // `ext === 'web'`. Both are mpegts requests — only the outputType differs.
    const effectiveExt = (ext === 'enigma2' || ext === 'web' || pathOutputType === 'enigma2' || isWeb) ? 'ts' : ext;
    if (!['ts', 'mkv', 'mp4', 'mpegts', 'matroska'].includes(effectiveExt)) {
      log.warn('http', 'unsupported stream extension requested', { ext, name: req.params.name });
      return res.status(400).send(`vu-movie: unsupported extension ".${ext}" (use .ts, .mkv, .m3u8 or .m3u)`);
    }

    // A preview never muxes Matroska: the player is an MSE transmuxer and the
    // web-preview profile pins mpegts anyway.
    const container = isWeb ? 'mpegts' : (effectiveExt === 'mkv' || effectiveExt === 'matroska' ? 'matroska' : 'mpegts');
    stream = await prepareStreamForPlayback(stream, res, 'media-playback-start');
    if (!stream || closed || requestClosed(req, res)) return undefined;
    // Bounded wait so a slow GPU self-test cannot hold a playback request open.
    const hw = await hardware({ waitMs: 15000 });
    if (closed || requestClosed(req, res)) return undefined;
    let session;
    try {
      session = await relay.ensureSession(stream, { container, outputType: isWeb ? 'web' : outputType, web: webOpts });
    } catch (err) {
      logError('http', 'could not start the stream session', err, { stream: stream.id });
      if (!res.headersSent && !requestClosed(req, res)) {
        return res.status(500).send(`vu-movie: could not start ffmpeg (${err.message})`);
      }
      return undefined;
    }
    if (closed || requestClosed(req, res)) {
      if (session.clients.size === 0 && receiver) {
        relay.stopSession(stream.id, 'receiver left before playback started');
      }
      return undefined;
    }

    // The player is told what ffmpeg REALLY writes, not what the URL asked
    // for: the template bound to this output slot decides the container (see
    // relay.outputContainerFor). Matroska bytes announced as `video/mp2t` is
    // the one that costs the most to diagnose — VLC reads the label, fails to
    // demux, sweeps the seek bar and then sits at 00:00 without a frame.
    const served = session.format || session.container || container;
    res.setHeader('Content-Type', mediaTypeForContainer(served));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    if (req.method === 'HEAD') return res.end();

    log.info('http', `client is playing "${stream.title}"`, {
      ip: req.clientIp || req.ip, ua: truncate(req.headers['user-agent'], 60),
      mode: session.mode, encoder: session.encoder, container: served,
      hw: hw.available ? 'vaapi' : 'software', outputType, isEnigma2,
      ...(zapKind ? { zap: zapKind } : {}),
    });
    // A receiver (the Enigma2 box, a playlist or Xtream client) is not kept when
    // it leaves the movie. A pause keeps the connection, so playback continues.
    const { finish } = relay.attachClient(session, req, res, { receiver });
    res.on('close', () => finish('socket closed'));
    return undefined;
  });

  /* ---------------- download endpoint (attachment, single client) ---------------- */

  app.get('/dl/:token/:name', async (req, res) => {
    let stream = await streamByToken(req.params.token);
    if (!stream) return res.status(404).send('vu-movie: unknown or expired stream token');
    stream = await prepareStreamForPlayback(stream, res, 'download-start');
    if (!stream) return;
    const ext = extensionOf(req.params.name);
    const container = ext === 'mkv' ? 'matroska' : 'mpegts';
    const hw = await hardware({ waitMs: 15000 });
    const profile = normaliseProfile({ ...(stream.profile || {}), container }, stream.upstream?.probe || null);
    const args = buildFfmpegArgs({
      source: {
        url: stream.upstream?.url, headers: stream.upstream?.headers || {},
        kind: stream.upstream?.kind || undefined, container: stream.upstream?.probe?.container || null,
        subtitles: probeSubtitleList(stream.upstream?.probe),
      },
      profile, hw, mode: 'file', output: { container, target: 'pipe:1' },
    });
    log.info('http', `download started for "${stream.title}"`, { container, command: truncate(argsToCommand(args), 300) });
    // Same rule as the stream endpoint: a per-stream template can make ffmpeg
    // write a container the URL did not ask for, and a downloaded file that is
    // named .ts but is really Matroska is a puzzle for whoever opens it.
    const served = outputFormatOf(args) || container;
    const servedExt = served === 'matroska' ? 'mkv' : served === 'mp4' ? 'mp4' : ext;
    res.setHeader('Content-Disposition', `attachment; filename="${store.slugify(`${stream.title}-${stream.year || ''}`)}.${servedExt}"`);
    res.setHeader('Content-Type', mediaTypeForContainer(served));
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
    const urls = store.urlsFor(stream, baseUrlFrom(req));
    const resolution = store.resolutionFor(stream);
    const videoCodec = stream.upstream?.probe?.video?.codec || '';
    const durationSec = Number(stream.upstream?.probe?.durationSec) || Number(stream.upstream?.durationSec) || 0;
    const metaLine = [resolution, videoCodec, durationSec ? `${Math.round(durationSec / 60)} min` : '']
      .filter(Boolean).join(' · ');
    const tsUrlJson = JSON.stringify(urls.ts).replace(/</g, '\\u003c');
    const webUrlJson = JSON.stringify(urls.web).replace(/</g, '\\u003c');
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(stream.title)} — vu-movie</title>
<style>body{background:#0b0f16;color:#e6edf7;font:14px system-ui;margin:0;padding:24px}
video{width:100%;max-width:1100px;background:#000;border-radius:12px}#status{color:#94a3b8;margin:10px 0}
a{color:#38bdf8}code{background:#151d2c;padding:2px 6px;border-radius:6px}</style>
<script src="/vendor/mpegts.js"></script><script src="/web-codecs.js"></script></head>
<body><h1>${escapeHtml(stream.title)}${stream.year ? ` (${stream.year})` : ''}</h1>
${metaLine ? `<div id="meta" style="color:#94a3b8;margin:-6px 0 10px">${escapeHtml(metaLine)}</div>` : ''}
<video id="video" controls autoplay playsinline></video><div id="status">starting the MPEG-TS relay…</div>
<p>Preview link (no subtitles, browser codecs): <code id="weburl"></code><br>
VLC link (keeps subtitles): <code>${escapeHtml(urls.ts)}</code> · <a href="${urls.playlist}">.m3u playlist</a> · <a href="${urls.download}">download</a></p>
<script>(()=>{const video=document.getElementById('video');const status=document.getElementById('status');
const web=window.VMWebCodecs?VMWebCodecs.previewUrl(${webUrlJson}):${webUrlJson};
document.getElementById('weburl').textContent=web;let failed=false;
if(window.mpegts&&window.mpegts.isSupported()){const player=window.mpegts.createPlayer({type:'mpegts',isLive:true,url:web},{enableWorker:true,lazyLoad:false,liveBufferLatencyChasing:true});player.attachMediaElement(video);player.on(window.mpegts.Events.ERROR,(type,detail,info)=>{failed=true;const reason=String((info&&info.msg)||detail||type||'');status.textContent='Playback failed: '+(/endOfStream before demuxer|COULD_NOT_OPEN|not supported/i.test(reason)?'the relay sent no playable video — the source did not start (dead mirror, expired link, or ffmpeg unavailable)':reason)+'. Try VLC — it keeps the subtitles too.'});player.load();player.play().catch(()=>{if(!failed)status.textContent='ready — press Play to start'});video.addEventListener('playing',()=>{status.textContent='playing'},{once:true});window.addEventListener('beforeunload',()=>{try{player.destroy()}catch{}})}else{video.src=web;status.textContent='native browser playback fallback (no subtitles)';video.play().catch(()=>{})}})();</script>
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

/**
 * Is the UI behind a login, and what does the boot log call it?
 *
 * Kept in one place because the answer is not “is a username set”: a username
 * with an empty password is no login at all (nobody can type an empty
 * password), so treating it as one would lock the operator out of the only
 * screen that can undo it. The middleware asks per request, the boot log once.
 */
export function authState(cfg) {
  if (!cfg.app.username) return { login: false, text: 'open on the LAN (no username set)' };
  if (!cfg.app.password) return { login: false, text: 'open on the LAN (a username is set but no password, so no login is asked for)' };
  return { login: true, text: 'basic auth enabled' };
}

/**
 * The MIME type a player is told. It describes the bytes ffmpeg really writes
 * — never the container the URL happened to end in, because a template bound
 * to an output slot is allowed to write another one.
 */
function mediaTypeForContainer(container) {
  if (container === 'matroska' || container === 'mkv') return 'video/x-matroska';
  if (container === 'mp4') return 'video/mp4';
  if (container === 'hls' || container === 'm3u8') return 'application/vnd.apple.mpegurl';
  return 'video/mp2t';
}

function baseUrlFrom(req) {
  // Same rule as the auth middleware: the LAN base URL is editable from
  // Settings → Application, so links handed out to VLC and the receiver are
  // built from the configuration as it is *now*, not as it was at boot.
  const { baseUrl } = getConfig().app;
  if (baseUrl) return String(baseUrl).replace(/\/$/, '');
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
        auth: authState(cfg).text,
      });
      // A half-finished login (APP_USERNAME without APP_PASSWORD in .env, or a
      // hand-edited config file) is usually a typo, and the symptom gives no
      // hint where to look: the UI simply never asks for a password. Say it at
      // boot, next to the port.
      if (cfg.app.username && !cfg.app.password) {
        log.warn('http', 'the web interface is open — a username is set but no password, and an empty password cannot be typed',
          { username: cfg.app.username, hint: 'set APP_PASSWORD (or Settings → Application) to switch the login on, or clear the username' });
      }
      resolve(server);
    });
  });
}

export default { createApp, startServer };
