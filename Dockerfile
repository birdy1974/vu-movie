# syntax=docker/dockerfile:1
#
# vu-movie — Dockerfile for Synology DS918+ (DSM 7 / Container Manager)
# =============================================================================
# Target hardware: Intel Celeron J3455 (Apollo Lake) + Intel HD Graphics 500
#   decode : H.264, HEVC 8/10-bit, VP9, VC-1, MPEG-2   (hardware)
#   encode : **H.264 only**                             (hardware)
#   → realistic job: 4K/HEVC in, 1080p H.264 out, one stream at a time.
#
# What ends up in the image:
#   node 22 (Debian bookworm slim) · ffmpeg · ffprobe · chromium (system) ·
#   intel VA-API drivers (iHD + i965) · vainfo · unzip/7z/unrar (subtitle archives)
#
# Build notes that matter on a NAS:
#   * package-lock.json is committed, so `npm ci` is used. If the lockfile is
#     ever missing, we fall back to `npm install` with a loud warning instead of
#     failing the build (that was one of the explicit requirements).
#   * DATABASE_URL during the build points at 127.0.0.1 on purpose: no build step
#     is ever allowed to reach a database. The app also opens its pool lazily, so
#     `npm ci` can never hang waiting for Postgres.
#   * public/ is copied into the image and verified: an empty/missing public
#     directory is a hard error at build time (a silently broken UI is worse than
#     a failed build), and the runtime also creates it defensively.
#
# Build:  docker build -t vu-movie:1.0.0 .
# Run:    see docker-compose.yml (passes /dev/dri through for transcoding)
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1 — dependencies
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Build-time environment. The dummy DATABASE_URL is deliberate (see header).
ENV NODE_ENV=production \
    DATABASE_URL=postgres://build:build@127.0.0.1:5432/build \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

COPY package.json ./
# The lockfile is optional at build time — see the warning branch below.
COPY package-lock.json* ./

RUN set -eux; \
    if [ -f package-lock.json ]; then \
      echo "[vu-movie] installing dependencies with npm ci (reproducible, lockfile present)"; \
      npm ci --omit=dev --ignore-scripts; \
    else \
      echo "[vu-movie] WARNING: no package-lock.json in the build context — falling back to npm install"; \
      echo "[vu-movie]          generate one with 'npm run lock' and commit it for reproducible builds"; \
      npm install --omit=dev --ignore-scripts; \
    fi; \
    echo "[vu-movie] installed packages:"; \
    node -e "const p=require('./package.json');console.log(Object.keys(p.dependencies||{}).join(', '))"

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="vu-movie" \
      org.opencontainers.image.description="Scrape a movie/series URL into one playable stream (VLC), VAAPI transcode on DS918+, Enigma2 bouquet push for VU+ Duo2" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.licenses="MIT"

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    # --- runtime paths (all overridable in docker-compose.yml) ---
    CONFIG_FILE=/config/vumovie.json \
    DOWNLOADS_DIR=/downloads \
    TMP_DIR=/tmp/vumovie \
    SESSION_DIR=/config/sessions \
    SOURCES_DIR=/config/sources \
    MIGRATIONS_DIR=/app/migrations \
    PUBLIC_DIR=/app/public \
    # --- media tooling ---
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    CHROMIUM_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    # --- memory tuning for a 4 GB NAS (Chromium + ffmpeg + node in one box) ---
    MALLOC_ARENA_MAX=2 \
    NODE_OPTIONS=--max-old-space-size=512 \
    # Prefer the modern iHD driver for Apollo Lake; the app falls back to i965
    # automatically when iHD is not installable in the base image.
    LIBVA_DRIVER_NAME=iHD

