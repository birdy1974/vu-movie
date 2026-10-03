# vu-movie — design proposal & UI mockup (v0.1, for approval)

> **Status:** nothing is coded yet. This is the mockup + plan. Open questions are at the
> bottom (D1–D6) — answer those and I build the whole thing.
>
> **See the UI:** `public/mockup.html` (static, clickable, fake data — opened via the live preview).

---

## 1. What I verified before designing anything

| Check | Result | Why it matters for the design |
|---|---|---|
| `mesamirh/MovieBox-TUI` source, licence, architecture | Rust TUI, **Apache-2.0**, backend = signed REST API (`api*.aoneroom.com` + HMAC-MD5 request signing, visitor-login token, host pool with retry) | An Apache-2.0 licence means we *can* reuse the protocol knowledge. But there is **no Node/Rust library to call**: we implement the same signed REST client natively in Node. No browser needed for MovieBox → fast, reliable |
| Your 7 source sites reachable from this sandbox | **No** — all 7 resolve but time out / return nothing from this build environment | I cannot reverse-engineer the exact player API of each site here. The design therefore does **not** hard-code one brittle path per site; see §3 |
| Relationship between “Flixer” and Overlook / Flixhub / 1flex / Redflix / Cinevo / Cinejoy / Cinezo | Independent research confirms these are a **family of Flixer-style aggregator front-ends**: they share the same player-API “farms” (vidrock, vixsrc, vidnest, vidlove, moviesapi, rivestream…). Some speak a plain JSON API, Cinejoy and Flixer speak an **encrypted binary API decrypted by a WASM blob** | One good resolver unlocks most sites. Also explains why “just parse the HTML” fails on some of them |
| Cheap/flaky shortcuts exist (Stremio scraper, cinepro) | yes, but (a) no licence on the scraper repo (all rights reserved), (b) cinepro needs its own server. **We will not copy their code** | Our code stays ours; we may add an *optional* external-extractor hook you can point at anything |
| DS918+ hardware (J3455 / Apollo Lake / HD Graphics 500) | VAAPI decode: H.264, HEVC 8/10-bit, VP9, VC-1. **Encode: H.264 only** (no HEVC/VP9 encode). `/dev/dri/renderD128`, needs `iHD` or `i965` driver + render-group access | Realistic target = **decode 4K HEVC → encode 1080p H.264**. HEVC *output* is impossible on this box (CPU-only). 1080p H.264 encode is real-time-capable at modest bitrate, but **one** concurrent transcode |
| Subtitle sources: real API vs. scraping | OpenSubtitles.com REST API (key, 5–20 downloads/day free) · SubDL REST API (free key, 2000 req/day) · OpenSubtitles.org **legacy XML-RPC still works, no key** · Podnapisi (keyless) · TVsubtitles/Podnapisi scrape reasonably · **Addic7ed requires login** · JustSubtitles/Tvsubs are plain page scrapes that break often | Design: provider registry with per-provider *state* (ok / needs key / needs login / broken) + a **custom provider template editor** so *you* can add sources |
| Enigma2 bouquet | `#NAME` + `#SERVICE <ref-type>:0:1:0:0:0:0:0:0:0:<urlencoded-url>:<name>` + `#DESCRIPTION`; entry must be listed in `bouquets.tv`; reload via OpenWebif `/web/servicelistreload?mode=2` | Push is fully doable over HTTP with no SSH. Type **4097** (GStreamer) is the safe choice for IPTV on a Duo2 |

---

## 2. Architecture (3 containers, one compose file)

```
                    ┌───────────────────────── Synology DS918+ (DSM 7, Container Manager) ─────────────────────────┐
  browser ────────► │  vu-movie  (node:22-bookworm-slim + ffmpeg 6 + chromium 121 + intel vaapi drivers)          │
  VLC     ────────► │                                                                            /dev/dri ───┐      │
  VU+ Duo2 ───────► │   express  ─┬─ /api/*        REST + SSE (progress, logs)                             │      │
                    │             ├─ /s/:id/*.ts   ★ unified MPEG-TS  ──► ffmpeg (copy or VAAPI) ────────┘      │
                    │             ├─ /s/:id/*.m3u8 HLS for VLC/browser                                     │
                    │             ├─ /dl/:id       progressive file (download button)                      │
                    │             └─ static UI (public/)                                                   │
                    │   scraper:  recipe adapters → headless chromium sniffer → probe (ffprobe) ranking    │
                    │   subtitles: provider registry (API + scrape + your templates)                       │
                    │   enigma2:  bouquet builder + OpenWebif pusher                                       │
                    └───────┬─────────────────────────────────────────────┬───────────────────────────────────┘
                            │ postgres (lazy pool, migrations on boot)     │ /downloads  /config  /cache (volumes)
                     ┌──────▼──────┐                              ┌────────▼─────────┐
                     │  postgres:16│                              │  flaresolverr    │  (always on)
                     └─────────────┘                              │  host :8192      │   (container :8191)
                                                                  └──────────────────┘
```

