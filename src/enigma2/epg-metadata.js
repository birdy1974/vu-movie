/**
 * Last-resort plot lookup during a bouquet push, bounded so a slow provider
 * cannot hold the push indefinitely.
 *
 * Plots normally arrive stored on the stream record (see metadata/plots.js:
 * add time and the background backfill), so this only runs for entries that
 * still have none. Whatever it finds is stored on the stream too, and the
 * caller kicks the backfill for anything the deadline cut off — a later push
 * never repeats a lookup that already succeeded.
 */
import { repo } from '../core/db.js';
import { resolvePlot, lookupPlot, storePlotOnStream } from '../metadata/plots.js';

export async function enrichEpgPlots(entries, { timeoutMs = 10000, lookup = lookupPlot, cache = repo, persist = storePlotOnStream } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let next = 0;
  const result = entries.map((entry) => ({ ...entry }));
  await Promise.all(Array.from({ length: Math.min(4, result.length) }, async () => {
    while (next < result.length && !signal.aborted) {
      const entry = result[next++];
      if (String(entry.plot || '').trim()) continue;
      try {
        const found = await resolvePlot(entry, { signal, lookup, cache });
        if (!found) continue;
        entry.plot = found.plot;
        if (entry.streamId) await persist({ id: entry.streamId, title: entry.title }, found);
      } catch { /* Missing metadata must not prevent the bouquet push. */ }
    }
  }));
  return result;
}

export { lookupPlot };