# System packages.
#   ffmpeg/ffprobe      → probing, remuxing and (with vaapi) transcoding
#   chromium            → the headless sniffer (system browser, no 300 MB download)
#   intel-media-va-driver-non-free / i965-va-driver → the two VA-API driver flavours
#   vainfo              → capability detection + startup self-test reporting
#   unzip/7z/unrar      → subtitle archives
#   tini                → PID 1, reaps ffmpeg/chromium children properly
#
# Two Debian-12 facts this step has to respect (both used to break the build):
#   1. There is NO /etc/apt/sources.list in the bookworm images — the default
#      repository lives in deb822 format in /etc/apt/sources.list.d/debian.sources.
#      A sed against *.list therefore matched nothing and contrib/non-free stayed
#      disabled, so the non-free VA-API driver could never be installed.
#   2. `libva-utils` is not a binary package in bookworm (it is only the *source*
#      package name); the binary package is called `vainfo`. Listing it made apt
#      abort the whole build with "E: Unable to locate package libva-utils"
#      (exit code 100). install_one() below tolerates exactly this kind of rename.
RUN set -eux; \
    # ---- enable contrib + non-free, in whichever source format is present ----
    enable_components() { \
      components="$1"; \
      for f in /etc/apt/sources.list.d/*.sources; do \
        [ -f "$f" ] || continue; \
        sed -i "s/^Components:.*/Components: main $components/" "$f"; \
      done; \
      for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list; do \
        [ -f "$f" ] || continue; \
        sed -i -E "s/^(deb(-src)?[[:space:]]+(\[[^]]*\][[:space:]]+)?[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+main).*/\\1 $components/" "$f"; \
      done; \
    }; \
    # install_one <pkg> [alternative-pkg …] → installs the first name that exists.
    # Never fails the build: a package that no longer exists is a warning.
    install_one() { \
      for pkg in "$@"; do \
        if apt-cache show "$pkg" > /dev/null 2>&1; then \
          echo "[vu-movie] installing $pkg"; \
          apt-get install -y --no-install-recommends "$pkg"; \
          return 0; \
        fi; \
        echo "[vu-movie] '$pkg' is not offered by the enabled repositories — trying the next name"; \
      done; \
      echo "[vu-movie] WARNING: none of [$*] is available — skipping (the app degrades gracefully)" >&2; \
      return 0; \
    }; \
    # install_many <pkg> … → installs every name; a missing one fails the build.
    install_many() { \
      for pkg in "$@"; do \
        apt-cache show "$pkg" > /dev/null 2>&1 || { \
          echo "[vu-movie] FATAL: required package '$pkg' is not in the enabled repositories" >&2; \
          exit 1; \
        }; \
        apt-get install -y --no-install-recommends "$pkg"; \
      done; \
    }; \
    enable_components "contrib non-free non-free-firmware"; \
    if ! apt-get update -o Acquire::Retries=3; then \
      # e.g. an older release that has no non-free-firmware component: retry once
      echo "[vu-movie] apt-get update failed with non-free-firmware enabled — retrying with contrib + non-free"; \
      enable_components "contrib non-free"; \
      apt-get update -o Acquire::Retries=3; \
    fi; \
    # ---- tools the app cannot work without (missing → build fails loudly) ----
    install_many \
        ffmpeg chromium tini curl ca-certificates tzdata unzip \
        libva2 libva-drm2 \
    ; \
    # ---- everything else, tolerant of package renames between releases ------
    # vainfo = the capability reporter that src/core/media.js shells out to.
    install_one vainfo libva-utils; \
    # VA-API drivers: non-free iHD first (best for Apollo Lake), i965 as fallback.
    install_one intel-media-va-driver-non-free; \
    install_one i965-va-driver; \
    # Subtitle archives. p7zip-full ships /usr/bin/7z (the `7zip` package ships
    # 7zz instead, so it is only the fallback), and `unrar` is the non-free RAR4/
    # RAR5 extractor — unrar-free installs a binary called `unrar-free`, which
    # src/subtitles/util.js never calls, hence `unrar` first.
    install_one p7zip-full 7zip; \
    install_one unrar unrar-free; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt; \
    # ---- build-time proof that this image can do its job --------------------
    for bin in ffmpeg ffprobe chromium tini; do \
      command -v "$bin" > /dev/null 2>&1 \
        || { echo "[vu-movie] FATAL: $bin is missing from the image" >&2; exit 1; }; \
    done; \
    echo "[vu-movie] ffmpeg: $(ffmpeg -version 2>/dev/null | head -1 || echo missing)"; \
    echo "[vu-movie] chromium: $(chromium --version 2>/dev/null || echo missing)"; \
    echo "[vu-movie] archivers: 7z=$(command -v 7z || echo none) unrar=$(command -v unrar || echo none) unzip=$(command -v unzip || echo none)"; \
    echo "[vu-movie] vaapi drivers: $(ls /usr/lib/x86_64-linux-gnu/dri/ 2>/dev/null | tr '\n' ' ')"

WORKDIR /app

# Application dependencies from the builder stage
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY package-lock.json* ./

# Application code
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY config ./config

# The web UI. `public/` is committed with real content (index.html, app.js,
# style.css) — here we also make the failure mode explicit instead of shipping an
# image that serves nothing.
COPY public ./public
RUN set -eux; \
    mkdir -p /app/public /config /config/sources /config/sessions /downloads /tmp/vumovie; \
    test -f /app/public/index.html || (echo "[vu-movie] FATAL: public/index.html is missing from the build context — the UI would be empty" >&2; exit 1); \
    test -f /app/public/app.js || (echo "[vu-movie] FATAL: public/app.js is missing" >&2; exit 1); \
    echo "[vu-movie] public/ ok: $(ls -1 /app/public | tr '\n' ' ')"

# Syntax check as a build gate: a broken JS file should never make it into a run.
RUN node scripts/check-syntax.mjs

# Runtime volumes (compose mounts these; the paths must exist and be writable)
VOLUME ["/config", "/downloads"]

EXPOSE 8080

# Container-level health: the same endpoint the UI uses. DSM's Container Manager
# shows this state, and docker-compose uses it for depends_on: service_healthy.
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/api/health > /dev/null || exit 1

# Clean shutdown: tini forwards SIGTERM, the app kills ffmpeg/Chromium children.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "src/index.js"]

# ---------------------------------------------------------------------------
# Optional: run as a non-root user instead of root.
#   DSM often needs group access to /dev/dri; if you prefer non-root, uncomment
#   the two lines below *and* add the render group id from your NAS
#   (see docs/SYNO.md → "VAAPI permissions"). Root is the default here only to
#   avoid "permission denied on /dev/dri/renderD128" on stock DSM 7.
# ---------------------------------------------------------------------------
# RUN useradd -r -u 1000 -G render vumovie && chown -R vumovie:vumovie /config /downloads /tmp/vumovie
# USER vumovie
