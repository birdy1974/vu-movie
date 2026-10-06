# Running vu-movie on a Synology DS918+ (DSM 7)

Everything in this document was written for the DS918+: Celeron J3455, HD Graphics
500 (Apollo Lake), 4 GB RAM, DSM 7.2 with Container Manager.

---

## 1. Install

### Option A — Container Manager project (no SSH needed for the app itself)

1. Copy the project folder to the NAS, e.g. `/volume1/docker/vu-movie`
   (File Station → drag the folder, or `scp -r`).
2. **Container Manager → Project → Create**
   * Project name: `vu-movie`
   * Path: `/volume1/docker/vu-movie`
   * Source: *Select a path* → the folder you just copied → it finds `docker-compose.yml`
3. Before the first start, create the environment file:
   * rename `.env.example` to `.env` (File Station → right click → Rename, or edit with Text Editor)
   * set at least `ENIGMA2_HOST` and `ENIGMA2_PASSWORD`
4. Build. The first build downloads Chromium and ffmpeg (~350 MB) and takes a few
   minutes on the J3455. Later rebuilds are cached.
5. Open `http://<nas-ip>:8080`.

### Option B — SSH

```bash
sudo -i
mkdir -p /volume1/docker/vu-movie && cd /volume1/docker/vu-movie
# copy the project here, then:
cp .env.example .env && vi .env
docker compose up -d --build
docker compose logs -f vu-movie
```

---

## 2. VAAPI permissions (the one thing that usually goes wrong)

The hardware encoder lives at `/dev/dri/renderD128`. Three things must line up:

1. **The device is passed into the container.** `docker-compose.yml` already does:

   ```yaml
   devices:
     - /dev/dri:/dev/dri
   ```

   Verify on the NAS: `ls -l /dev/dri` should show `card0` and `renderD128`.

2. **The container user may open it.** The image runs as root by default — that is
   the easy path on DSM. If you prefer a non-root container (uncomment the two
   lines at the bottom of the `Dockerfile`), give it the render group:

   ```bash
   # on the NAS: find the group that owns renderD128
   ls -l /dev/dri/renderD128        # e.g. root:videodriver
   # then, in the Dockerfile/compose, run as a user in that group (GID shown above)
   # and (DSM sometimes needs this) relax the device mode:
   sudo chmod 666 /dev/dri/renderD128
   ```

   A `chmod` does not survive DSM updates/reboots on all models; the root default
   exists precisely to avoid that.

3. **The right driver is used.** The image installs both VA-API drivers
   (`intel-media-va-driver-non-free` → iHD and `i965-va-driver`). Leave
   `LIBVA_DRIVER_NAME` **empty** in `.env` (the default): the app runs its
   self-test with every installed driver, keeps the one that actually encoded a
   test pattern and passes it to every ffmpeg process.

   This matters because on a DS918+ iHD *installs* fine but often fails to
   initialise against Synology's kernel (`libva error: … iHD_drv_video.so init
   failed`). In that case the app falls back to i965 automatically and logs
   `vaapi self-test ok (variant …, LIBVA_DRIVER_NAME=i965)`. Set
   `LIBVA_DRIVER_NAME=i965` only to force a driver (libva itself does *not* fall
   back once a driver's `.so` opens but fails to init).

Check from inside the container — or let one command do all of it:

```bash
sh scripts/doctor.sh                                       # container + /dev/dri + drivers + a 2 s encode
curl -s localhost:8080/api/diagnostics/ffmpeg              # the same, timed, from the app itself
docker compose exec vu-movie vainfo
docker compose exec vu-movie ffmpeg -hwaccels
curl -s localhost:8080/api/health | grep -A6 hwaccel
```

Expected `vainfo` on a DS918+:

```
vainfo: Driver version: Intel iHD driver ...
vainfo: VA-API version: 1.19
      VAProfileH264High               : VAEntrypointEncSlice     ← encode
      VAProfileHEVCMain               : VAEntrypointVLD         ← decode only
      VAProfileHEVCMain10             : VAEntrypointVLD
      VAProfileVP9Profile0            : VAEntrypointVLD
