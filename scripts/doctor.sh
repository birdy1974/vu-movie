#!/bin/sh
# =============================================================================
# vu-movie doctor — one command that answers "why is ffmpeg/VAAPI not working?".
#
#   On the NAS, from the folder that holds docker-compose.yml:
#
#       sh scripts/doctor.sh
#
#   Overrides:  CONTAINER=vu-movie  PORT=8080  VAAPI_DEVICE=/dev/dri/renderD128
#
# The checks, in order:
#   1. the container is running
#   2. the NAS *and* the container can see /dev/dri
#   3. ffmpeg exists in the container and how long `ffmpeg -version` takes
#   4. which VA-API driver really encodes a 2 s test pattern (iHD vs i965)
#   5. what the app itself reports (GET /api/diagnostics/ffmpeg)
#
# Every line is a fact read from your machine — the point is to stop guessing.
# Exit status 0 = everything a stream needs is in place.
# =============================================================================
set -u

CONTAINER="${CONTAINER:-vu-movie}"
PORT="${PORT:-8080}"
DEVICE="${VAAPI_DEVICE:-/dev/dri/renderD128}"
TMP_LOG="${TMPDIR:-/tmp}/vu-movie-doctor.$$.log"

PROBLEMS=0
ok()   { printf '  [ok]   %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1"; PROBLEMS=$((PROBLEMS + 1)); }
warn() { printf '  [warn] %s\n' "$1"; }
head1() { printf '\n=== %s ===\n' "$1"; }

dexec() { docker exec "$CONTAINER" sh -c "$1" 2>&1; }

# -----------------------------------------------------------------------------
head1 "1. container"
if ! command -v docker > /dev/null 2>&1; then
  bad "docker is not on this shell's PATH — run the script on the NAS (DSM: sudo -i first)"
  printf '\nCannot continue without docker.\n'
  exit 2
fi
if docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  ok "container '$CONTAINER' is running"
  docker inspect -f '    image: {{.Config.Image}}  (started {{.State.StartedAt}})' "$CONTAINER" 2>/dev/null
else
  bad "container '$CONTAINER' is not running — start it: docker compose up -d"
  printf '    (is the name different? CONTAINER=<name> sh scripts/doctor.sh)\n'
  printf '\nStopped container: nothing else can be checked.\n'
  exit 2
fi

# -----------------------------------------------------------------------------
head1 "2. /dev/dri"
printf '  on the NAS:\n'
if [ -d /dev/dri ]; then
  ls -l /dev/dri 2>/dev/null | sed 's/^/              /'
else
  printf '              /dev/dri does not exist\n'
fi
if [ -e "$DEVICE" ]; then
  ok "the NAS has $DEVICE (required for VAAPI)"
else
  bad "the NAS itself does not have $DEVICE — the Intel GPU driver is not loaded"
  printf '         On a DS918+ this usually means the box was not updated correctly;\n'
  printf '         check with:  ls -l /dev/dri   (card0 and renderD128 must exist)\n'
fi

if dexec "ls -l '$DEVICE'" | grep -q "$DEVICE"; then
  ok "the container sees $DEVICE (the compose devices: mapping works)"
  dexec "ls -l '$DEVICE'" | sed 's/^/              /'
else
  bad "the container does NOT see $DEVICE — check docker-compose.yml:"
  printf '             devices:\n               - /dev/dri:/dev/dri\n'
  printf '         then:  docker compose up -d --force-recreate\n'
fi

# -----------------------------------------------------------------------------
head1 "3. ffmpeg in the container"
PATH_FF=$(dexec 'command -v ffmpeg || true')
if [ -n "$PATH_FF" ]; then
  ok "ffmpeg is installed at $PATH_FF"
  dexec "ls -l $PATH_FF" | sed 's/^/              /'
  dexec "ffmpeg -hide_banner -version | head -1" | sed 's/^/         /'
else
  bad "ffmpeg is not in the container at all — rebuild it: docker compose build --no-cache && docker compose up -d"
fi

if [ -n "$PATH_FF" ]; then
  T0=$(date +%s)
  dexec 'ffmpeg -hide_banner -version > /dev/null 2>&1' > "$TMP_LOG" 2>&1
  CODE=$?
  T1=$(date +%s)
  ELAPSED=$((T1 - T0))
  if [ "$CODE" -eq 0 ]; then
    ok "ffmpeg -version answered in ${ELAPSED}s (exit 0)"
    if [ "$ELAPSED" -ge 10 ]; then
      warn "that is slow — the app's probe ceiling is FFMPEG_PROBE_TIMEOUT_MS (default 30 s)."
      printf '         A cold/busy volume can do this; the app now retries instead of disabling itself.\n'
    fi
  else
    bad "ffmpeg -version failed (exit $CODE after ${ELAPSED}s):"
    sed 's/^/         /' "$TMP_LOG"
  fi
fi

# -----------------------------------------------------------------------------
head1 "4. VA-API drivers (this is where a DS918+ usually fails)"
if ! dexec "ls -l '$DEVICE'" | grep -q "$DEVICE"; then
  warn "skipped: the container cannot see $DEVICE"
else
  DRIVER_OK=0
  for DRV in iHD i965; do
    printf '\n  --- LIBVA_DRIVER_NAME=%s ---\n' "$DRV"
    if ! dexec "ls /usr/lib/x86_64-linux-gnu/dri/${DRV}_drv_video.so" | grep -q _drv_video.so; then
      warn "${DRV}_drv_video.so is not installed in the image — skipping this driver"
      continue
    fi

    VA=$(docker exec -e LIBVA_DRIVER_NAME="$DRV" "$CONTAINER" vainfo -d "$DEVICE" 2>&1)
    if [ $? -eq 0 ]; then
      ok "vainfo works"
      printf '%s\n' "$VA" | grep -m1 'Driver version' | sed 's/^/         /'
      ENC=$(printf '%s\n' "$VA" | grep -m1 'VAProfileH264.*Enc' | sed 's/^[[:space:]]*//')
      if [ -n "$ENC" ]; then ok "H.264 encoder exposed: $ENC"; else warn "no H.264 encode profile reported"; fi
    else
      warn "vainfo failed with $DRV (this driver is not usable on this box):"
      printf '%s\n' "$VA" | tail -3 | sed 's/^/         /'
    fi

    T0=$(date +%s)
    docker exec -e LIBVA_DRIVER_NAME="$DRV" "$CONTAINER" \
      ffmpeg -hide_banner -loglevel error \
      -init_hw_device vaapi=intel:"$DEVICE" -filter_hw_device intel \
      -f lavfi -i testsrc2=size=640x360:rate=25 -t 2 \
      -vf format=nv12,hwupload,scale_vaapi=w=640:h=360 \
      -c:v h264_vaapi -b:v 1000k -f null - > "$TMP_LOG" 2>&1
    CODE=$?
    T1=$(date +%s)
    if [ "$CODE" -eq 0 ]; then
      DRIVER_OK=1
      ok "a 2 s H.264 encode through $DRV succeeded in $((T1 - T0))s — hardware transcoding works"
    else
      warn "the H.264 encode with $DRV failed (exit $CODE after $((T1 - T0))s):"
      tail -3 "$TMP_LOG" | sed 's/^/         /'
    fi
  done

  if [ "$DRIVER_OK" -eq 1 ]; then
    printf '\n  At least one driver encodes: the app pins it automatically (keep\n'
    printf '  LIBVA_DRIVER_NAME empty in .env). Forcing one is possible with\n'
    printf '  LIBVA_DRIVER_NAME=i965 in .env, but auto-detection is recommended.\n'
  else
    bad "NO VA-API driver could encode — transcoding falls back to the CPU (libx264)"
    printf '         Things to try, in order:\n'
    printf '           1. chmod 666 %s   (permission; does not survive a DSM reboot)\n' "$DEVICE"
    printf '           2. rebuild the image: docker compose build --no-cache\n'
    printf '           3. press "re-test hardware" in the UI and watch the log\n'
  fi
fi

# -----------------------------------------------------------------------------
head1 "5. what the app reports"
DIAG=$(docker exec "$CONTAINER" curl -fsS "http://127.0.0.1:${PORT}/api/diagnostics/ffmpeg" 2>&1)
if printf '%s' "$DIAG" | grep -q '"report"'; then
  printf '%s\n' "$DIAG" | sed 's/},/},\n/g; s/","/"\n  "/g' | sed 's/^/  /'
else
  warn "the app did not answer on http://127.0.0.1:${PORT} inside the container:"
  printf '%s\n' "$DIAG" | tail -3 | sed 's/^/         /'
fi

head1 "cache + next steps"
printf '  capability cache : /config/hwaccel.json  (= ./data/config/hwaccel.json on the NAS)\n'
printf '  A NEGATIVE entry is ignored on purpose; if you suspect a stale POSITIVE\n'
printf '  entry, delete the file (or press "re-test hardware" in the UI) and restart.\n'
printf '  live logs        : docker compose logs -f vu-movie\n'
printf '  app log page     : http://<nas-ip>:<port>/  → Logs (filter: hwaccel)\n'

rm -f "$TMP_LOG"
printf '\n'
if [ "$PROBLEMS" -eq 0 ]; then
  printf 'Doctor result: no problems found.\n'
  exit 0
fi
printf 'Doctor result: %s problem(s) above — the lines marked [FAIL] are the cause.\n' "$PROBLEMS"
exit 1
