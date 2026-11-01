#!/usr/bin/env bash
# Lab control script. Works under Podman (the Mac) and Docker (Linux).
#   ./lab.sh pull | build | up | down | check | preflight
#   ./lab.sh reset [dN]            no arg: wipe lab volumes and restart; dN: reset one demo
#   ./lab.sh demo dN [--step S]    run a demo headless
#   ./lab.sh exec <service> <cmd...>
#   ./lab.sh app-uri <mongo|oracle>  point the order service at a backend and restart it
set -uo pipefail
cd "$(dirname "$0")"

# Engine: PODMAN=1 forces podman; otherwise podman when on PATH, else docker.
if [ "${PODMAN:-}" = "1" ] || command -v podman >/dev/null 2>&1; then
  ENGINE=podman
else
  ENGINE=docker
fi
compose() { ensure_app_env; "$ENGINE" compose -f compose.yml "$@"; }

# The order service's backend URI, as seen from inside compose. %24 is "$":
# encoded so no env-file or compose interpolation can eat "$external".
app_uri() {
  case "$1" in
    mongo)  echo 'mongodb://mongo:27017/telco?replicaSet=rs0&directConnection=true' ;;
    oracle) echo "mongodb://MIG:${MIG_PASSWORD}@oracle:27017/MIG?authMechanism=PLAIN&authSource=%24external&tls=false&retryWrites=false&loadBalanced=true" ;;
    *)      return 1 ;;
  esac
}
write_app_env() { mkdir -p .lab && printf 'APP_MONGO_URI=%s\n' "$(app_uri "$1")" > .lab/app.env; }
# compose needs .lab/app.env to exist; default the app to the MongoDB source.
ensure_app_env() { [ -f .lab/app.env ] || write_app_env mongo; }

cmd_app_uri() {
  app_uri "$1" >/dev/null || usage
  write_app_env "$1"
  # A restart keeps the old env; recreating the container reads the new file.
  compose up -d --no-deps --force-recreate app && echo "order service now uses $1 (127.0.0.1:3300)"
}

MIG_PASSWORD="${MIG_PASSWORD:-MigUser2026}"
PORTS="27117 1523 8183 27119 3200 3300"
BASE_IMAGES="docker.io/library/mongo:8.2 docker.io/gvenzl/oracle-free:23.26.3-faststart docker.io/library/node:22-alpine"
LAB_IMAGES="mongodb-oracle-migration-lab-mongo:latest mongodb-oracle-migration-lab-oracle:latest docker.io/library/node:22-alpine"
CHECK_TIMEOUT="${CHECK_TIMEOUT:-300}"

