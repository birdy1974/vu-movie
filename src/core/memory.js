/**
 * vu-movie — process memory snapshot for /api/health and the shutdown log.
 *
 * Why this exists: "the NAS says vu-movie uses 1 GB after a movie and it never
 * goes down" mixes four different numbers, and only one of them says whether
 * the app itself leaks:
 *
 *   heapUsed      — JS objects actually alive. THIS growing across repeated
 *                   play/stop cycles is a leak; flat is not.
 *   external +
 *   arrayBuffers  — Buffer memory (upstream chunk/segment caches, socket
 *                   buffers). Jumps while a movie plays, must fall back after
 *                   the session and its upstream proxy are closed.
 *   rss           — what DSM / `docker stats` show. RSS is a high-water mark:
 *                   V8 and glibc keep freed pages for reuse, so RSS normally
 *                   stays up after the memory is logically released. Only a
 *                   process restart resets it. See docs/MEMORY.md.
 *
 * The ffmpeg and Chromium child processes are NOT in these numbers — they are
 * separate processes (counted separately in the container total).
 */
export function memorySnapshot() {
  const m = process.memoryUsage();
  return {
    rssBytes: m.rss,
    heapUsedBytes: m.heapUsed,
    heapTotalBytes: m.heapTotal,
    externalBytes: m.external,
    arrayBuffersBytes: m.arrayBuffers,
  };
}

/** Compact log fields (MB, 1 decimal) for start/stop/shutdown lines. */
export function memoryLogFields() {
  const m = memorySnapshot();
  const mb = (v) => Math.round((v / 1048576) * 10) / 10;
  return {
    rssMb: mb(m.rssBytes),
    heapMb: mb(m.heapUsedBytes),
    externalMb: mb(m.externalBytes + m.arrayBuffersBytes),
  };
}

export default { memorySnapshot, memoryLogFields };
