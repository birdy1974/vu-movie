/**
 * vu-movie — exports: M3U playlists and file downloads.
 *
 * The M3U is what most people actually want next to the bouquet: a playlist file
 * that VLC (desktop, Android, Fire TV) can open directly, with the title, the
 * poster and the resolution in the EXTINF metadata.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log, logError, truncate } from '../core/log.js';
import { getConfig } from '../core/config.js';
import { FFMPEG, buildFfmpegArgs, argsToCommand, hardware, normaliseProfile, parseProgressLine } from '../core/media.js';
import { JobQueue } from '../core/jobs.js';
import { urlsFor, slugify } from './store.js';

/** Extra queue so a download never starves a live transcode. */
export const downloadQueue = new JobQueue({ name: 'download', concurrency: Number(process.env.MAX_CONCURRENT_DOWNLOADS || 1), historyLimit: 50 });

/**
 * Build an M3U playlist text for one or many streams.
 * @param {object[]} items  [{ title, url, duration, logo, group, quality, subtitle }]
 */
export function buildM3U(items, { name = 'vu-movie' } = {}) {
  const lines = ['#EXTM3U', `#PLAYLIST:${name}`];
  for (const item of items) {
    const attrs = [
      `tvg-name="${esc(item.title)}"`,
      item.logo ? `tvg-logo="${esc(item.logo)}"` : '',
      `group-title="${esc(item.group || 'vu-movie')}"`,
    ].filter(Boolean).join(' ');
    lines.push(`#EXTINF:-1 ${attrs},${esc(item.title)}${item.quality ? ` [${item.quality}]` : ''}`);
    if (item.subtitle) lines.push(`#EXTVLCOPT:sub-file=${item.subtitle}`);
    lines.push(item.url);
  }
  return `${lines.join('\n')}\n`;
}

function esc(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/"/g, "'");
}

/** Write a playlist into /downloads so it stays available as a file. */
export function writePlaylistFile(text, filename) {
  const cfg = getConfig();
  const dir = path.join(cfg.storage.downloads, 'playlists');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slugify(filename)}.m3u`);
  fs.writeFileSync(file, text);
  log.info('export', `playlist written`, { file, bytes: text.length });
  return file;
}

/**
 * Download a stream to /downloads. Runs on its own job queue with progress
 * reporting parsed straight out of ffmpeg (`-progress pipe:2`).
 *
 * @returns the job (already queued)
 */
export function startDownload(stream, { profile = {}, filename = null, baseUrl = null } = {}) {
  const cfg = getConfig();
  const container = profile.container || stream.profile?.container || cfg.transcode.container;
  const ext = container === 'matroska' ? 'mkv' : container === 'mp4' ? 'mp4' : 'ts';
  const name = filename || `${slugify(`${stream.title}-${stream.year || ''}`)}-${stream.profile?.resolution ? `${stream.profile.resolution}p` : 'source'}.${ext}`;
  const target = path.join(cfg.storage.downloads, name);

  return downloadQueue.submit(
    { type: 'download', title: stream.title || name, meta: { streamId: stream.id, target, container } },
    async (ctx) => {
      const hw = await hardware();
      const normalised = normaliseProfile({ ...(stream.profile || {}), ...profile, container }, stream.upstream?.probe || null);
      const args = buildFfmpegArgs({
        source: {
          url: stream.upstream?.url,
          headers: stream.upstream?.headers || {},
          kind: stream.upstream?.kind || undefined,
          container: stream.upstream?.probe?.container || null,
        },
        profile: normalised,
        hw,
        mode: 'file',
        output: { container, target },
      });
      log.info('export', `download started`, { title: stream.title, target, command: truncate(argsToCommand(args), 400) });
      ctx.log(`ffmpeg → ${target}`);
      ctx.progress(1, 'starting');

      const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      ctx.setHandle(child);
      const durationSec = stream.upstream?.probe?.durationSec || null;
      let buffer = '';
      let lastLog = 0;

      child.stderr.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (/^[a-z_]+=/.test(line)) {
            const stats = parseProgressLine(line, {});
            if (durationSec && stats.outTimeMs) {
              const pct = Math.min(99, Math.round((stats.outTimeMs / 1000 / durationSec) * 100));
              ctx.progress(pct, `${Math.round(stats.outTimeMs / 1000)}s / ${Math.round(durationSec)}s @ ${stats.speed || '?'}`);
            }
          } else if (line.trim() && Date.now() - lastLog > 3000) {
            lastLog = Date.now();
            ctx.log(truncate(line, 180));
          }
        }
      });

      const result = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve({ code }) : reject(new Error(`ffmpeg exited with code ${code}`))));
      });

      const size = fs.existsSync(target) ? fs.statSync(target).size : 0;
      ctx.progress(100, `done (${(size / 1048576).toFixed(1)} MB)`);
      log.info('export', 'download finished', { target, sizeMb: (size / 1048576).toFixed(1), code: result.code });
      if (ctx.isCancelled()) throw new Error('cancelled by user');
      return { file: target, sizeBytes: size, filename: path.basename(target) };
    },
  );
}

export function listDownloads() {
  const cfg = getConfig();
  try {
    return fs.readdirSync(cfg.storage.downloads)
      .map((f) => {
        const full = path.join(cfg.storage.downloads, f);
        const st = fs.statSync(full);
        return st.isFile() ? { name: f, sizeBytes: st.size, modified: st.mtime.toISOString(), path: full } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.modified.localeCompare(a.modified))
      .slice(0, 200);
  } catch (err) {
    logError('export', 'could not list the downloads directory', err, { dir: cfg.storage.downloads });
    return [];
  }
}

export { urlsFor };
export default { buildM3U, writePlaylistFile, startDownload, listDownloads, downloadQueue };
