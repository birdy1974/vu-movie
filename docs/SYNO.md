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
* **Subtitles**: search NL/EN, attach to the stream (muxed for the VLC/MKV path or
  served as a sidecar `.srt`), or push the `.srt` to `/media/hdd/movie/vumovie` on
  the box. Filename must match the recording name for Enigma2 to auto-load it —
  the app names it after the stream title.
* **Download**: `Download` runs an ffmpeg copy job into `data/downloads` with
  progress in the job list; the resulting `.mkv` plays anywhere.

VLC tips: if playback stutters, lower the video bitrate in the profile before
creating the stream (or append `?bw=1200` to a play URL); the relay restarts with
the new profile on the next request.

---

## 6. Troubleshooting

| Symptom | Where to look |
|---|---|
| "no media found" while scraping | Logs page → filter `browser`. FlareSolverr starts with the project, listens on container port `8192`, and is published on NAS port `8193` by default (`FLARESOLVERR_HOST_PORT`); inspect it with `docker compose logs -f flaresolverr`. Challenged searches retry through its API; outbound DNS/network failures still need to be fixed separately. |
| Resolve ends with zero candidates; browser reports `ERR_CONNECTION_REFUSED` and MovieBox reports `fetch failed` | These are outbound HTTPS failures from the app container, separate from Enigma2 reachability. Check DNS and HTTPS from inside `vu-movie` using the commands below; if both providers fail, check NAS/Docker egress, DNS, firewall, or proxy configuration. A reachable FlareSolverr container does not by itself provide a general proxy. |
| Stream plays but stops after a while | `relay` logs: most upstream URLs expire. Increase `TOKEN_TTL_MINUTES`, or use *Transcode* so the app owns the connection and re-fetches |
| VLC shows a black screen | Copy the ffmpeg command from the Stream page and run it inside the container: `docker compose exec vu-movie sh -c '<command> > /tmp/x.ts'` — the error message is always in the last lines |
| `permission denied /dev/dri/renderD128` | Section 2 above |
| `ERROR hwaccel /usr/bin/ffmpeg not available … {"error":"spawnSync /usr/bin/ffmpeg ETIMEDOUT"}` | That was the app timing out its own `ffmpeg -version` probe on a cold/busy volume and then caching "ffmpeg missing" for a week — fixed: the ceiling is 30 s (`FFMPEG_PROBE_TIMEOUT_MS`), a timeout is reported as a timeout, failed checks are retried in the background, and a negative result is never reused. Nothing to do; if it persists, run `sh scripts/doctor.sh` |
| `hardware transcoding unavailable … {"reason":"ffmpeg is not usable in the container"}` | ffmpeg is genuinely missing from the image → `docker compose build --no-cache && docker compose up -d` |
| `vainfo failed with iHD … init failed` / `iHD cannot encode on this box` | Expected on Apollo Lake. Leave `LIBVA_DRIVER_NAME` empty so the app pins i965, or set `LIBVA_DRIVER_NAME=i965` in `.env` |
| `no vaapi encode pipeline worked — using software encoding` | The container sees `/dev/dri` but no driver encodes: check the device permissions (Section 2) and run `sh scripts/doctor.sh` |
| `/dev/dri device: missing` in the UI while the NAS has it | The compose `devices:` mapping did not apply to the running container: `docker compose up -d --force-recreate` |
| Emoji/CP1252 subtitles show as `Ã©` | The app converts to UTF-8 on download; if a file still looks wrong, re-download with the *force UTF-8* switch |
| Bouquet push fails | The app falls back to FTP/SCP; check `ENIGMA2_FTP=true` and that FTP is enabled on the box. WebIF's upload endpoint is disabled on some images |
| Container restarts in a loop | `docker compose logs vu-movie` — the first lines name the missing piece (usually the database, if you set `REQUIRE_DB=true`) |
| UI reachable but "database: memory" | Postgres is not up; the app still works but forgets streams on restart. `docker compose ps` and check the `db` healthcheck |

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

## 7. Updating

```bash
cd /volume1/docker/vu-movie
git pull                      # or copy the new folder over
docker compose up -d --build  # migrations run automatically at startup
```

`data/` and the database volume are untouched by an image rebuild.