```

If `VAProfileH264High : VAEntrypointEncSlice` is missing, the container sees the
GPU but the driver is wrong — try `LIBVA_DRIVER_NAME=i965`.

---

## 3. What this hardware can actually do

| | Apollo Lake (HD Graphics 500) |
|---|---|
| Decode | H.264 up to L5.2, HEVC 8-bit **and 10-bit**, VP8, VP9, VC-1, MPEG-2 |
| **Encode** | **H.264 only** (no HEVC, no VP9) |
| Concurrent transcodes | realistically **1** at 1080p, or 2 at 720p if you accept dropped frames |
| Headless Chromium | keep `BROWSER_CONCURRENCY=1` (~300 MB, one core while a page is scraping) |

Practical defaults in `.env`: `DEFAULT_RESOLUTION=1080`, `DEFAULT_VIDEO_BITRATE=2500`.
4K HEVC sources are decoded in hardware and encoded to 1080p H.264 in real time —
that is the realistic sweet spot. Anything asking for HEVC *output* is a CPU job
(hours, not minutes) and the UI marks it as such.

Measured on a DS918+ (reference for your own tuning):

| Job | Result |
|---|---|
| 4K HEVC 10-bit → 1080p H.264 VAAPI, 2.5 Mbit | ~1.0× real time, GPU ~55 %, one core busy |
| 1080p H.264 → 720p H.264 VAAPI, 1.5 Mbit | ~2.5× real time |
| 1080p H.264 remux (copy) | no measurable CPU, ~50 Mbit/s throughput |
| 4K HEVC → 1080p with `libx264 veryfast` | ~0.15× real time (fallback only) |

---

## 4. Where the data lives

Everything is under `./data` next to `docker-compose.yml`:

```
data/config/vumovie.json     settings written by the UI (secrets included → keep it private)
data/config/sessions/        Chromium storage state per site (Cloudflare cookies)
data/downloads/              finished downloads and downloaded .srt files
data/tmp/                    HLS segments, probe temp files (safe to delete)
```

The Postgres database is a named volume (`vu-movie-pgdata`); back it up with
Container Manager → *Volume* → Export, or `docker compose exec db pg_dump -U vu-movie vumovie > backup.sql`.

**Memory budget.** `docker-compose.yml` limits the app to 2.5 GB and the database
to 512 MB. On a 4 GB NAS with Plex/Jellyfin also running, lower
`MEM_LIMIT` to `1500m` and keep `BROWSER_CONCURRENCY=1`.

---

## 5. Using it from VLC and the Duo2

* **VLC on the phone/laptop**: open `http://<nas-ip>:8080`, create the stream, press
  *Open in VLC*, or copy `http://<nas-ip>:8080/s/<token>/<title>.ts`.
* **M3U playlist**: the *Playlist* button downloads `vu-movie.m3u` with every stream
  in it — open it once in VLC and all your titles are there.
* **Duo2**: the *Enigma2* page previews the bouquet, then *Push*. Entries use
  service type 4097 (GStreamer), so watching them does not occupy a tuner. After
  the push the app reloads the service list; the bouquet appears under
  *Favourites* / *vu-movie*.
* **Subtitles**: search NL/EN and attach to the stream, then choose how the box
  gets it (*Playlist → ▤ subtitle → How the box gets it*). Ordered by NAS cost:
  **copy the `.srt` to the box** (FTP or a mounted share, named after the movie —
  no transcoding at all, picked up next to a recording of the same name),
  **soft track** in the Matroska `.mkv` (flagged `default`; no re-encode),
  **burned into the picture** (works on every player but re-encodes the video),
  or **off**. MPEG-TS/HLS cannot carry a text subtitle at all: the relay says so
  in the log instead of failing the stream.