**Data flow of one title**

1. **Find** — search on the enabled sites (recipe adapter or headless sniffer) → normalised `Title` with available poster, year, rating, genres, runtime, language and synopsis metadata.
2. **Resolve** — adapter walks the source’s own server list (like the site’s player does), decrypting/unpacking as needed → candidates `[{url, quality, codec, headers}]`.
3. **Probe** — every candidate is fetched with `ffprobe` (or a HEAD/`m3u8` parse for HLS): resolution, codec, fps, bitrate, audio tracks, subtitle tracks. Dead/403/expired candidates are dropped, the rest ranked.
4. **Unify** — resolve the chosen candidate to a **segment list** (HLS/DASH) or a single progressive URL and expose *one* stable URL on the NAS. VLC, the Duo2 and a download all read from that URL; the upstream (expiring) URL never leaves the container.
5. **Transcode (optional)** — if 4K/HEVC/forced, route through ffmpeg (VAAPI) before the client; otherwise **stream-copy remux** into MPEG-TS (0 % CPU).
6. **Subtitles (optional)** — fetch best NL/EN `.srt`, normalise, then either mux into the stream, keep as file, and/or push to the box.
7. **Publish** — `.m3u` playlist download, Enigma2 bouquet entry, or direct file download.

---

## 3. Site adapters — the honest plan (this is decision **D1**)

Your 7 sites cannot all be treated identically. Three layers, in order of preference:

**Layer 1 — recipe adapters (fast, no browser).**
Per-site JSON/HTML recipe: search URL template, result selectors / JSON pointers, embed pattern, resolver
chain, “server list” endpoint. Works for the plain-API sites (Cinezo-family, MovieBox-API clones, and the
Flixer-family JSON farms). Config lives in `/config/sources/*.json`, so fixing a site after it changes is a
**file edit, not a rebuild**.

**Layer 2 — generic headless-browser sniffer (robust, always available).**
Playwright/Chromium opens the movie page, blocks ads, watches network traffic and collects every `.m3u8` /
`.mp4` / `.mpd` / master-playlist request plus the site’s own XHR API answers, then probes them. This is the
fallback that keeps working when a site’s obfuscation changes, at the cost of ~400–600 MB RAM and a few
seconds per title. One browser instance max, reused, killed after idle — important on a 4 GB NAS.

**Layer 3 — encrypted/obfuscated players (Cinejoy, Flixer-native).**
Their backend returns encrypted bytes decrypted by a WASM blob in the front-end. Options:
**(a)** run their WASM inside Node (workable, no browser), **(b)** let the headless browser do it and just read
the resulting media URL (simpler, slower), **(c)** accept what the plain API farms already give us and skip the
site-specific path. **Recommendation: (b) by default, (a) as an optimisation later.**

**Optional Layer 4 — external extractor hook.** A Stremio addon endpoint or cinepro-style API can be
configured as a provider in settings. FlareSolverr is a separate service that Compose starts automatically
and publishes on host port 8192 (container port 8191); the current scraper does not yet call its API.

**MovieBox (you explicitly asked for this one):** implemented natively — visitor-login token + HMAC-MD5
signed requests + host-pool retry, exactly as the Apache-2.0 client does it, in TypeScript against the same
`api*.aoneroom.com` endpoints. No Chromium, no download of the Rust binary. (Alternative, if you prefer: bundle
the MovieBox-TUI binary and shell out to it — bigger image, brittle CLI parsing. **Recommendation: native.**)

---

## 4. The “chunks → one stream” core

Your requirement: *“the application needs to redirect these video streams in 1 final video stream that should
be able to be played directly with VLC”*. Three possible implementations — **this is decision D2**:

| | A. Hard redirect (302 to upstream) | B. **Relay/remux through the NAS** (recommended) | C. Hybrid |
|---|---|---|---|
| Load on NAS | none | ~2–5 % CPU (copy) | none/low |
| Stable URL for VLC + Duo2 | ✗ (token expires in minutes) | ✓ never expires | ✓ |
| Subtitle muxing | ✗ | ✓ | ✓ |
| Works when the source needs custom headers/Referer | ✗ | ✓ (headers added server-side) | ✓ |
| Download button/resume | ✗ | ✓ | ✓ |

