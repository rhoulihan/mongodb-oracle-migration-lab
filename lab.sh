#!/usr/bin/env bash
# Lab control script. Works under Podman (the Mac) and Docker (Linux).
#   ./lab.sh pull | build | up | down | check | preflight
#   ./lab.sh reset [dN]            no arg: wipe lab volumes and restart; dN: reset one demo
#   ./lab.sh demo dN [--step S]    run a demo headless
#   ./lab.sh generate [--scale S]  load the deterministic dataset into the MongoDB source
#   ./lab.sh mongosh src|ora [args...]  mongosh against the source or the Oracle API for MongoDB
#   ./lab.sh exec <service> <cmd...>
#   ./lab.sh app-uri <mongo|oracle>  switch the order service's backend (no restart)
#   ./lab.sh app-mode <ageout|normal>  D2: age-out router (old orders from MongoDB, new on Oracle) or back to MongoDB
#   ./lab.sh migrate-entities      D2: dump the long-lived collections and restore them into MIG (runner)
#   ./lab.sh mongorestore-ora [args...]  D3: mongorestore into MIG (lab-mongo); the URI and password come from MIG_PASSWORD
#   ./lab.sh agent read|write|retry --agent A|B  a D7 agent (runs in the runner)
#   ./lab.sh repl fwd|rev|stop|status|logs  the D4 stand-in for Oracle GoldenGate
#   ./lab.sh bake-recordings       save the console's rehearsal results in fallback/recorded/
#   ./lab.sh drive stage|status|plan dN   Claude drives the demos (tmux session `lab` + the console)
#   ./lab.sh drive console dN STEP [--skip|--show] [--nowait] | wait SEQ | term [A|B] 'CMD'
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
# Where app.env lives. compose.yml always reads .lab/app.env; LAB_STATE_DIR
# moves it only for the unit tests, which run lab.sh against a fake engine.
STATE_DIR="${LAB_STATE_DIR:-.lab}"
APP_ENV="$STATE_DIR/app.env"
write_app_env() { mkdir -p "$STATE_DIR" && printf 'APP_MONGO_URI=%s\n' "$(app_uri "$1")" > "$APP_ENV"; }
# D2 age-out mode: both backends behind the router, split at the cutoff the app chose.
write_ageout_env() {
  mkdir -p "$STATE_DIR" && printf 'APP_MONGO_URI=%s\nAPP_MODE=ageout\nAPP_CUTOFF=%s\n' "$(app_uri mongo)" "$1" > "$APP_ENV"
}
# compose needs .lab/app.env to exist; default the app to the MongoDB source.
ensure_app_env() { [ -f "$APP_ENV" ] || write_app_env mongo; }

# The order service as seen from the host. LAB_APP_URL overrides it (tests).
APP_URL="${LAB_APP_URL:-http://127.0.0.1:3300}"

# POST /admin/backend {target: $1}; sets BODY (the response), CODE and RC (curl's exit code).
post_backend() {
  local f; f="$(mktemp)"
  RC=0
  CODE="$(curl -s --max-time 30 -o "$f" -w '%{http_code}' -X POST -H 'content-type: application/json' \
    -d "{\"target\":\"$1\"}" "$APP_URL/admin/backend")" || RC=$?
  BODY="$(cat "$f")"; rm -f "$f"
}
json_field() { printf '%s' "$BODY" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }
switch_failed() {
  echo "FAIL  order service did not switch to $1: $(json_field error | grep . || echo "HTTP ${CODE:-none}, curl exit $RC")" >&2
  return 1
}

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
  post_backend "$1"
  if [ "$RC" -eq 0 ] && [ "$CODE" = "200" ]; then
    write_app_env "$1"
    echo "order service now uses $1 (127.0.0.1:3300)"
  elif [ "$RC" -eq 7 ]; then
    write_app_env "$1"
    echo "order service is not running; starting it on $1" >&2
    compose up -d --no-deps app && echo "order service now uses $1 (127.0.0.1:3300)"
  else
    switch_failed "$1"
  fi
}

