/**
 * Copying a subtitle file onto the Enigma2 receiver.
 *
 * Two transports, both already used by the bouquet push:
 *
 *   ftp    — `curl -T` against the box's FTP server (the only portable write
 *            API; OpenWebif has none). Directories are created as needed.
 *   mount  — when FTP is switched off and the receiver's media directory is
 *            reachable at the same path (NFS/SMB mount into the container).
 *
 * Why this exists as its own module: the Playlist tab's "copy to the box"
 * subtitle mode needs it too, and that path must not import the HTTP router.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { log, logError, errorText } from '../core/log.js';
import { getConfig } from '../core/config.js';
import * as store from '../streams/store.js';

/**
 * Upload one local file into a directory on the receiver.
 *
 * @param {string} localFile   absolute path of the stored .srt
 * @param {string} remoteName  file name on the box (`<title>.<lang>.srt`)
 * @param {string} remoteDir   receiver directory, e.g. /media/hdd/movie
 * @returns {{ok:boolean, via?:string, path?:string, error?:string}}
 */
export function uploadSubtitleToReceiver(localFile, remoteName, remoteDir) {
  const enigma = getConfig().enigma2;
  if (!enigma.ftpEnabled) {
    // Without FTP the receiver directory must be reachable as a local mount at
    // the same path (e.g. /media/hdd/movie over NFS/SMB). `mountDir` was never
    // a config key, so this branch could never succeed before.
    const dir = remoteDir || null;
    if (dir && fs.existsSync(dir)) {
      const destination = path.join(dir, remoteName);
      fs.copyFileSync(localFile, destination);
      log.info('subtitles', 'subtitle copied into the mounted share', { dir, remoteName });
      return { ok: true, via: 'mount', path: destination };
    }
    return { ok: false, error: 'enable Enigma2 FTP or mount the receiver directory (Settings → Subtitles → receiver dir) to copy subtitles to the box' };
  }
  if (!enigma.host) return { ok: false, error: 'no Enigma2 host configured — set it in Settings → Enigma2' };
  const target = `ftp://${enigma.host}:${enigma.ftpPort}/${String(remoteDir).replace(/^\//, '')}/${remoteName}`;
  const res = spawnSync('curl', ['-sS', '--fail', '--ftp-create-dirs', '-u', `${enigma.username}:${enigma.password || ''}`, '-T', localFile, target], { encoding: 'utf8', timeout: 30000 });
  if (res.error || res.status !== 0) {
    const detail = res.error ? res.error.message : String(res.stderr || `exit ${res.status}`).trim();
    logError('subtitles', 'subtitle upload failed', new Error(detail), { target });
    return { ok: false, error: detail };
  }
  log.info('subtitles', 'subtitle pushed over FTP', { target });
  return { ok: true, via: 'ftp', path: target };
}

/**
 * Push the subtitle stored for a stream, named after the movie so Enigma2
 * (Enhanced Movie Center / MediaPlayer) loads it automatically next to a
 * recording of the same name.
 */
export async function pushSubtitleToReceiver({ stream, language }) {
  if (!stream) return { ok: false, error: 'no stream' };
  const file = stream.profile?.subtitlePath;
  if (!file || !fs.existsSync(file)) return { ok: false, error: 'no subtitle file stored for this stream yet' };
  const lang = String(language || stream.profile?.subtitleLanguage || 'sub').slice(0, 3);
  const name = `${store.slugify(`${stream.title}${stream.year ? `-${stream.year}` : ''}`)}.${lang}.srt`;
  // receiverDir lives in the *subtitles* section (Settings → Subtitles). Reading
  // it off enigma2 always returned undefined, so every push silently went to the
  // hard-coded /media/hdd/movie and the setting did nothing.
  const target = getConfig().subtitles.receiverDir || '/media/hdd/movie';
  log.info('subtitles', 'pushing subtitle to the receiver', { file, name, dir: target });
  try {
    return uploadSubtitleToReceiver(file, name, target);
  } catch (err) {
    logError('subtitles', 'subtitle push failed', err);
    return { ok: false, error: errorText(err) };
  }
}

export default { uploadSubtitleToReceiver, pushSubtitleToReceiver };