Recommended = **C**: default `relay + remux to MPEG-TS`, but every stream page also exposes a
“direct link” button that 302-redirects to upstream when the NAS should stay out of the path.
Chunked sources (HLS/DASH) are then invisible to the client: it sees **one continuous TS stream**
(and, for VLC seeking, an HLS variant `.m3u8` is offered as well).

---

## 5. Transcoding on the DS918+ (decision D3 folds in here)

The command you gave is taken as the base. Additions/corrections to make it survive real content:

* **Keep the source frame rate by default.** Your example forces `fps=25 -r 25`. For 23.976/24 fps film that
  means duplicate frames and visible judder; for 25 fps PAL it is perfect. Default = *keep source fps*,
  with an explicit “force 25” toggle (and a note in the UI).
* **`fps` filter + `scale_vaapi` in one chain is not universally buildable** — the `fps` filter cannot always
  run on VAAPI surfaces. The builder emits the correct variant and there is a **startup self-test** that runs
  each candidate pipeline for 2 s against a test pattern on your NAS and selects one that actually works:
  1. `scale_vaapi=…,fps=25` (as in your command),
  2. `scale_vaapi=…` + output `-fps_mode cfr -r 25`,
  3. `scale_vaapi=…` + `-r 25` (legacy syntax, for older ffmpeg).
* **Driver:** Apollo Lake works with `iHD` (intel-media-driver, non-free) or `i965-va-driver` (free). Startup
  runs `vainfo` twice and logs which one initialises; the compose file documents the render-group GID needed
  (DSM often needs `group_add` or `privileged: true` for `/dev/dri`).
* **Hardware fallback:** if vaapi init fails, the app logs an ERROR with the raw ffmpeg stderr and
  automatically falls back to `libx264 -preset veryfast -crf 22` (with a loud warning that 1080p software
  encode is not real-time on a J3455).
* **Bitrate/quality guards:** resolution 480/720/1080 × aspect 16:9 / 4:3 (960×720 pillarbox) / source ×
  video bitrate × audio bitrate × channels × container × fps — all user-selectable, all reflected in a
  **live-updating, copy-ready ffmpeg command** in the UI (so you can paste it into a shell yourself).
* **Clean degradation:** source ≤1080p H.264 → copy (no encode at all); otherwise/if forced → VAAPI encode.
  Max 1 concurrent transcode by default (configurable), queue with clear “waiting for encoder” status.
* **Download vs live:** a download job may use a slower, better profile (e.g. 2-pass x264) because it does not
  have to hit real time; live streams always use the real-time-safe profile.

---

## 6. Subtitles

| Provider | Interface | Key/credentials | NL | EN | Notes |
|---|---|---|---|---|---|
| OpenSubtitles.org | legacy XML-RPC | none | ✓ | ✓ | still the easiest keyless source; hash matching works |
| OpenSubtitles.com | REST | API key (5–20 dl/day free) | ✓ | ✓ | best metadata + ratings |
| SubDL | REST | free key, 2000 req/day | ✓ | ✓ | includes Subscene archive |
| Podnapisi | XML/scrape | none | ✓ | ✓ | movies + series |
| TVsubtitles.net | scrape | none | ✓ | ✓ | series only, sane HTML |
| Addic7ed | scrape | **login required** | ✓ | ✓ | good for series; needs your account |
| JustSubtitles.com | scrape | none | ✓ | ✓ | layout changes often → provider marked broken |
| Tvsubs.net | scrape | none | ✓ | ✓ | slow, ad-heavy |
| **+ Your own sources** | template | per source | ? | ? | URL template with `{query}{imdb}{tmdb}{imdbid}{sxx}{exx}{lang}` + archive rule + auth (none/api-key/basic/cookie) + **Test** button |

Pipeline: search → score (hash match ▸ release match ▸ title+year ▸ downloads) → download (zip/rar/7z
extraction) → normalise (`UTF-8`, CRLF, cue sanity, optional timing offset, optional audio-based re-sync) →
then *mux into the stream* (soft track), *sidecar .srt*, and/or **push to the receiver** (OpenWebif / SFTP /
Samba share), renamed to match. Realistic expectation, stated honestly: pushed sidecar `.srt` is honoured by
*some* E2 players and ignored by others; the reliable route on a Duo2 is the muxed track, so both are offered
and the UI tells you which one the box will actually use.