# D2 (Ruling O, same switch): ageout puts the order service in front of both
# backends, the age-out router; the app picks the cutoff from the data and
# answers with it, and .lab/app.env keeps mode and cutoff for a restart.
# normal is app-uri mongo. A stopped service is started on mongo first.
cmd_app_mode() {
  case "$1" in
    normal) cmd_app_uri mongo; return ;;
    ageout) ;;
    *) usage ;;
  esac
  post_backend ageout
  if [ "$RC" -eq 7 ]; then
    cmd_app_uri mongo >/dev/null || return 1
    local i
    for i in $(seq 1 30); do
      curl -s --max-time 2 -o /dev/null "$APP_URL/health" && break
      sleep 1
    done
    post_backend ageout
  fi
  if [ "$RC" -eq 0 ] && [ "$CODE" = "200" ]; then
    local cutoff; cutoff="$(json_field cutoff)"
    write_ageout_env "$cutoff"
    echo "order service now in age-out mode: orders before $cutoff read from MongoDB, new orders go to Oracle"
  else
    switch_failed ageout
  fi
}

# After a demo or reset (which may switch the backend through the endpoint),
# make .lab/app.env match the live backend, so a later restart keeps it.
# Silent no-op when the service does not answer.
sync_app_env() {
  local h
  h="$(curl -sf --max-time 5 "$APP_URL/health" 2>/dev/null)" || return 0
  case "$h" in
    *'"backend":"ageout"'*)  BODY="$h"; write_ageout_env "$(json_field cutoff)" ;;
    *'"backend":"oracle"'*)  write_app_env oracle ;;
    *'"backend":"mongodb"'*) write_app_env mongo ;;
  esac
}

MIG_PASSWORD="${MIG_PASSWORD:-MigUser2026}"
PORTS="27117 1523 8183 27119 3200 3300"
# node:22-bookworm-slim is the base of the app image (app, runner, replicator, console).
BASE_IMAGES="docker.io/library/mongo:8.2 docker.io/gvenzl/oracle-free:23.26.3-faststart docker.io/library/node:22-bookworm-slim"
LAB_IMAGES="mongodb-oracle-migration-lab-mongo:latest mongodb-oracle-migration-lab-oracle:latest mongodb-oracle-migration-lab-app:latest"
# A full reset recreates Oracle and ORDS from scratch: give them 10 minutes.
CHECK_TIMEOUT="${CHECK_TIMEOUT:-600}"

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
  # `podman compose` needs a provider (docker-compose or podman-compose) on PATH.
  if "$ENGINE" compose version >/dev/null 2>&1; then ok "$ENGINE compose works"
  elif [ "$ENGINE" = "podman" ]; then
    fail "podman compose has no provider (brew install podman-compose)"
  else
    fail "docker compose is missing (install the Docker Compose plugin)"
  fi
  if [ "$ENGINE" = "podman" ] && [ "$os" = "Darwin" ]; then
    mem="$(podman machine inspect --format '{{.Resources.Memory}}' 2>/dev/null | head -1)"
    if [ -n "$mem" ] && [ "$mem" -ge 12288 ]; then ok "podman machine memory ${mem} MiB"
    else fail "podman machine memory '${mem:-unknown}' MiB, need >= 12288 (podman machine init --cpus 6 --memory 16384 --disk-size 60)"; fi
  elif [ "$os" = "Linux" ]; then
    mem=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
    [ "$mem" -ge 12288 ] && ok "host memory ${mem} MiB" || warn "host memory ${mem} MiB (12 GB+ recommended)"
  fi

  command -v tmux >/dev/null 2>&1 && ok "tmux present (for ./lab.sh drive)" \
    || warn "tmux missing: only ./lab.sh drive needs it (brew install tmux)"

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

