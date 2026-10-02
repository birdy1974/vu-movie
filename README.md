# vu-movie

**Turn a movie/series streaming page into one file VLC can play — and publish it to your VU+ Duo2.**

`vu-movie` runs on a Synology DS918+ (or any Docker host) and does three things:

1. **Scrapes** a stream from a supported site — either by searching the site for a
   title, or by pasting the page/player URL — and merges the chunks into **one
   continuous stream** that VLC, a browser, or the Duo2 can play directly.
2. **Transcodes** that stream on the NAS with Intel VAAPI hardware when the source
   is too big for the target (4K HEVC → 1080p H.264, 1 concurrent stream), with a
   full profile editor: resolution, aspect ratio, video/audio bitrate, fps, container.
3. **Publishes** what you scraped as an **Enigma2 bouquet** on the receiver, so a
   film shows up in the channel list next to the normal satellites — plus Dutch/English
   **subtitles** searched and pushed to the box.

The UI is a single page with live logs (SSE), a job list, a live ffmpeg command
preview and a settings editor — no build step, no CDN, everything served from `/`.

```
                    ┌────────────────────────────┐
  browse site  ───▶ │ Chromium sniffer (Layer 2) │ ──┐
  or search         └────────────────────────────┘   │  manifest URL + headers
                                                      ▼
  ┌──────────────┐   ┌───────────────────┐   ┌──────────────────────┐
  │ source recipe │──▶│   registry        │──▶│  ffmpeg relay        │
  │ (Layer 1)     │   │ probe + rank      │   │  copy / VAAPI trans- │
  └──────────────┘   └───────────────────┘   │  code → TS / MKV /HLS│
  external extractor (Layer 3, optional) ────┘        │
                                                      ▼
                                   http://nas:8080/s/<token>/<title>.ts
                                     ├─ VLC · browser · M3U playlist
                                     ├─ Enigma2 bouquet entry (4097)
                                     └─ /dl/… download · subtitles
```

---

## Quick start (Synology DS918+)

```bash
# 1. put the project somewhere on the NAS
sudo mkdir -p /volume1/docker/vu-movie && cd /volume1/docker/vu-movie
#    (copy this repository here — Container Manager → Project also works)

# 2. configuration
cp .env.example .env
vi .env                      # set ENIGMA2_HOST + ENIGMA2_PASSWORD at least

# 3. build and start
docker compose up -d --build

# 4. open the UI
#    http://<nas-ip>:8080
```

First run: the app creates its config, runs the database migrations, detects
whether `/dev/dri` works, and tells you in the log exactly what hardware it found.

Read **[docs/SYNO.md](docs/SYNO.md)** for the DSM-specific details (VAAPI
permissions, Container Manager project import, firewall, where the data lives).

---

## What you get

### Search & scrape
* One search box that fans out over the enabled sources, plus a **paste-URL** mode
  for a page or player URL.
* Source list (editable in Settings → Sources): `overlook.cx`, `cinevo.nl`,
  `cinejoy.pk`, `flixhub.studio`, `redflix.club`, `1flex.org`, `cinezo.st` — and
  **MovieBox** through its own signed REST client.
* Candidates are **probed with ffprobe**, ranked by resolution/codec/bitrate and
  deduplicated, so you choose a stream instead of a URL soup. Broken mirrors are
  marked, not offered.

### One stream for VLC
* `http://<nas>:8080/s/<token>/<title>.ts` — a single continuous MPEG-TS.
  The token never expires (until you delete the stream), so it can live in a
  playlist, in VLC's history, or on the receiver.
* Ports of the same stream: `.m3u8` (segmented live HLS, seekable, works in
  browsers), `.mkv` (Matroska for downloads/archival), `.m3u` playlist,
  `/dl/…` download, `/watch/…` simple player page, and `/s/<token>/direct`
  which 302s to the upstream URL if you prefer to let VLC fetch it itself.
* **Remux by default**: if the source is already 1080p H.264 it is copied, not
  re-encoded — a J3455 happily relays several of those.

