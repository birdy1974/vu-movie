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
#   vainfo/libva-utils  → capability detection + startup self-test reporting
#   unzip/7z/unrar      → subtitle archives
#   tini                → PID 1, reaps ffmpeg/chromium children properly
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ffmpeg chromium vainfo libva-utils libva2 libva-drm2 \
        tini curl ca-certificates tzdata unzip \
    ; \
    # optional helpers: keep the build alive when a package name differs between
    # Debian releases (this is what makes the image build on every DSM version)
    (apt-get install -y --no-install-recommends p7zip-full || apt-get install -y --no-install-recommends 7zip || true); \
    (apt-get install -y --no-install-recommends unrar-free || apt-get install -y --no-install-recommends unrar || true); \
    # VA-API drivers: try the non-free iHD driver first (best for Apollo Lake),
    # fall back to the free i965 driver, and never fail the build over it.
    (sed -i 's/^\(deb .*main\)/\1 contrib non-free non-free-firmware/' /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null || true); \
    (apt-get update && apt-get install -y --no-install-recommends intel-media-va-driver-non-free) \
      || echo "[vu-movie] intel-media-va-driver-non-free not available — using i965-va-driver"; \
    (apt-get install -y --no-install-recommends i965-va-driver || true); \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt; \
    # record what we ended up with — this shows up in `docker run ... vainfo`
    echo "[vu-movie] ffmpeg: $(ffmpeg -version 2>/dev/null | head -1 || echo missing)"; \
    echo "[vu-movie] chromium: $(chromium --version 2>/dev/null || echo missing)"

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