# mongorestore into the Oracle API for MongoDB as MIG, from lab-mongo over the
# compose network. The URI is built here from MIG_PASSWORD so no typed command,
# slide or console step shows the password. No database in the URI path: with
# /MIG mongorestore restores 0 documents and still exits 0 (Ruling Q).
# Its last line is the wall time on this laptop, so the presenter reads the
# restore time off the screen live (D3) instead of quoting a fixed number.
cmd_mongorestore_ora() {
  local start=$SECONDS rc=0
  lab_exec mongo mongorestore "$@" \
    --uri "mongodb://MIG:${MIG_PASSWORD}@oracle:27017/?authMechanism=PLAIN&authSource=\$external&tls=false&retryWrites=false&loadBalanced=true" \
    || rc=$?
  echo "INFO  restore took $((SECONDS - start)) s on this laptop (wall clock, exit $rc)"
  return "$rc"
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

# D4 replicator (Ruling O): the compose `replicator` service on the app image.
# fwd|rev recreate it in that mode and wait for its "ready" line; stop sends
# SIGTERM, and it drains to lag 0 and saves its position before exiting.
REPL_LOG_READY=' ready$'
repl_running() { [ "$("$ENGINE" inspect -f '{{.State.Running}}' lab-replicator 2>/dev/null)" = "true" ]; }

wait_repl_ready() {
  local i out=""
  for i in $(seq 1 60); do
    out="$("$ENGINE" logs lab-replicator 2>&1)"
    if printf '%s\n' "$out" | grep -q "$REPL_LOG_READY"; then printf '%s\n' "$out"; return 0; fi
    if ! repl_running; then
      printf '%s\n' "$out"; echo "FAIL  the replicator exited (see above)" >&2; return 1
    fi
    sleep 1
  done
  printf '%s\n' "$out"; echo "FAIL  the replicator did not report ready within 60 s" >&2; return 1
}

repl_stop() {
  if repl_running; then
    compose --profile d4 stop -t 30 replicator >/dev/null 2>&1
    "$ENGINE" logs --tail 3 lab-replicator 2>&1
  else
    echo "[stand-in for Oracle GoldenGate] replicator is not running"
  fi
}

cmd_repl() {
  case "${1:-}" in
    fwd|rev)
      export REPL_MODE="$1"
      compose --profile d4 up -d --no-deps --force-recreate replicator >/dev/null 2>&1 \
        || { echo "FAIL  could not start the replicator (run ./lab.sh build first?)" >&2; return 1; }
      wait_repl_ready ;;
    stop)   repl_stop ;;
    status) run_node replicator/cli.mjs status ;;
    logs)   "$ENGINE" logs -f lab-replicator ;;
    *)      usage ;;
  esac
}