* **Download**: `Download` runs an ffmpeg copy job into `data/downloads` with
  progress in the job list; the resulting `.mkv` plays anywhere.

VLC tips: if playback stutters, lower the video bitrate in the profile before
creating the stream (or append `?bw=1200` to a play URL); the relay restarts with
the new profile on the next request.

---

## 6. Troubleshooting

| Symptom | Where to look |
|---|---|
| `blocked by bot protection and FlareSolverr is not configured` (or `FLARESOLVERR_URL is set but is not a usable URL` / `the configured FlareSolverr URL is a comment, not a URL`) | The source returned a Cloudflare challenge and the solver could not be used. Check `docker compose exec vu-movie printenv FLARESOLVERR_URL` and the `flaresolverr` block of `GET /api/health`: it reports whether the URL is configured, whether the solver answers and which version. Empty → set `FLARESOLVERR_URL=http://flaresolverr:8192` and recreate the container; `set but not a usable URL` → the value is malformed (an inline `# comment` copied from an older `.env` is the classic cause — the app strips it, older builds did not); `is a comment, not a URL` → an example line was saved *as the value* in `/config/vumovie.json`, so replace it with the nested `"scraper": { "flaresolverrUrl": "http://flaresolverr:8192" }` (a flat `"scraper.flaresolverrUrl"` key is ignored — and since this fix it is also named in a boot warning); a solver that answers while the variable is empty is reported too |
| "no media found" while scraping | Logs page → filter `browser`. FlareSolverr starts with the project, listens on container port `8192`, and is published on NAS port `8193` by default (`FLARESOLVERR_HOST_PORT`); inspect it with `docker compose logs -f flaresolverr`. Challenged searches retry through its API; outbound DNS/network failures still need to be fixed separately. |
| `flaresolverr` container restart-loops: `Error getting browser User-Agent … Read timed out (read timeout=120)` | FlareSolverr's *own* Chromium never answered its boot test, so the process exits and Docker restarts it — nothing is wrong with vu-movie. Run `sh scripts/doctor.sh` (section 6) and fix in this order: (1) `FLARESOLVERR_SHM_SIZE=512m` in `.env` then `docker compose up -d --force-recreate flaresolverr` (Docker's `/dev/shm` default is 64 MB and Chromium hangs in it); (2) give it ≥ 1 GB RAM (`FLARESOLVERR_MEM_LIMIT`, raise it or stop other containers — 2 GB NAS boxes are tight); (3) pin an older image with `FLARESOLVERR_IMAGE=flaresolverr/flaresolverr:v3.3.21`. The app itself keeps running and skips Cloudflare sources meanwhile. |
| MovieBox: `visitor-login failed on every API host [fetch-failed:…]` and `tls-or-ip-block`, while some hosts answer `HTTP 404` | Those two verdicts together mean the *mobile* edge (`api*.aoneroom.com`) is blocked at the TLS layer, but other MovieBox hosts still complete a handshake — the 404 is a real HTTP answer to the mobile path from a *different* backend. vu-movie now retries the search on the web (H5) BFF (`h5-api.aoneroom.com` + the public site mirrors) automatically. Force it with `MOVIEBOX_TRANSPORT=h5`, or skip it with `mobile`; full comparison in [docs/MOVIEBOX-TUI-COMPARISON.md §6](MOVIEBOX-TUI-COMPARISON.md) |
| Resolve ends with zero candidates; browser reports `ERR_CONNECTION_REFUSED` and MovieBox reports `fetch failed` | These are outbound HTTPS failures from the app container, separate from Enigma2 reachability. Check DNS and HTTPS from inside `vu-movie` using the commands below; if both providers fail, check NAS/Docker egress, DNS, firewall, or proxy configuration. A reachable FlareSolverr container does not by itself provide a general proxy. |
| The log repeats `enigma2 receiver reachable: <model>` every few seconds | That was `/api/health` forwarding a fresh `/web/about` request to the box on every poll — the container healthcheck (30 s) plus the dashboard (15 s). `/api/health` now **never** contacts the receiver: it reports the last known state (`not checked` until someone tests). The box is checked by the *test connection* button (`GET /api/enigma2/status`) and before each bouquet push; reachability is logged when it **changes** |
| Stream plays but stops after a while | `relay` logs: most upstream URLs expire. Increase `TOKEN_TTL_MINUTES`, or use *Transcode* so the app owns the connection and re-fetches |
| VLC shows a black screen | Copy the ffmpeg command from the Stream page and run it inside the container: `docker compose exec vu-movie sh -c '<command> > /tmp/x.ts'` — the error message is always in the last lines |
| `permission denied /dev/dri/renderD128` | Section 2 above |
| `ERROR hwaccel /usr/bin/ffmpeg not available … {"error":"spawnSync /usr/bin/ffmpeg ETIMEDOUT"}` | That was the app timing out its own `ffmpeg -version` probe on a cold/busy volume and then caching "ffmpeg missing" for a week — fixed: the ceiling is 30 s (`FFMPEG_PROBE_TIMEOUT_MS`), a timeout is reported as a timeout, failed checks are retried in the background, and a negative result is never reused. Nothing to do; if it persists, run `sh scripts/doctor.sh` |
| `hardware transcoding unavailable … {"reason":"ffmpeg is not usable in the container"}` | ffmpeg is genuinely missing from the image → `docker compose build --no-cache && docker compose up -d` |
| `vainfo failed with iHD … init failed` / `iHD cannot encode on this box` | Expected on Apollo Lake. Leave `LIBVA_DRIVER_NAME` empty so the app pins i965, or set `LIBVA_DRIVER_NAME=i965` in `.env` |
| `no vaapi encode pipeline worked — using software encoding` | The container sees `/dev/dri` but no driver encodes: check the device permissions (Section 2) and run `sh scripts/doctor.sh` |
| `/dev/dri device: missing` in the UI while the NAS has it | The compose `devices:` mapping did not apply to the running container: `docker compose up -d --force-recreate` |
| Emoji/CP1252 subtitles show as `Ã©` | The app converts to UTF-8 on download; if a file still looks wrong, re-download with the *force UTF-8* switch |
| Subtitles never appear on the Duo2, although a subtitle is attached | Read the relay's own verdict in the log first — it now names the reason: `not in this MPEG-TS output` (text `.srt` cannot become DVB bitmaps — use the `.mkv` URL or burn in), `an FFmpeg template drops it` (the template bound to the `enigma2`/`vlcMkv` output has `-sn`), `burn-in was requested … but this output runs an FFmpeg template` (unbind the template for that output). The box side: service **5002** (exteplayer3) renders embedded text tracks but exposes no subtitle menu entry, Enigma2 **4097** lists the track in the subtitle menu (gstplayer **5001** needs ServiceApp's *embedded subtitles* switch), and DVB bitmap subtitles need service type **1**. Last resort: switch the item to *burn into the picture* — that shows on every player |
| Bouquet push fails | The app falls back to FTP/SCP; check `ENIGMA2_FTP=true` and that FTP is enabled on the box. WebIF's upload endpoint is disabled on some images |
| Container restarts in a loop | `docker compose logs vu-movie` — the first lines name the missing piece (usually the database, if you set `REQUIRE_DB=true`) |
| UI reachable but "database: memory" | Postgres is not up; the app still works but forgets streams on restart. `docker compose ps` and check the `db` healthcheck |
| `WARN db slow query {"ms":759,…}` right after a start | The first read of a table comes off cold volumes and an empty Postgres cache — the same cold start that makes `ffmpeg -version` take ~20 s on a sleeping NAS. One slow query after a restart is expected and drops to single-digit ms once warm; the bar is `DB_SLOW_QUERY_MS` (default 1500 ms) and the line now reports the row count. Investigate only if it repeats on **every** load: compare the query in the log with the indexes in `migrations/0001_init.sql` |
| *Run test* in the Transcode/Test tab shows no output, or the tab becomes unresponsive | Fixed: a template ending in `pipe:1` writes the **movie**, not a log, to stdout — the test used to forward those bytes as thousands of text lines (an 8 s run produced 6,036 events / 2.7 MB). Now binary stdout is counted, not printed (`# this template writes the finished stream to stdout (pipe:1) …`), stdout text is capped at 64 KB, and the panel keeps 400 lines rendered from one coalesced write. The verdict also reports the bytes the command wrote to `<output>`, so a file-writing template no longer reads as "no bytes reached the output" |
| `WARN config … uses flat dotted key(s)`, `ignoring flat key(s)`, or `unknown option(s)` | `/config/vumovie.json` contains hand-written `"a.b"` keys. JSON has no dotted paths, so they are folded into the nested objects (or, when the nested value already exists, ignored — the nested value wins) and named in the log. Edit the nested object instead, or save once from the Settings page, which rewrites the file in the correct shape |

