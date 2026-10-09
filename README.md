# vu-movie

**Turn a movie/series streaming page into one file VLC can play — and publish it to your VU+ Duo2.**

`vu-movie` runs on a Synology DS918+ (or any Docker host) and does three things:

1. **Scrapes** a stream from a supported site — either by searching the site for a
   title, or by pasting the page/player URL — and merges the chunks into **one
   continuous stream** that VLC, a browser, or the Duo2 can play directly.
   CDNs that end a chunked transfer after a few minutes can't cut the movie
   short: the relay pulls the source itself in small ranged requests (the
   MovieBox-TUI mechanism — headers replayed on every request, every request
   retried, DASH segments cached) and feeds ffmpeg locally (`UPSTREAM_PROXY`).
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
vi .env                      # set ENIGMA2_HOST + ENIGMA2_PASSWORD; keep ENIGMA2_FTP=true

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
* Built-in browser recipes for `overlook.cx`, `cinevo.nl`, `cinejoy.pk`,
  `flixhub.studio`, `redflix.club`, `1flex.org`, `cinezo.st`, `flixer.gd`,
  `flixer.su`, `vidbox.vc`, `nunflix.cx`, `moviewiser.com`, `purehd.cc`,
  `fmovieshd.one`, `filmween.net`, `pc.netmovie.site`, `1tube.org` and
  `nippleflix.org` (18 recipes total). Flixer.gd and Flixer.su remain separate
  entries because an exact shared redirect destination could not be verified.
  The source selector is available on Mobile and Search; direct site links are
  also in Mobile, Search → Open a source and Dashboard. A small external-link
  control beside each Search/Mobile source chip opens that source's homepage.
  Custom recipes can
  be added in Settings → Sources. **MovieBox** uses its own signed REST client (the
  same protocol the [MovieBox-TUI](https://github.com/mesamirh/MovieBox-TUI) reference client speaks;
  see [docs/MOVIEBOX-TUI-COMPARISON.md](docs/MOVIEBOX-TUI-COMPARISON.md) for a
  line-by-line comparison of how both apps select a title versus how they fetch and
  play it). When the `api*.aoneroom.com` edge is filtered and no host answers at
  all, the same search is retried on MovieBox's **web** backend
  (`/wefeed-h5api-bff` on `h5-api.aoneroom.com` and the public site mirrors) —
  different hosts, so it survives blocks that target the mobile API
  (`MOVIEBOX_TRANSPORT=auto|h5|mobile`, see §6 of that document).
* Search pages are treated as live documents, not static HTML: the browser layer
  waits for the **result cards** instead of guessing with `networkidle` (the flixer
  clones ship an empty shell and fetch their results over XHR), and a site that
  fires an ad pop-under (1flex redirects its own tab to `youtube.com`) has the
  redirect blocked and the search retried once in a fresh tab. A source that still
  comes back empty says *why* — in the log line and in the UI's error row: how many
  links the page exposed, how long we waited, and a sample of the links the recipe
  pattern rejected. Per-source waits live in the recipe (`search.waitMs`), the
  global budget in `SEARCH_WAIT_MS`.
* Result cards show available release year, rating, genres and runtime; the
  selected-title panel adds the synopsis, release date and language when a source
  provides them. Missing fields can be filled from an exact title/year/type match
  from another source.
* The result list says what it does: one card per title, one chip per provider.
  Clicking the **card** resolves the formats of *every* provider on it; clicking a
  **provider chip** (in the card, in the Selected-title panel — where “all
  providers” goes back to the whole card — or on the Mobile tab) resolves only
  that source, so a missing quality is never mistaken for “the source has
  nothing else”. Four filters narrow the list and nothing else: the free-text
  **Title filter**, **Filter found title** (one exact title), **Provider** and
  **Kind** (*All / movie / series*) — none of them selects or resolves a title.
  Starting a search drops the
  previous answer — cards, counts, filters, the selected title and its formats —
  before the request goes out and shows what is running, so a fan-out that takes
  half a minute cannot look like it answered with the old titles (the Mobile
  tab's panes do the same).
* Candidates are **probed with ffprobe**, ranked by resolution/codec/bitrate and
  deduplicated, so you choose a stream instead of a URL soup. Broken mirrors are
  marked, not offered.
* Every result card (Search and Mobile) has a **▶ preview** button: it races the
  title's providers, takes the best playable format of the first one that answers
  (S1E1 for a series), and plays it in the preview web player — without adding
  anything to the playlist. The backing stream is ephemeral: deleted when the
  player closes, swept after 60 minutes if the browser is closed mid-preview.
* **Series get a season/episode picker.** Below the selected title, one card per
  season offers every episode as a checkbox (with per-season and
  all-seasons toggles); the season list comes from MovieBox when the title has
  it, else from TMDB (needs the key below), else from manual season/episode
  numbers. Formats resolve **on demand per episode** — expanding an episode
  group fetches it, “load selected” fetches the ticked ones — and a
  **quality-coverage matrix** combines everything loaded into one row per
  quality (episodes covered, providers, bulk “add all in 1080p”). Movies keep
  the flat format list. The Mobile tab shows the same season cards, matrix and
  episode groups for a series (with its provider-scope chips). Played episodes
  are added as `Title S01E02` items with their season/episode stored on the
  stream (bouquet separators included).
* **Discover titles** opens a Trending now / Top 10 / For you popup on Search
  and Mobile. Picking a title runs the normal source search. The first two lists
  use TMDB; For you uses every playlist-add event as its recommendation signal,
  retaining removed/deleted titles and never consulting playback history. Add a
  free TMDB API key in **Settings → Metadata** to enable the lists.

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
* **Pause and resume**: a player that stops reading (a paused VLC) holds the
  source instead of being dropped, so the movie continues from the same point.
  When the last player leaves, the session is kept for `PAUSE_KEEP_SECONDS`
  (900 s). A session that ends without anyone choosing it (the idle stop) keeps
  its play head for `RESUME_HOURS` (12 h), and the next play of that movie
  resumes there. A player that never reads again is dropped after
  `CLIENT_STALL_SECONDS` (1800 s). When a player comes back after another one
  left, the movie restarts 10 s earlier: the data the relay had sent but the
  player had not shown yet is lost with the connection, so it is sent again
  rather than skipped.
* **Enigma2 box (receiver)**: the box's bouquet URL (`…/<title>.ts.enigma2`) is
  handled differently. Pausing the box keeps its connection open, so the movie
  continues from the same point. Leaving the movie (zapping away, or stopping the
  stream on the box) closes that connection: the movie stops at once, nothing is
  kept, and the next play starts at the beginning. A box that the relay drops for
  stalling after a long pause keeps its place, like any pause. If another player
  is still watching the same movie, the movie keeps running for it, a box that
  comes back joins it where it is, and the movie is not kept for the box once
  that player leaves too. VLC, browser and Xtream players keep the pause window
  and resume memory described above.
* **Seeking**: a progressive file's `direct` link (`/s/<token>/direct`) seeks in
  VLC. For a file that needs no headers it redirects to the CDN; for one that
  needs a signed cookie or referer, the relay serves it with Range support. The
  `.ts` relay output is a live stream and cannot seek. The VLC playlist
  (`/pl/<token>/vlc.m3u`) therefore has a second, `(seekable)` entry for each
  file movie, next to the `.ts` entry.
* **Paced at 1×** (ffmpeg `-re`, on by default for live outputs): the relay
  hands the stream to the player at the source's native rate instead of reading
  the upstream as fast as it can be served. Clients are real-time players that
  drain ~1–3 MB/s, so bursting a 2-hour movie at 50× only fills their socket
  buffer. A player that stops reading holds the source instead of being
  dropped (see *Pause and resume* below). Downloads (`/dl/…`) and
  template test runs stay unpaced. Switch: `REALTIME_PLAYBACK=false` or
  `transcode.realtime` in `/config/vumovie.json`; a single stream can opt out
  with `"realtime": false` in its profile.

### Complete playlist and Xtream IPTV output

The **Stream** tab exposes both the Xtream `player_api.php` server URL and the
**complete M3U+ playlist** (`get.php?type=m3u_plus`). Both are built from the
Playlist tab: every **enabled** item is included in playlist order; disabled
items stay out of all public outputs. The Xtream API also advertises enabled
movies as VOD and groups enabled series episodes by season. Each catalogue item
has a token-protected Xtream playback URL that relays through vu-movie rather
than exposing the upstream source. Use the displayed username/password in
TiviMate, IPTV Smarters or another Xtream-compatible player; the playlist token
remains part of the server URL.

The account itself is set in **Settings → Xtream Codes** (or with
`XTREAM_USERNAME` / `XTREAM_PASSWORD`, which win over a saved value). The
password may be left empty: the playlist token then doubles as the password,
which is the default. Values that cannot travel inside a playback URL — a
space, `/`, `?`, `#`, `%`, `&` — are refused on save, because an IPTV app would
store a link it cannot fetch. Changing the account invalidates the links already
saved in your IPTV app; the Stream tab always shows the current credentials.

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
| TVsubtitles.net | scrape (series only) | no |
| TVsubs.net | scrape (series only), ZIP archives | no |
| SubDL | REST API | free key, 2000 req/day |
| OpenSubtitles.com | REST API | free key, 5–20 downloads/day |
| Addic7ed | scrape (series only) | free account (`ADDIC7ED_USER`/`ADDIC7ED_PASS`) — anonymous downloads are throttled to nothing |
| *your own* | template (URL + regex), added in the UI | — |

Of the six sites in the requirements, **JustSubtitles.com has no dedicated
provider**: its search and downloads run entirely in page JavaScript against a
Cloudflare-fronted API, so there is no server-side endpoint to scrape. Use a
custom template if you have one, or any of the providers above.

Search, preview the cues, **shift the timing** (+/− ms), download the `.srt`, or
push it to the receiver (`/media/hdd/movie/vumovie`, configurable) so the Duo2
picks it up next to the recording.

### Getting a subtitle onto the Duo2 (4097 / 5001 / 5002)
The receiver reads subtitles out of the *stream*, so which container you play
decides whether it can show them at all. Per playlist item, **▤ subtitle → How
the box gets it** picks the mode:

| Mode | NAS cost | What happens | Plays on |
|---|---|---|---|
| **copy the .srt to the box** | **none** — no encode, no mux | uploads the `.srt` to the receiver directory (FTP, or a copy into a mounted share), named after the movie | Enigma2/EMC/MediaPlayer auto-load it next to a recording of the same name (e.g. a timer recording of the bouquet entry). It does not appear while zapping a live stream |
| **soft track** (default) | none — container remux only | a real `subrip` track inside the Matroska `.mkv` (`.srt` attached via the Playlist tab), flagged `default` with its language tag | VLC/Kodi, and Enigma2 **4097** (the track appears in the subtitle menu). gstplayer **5001** shows it when ServiceApp's *embedded subtitles* switch is on. exteplayer3 **5002** plays embedded text tracks itself, but Enigma2's subtitle menu stays empty (external players do not publish their track list) — the `default` flag is what makes it show without pressing anything |
| **burn into the picture** | an encode (VAAPI on the DS918+, libx264 otherwise) | `subtitles=filename=…` filter spliced into the video chain | every player, including service type **1** (DVB) and a 5002 box whose player ignores soft tracks. Cannot be switched off during playback |
| **off** | nothing (the `.srt` stays on the NAS) | — |

Two hard limits worth knowing:

* **MPEG-TS/HLS cannot carry a text subtitle.** ffmpeg refuses to convert text
  to the DVB bitmaps those containers need ("Subtitle encoding currently only
  possible from text to text or bitmap to bitmap"). The relay therefore leaves
  an attached `.srt` out of `.ts` output instead of dying on it, and says so in
  the log — use the `.mkv` URL or burn in. *Transcode → template → Subtitles =
  DVB bitmap* only works when the **source** already carries DVB/PGS subtitles
  (`-c:s copy`).
* **Burn-in is rendered by the guided profile builder.** If an FFmpeg template
  is bound to the output the box plays (`enigma2`, `vlcMkv`, or the global
  default), that template owns the filter chain and no subtitle is burned in —
  unbind it for that output or use the soft track. The relay logs both cases
  (`the subtitle nld attached to this item is not in this Matroska output …`).

The relay logs one line per session when it muxes an attached subtitle and a
warning when it cannot, so "the box shows nothing" is answerable from the Logs
page instead of from guesswork.

### Enigma2 bouquet
* Generates `userbouquet.<name>.tv` with `#SERVICE 4097:…` entries (GStreamer
  service type, so no tuner is used), `#DESCRIPTION` lines, and per-season
  separators for series.
* Writes bouquet files over **FTP** (OpenWebif has no portable file-upload API),
  using a temporary file + same-directory rename. Before changing `bouquets.tv`
  it saves one restore point and patches the existing index without removing
  satellite/favourites bouquets.
* Uses **OpenWebif only to reload** the bouquet list (`mode=2`) and verify the
  services. The receiver's FTP service must be enabled and able to write to
  `/etc/enigma2` (normally the root login on port 21). FTP is plaintext, so keep
  it on a trusted LAN. FTP is enabled by default for fresh installs; after
  upgrading an older config, enable **Settings →
  Enigma2 → use FTP for bouquet/subtitle files**.
* Preview the exact file in the UI before anything is uploaded.

### Operations
* **Jobs** for every long action, with progress, logs and a cancel button
  (cancelling kills the underlying Chromium/ffmpeg process).
* **Playlist availability and recovery:** the Playlist tab's **Check streams**
  action probes each upstream with ffprobe and reports **working**, **not
  working**, **token expired**, **unverified** or **skipped**. Broken/expired
  items are automatically re-resolved: vu-movie searches the current provider
  first, then other enabled providers for the same title/year/type. A successful
  candidate replaces the saved upstream URL, headers and probe in place; the
  stable stream id/token and every existing output URL remain unchanged. Rows
  identify auto-refreshed items and update their source/quality. The scheduled
  check runs every six hours by default (first pass shortly after startup), and
  playback, download and relay-session starts perform an availability check
  before using an upstream. If recovery fails, playback returns an actionable
  503 instead of starting ffmpeg against a known-dead link. Set **Settings →
  Playlist availability** or `PLAYLIST_AUTO_CHECK`,
  `PLAYLIST_CHECK_INTERVAL_MINUTES` (15–10080) and `PLAYLIST_AUTO_REPAIR` to
  adjust it. API: `POST /api/playlist/check` accepts optional
  `{ "streamIds": ["…"], "autoRepair": false }`; omit `streamIds` to check the
  whole list. `GET /api/playlist/check/schedule` reports schedule state.
* **Live log view** in the UI (`/api/events`, SSE) with level/component filters —
  made for "why is this film not playing" debugging.
* **Detailed, levelled, component-tagged logging** in the container log too
  (`docker logs -f vu-movie`), including the full ffmpeg command for every stream.
* Postgres (with migrations) or **in-memory mode** when no database is reachable —
  the app degrades instead of refusing to start, and `REQUIRE_DB=true` flips that
  to a hard failure if you prefer.
* **"Nothing resolved — why?" answered in one line.** When a resolve ends with zero
  candidates the app probes a control host and compares the container's DNS answers
  with public resolvers, then reports a verdict: `no-egress`, `tls-intercepted`
  (a proxy re-signing TLS), `dns-filtered`, `tls-or-ip-block` (SNI/JA3 filtering) or
  `service-unreachable`. Set `DIAGNOSE_ON_FAILURE=false` to skip the ~4 s probe.

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

### Per-output transcode templates

The **Transcode templates** tab holds a library of named FFmpeg commands. Each
template can be assigned to one of the seven output slots independently, so a
single title can hand out a 1080p HEVC pass-through to VLC, a 720p H.264
re-encode to the VU+ Duo2, an HLS playlist to the browser, and a passthrough
Matroska to the download button — all from the same upstream. The relay picks
the right template per request URL:

| Slot           | URL                                | Typical use                              |
| -------------- | ---------------------------------- | ---------------------------------------- |
| `vlcTs`        | `/s/{token}/{slug}.ts`             | Desktop VLC / generic TS player          |
| `vlcMkv`       | `/s/{token}/{slug}.mkv`            | Desktop VLC, MKV                         |
| `m3u8`         | `/s/{token}/{slug}.m3u8`           | Browser HLS                              |
| `m3u`          | `/s/{token}/{slug}.m3u`            | M3U playlist                             |
| `enigma2`      | `/s/{token}/{slug}.ts.enigma2`     | VU+ Duo2 (bouquet service-ref)           |
| `direct`       | `/s/{token}/direct`                | 302 to the upstream URL when safe        |
| `download`     | `/dl/{token}/{slug}.{ext}`         | Saved-to-disk copy                       |

A stream can also override any individual slot from the Stream tab
("FFmpeg template per output") without changing the others. The bouquet builder
writes `.ts.enigma2` URLs (not a query parameter) because `encodeE2Url` strips
the query string when it builds the service reference — a 720p H.264 template
bound to the `enigma2` slot is what actually runs on the Duo2.

The **browser preview is an eighth output** (`web`, URL `/s/{token}/{slug}.ts.web`).
It is the one slot no template can be assigned to — see below.

#### The web preview (the browser player)

The ▶ **preview** button in the Playlist tab (and the `/watch/{token}` page) does
not play an FFmpeg template's output. The player is
[mpegts.js](https://github.com/xqq/mpegts.js): it transmuxes MPEG-TS into
fragmented MP4 and feeds that to Media Source Extensions, so what can be played
is decided by **the browser in front of the stream** — not by VLC, not by the
Duo2, and not by the template the item carries.

Before playback starts the page asks its own browser what it can decode
(`MediaSource.isTypeSupported` over H.264/HEVC/AV1/VP9 and
AAC/AC-3/E-AC-3/Opus/MP3) and hands that report to the relay as a query string —
a query, because a plain `<video src>` fallback can carry it too:

```
/s/{token}/{slug}.ts.web?codecs=1&vcodecs=avc1,hvc1&acodecs=mp4a,ac-3
```

The relay answers with a session that

* **drops every subtitle** — no sidecar `.srt`, no source track, no
  `-c:s dvbsub`: the command always carries `-sn -dn`. A text track cannot be
  muxed into TS at all, a DVB bitmap track makes the browser transmuxer fail, and
  the preview player has no subtitle UI;
* **ignores the item's and the global templates** for every other slot (they are
  written for the receiver — DVB subtitles, HEVC, AC-3). The guided profile
  builder runs instead, so the item's resolution cap and bitrates still apply;
* **copies what the browser can play and re-encodes the rest**: H.264 video plus
  a supported audio track is a plain remux (no CPU at all), anything else becomes
  H.264 + AAC (VAAPI when the NAS has it, libx264 otherwise). HEVC/AV1/VP9 always
  transcode, even in a browser whose MediaSource claims support, because
  mpegts.js only transmuxes H.264 reliably.

The modal prints the verdict under the video — `playing — web preview: transcode
hevc → h264 + transcode eac3 → aac, subtitles dropped (… support)` — together
with the exact preview URL, so a surprise transcode is explained in the player
instead of in the log. `GET /api/streams/{id}` returns the same as
`session.webDecisions` (`{ copy, reported, video: { source, family, supported,
action }, audio: { … }, subtitles: 'dropped', reasons }`).

Subtitles therefore never show in the web preview, by design, and the relay says
so once per session (`web preview profile for stream …: … subtitles dropped`).
The `.ts`/`.mkv` URLs are unaffected: the same modal's **open in VLC** plays the
`.ts` URL with the item's template and its subtitle track, and *Watch in browser*
in the URLs panel shows the preview URL for a bug report.

#### Building the command from fields

The template editor is not just a text area: it carries the same structured
parameter set as the sibling project
[stalker-proxy-manager](https://github.com/birdy1974/stalker-proxy-manager), so
a template can be assembled from dropdowns instead of memory. Every control
rewrites the command live, and editing the command by hand fills the controls
back in — an old hand-written template opens editable:

| Group | Parameters |
| ----- | ---------- |
| Video | `hw_accel` (none/VAAPI/QSV), `device`, `resolution` (source, 360p–4320p, `WIDTHxHEIGHT`, `900p`), `aspect`, `video_codec`, `vf_preset` (17 deinterlace / diagnostics filters) |
| Rate control & VAAPI tuning | `video_bitrate`, `maxrate`, `bufsize`, `fps`, `gop`, `profile`, `level`, `rc_mode` (AUTO/CQP/CBR/VBR/ICQ/QVBR/AVBR), `global_quality`, `low_power`, `async_depth` |
| Audio | `audio_codec`, `audio_bitrate`, `audio_channels`, `audio_rate` |
| Subtitles | `subs` (drop / DVB bitmap — copies the source's own DVB/PGS bitmaps into TS / copy all — Matroska only) |
| Output | `output_format` (mpegts / matroska / hls — the template's container) |
| Extra | `extra_input`, `extra_output` raw flag boxes |
| Advanced | one row per flag: `-rw_timeout`, `-reconnect*`, `-probesize`, `-analyzeduration`, `-thread_queue_size`, `-fflags`, `-err_detect`, `-user_agent`, `-referer`, `-preset`, `-crf`, `-tune`, `-threads`, `-fps_mode`, `-max_muxing_queue_size`, `-muxdelay`, `-flush_packets`, `-mpegts_flags`, `-hls_time`, `-hls_init_time`, `-hls_list_size`, `-hls_flags`, `-live`, `-metadata`, `-bsf:v`, or any custom flag with its own value |

The fields are stored next to the command they produced, and the server renders
the command from them, so what the editor shows is exactly what the relay runs.
A disabled template ("Available for playback" off) stays in the library but is
never picked for an output — every lookup falls through to the next binding.

Two pure endpoints back the editor (and are handy from `curl`):

```bash
# fields → command
curl -s localhost:8080/api/ffmpeg/templates/build -H 'content-type: application/json' \
  -d '{"container":"mpegts","options":{"video_codec":"h264_vaapi","hw_accel":"vaapi","resolution":"720p","video_bitrate":"4000k"}}'
# command → fields
curl -s localhost:8080/api/ffmpeg/templates/parse -H 'content-type: application/json' \
  -d '{"command":"ffmpeg -i <url> -vf scale=640:360 -c:v libx264 -c:a aac -f mpegts pipe:1"}'
```

`GET /api/ffmpeg/templates` returns the parameter `schema` as well, which is
what the browser draws the form from — the field list lives in exactly one
place (`src/core/ffmpeg-options.js`).

Hand-editing `/config/vumovie.json`? A template record looks like this — the
`options` object is the same parameter set the editor shows, and the stored
`command` is re-rendered from it on the next save:

```jsonc
"transcode": {
  "ffmpegTemplates": [
    {
      "id": "vaapi-720",
      "name": "VAAPI 720p H.264",
      "container": "mpegts",
      "description": "what the VU+ Duo2 gets",
      "enabled": true,
      "output": { "enigma2": "vaapi-720" },
      "options": {
        "hw_accel": "vaapi", "device": "/dev/dri/renderD128", "resolution": "720p",
        "aspect": "16:9", "video_codec": "h264_vaapi", "video_bitrate": "4000k",
        "maxrate": "4400k", "bufsize": "8000k", "fps": "25", "gop": "50",
        "profile": "high", "level": "4.0", "rc_mode": "VBR", "low_power": true,
        "async_depth": "4", "audio_codec": "ac3", "audio_bitrate": "384k",
        "audio_channels": "2", "subs": "dvb", "output_format": "mpegts",
        "advanced": [{ "flag": "-rw_timeout", "value": "10000000", "side": "input" }]
      },
      "command": "ffmpeg … -f mpegts pipe:1"
    }
  ],
  "defaultFfmpegTemplateId": "vaapi-720",
  "ffmpegDefaults": { "vlcTs": "vaapi-720", "enigma2": "vaapi-720" }
}
```

---

## Configuration

Precedence: **environment** (`.env` / compose) → `/config/vumovie.json` (written by
the Settings page) → built-in defaults. Everything can be changed in the UI; the
docs for each knob are in [.env.example](.env.example) and
[config/vumovie.example.json](config/vumovie.example.json).

### Editing `/config/vumovie.json` by hand

* **Options are nested, never dotted.** Write
  `"scraper": { "flaresolverrUrl": "http://flaresolverr:8192" }` — not
  `"scraper.flaresolverrUrl": "…"`. JSON has no dotted paths and nothing reads a
  flat `"a.b"` key, so the dotted spelling was silently ignored (and, worse,
  unmasked: `publicConfig()` masks secrets by path, so a flat `"db.url"` printed
  the Postgres password in the log banner). Such keys are now folded into the
  nested objects when that spot is empty, kept out when it is already set, and
  **named in a warning at boot** either way; unknown keys are dropped with a
  warning too. Saving from the Settings page rewrites the file in the correct
  shape, so the warning disappears after the first save.
* **Only ask for a URL where a URL belongs.** A copied example line kept as the
  *value* (e.g. `"flaresolverrUrl": "# e.g. http://flaresolverr:8191 (profile: cf)"`)
  is not a URL; the app reports it as *"the configured FlareSolverr URL is a
  comment, not a URL"* instead of pretending the variable is unset.
* **Types are forgiving.** `"8080"` / `"true"` in a hand-edited file are coerced
  to the type the option's default has, so they cannot end up compared or added
  as strings.
* A broken file never stops the container: it is logged and defaults + env win.

The ones that matter most on a DS918+:

| Variable | Default | Why |
|---|---|---|
| `TRANSCODE_MODE` | `auto` | `copy` never encodes; `vaapi` forces hardware encode |
| `ALWAYS_TRANSCODE` | `false` | `true` re-encodes even a perfect source |
| `MAX_CONCURRENT_TRANSCODES` | `1` | the J3455 cannot do two 1080p encodes |
| `DEFAULT_RESOLUTION` / `DEFAULT_VIDEO_BITRATE` | `1080` / `8000` | the requested 1080p H.264 VAAPI target is 8 Mbit/s |
| `DEFAULT_AUDIO_BITRATE` / `DEFAULT_AUDIO_CHANNELS` | `192` / `6` | AAC audio target from the supplied MPEG-TS command |
| `DEFAULT_FPS` | `25` | fixed output rate for the requested live-transcode profile |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | passed through by `docker-compose.yml` |
| `BROWSER_CONCURRENCY` | `1` | one headless Chromium is ~300 MB |
| `SEARCH_WAIT_MS` | `12000` | how long a search page may take to render its result cards (recipes can override it per source with `search.waitMs`); the search stops as soon as the cards stop growing |
| `DB_SLOW_QUERY_MS` | `1500` | warns when one query is slower; the first read after a start is cold-disk I/O, not a database fault |
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
* `docker-compose.yml` — the app, `postgres:16-alpine`, and an always-started
  FlareSolverr service. Its API listens on port `8192` inside the container and
  is published on NAS port `8193` by default (`FLARESOLVERR_HOST_PORT` in
  `.env`); containers on the Compose network
  use `http://flaresolverr:8192`. Browser searches that hit a Cloudflare/security
  challenge automatically retry through the configured `FLARESOLVERR_URL`; the
  solved page is parsed as static HTML and its cookies are imported into that
  site's browser context. Do not forward this unauthenticated API to the public
  Internet.
  If `FLARESOLVERR_URL` is empty or malformed, vu-movie says so at startup and
  in `GET /api/health` (`flaresolverr`: configured / reachable / version / hint)
  instead of only complaining on the first Cloudflare page.
  It is a **sidecar, not a dependency**: the app starts without it (only
  Cloudflare-protected sources degrade, with a "FlareSolverr is not reachable"
  log line). The service runs with `shm_size: 512m` and a 1.2 GB memory limit
  because Chromium cannot start in Docker's 64 MB `/dev/shm` default — the
  symptom when it can't is `Error getting browser User-Agent … Read timed out`
  and a container that restart-loops. `sh scripts/doctor.sh` section 6 checks
  all of that (restart count, `/dev/shm` size, reachable API) for you; to pin a
  known-good image set `FLARESOLVERR_IMAGE=flaresolverr/flaresolverr:v3.3.21`.
* Health: `GET /api/health` (also wired into the container healthcheck).
  The receiver is **not** contacted by this endpoint — it reports the last known
  state only. The container healthcheck (every 30 s) and the dashboard (every
  15 s) both read `/api/health`, and a VU+ should not be woken up that often for
  a value that changes roughly never. The box is checked on demand
  (`GET /api/enigma2/status`, the *test connection* button) and before every
  bouquet push (FTP is checked first; OpenWebif reachability is advisory because
  it is only used for reload/verification); reachability is logged when it
  **changes**, not per poll.

```bash
docker compose logs -f vu-movie          # structured app logs
docker compose logs -f flaresolverr      # Cloudflare solver logs
docker compose exec vu-movie vainfo      # what the GPU actually supports
docker compose exec vu-movie ffmpeg -hwaccels
```

## Verifying your NAS's hardware after deployment

```bash
sh scripts/doctor.sh                                      # ← start here: one command, every check
docker compose exec vu-movie vainfo                       # driver + codecs
curl -s localhost:8080/api/diagnostics/ffmpeg             # timed report (also a button in the UI)
curl -s localhost:8080/api/health | jq .health.hwaccel    # what the app detected
curl -s "localhost:8080/api/config/hwaccel/test" -X POST  # runs a 2 s VAAPI self-test
```

`scripts/doctor.sh` checks the container, `/dev/dri` on the NAS *and* in the
container, how long `ffmpeg -version` takes, which VA-API driver (iHD/i965)
really encodes, and prints what the app itself reports.

If `vaapi` shows `false`, check `docs/SYNO.md` → *VAAPI permissions*. The app
keeps working either way (software encoding) — unless the log says ffmpeg is
unusable, in which case nothing can be transcoded *or* copied:

| Log line | Meaning | What to do |
|---|---|---|
| `ffmpeg did not answer in time — this is a TIMEOUT, not a missing binary` | the binary exists but a cold/busy NAS volume was too slow for the probe (30 s ceiling, `FFMPEG_PROBE_TIMEOUT_MS`) | nothing: the check is retried automatically and hardware detection re-runs. Never cached as "missing" |
| `ffmpeg is not usable … (ENOENT)` | the binary really is absent from the image | `docker compose build --no-cache && docker compose up -d` |
| `iHD cannot encode on this box — trying the next driver` | normal on a DS918+: iHD installs but does not initialise on Apollo Lake | nothing: the app self-tests i965 and pins it (`LIBVA_DRIVER_NAME` may stay empty) |
| `no vaapi encode pipeline worked — using software encoding` | no driver could encode | `sh scripts/doctor.sh`, then check permissions on `/dev/dri` in `docs/SYNO.md` §2 |

A failed ffmpeg check is **never** written into `/config/hwaccel.json` as the
truth: negative results are re-tested (and ignored on startup), positive ones are
cached for a week.

---

## Development

```bash
npm install          # express + pg + playwright-core only
npm test             # 42 unit tests (ffmpeg args, subtitles, bouquet, MovieBox signing)
npm run check        # node --check on every source file
npm run dev          # nodemon-style watch with debug logging
LOG_LEVEL=debug npm start
```

See [docs/MOVIEBOX-TUI-COMPARISON.md](docs/MOVIEBOX-TUI-COMPARISON.md) for how this
app's title selection and stream fetching compare to the MovieBox-TUI reference client,
and for the failure-verdict table (`no-egress` / `tls-intercepted` / `dns-filtered` /
`tls-or-ip-block`) that tells you which layer is broken when a resolve fails.

Useful endpoints while debugging: `GET /api/health`, `GET /api/logs?level=warn`,
`GET /api/events` (SSE), `POST /api/find/resolve`, `GET /api/streams/:id/command`
(prints the exact ffmpeg command line the relay would run).

### Repo layout

```
src/core/       log, config, db+repo, job queue, media (ffmpeg probing + VAAPI),
                ffmpeg-options (template fields → command → fields)
src/scrapers/   http, headless-Chromium sniffer, recipes, registry, MovieBox client,
                failure diagnostics (DNS/egress/TLS verdicts)
src/streams/    stream store (tokens/URLs), relay (ffmpeg sessions), downloads, M3U
src/subtitles/  7 providers + custom templates, SRT/VTT/encoding tools, receiver push
src/enigma2/    bouquet builder + atomic FTP writes; OpenWebif reload/verification
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
