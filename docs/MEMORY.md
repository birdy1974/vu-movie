# Memory: what a movie costs, what is released, and how to tell a leak from a cache

This page exists because of a recurring observation on the NAS:

> "Memory goes up a lot when a movie starts, and it is not released when the
> movie stops — or even when the application is stopped."

Part of that was real bugs (fixed; list below), part is *by design* (a paused
movie is deliberately kept ready to resume), and part is how Linux and DSM
account memory. This document separates the three so the next report can
start from measurements instead of guesses.

## How to measure (do this first)

`GET /api/health` now reports the numbers that matter:

```bash
curl -s http://<nas>:8080/api/health | python3 -m json.tool | grep -A6 '"memory"'
```

| field | meaning | healthy behaviour |
|---|---|---|
| `memory.heapUsedBytes` | JS objects actually alive in the app | **flat across repeated play/stop cycles.** Steady growth here (and only here) is a leak — please report it with the values before/after a few cycles. |
| `memory.externalBytes` + `memory.arrayBuffersBytes` | `Buffer` memory: upstream chunk/segment caches, socket queues | jumps while a movie plays; must fall back once the session *and* its upstream proxy are closed (allow the keep-windows below). |
| `memory.rssBytes` | what DSM / `docker stats` show for the Node process | a **high-water mark**. V8/glibc keep freed pages for reuse, so RSS normally stays up after a movie stops even though the bytes are logically free (the next movie reuses them — measured: RSS plateaus, it does not ratchet up per movie). Only a process restart resets RSS. |
| `streamSessions[].upstreamProxy.cacheBytes`, `upstreamProxies[]` | the per-movie chunk/segment cache actually held right now | 0 when nothing plays (after the keep-windows). |
| `db.memCacheEntries` | entries in the in-memory metadata cache | ≤ 500 (bounded). |

The same fields are in the log: `stopping session … {rssMb, heapMb,
externalMb}` and `upstream proxy closed … {cacheFreedMb}`.

Two measurement traps on DSM:

* **Page cache is shown as "used".** A movie writes/reads gigabytes through
  the kernel (HLS segments, the range-less capture file, downloads). Linux
  keeps those file pages cached in otherwise-empty RAM and reclaims them
  instantly under pressure. DSM's Resource Monitor counts cache as used, so
  host memory *looks* unreleased after the container stops. `free -m`'s
  **available** column is the truth; cache is not a leak.
* **`docker stats` counts the whole cgroup**: Node + ffmpeg + Chromium +
  `/dev/shm` (512 MB tmpfs, Chromium) + file cache attributed to the
  container. Compare like with like: same state, before vs. after.
* **Stopping only the `vu-movie` container** leaves the Postgres (≤ 512 MB)
  and FlareSolverr (≤ 1.2 GB, its own Chromium) sidecars running. Stop the
  *project* to release those.

To check for orphaned children after stopping the app:

```bash
docker compose exec vu-movie ps aux | grep -E 'ffmpeg|chromium'   # while running
# outside Docker:  ps aux | grep -E 'ffmpeg|chromium'
```

## What a playing movie legitimately costs

All of this is *expected* while a movie plays, and is per concurrent session
(distinct movies started at the same time multiply it — `MAX_CONCURRENT_TRANSCODES`
does not gate live relay sessions):

| consumer | typical size | released when |
|---|---|---|
| ffmpeg process (separate from Node) | VAAPI 1080p ≈ 150–400 MB RSS; software x264 more; 4K decode surfaces more again | the process exits (`waitForChildrenToExit` verifies this on shutdown) |
| upstream chunk/segment cache (Node) | up to `UPSTREAM_CACHE_MB` (default **64 MB**) per session/direct link | session stop → proxy close frees it immediately (`cacheFreedMb` in the log) |
| stuck/paused player queue (Node) | up to **64 MB** per player that stops reading while others keep watching | the player drains, disconnects, or is dropped after `CLIENT_STALL_SECONDS` |
| range-less capture file (disk, not RAM) | up to the whole movie under `TMP_DIR/upstream/*.part` | proxy close deletes it; while playing it also fills page cache (see above) |
| headless Chromium (scraping only) | ≈ 300 MB+ ("frees ~300 MB" in its own log line) | `BROWSER_IDLE_SECONDS` (default 180 s) after the last scrape |
| HLS segments (disk) | ~10 × 2 s window, `delete_segments` is on | session stop removes the directory |
| Node baseline | ≈ 60–80 MB RSS idle | — |