---

## 7. Enigma2 bouquet & push

```text
/etc/enigma2/userbouquet.vumovie.tv
#NAME vu-movie (TV)
#SERVICE 4097:0:1:0:0:0:0:0:0:0:http%3a//192.168.1.10%3a8080/s/9f3ab21c/dune.m3u8:Dune Part Two (2024) [NL]
#DESCRIPTION Dune Part Two (2024) — 1080p · NL subs

/etc/enigma2/bouquets.tv           ← one line added (and never duplicated):
#SERVICE 1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "userbouquet.vumovie.tv" ORDER BY bouquet
```

* Service type selectable: **4097** (GStreamer, recommended) / 5001 / 5002 / 1.
* Unique service references auto-generated (duplicate refs are the #1 reason a new bouquet shows fewer
  channels than expected — the app checks with `/web/getservices` after reload and repairs).
* Push = upload + `servicelistreload?mode=2` + **verify**, via OpenWebif over HTTP (no SSH needed).
  Fallbacks: SFTP/scp to a mounted share, or write files into a Synology folder your box already syncs.
* Dry-run / diff before writing; refuses to touch a bouquet it did not create.
* Series: one entry per episode, grouped per season with `#NAME ── Title (Year) ──` separators.

---

## 8. Docker / Synology — your bullet list, addressed explicitly