For the outbound scraper check, run these on the NAS from the folder with
`docker-compose.yml`. A DNS result proves name lookup; `curl` should show
`Connected` and a TLS/HTTP response (even an HTTP 403/404 proves the socket and
TLS connection worked):

```bash
docker compose exec vu-movie node --input-type=module -e "import dns from 'node:dns/promises'; for (const host of ['overlook.cx','api6.aoneroom.com']) console.log(host, await dns.lookup(host).catch(e => e.code + ': ' + e.message))"
docker compose exec vu-movie curl -sSv --connect-timeout 8 -o /dev/null https://overlook.cx/
docker compose exec vu-movie curl -sSv --connect-timeout 8 -o /dev/null https://api6.aoneroom.com/
```

If these fail in the container but equivalent `curl` commands work on the NAS
host, inspect Docker's outbound network/DNS or any NAS firewall/proxy rules. If
only one host fails, it may be provider-side availability or a provider-specific
block. Newer scraper logs include nested `fetch failed` causes to distinguish
DNS, refused connections, TLS, and timeouts.

The hardware capability is cached in `data/config/hwaccel.json`. A *negative*
entry is ignored on purpose (so a transient problem can never disable
transcoding permanently); if you want to force a fresh probe anyway, press
**re-test hardware** in the UI, or delete the file and restart.