Measured on the bench (512 MB test file streamed through the upstream proxy):
Node RSS 62 MB → ≈ 203 MB during play (64 MB cache + in-flight copies + heap
growth), `heapUsed` flat at ~11 MB, and after stop the freed buffers are
**reused** by the next movie rather than returned to the OS — RSS stays at
the plateau across cycles 2, 3, 4 while `heapUsed`/`external` come back
down. That plateau is the allocator's high-water mark, not a leak.

## By-design holds after "stop" (the usual suspects)

Pressing stop in a player does not mean "free everything now" — these are
deliberate, each with a knob:

| hold | default | knob |
|---|---|---|
| a non-receiver player (VLC, browser) leaves → the session is kept *frozen* (ffmpeg alive, cache held) so a returning player resumes mid-movie | **900 s** | `PAUSE_KEEP_SECONDS` |
| a session nobody attached to (API pre-start, HEAD probe, HLS between polls) | 45 s | `STREAM_IDLE_SECONDS` |
| a player that stopped reading but didn't disconnect (a long pause) is held before being dropped | 1800 s | `CLIENT_STALL_SECONDS` |
| a direct-link upstream proxy (and its 64 MB cache) waits for a reconnect after the last request | 10 min idle sweep | — (its background *download* now pauses the moment the player leaves) |
| Chromium after scraping | 180 s | `BROWSER_IDLE_SECONDS` |
| finished-HLS segments kept for late clients | `STREAM_IDLE_SECONDS` | — |
| Node RSS high-water mark | life of the process | restart the container |

The Enigma2 box / playlist / Xtream receivers are the exception: when they
leave a movie the session stops immediately, nothing is kept.
The UI's **stop all sessions** button is likewise immediate.

If the NAS is tight on RAM, the effective diet is: lower
`PAUSE_KEEP_SECONDS` (e.g. 120), lower `UPSTREAM_CACHE_MB` (e.g. 32), and
keep `NODE_OPTIONS=--max-old-space-size=512` + `MALLOC_ARENA_MAX=2` from the
Dockerfile (both already set in the image).

## Leaks found in the audit and fixed

Each has a regression test in `test/memory-lifecycle.test.js`:

1. **Closed upstream proxy kept its cache.** `closeUpstreamProxy` removed
   the proxy from the registry but left the 64 MB `ByteStore`/`SegmentCache`
   intact; the closed session object is routinely kept alive by timers and
   closures, so the bytes stayed allocated until an arbitrary GC. Closing
   now clears the caches, manifest refs and rewritten MPD.
2. **Range-less direct links downloaded forever after stop.** The background
   capture for Range-less CDNs kept pulling the whole movie after the player
   disconnected, and every written chunk refreshed the proxy's activity
   stamp, so the 10-minute idle sweep could never close it. Capture progress
   no longer counts as reader activity, and the capture now **pauses** when
   the last direct-link reader disconnects (resuming on the next read).
3. **Unbounded metadata cache.** The in-memory mirror of `api_cache` was
   written on every `cacheSet` (also in Postgres mode) and only ever removed
   entries read again after expiry — one entry per distinct key, forever.
   It is now capped at 500 entries with expired/oldest eviction, and the
   Postgres table gets a throttled expired-row sweep.
4. **Spawn-failure sessions leaked.** Node does not guarantee a `'close'`
   event after a spawn `'error'`; the relay only cleaned up on `'close'`, so
   a missing/non-executable ffmpeg left the session registered and its
   upstream proxy pinned for the life of the process. The `'error'` handler
   now unregisters the session and releases the proxy.
5. **Shutdown orphaned children.** App shutdown SIGTERM'd relay ffmpeg and
   exited 500 ms later — the 5 s SIGKILL escalation could never fire, and
   `/dl` downloads, download-job ffmpeg and live template tests were not
   stopped at all. Shutdown now stops *every* registered child (relay,
   jobs, downloads, template tests), waits for them to exit (SIGKILL at a
   5 s deadline, inside Docker's stop grace), closes all upstream proxies,
   and only then exits. Inside Docker the PID-namespace teardown eventually
   killed orphans anyway; outside it (plain `node`, a systemd unit with
   `KillMode=process`) they survived indefinitely.
6. **Small unbounded growth**: expired resume points are now swept (they
   were only removed when the same movie replayed), the browser sniffer's
   console-error list is capped, and the template-test/client-abort kill
   paths escalate to SIGKILL like the timeout path already did.

## Known remaining characteristics (not leaks)

* RSS will still sit at its high-water mark after the first movie. Judge
  leaks by `heapUsedBytes`/`externalBytes` across cycles, not by RSS/DSM.
* Concurrent *different* movies each get their own ffmpeg + cache. On the
  DS918+ target that is a product limit to watch, not a leak.
* A paused range-less *relay* session may still capture ahead to disk while
  frozen (that is what makes it seekable); the file is deleted on stop.