| Your requirement | How it is handled |
|---|---|
| Complete Dockerfile with Chromium, FFmpeg, VAAPI | multi-stage `node:22-bookworm-slim`; contrib/non-free enabled in *both* source formats (`debian.sources` deb822 + classic `*.list`); apt: `ffmpeg`, `chromium`, `libva2`, `libva-drm2`, `vainfo`, `intel-media-va-driver-non-free` (iHD) with `i965-va-driver` fallback, `p7zip-full` (provides `/usr/bin/7z`, with the `7zip` package as fallback), `unrar` (non-free, RAR4/RAR5) with `unrar-free` fallback, `unzip`, `ca-certificates`; optional packages go through a tolerant installer, so a renamed package (e.g. bookworm's `libva-utils` → `vainfo`) no longer fails the build, while `ffmpeg`/`ffprobe`/`chromium`/`tini` are verified at build time; `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` + `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium` (system Chromium — no 300 MB download) |
| `docker-compose.yml` with PostgreSQL + app, `/dev/dri` | 3 services (`vu-movie`, `db`, always-on `flaresolverr` published on host port 8192), `devices: [/dev/dri:/dev/dri]`, healthchecks, `depends_on: service_healthy`, named volumes for `pgdata`, `/downloads`, `/config`, `/cache` |
| Optimised for J3455 / HD Graphics 500 | 1 browser + 1 transcode concurrency by default, `shm_size: 512mb` for Chromium, memory limits, `LIBVA_DRIVER_NAME` auto-detected at boot, `MALLOC_ARENA_MAX=2` |
| Detailed logging & comments | `pino` structured logs, per component (`scraper`, `browser`, `resolver`, `transcode`, `subtitles`, `enigma2`, `db`, `hwaccel`), every stage logs latency + reason for rejection, ffmpeg stderr mirrored, `/api/health` JSON, log viewer page with filters |
| `package-lock.json` / failing Docker build | `npm ci` **needs** the lockfile → the repo ships a committed `package-lock.json` (generated with `npm install --package-lock-only`); Dockerfile falls back to `npm install` with a clear warning if a lockfile is ever missing, so a build never dies on that |
| Lazy DB connection + dummy URL at build time | the pool is created on first query (not at import); `DATABASE_URL` defaults to `postgres://vu-movie:vu-movie@db:5432/vumovie`, and every build-time step uses `DATABASE_URL=postgres://build:build@127.0.0.1:5432/build` so `npm ci`/prisma-free codegen never tries to reach a DB; `/api/health` reports `db: not_connected_yet` until first use |
| DB initialisation / tables exist at startup | plain-SQL migration runner (`schema_migrations` table, `migrations/0001_init.sql`…), executed **before** the HTTP listener opens, with `--wait-for-db` retry/backoff (Postgres takes ~10 s to accept connections on a NAS); idempotent, so restarts are safe. Tables: `titles`, `sources`, `stream_candidates`, `streams`, `subtitle_files`, `subtitle_providers`, `boquets(sic)`, `jobs`, `settings`, `logs` |
| `public/` always exists | **real content is committed** (`public/index.html`, `public/mockup.html`, `public/assets/.gitkeep`); Dockerfile does `RUN mkdir -p /app/public && test -f /app/public/index.html` (build fails loudly if the dir is empty, which is the honest fix — a silently missing UI is worse); app also creates the dir and serves a built-in “UI not built” page if it is ever empty |
| Info/warn/error everywhere for fault-finding | every catch logs `component + what failed + which fallback is being tried + the raw upstream error`; the log page and `/api/health` expose it; a `DEBUG=vu-movie:*` env flag raises verbosity per component |

Also: `.dockerignore` (keeps `node_modules`, caches, media out of the context), non-root runtime user with
the render group, `tini` as PID 1 so ffmpeg/Chromium children are reaped, and a `/api/health` endpoint plus
**DSM Container Manager** friendly labels/healthcheck so it looks right in the Synology UI.

---

## 9. Proposed file tree

```
vu-movie/
├─ docker-compose.yml            # app + postgres + always-on flaresolverr (host port 8192)
├─ Dockerfile                    # node 22 + ffmpeg + chromium + vaapi
├─ .dockerignore  .env.example  package.json  package-lock.json  README.md
├─ docs/  MOCKUP.md  API.md  SYNO.md
├─ migrations/  0001_init.sql …
├─ public/                      # UI (no build step in the recommended option)
│  ├─ index.html  mockup.html  app.js  style.css  assets/
├─ config/sources/*.json        # per-site recipes (editable without rebuild)
└─ src/
   ├─ server.ts  routes/ (find, resolve, stream, subs, enigma, settings, jobs, health)
   ├─ core/  log.ts  config.ts  db.ts  migrations.ts  jobs.ts  probe.ts  hwaccel.ts
   ├─ scrapers/  registry.ts  browser.ts  recipes/*.ts  moviebox.ts  custom.ts
   ├─ stream/  relay.ts  transcode.ts  ffmpeg.ts  playlist.ts
   ├─ subtitles/ providers/*.ts  score.ts  normalize.ts  push.ts
   └─ enigma2/  bouquet.ts  push.ts
```

---

## 10. Roadmap (each phase ends with something you can actually run)

1. **Skeleton + Docker** — compiles, builds, boots on the NAS, DB migrated, health/logs page, mockup UI served.
2. **Find & resolve** — MovieBox native client + 2–3 recipe adapters + headless sniffer fallback, ffprobe ranking.
3. **Stream core** — `/s/:id/*.ts|m3u8`, copy-remux path, VLC verified, download job, `.m3u` export.
4. **Transcode** — VAAPI pipeline with self-test + fallback, all the UI knobs, live command preview, job queue.
5. **Subtitles** — providers (keyless first), custom provider editor, mux/sidecar/push.
6. **Enigma2** — bouquet builder, OpenWebif push with verify, series layout.
7. **Polish** — health dashboard, site-health badges, config import/export, docs for DSM setup.

---

## 11. Decisions I need from you

**D1 · Scraper strategy** — how much do we fight for the 4 encrypted/obfuscated sites vs. relying on the shared
API farms? *(options in the question prompt)*

**D2 · Stream delivery** — always relay through the NAS (stable URL, subtitles muxed, works for VLC **and** the
Duo2) vs. bare 302 redirect to upstream (zero NAS load, but expiring URLs) vs. hybrid with a per-stream toggle.

**D3 · MovieBox** — native TypeScript port of the signed API (recommended) vs. bundling the Rust TUI binary vs.
skipping MovieBox entirely.

**D4 · Default subtitle providers** — keyless set only, or also wire in OpenSubtitles.com + SubDL keys, or
scrape-everything including Addic7ed logins.

**D5 · Enigma2 push method** — OpenWebif HTTP upload (recommended, no SSH), SFTP/Samba share, or both.

**D6 · UI stack** — plain server-rendered HTML + vanilla JS in `public/` (no build step, tiny, easy to debug on
a NAS — recommended, and what the mockup uses) vs. Vite+React SPA (nicer for lots of interactive state, adds a
build stage and ~200 MB of dev tooling to the image).

**Things I decided for you unless you object** (say the word and I change them):
fps = keep source (with a force-25 toggle) · software fallback always armed · 1 concurrent transcode and 1
concurrent browser by default · Postgres as you specified (not SQLite) · service type 4097 · Dutch first, then
English · stream URLs are unguessable per-title tokens (no login needed on the LAN) · the app itself is
headless-scraping **your** sources only; no content is bundled or indexed by us.