# Ruling V: copy the console's recordings (/state/recorded on the state volume,
# which a full reset deletes) into the repo, where the console finds them after
# a reset. A container copy: no host Node needed. Commit fallback/recorded/.
cmd_bake_recordings() {
  mkdir -p fallback/recorded
  "$ENGINE" cp lab-console:/state/recorded/. fallback/recorded/ \
    || { echo "FAIL  could not copy from lab-console (is the console running? ./lab.sh up)" >&2; return 1; }
  rm -f fallback/recorded/*.tmp
  ls fallback/recorded/*.json 2>/dev/null | sed 's/^/saved  /' | grep . \
    || { echo "FAIL  no recordings yet: run the demos in the console first" >&2; return 1; }
}

# ---- drive: Claude runs the demos while the presenter talks -----------------
# The presenter shares two windows: the console in Chrome, and one terminal
# attached to the tmux session `lab` (`./lab.sh drive stage`). Console steps go
# through the console's remote channel, so the open page presses its own button
# and the audience sees the usual timer and result. Terminal steps are typed
# into the shared tmux pane. Only bash, curl and tmux on the host.
CONSOLE_URL="${LAB_CONSOLE_URL:-http://127.0.0.1:3200}"
TMUX_SESSION="${LAB_TMUX_SESSION:-lab}"
case "$STATE_DIR" in /*) DRIVE_DIR="$STATE_DIR/drive" ;; *) DRIVE_DIR="$PWD/$STATE_DIR/drive" ;; esac

# curl the console; sets BODY, CODE and RC. Fails loudly when it is down.
drive_req() {
  local f; f="$(mktemp)"
  RC=0
  CODE="$(curl -s --max-time 40 -o "$f" -w '%{http_code}' -X "$1" "$CONSOLE_URL$2")" || RC=$?
  BODY="$(cat "$f")"; rm -f "$f"
  if [ "$RC" -ne 0 ]; then echo "FAIL  the console did not answer at $CONSOLE_URL (curl exit $RC; ./lab.sh up?)" >&2; return 1; fi
  case "$CODE" in 2??) return 0 ;; esac
  printf '%s\n' "${BODY:-FAIL  HTTP $CODE}" >&2; return 1
}

need_tmux() { command -v tmux >/dev/null 2>&1 || { echo "FAIL  tmux is not installed (Mac: brew install tmux)" >&2; return 1; }; }
need_stage() {
  need_tmux || return 1
  tmux has-session -t "$TMUX_SESSION" 2>/dev/null \
    || { echo "FAIL  no tmux session $TMUX_SESSION: run ./lab.sh drive stage, then tmux attach -t $TMUX_SESSION in the shared terminal" >&2; return 1; }
}

# Each pane runs bash with this rc file: a short prompt, and a prompt hook
# that writes "<count> <exit status>" to a file per pane, so the driver knows
# when a command has finished without printing anything on screen.
drive_rc() {
  mkdir -p "$DRIVE_DIR"
  cat > "$DRIVE_DIR/bashrc" <<RC
cd "$PWD"
PS1='lab \\\$ '
__lab_n=0
PROMPT_COMMAND='__lab_s=\$?; __lab_n=\$((__lab_n+1)); echo "\$__lab_n \$__lab_s" > "$DRIVE_DIR/prompt-\$LAB_PANE"'
clear
RC
}

drive_stage() {
  need_tmux || return 1
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "OK    tmux session $TMUX_SESSION already exists"
  else
    drive_rc
    rm -f "$DRIVE_DIR"/prompt-*
    tmux new-session -d -s "$TMUX_SESSION" -n main "env LAB_PANE=main bash --noprofile --rcfile '$DRIVE_DIR/bashrc' -i"
    tmux new-window -d -t "$TMUX_SESSION" -n agents "env LAB_PANE=A bash --noprofile --rcfile '$DRIVE_DIR/bashrc' -i"
    tmux split-window -h -d -t "$TMUX_SESSION:agents" "env LAB_PANE=B bash --noprofile --rcfile '$DRIVE_DIR/bashrc' -i"
    tmux set-option -t "$TMUX_SESSION" status off >/dev/null
    echo "OK    tmux session $TMUX_SESSION: window main, window agents (A left, B right)"
  fi
  echo "Next: in the terminal you will share, run:  tmux attach -t $TMUX_SESSION"
}

drive_status() {
  drive_req GET /api/remote/status || return 1
  printf '%s\n' "$BODY"
  if need_stage 2>/dev/null; then
    local n; n="$(tmux display -p -t "$TMUX_SESSION" '#{session_attached}')"
    if [ "${n:-0}" -gt 0 ]; then echo "OK    tmux session $TMUX_SESSION attached ($n terminal)"
    else echo "FAIL  tmux session $TMUX_SESSION is not attached: run tmux attach -t $TMUX_SESSION in the shared terminal"; fi
  else
    echo "FAIL  no tmux session $TMUX_SESSION: run ./lab.sh drive stage"
  fi
  grep -q '^FAIL' <<<"$BODY" && return 1
  return 0
}

# Wait for the outcome of a console command, in 25 s long polls.
drive_wait() {
  while :; do
    drive_req GET "/api/remote/result/$1?wait=25000" || return 1
    [ "$CODE" = "202" ] || break
  done
  printf '%s\n' "$BODY"
  case "$BODY" in OK*) return 0 ;; *) return 1 ;; esac
}

drive_console() {
  [ $# -ge 2 ] || usage
  local demo="$1" step="$2" action=run wait=1
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --skip) action=skip ;; --show) action=show ;; --nowait) wait=0 ;; *) usage ;;
    esac
    shift
  done
  drive_req POST "/api/remote/$demo/$step/$action" || return 1
  local seq="$BODY"
  if [ "$wait" = 0 ]; then echo "INFO  $demo $step started; ./lab.sh drive wait $seq waits for it"; return 0; fi
  drive_wait "$seq"
}

# Type a command into the shared pane (main, or A/B for D7), wait for its
# prompt to come back, then print the pane's last lines and the exit status.
drive_term() {
  local pane=main target="$TMUX_SESSION:main"
  case "${1:-}" in
    A) pane=A; target="$TMUX_SESSION:agents.0"; shift ;;
    B) pane=B; target="$TMUX_SESSION:agents.1"; shift ;;
  esac
  [ $# -eq 1 ] || usage
  need_stage || return 1
  local f="$DRIVE_DIR/prompt-$pane" before after status
  before="$(cut -d' ' -f1 "$f" 2>/dev/null)"
  tmux select-window -t "${target%.*}"
  [ "$pane" = main ] || tmux select-pane -t "$target"
  tmux send-keys -t "$target" -l -- "$1"
  tmux send-keys -t "$target" Enter
  local limit=$((SECONDS + ${DRIVE_TIMEOUT:-900}))
  while :; do
    after="$(cut -d' ' -f1 "$f" 2>/dev/null)"
    [ -n "$after" ] && [ "$after" != "$before" ] && break
    [ "$SECONDS" -lt "$limit" ] || { echo "FAIL  still running after ${DRIVE_TIMEOUT:-900} s: look at the terminal" >&2; return 1; }
    sleep 0.3
  done
  status="$(cut -d' ' -f2 "$f")"
  tmux capture-pane -p -J -t "$target" -S -60 | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' | tail -n "${DRIVE_LINES:-20}"
  if [ "$status" = 0 ]; then echo "OK    exit 0"; else echo "FAIL  exit $status"; return 1; fi
}

cmd_drive() {
  local sub="${1:-}"; [ $# -gt 0 ] && shift
  case "$sub" in
    stage)   drive_stage ;;
    status)  drive_status ;;
    plan)    [ $# -eq 1 ] || usage; drive_req GET "/api/remote/plan/$1" && printf '%s\n' "$BODY" ;;
    console) drive_console "$@" ;;
    wait)    [ $# -eq 1 ] || usage; drive_wait "$1" ;;
    term)    drive_term "$@" ;;
    *)       usage ;;
  esac
}

usage() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
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
      # Fresh volumes, fresh app: back on the MongoDB source in normal mode,
      # whatever backend or age-out mode the last run left in app.env.
      compose --profile d4 down -v && write_app_env mongo && compose up -d && cmd_check
    else
      # D4's replicator runs in its own container; stop it before the reset.
      [ "$1" = "d4" ] && repl_stop >/dev/null
      run_demo_cli "$1" --reset
    fi ;;
  demo)      [ $# -ge 1 ] || usage; run_demo_cli "$@" ;;
  generate)  run_node gen/generate.mjs "$@" ;;
  mongosh)   [ $# -ge 1 ] || usage; cmd_mongosh "$@" ;;
  exec)      [ $# -ge 2 ] || usage; lab_exec "$@" ;;
  app-uri)   [ $# -eq 1 ] || usage; cmd_app_uri "$1" ;;
  app-mode)  [ $# -eq 1 ] || usage; cmd_app_mode "$1" ;;
  agent)     [ $# -ge 1 ] || usage; run_node demos/d7-etag/agent.mjs "$@" ;;
  migrate-entities) [ $# -eq 0 ] || usage; run_node demos/d2-ageout/migrate-cli.mjs ;;
  mongorestore-ora) cmd_mongorestore_ora "$@" ;;
  repl)      [ $# -eq 1 ] || usage; cmd_repl "$1" ;;
  bake-recordings) cmd_bake_recordings ;;
  drive)     cmd_drive "$@" ;;
  *)         usage ;;
esac