ok()   { printf 'OK    %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILED=1; }

lab_exec() {
  local svc="$1"; shift
  local tty=""
  [ -t 0 ] && [ -t 1 ] && tty="-t"
  "$ENGINE" exec -i $tty "lab-$svc" "$@"
}

# --- readiness probes (each returns 0 when ready) ---------------------------
probe_mongo()  { "$ENGINE" exec lab-mongo mongosh --quiet --eval 'quit(db.hello().isWritablePrimary ? 0 : 1)' >/dev/null 2>&1; }
probe_oracle() { "$ENGINE" exec lab-oracle healthcheck.sh >/dev/null 2>&1; }
probe_ords()   { [ "$(curl -s -L -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8183/ords/)" = "200" ]; }
probe_oramongo() {
  "$ENGINE" exec lab-oracle mongosh --quiet \
    "mongodb://MIG:${MIG_PASSWORD}@localhost:27017/MIG?authMechanism=PLAIN&authSource=\$external&tls=false&retryWrites=false&loadBalanced=true" \
    --eval 'quit(db.runCommand({ ping: 1 }).ok === 1 ? 0 : 1)' >/dev/null 2>&1
}

# Poll each probe in order against one shared deadline; one line per service.
cmd_check() {
  FAILED=0
  local start=$SECONDS deadline=$((SECONDS + CHECK_TIMEOUT))
  local entry name label
  for entry in "mongo|MongoDB source (rs0 primary, 127.0.0.1:27117)" \
               "oracle|Oracle 26ai database (127.0.0.1:1523)" \
               "ords|ORDS /ords/ (127.0.0.1:8183)" \
               "oramongo|Oracle API for MongoDB ping (127.0.0.1:27119)"; do
    name="${entry%%|*}"; label="${entry#*|}"
    until "probe_$name"; do
      if [ "$SECONDS" -ge "$deadline" ]; then break; fi
      sleep 3
    done
    if "probe_$name"; then ok "$label [$((SECONDS - start))s]"
    else fail "$label (not ready after ${CHECK_TIMEOUT}s)"; fi
  done
  return "$FAILED"
}

cmd_preflight() {
  FAILED=0
  local os arch mem p
  os="$(uname -s)"; arch="$(uname -m)"
  if [ "$os" = "Darwin" ]; then
    [ "$arch" = "arm64" ] && ok "CPU arch arm64" || fail "CPU arch is $arch, expected arm64 (Apple silicon)"
  else
    [ "$arch" = "arm64" ] || [ "$arch" = "aarch64" ] && ok "CPU arch $arch" \
      || warn "CPU arch is $arch (the session laptop is arm64; fine for a Linux lab host)"
  fi

  echo "INFO  container engine: $ENGINE"
  if [ "$ENGINE" = "podman" ] && [ "$os" = "Darwin" ]; then
    mem="$(podman machine inspect --format '{{.Resources.Memory}}' 2>/dev/null | head -1)"
    if [ -n "$mem" ] && [ "$mem" -ge 12288 ]; then ok "podman machine memory ${mem} MiB"
    else fail "podman machine memory '${mem:-unknown}' MiB, need >= 12288 (podman machine init --cpus 6 --memory 16384 --disk-size 60)"; fi
  elif [ "$os" = "Linux" ]; then
    mem=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
    [ "$mem" -ge 12288 ] && ok "host memory ${mem} MiB" || warn "host memory ${mem} MiB (12 GB+ recommended)"
  fi

  for p in $LAB_IMAGES; do
    "$ENGINE" image inspect "$p" >/dev/null 2>&1 && ok "image $p present" \
      || fail "image $p missing (run ./lab.sh pull && ./lab.sh build)"
  done

  local lab_ports
  lab_ports="$("$ENGINE" ps --filter name=lab- --format '{{.Ports}}' 2>/dev/null)"
  for p in $PORTS; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
      if printf '%s' "$lab_ports" | grep -q ":$p->"; then ok "port $p in use by this lab stack"
      else fail "port $p already has a listener (stop it before ./lab.sh up)"; fi
    else
      ok "port $p free"
    fi
  done
  return "$FAILED"
}

run_demo_cli() {
  if [ ! -f demos/run.mjs ]; then
    echo "demos/run.mjs not found: demos are not installed yet" >&2; return 1
  fi
  node demos/run.mjs "$@"
}

usage() {
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

cmd="${1:-}"; [ $# -gt 0 ] && shift
case "$cmd" in
  pull)      for i in $BASE_IMAGES; do "$ENGINE" pull "$i" || exit 1; done ;;
  build)     compose build ;;
  up)        compose up -d && echo "Stack starting. Run ./lab.sh check to wait for readiness." ;;
  down)      compose --profile d4 down ;;
  check)     cmd_check ;;
  preflight) cmd_preflight ;;
  reset)
    if [ $# -eq 0 ]; then
      compose --profile d4 down -v && compose up -d && cmd_check
    else
      run_demo_cli "$1" --reset
    fi ;;
  demo)      [ $# -ge 1 ] || usage; run_demo_cli "$@" ;;
  exec)      [ $# -ge 2 ] || usage; lab_exec "$@" ;;
  app-uri)   [ $# -eq 1 ] || usage; cmd_app_uri "$1" ;;
  *)         usage ;;
esac