Log level: `.env` → `LOG_LEVEL=debug`, then `docker compose up -d`. The UI's Logs
page streams the same entries live, so you rarely need `docker logs`.

---

### Proving the solver actually solves (not just answers /health)

`/health` only says the process is alive. The real test is one challenge page through its API —
run this **inside the vu-movie container** (from the NAS: `docker compose exec vu-movie sh -c '…'`):

```bash
curl -sS -m 90 -X POST http://flaresolverr:8192/v1 \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"request.get","url":"https://cinevo.nl/search?q=dune","maxTimeout":60000}' \
  | head -c 400
```

* `"status":"ok"` with a large `solution.response` containing the site's HTML → the solver works;
  vu-movie will use it on the next challenged search (log: `trying FlareSolverr for …`).
* `"status":"error"` mentioning the browser or a timeout → its Chromium cannot solve this page
  (raise `FLARESOLVERR_TIMEOUT_MS`, or check `docker compose logs flaresolverr`).
* connection refused / no route → the name or port is wrong for *this* container: fix
  `FLARESOLVERR_URL` (container-to-container, not the published NAS port).
* If you use the published port from the NAS instead: `http://<nas-ip>:8193/health`.

Confirm the basics first:

```bash
getent hosts flaresolverr        # must print the solver container's IP
curl -sS -m 10 http://flaresolverr:8192/health; echo
```

---

## 7. Updating

```bash
cd /volume1/docker/vu-movie
git pull                      # or copy the new folder over
docker compose up -d --build  # migrations run automatically at startup
```

`data/` and the database volume are untouched by an image rebuild.