### Hardware transcoding that respects the J3455
* VAAPI via `/dev/dri/renderD128` with the exact command family from the
  requirements (`-init_hw_device vaapi=intel:… -hwaccel vaapi -hwaccel_output_format
  vaapi -vf scale_vaapi=… -c:v h264_vaapi … -f mpegts -mpegts_flags +resend_headers`).
* The truth about Apollo Lake, shown in the UI: **decode** H.264/HEVC/VP9/VC-1,
  **encode H.264 only** — one 1080p stream at a time. HEVC output is offered for
  downloads (CPU, slow) and labelled as such.
* Automatic fps-variant detection: if your ffmpeg build cannot run the `fps`
  filter on VAAPI surfaces, the framerate conversion moves to the output stage
  (`-fps_mode cfr -r N`) instead of failing.
* Software fallback (`libx264 -preset veryfast`) whenever `/dev/dri` is missing —
  the app says so loudly instead of producing a broken stream.

### Subtitles (Dutch + English by default)
| Provider | Type | Key needed |
|---|---|---|
| OpenSubtitles.org | XML-RPC, hash matching | no |
| Podnapisi | scrape | no |
| TVsubtitles.net | scrape | no |
| SubDL | REST API | free key, 2000 req/day |
| OpenSubtitles.com | REST API | free key, 5–20 downloads/day |
| *your own* | template (URL + regex), added in the UI | — |

Search, preview the cues, **shift the timing** (+/− ms), download the `.srt`, or
push it to the receiver (`/media/hdd/movie/vumovie`, configurable) so the Duo2
picks it up next to the recording.

### Enigma2 bouquet
* Generates `userbouquet.<name>.tv` with `#SERVICE 4097:…` entries (GStreamer
  service type, so no tuner is used), `#DESCRIPTION` lines, and per-season
  separators for series.
* Pushes it to the box over **OpenWebif**, patches `bouquets.tv`, reloads with
  `servicelistreload?mode=2` and verifies the entries came back —
  FTP/SCP fallback when the WebIF upload endpoint is unavailable.
* Preview the exact file in the UI before anything is uploaded.

### Operations
* **Jobs** for every long action, with progress, logs and a cancel button
  (cancelling kills the underlying Chromium/ffmpeg process).
* **Live log view** in the UI (`/api/events`, SSE) with level/component filters —
  made for "why is this film not playing" debugging.
* **Detailed, levelled, component-tagged logging** in the container log too
  (`docker logs -f vu-movie`), including the full ffmpeg command for every stream.
* Postgres (with migrations) or **in-memory mode** when no database is reachable —
  the app degrades instead of refusing to start, and `REQUIRE_DB=true` flips that
  to a hard failure if you prefer.

---

## Daily use

1. **Search** a title, pick the site result, press **Scrape stream**.
2. Pick a candidate (quality/mirror) → **Create stream**.
3. Copy the **play URL** into VLC, or press **Open in VLC**.
   The transcode profile on the right changes the URL's behaviour live
   (`?q=720&bw=1500` overrides work too) and shows the resulting ffmpeg command.
4. Press **Subtitles**, search NL/EN, attach or download — or push it to the Duo2.
5. Press **Push to Duo2** to add the title to the bouquet (it appears in the
   channel list without a reboot).

---

## Configuration

Precedence: **environment** (`.env` / compose) → `/config/vumovie.json` (written by
the Settings page) → built-in defaults. Everything can be changed in the UI; the
docs for each knob are in [.env.example](.env.example) and
[config/vumovie.example.json](config/vumovie.example.json).

The ones that matter most on a DS918+:

| Variable | Default | Why |
|---|---|---|
| `TRANSCODE_MODE` | `auto` | `copy` never encodes; `vaapi` forces hardware encode |
| `ALWAYS_TRANSCODE` | `false` | `true` re-encodes even a perfect source |
| `MAX_CONCURRENT_TRANSCODES` | `1` | the J3455 cannot do two 1080p encodes |
| `DEFAULT_RESOLUTION` / `DEFAULT_VIDEO_BITRATE` | `1080` / `2500` | 1080p @ 2.5 Mbit looks fine and keeps the GPU cool |
| `DEFAULT_FPS` | `source` | forcing 25 fps on 23.976 material causes judder |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | passed through by `docker-compose.yml` |
| `BROWSER_CONCURRENCY` | `1` | one headless Chromium is ~300 MB |
| `ENIGMA2_HOST` | — | your Duo2, e.g. `192.168.1.50` |

---

## Docker

* `Dockerfile` — multi-stage, `node:22-bookworm-slim`, **system Chromium**
  (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, so no 300 MB browser download), ffmpeg,
  VA-API drivers (iHD with i965 fallback), `vainfo`, `tini`, `unzip`/`7z`/`unrar`.
  contrib + non-free are enabled in both apt source formats (`debian.sources` and
  classic `*.list`), which is what makes the non-free iHD driver and the
  RAR4/RAR5-capable `unrar` installable; optional packages are installed through a
  tolerant helper so a package rename cannot break the build, and the build then
  **verifies** `ffmpeg`/`ffprobe`/`chromium`/`tini` are present. The build also
  **fails loudly if `public/` is missing** and falls back to `npm install` with a
  warning if `package-lock.json` is absent; `package-lock.json` is committed, so
  `npm ci` is the normal path.
* `docker-compose.yml` — the app, `postgres:16-alpine`, an optional
  `flaresolverr` (profile `cf`) and the `/dev/dri` device passthrough.
* Health: `GET /api/health` (also wired into the container healthcheck).

```bash
docker compose logs -f vu-movie          # structured logs
docker compose exec vu-movie vainfo      # what the GPU actually supports
docker compose exec vu-movie ffmpeg -hwaccels
```

## Verifying your NAS's hardware after deployment

```bash
docker compose exec vu-movie vainfo                       # driver + codecs
curl -s localhost:8080/api/health | jq .health.hwaccel    # what the app detected
curl -s "localhost:8080/api/config/hwaccel/test" -X POST  # runs a 2 s VAAPI self-test
```

If `vaapi` shows `false`, check `docs/SYNO.md` → *VAAPI permissions*. The app
keeps working either way (software encoding).

---

## Development

```bash
npm install          # express + pg + playwright-core only
npm test             # 42 unit tests (ffmpeg args, subtitles, bouquet, MovieBox signing)
npm run check        # node --check on every source file
npm run dev          # nodemon-style watch with debug logging
LOG_LEVEL=debug npm start
```

Useful endpoints while debugging: `GET /api/health`, `GET /api/logs?level=warn`,
`GET /api/events` (SSE), `POST /api/find/resolve`, `GET /api/streams/:id/command`
(prints the exact ffmpeg command line the relay would run).

### Repo layout

```
src/core/       log, config, db+repo, job queue, media (ffmpeg probing + VAAPI) 
src/scrapers/   http, headless-Chromium sniffer, recipes, registry, MovieBox client
src/streams/    stream store (tokens/URLs), relay (ffmpeg sessions), downloads, M3U
src/subtitles/  5 providers + custom templates, SRT/VTT/encoding tools, receiver push
src/enigma2/    bouquet builder/patcher + OpenWebif upload and verification
src/http/       REST API + server (static UI, playable /s, /dl, /hls, /watch)
public/         the entire UI (no build step): index.html, app.js, style.css
migrations/     SQL schema (applied automatically at startup)
test/           unit tests
```

## Legal / etiquette

`vu-movie` is a personal proxy for streams you are allowed to watch. It does not
host or index anything, it has no catalogue, and it stores no video. Scraping and
transcoding rules differ per jurisdiction — make sure what you do with it is legal
where you live, and respect the terms of the sites you point it at. The Docker
image contains no credentials; API keys stay in your own `/config`.

## Licence

MIT.
