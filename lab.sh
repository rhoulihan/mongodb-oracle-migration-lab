#!/usr/bin/env bash
# Lab control script. Works under Podman (the Mac) and Docker (Linux).
#   ./lab.sh pull | build | up | down | check | preflight
#   ./lab.sh reset [dN]            no arg: wipe lab volumes and restart; dN: reset one demo
#   ./lab.sh demo dN [--step S]    run a demo headless
#   ./lab.sh generate [--scale S]  load the deterministic dataset into the MongoDB source
#   ./lab.sh mongosh src|ora [args...]  mongosh against the source or the Oracle API for MongoDB
#   ./lab.sh exec <service> <cmd...>
#   ./lab.sh app-uri <mongo|oracle>  switch the order service's backend (no restart)
#   ./lab.sh agent read|write|retry --agent A|B  a D7 agent (runs in the runner)
# demo, reset dN, generate and agent run Node in a one-off runner container (the app
# image), so the laptop needs no Node. LAB_HOST_NODE=1 uses the host's node.
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

# The order service as seen from the host. LAB_APP_URL overrides it (tests).
APP_URL="${LAB_APP_URL:-http://127.0.0.1:3300}"

# Ruling O: switch the running service in place through POST /admin/backend,
# then write .lab/app.env so a restart keeps the choice. Three outcomes:
#   200            switched: write the file
#   no connection  (curl exit 7) nothing listening: write the file and start
#                  the service, which reads it
#   anything else  (an HTTP error such as 503 "cannot reach oracle", or a
#                  timeout) print the error, leave the file and the service
#                  as they were, exit 1
cmd_app_uri() {
  app_uri "$1" >/dev/null || usage
  local body code rc=0 err
  body="$(mktemp)"
  code="$(curl -s --max-time 30 -o "$body" -w '%{http_code}' -X POST -H 'content-type: application/json' \
    -d "{\"target\":\"$1\"}" "$APP_URL/admin/backend")" || rc=$?
  err="$(sed -n 's/.*"error":"\([^"]*\)".*/\1/p' "$body")"
  rm -f "$body"
  if [ "$rc" -eq 0 ] && [ "$code" = "200" ]; then
    write_app_env "$1"
    echo "order service now uses $1 (127.0.0.1:3300)"
  elif [ "$rc" -eq 7 ]; then
    write_app_env "$1"
    echo "order service is not running; starting it on $1" >&2
    compose up -d --no-deps app && echo "order service now uses $1 (127.0.0.1:3300)"
  else
    echo "FAIL  order service did not switch to $1: ${err:-HTTP ${code:-none}, curl exit $rc}" >&2
    return 1
  fi
}

# After a demo or reset (which may switch the backend through the endpoint),
# make .lab/app.env match the live backend, so a later restart keeps it.
# Silent no-op when the service does not answer.
sync_app_env() {
  local h
  h="$(curl -sf --max-time 5 "$APP_URL/health" 2>/dev/null)" || return 0
  case "$h" in
    *'"backend":"oracle"'*)  write_app_env oracle ;;
    *'"backend":"mongodb"'*) write_app_env mongo ;;
  esac
}

MIG_PASSWORD="${MIG_PASSWORD:-MigUser2026}"
PORTS="27117 1523 8183 27119 3200 3300"
# node:22-bookworm-slim is the app/runner base; node:22-alpine runs the console
# and replicator placeholders until their tasks land.
BASE_IMAGES="docker.io/library/mongo:8.2 docker.io/gvenzl/oracle-free:23.26.3-faststart docker.io/library/node:22-bookworm-slim docker.io/library/node:22-alpine"
LAB_IMAGES="mongodb-oracle-migration-lab-mongo:latest mongodb-oracle-migration-lab-oracle:latest mongodb-oracle-migration-lab-app:latest docker.io/library/node:22-alpine"
CHECK_TIMEOUT="${CHECK_TIMEOUT:-300}"

ok()   { printf 'OK    %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILED=1; }

lab_exec() { local svc="$1"; shift; lab_exec_env "$svc" "" "$@"; }

# lab_exec with one VAR=value set in the container ("" for none).
lab_exec_env() {
  local svc="$1" envvar="$2"; shift 2
  local opts=(-i)
  [ -t 0 ] && [ -t 1 ] && opts+=(-t)
  [ -n "$envvar" ] && opts+=(-e "$envvar")
  [ -n "${LAB_EXEC_WORKDIR:-}" ] && opts+=(-w "$LAB_EXEC_WORKDIR")
  "$ENGINE" exec "${opts[@]}" "lab-$svc" "$@"
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

# Run a repo script with Node (Ruling O): in a one-off `runner` container from
# the app image (it carries lib/, gen/, oracle/, app/, demos/, node_modules, the
# MongoDB Database Tools and mongosh; rebuild after code changes), never inside
# lab-app, so a demo step can switch the order service without touching the
# runner. LAB_HOST_NODE=1 runs on the host instead (developers, the vitest suite).
run_node() {
  if [ "${LAB_HOST_NODE:-}" = "1" ]; then
    node "$@"; return
  fi
  local tty=-T
  [ -t 0 ] && [ -t 1 ] && tty=
  # $tty is unquoted on purpose: empty means "allocate a TTY" (no argument).
  # --profile runner: podman-compose drops profiled services unless the profile is on.
  compose --profile runner run --rm --no-deps $tty -e "MIG_PASSWORD=$MIG_PASSWORD" runner node "$@"
}

run_demo_cli() { local rc=0; run_node demos/run.mjs "$@" || rc=$?; sync_app_env; return "$rc"; }

# mongosh inside the database containers, so terminal steps need no host tools.
#   src: the MongoDB source replica set, database telco (in lab-mongo)
#   ora: the Oracle API for MongoDB as MIG (in lab-oracle), run from /opt/lab,
#        where the oracle image keeps the repo's mongosh scripts (demos/d6-sql/),
#        so `./lab.sh mongosh ora demos/d6-sql/sql-stage.js` names the repo path
cmd_mongosh() {
  local target="$1"; shift
  case "$target" in
    src) lab_exec mongo mongosh 'mongodb://localhost:27017/telco?replicaSet=rs0&directConnection=true' "$@" ;;
    ora) LAB_EXEC_WORKDIR=/opt/lab lab_exec oracle mongosh "mongodb://MIG:${MIG_PASSWORD}@localhost:27017/MIG?authMechanism=PLAIN&authSource=\$external&tls=false&retryWrites=false&loadBalanced=true" "$@" ;;
    *)   usage ;;
  esac
}

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
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
  generate)  run_node gen/generate.mjs "$@" ;;
  mongosh)   [ $# -ge 1 ] || usage; cmd_mongosh "$@" ;;
  exec)      [ $# -ge 2 ] || usage; lab_exec "$@" ;;
  app-uri)   [ $# -eq 1 ] || usage; cmd_app_uri "$1" ;;
  agent)     [ $# -ge 1 ] || usage; run_node demos/d7-etag/agent.mjs "$@" ;;
  *)         usage ;;
esac
