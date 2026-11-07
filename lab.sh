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
#   ./lab.sh launch [--notes|--check]  instructor setup: full reset, data, tmux, console + notes + terminal + deck windows (macOS)
#   ./lab.sh shutdown [--wipe]     close the lab windows, end tmux, stop the stack (--wipe: delete the data)
#   ./lab.sh drive focus console|term|home  bring the console tab, the tmux terminal, or this session's terminal to the front (macOS)
#   ./lab.sh drive autopilot start|stop|status|run  the clicker drives the demos (launch starts it)
#   ./lab.sh drive demo|slides     demo start (notes stay on the laptop) / demo end (deck in front on the shared display, in focus)
# demo, reset dN, generate and agent run Node in a one-off runner container (the app
# image), so the laptop needs no Node. LAB_HOST_NODE=1 uses the host's node.
set -uo pipefail
cd "$(dirname "$0")"

# Engine: PODMAN=1 forces podman; otherwise podman when on PATH, else docker.
if [ "${PODMAN:-}" = "1" ] || command -v podman >/dev/null 2>&1; then
  ENGINE=podman
  # No ">>>> Executing external compose provider" banner on every command.
  export PODMAN_COMPOSE_WARNING_LOGS=false
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
# What the switch changed, for the audience: the connection string (password
# as ****) and what the running service reports now. Silent when /health doesn't
# answer.
describe_backend() {
  echo "  connection string: $(app_uri "$1" | sed -E 's#(mongodb://[^:/@]+:)[^@]*@#\1****@#; s#%24#$#g')"
  echo "  only the connection string changed: same code, no restart, no redeploy"
  BODY="$(curl -sf --max-time 5 "$APP_URL/health" 2>/dev/null)" || return 0
  local v o; v="$(json_field version)"; o="$(json_field ordsVersion)"
  echo "  the service now reports: backend $(json_field backend), server version $v${o:+, served by ORDS $o}"
}

cmd_app_uri() {
  app_uri "$1" >/dev/null || usage
  post_backend "$1"
  if [ "$RC" -eq 0 ] && [ "$CODE" = "200" ]; then
    write_app_env "$1"
    echo "order service now uses $1 (127.0.0.1:3300)"
    describe_backend "$1"
  elif [ "$RC" -eq 7 ]; then
    write_app_env "$1"
    echo "order service is not running; starting it on $1" >&2
    compose up -d --no-deps app && echo "order service now uses $1 (127.0.0.1:3300)" && describe_backend "$1"
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

export MIG_PASSWORD="${MIG_PASSWORD:-MigUser2026}"
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
  # The password reaches the runner through compose.yml's ${MIG_PASSWORD} (exported
  # above), never on this command line: podman-compose prints the command when it fails.
  compose --profile runner run --rm --no-deps $tty runner node "$@"
}

# mongorestore into the Oracle API for MongoDB as MIG, from lab-mongo over the
# compose network. The URI is built here from MIG_PASSWORD so no typed command,
# slide or console step shows the password. No database in the URI path: with
# /MIG mongorestore restores 0 documents and still exits 0 (Ruling Q).
# Its last line is the wall time on this laptop, so the presenter reads the
# restore time off the screen live (D3) instead of quoting a fixed number.
# On a terminal, the tool's real command line (password as ****), then its log
# without the timestamps: the audience reads it, and a long log scrolls the
# typed command away. Piped (the vitest suite, the console), it passes through
# untouched. Called as: tool_log lab_exec SERVICE TOOL ARGS...
# A command line as you would type it: plain words bare, the rest single-quoted.
shell_words() {
  local a out="" sq="'" esc="'\\''"
  for a in "$@"; do
    case "$a" in
      *[!A-Za-z0-9_@%+=:,./-]*|'') out+=" '${a//$sq/$esc}'" ;;
      *) out+=" $a" ;;
    esac
  done
  printf '%s' "${out# }"
}

tool_log() {
  if [ -t 1 ]; then
    printf '  runs: %s (in lab-%s)\n\n' "$(shell_words "${@:3}")" "$2" | sed -E 's#(mongodb://[^:/@]+:)[^@]*@#\1****@#g'
    "$@" 2>&1 | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+[+-][0-9]{4}[[:space:]]+//'
    return "${PIPESTATUS[0]}"
  fi
  "$@"
}

cmd_mongorestore_ora() {
  local start=$SECONDS rc=0
  tool_log lab_exec mongo mongorestore "$@" \
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
  local target="$1" uri svc what; shift
  case "$target" in
    src) svc=mongo; uri='mongodb://localhost:27017/telco?replicaSet=rs0&directConnection=true'
         what='the MongoDB source: replica set rs0, database telco' ;;
    ora) svc=oracle; uri="mongodb://MIG:${MIG_PASSWORD}@localhost:27017/MIG?authMechanism=PLAIN&authSource=\$external&tls=false&retryWrites=false&loadBalanced=true"
         what='Oracle 26ai through the Oracle API for MongoDB (ORDS, port 27017), as database user MIG' ;;
    *)   usage ;;
  esac
  # On a terminal, say what this mongosh is connected to: the audience sees
  # stock mongosh and a standard connection string, nothing Oracle-specific.
  if [ -t 1 ]; then
    echo "  runs: mongosh <connection string> $(shell_words "$@") (in lab-$svc)"
    echo "  connection string: $(printf '%s' "$uri" | sed -E 's#(mongodb://[^:/@]+:)[^@]*@#\1****@#')"
    echo "  connected to: $what"
  fi
  case "$target" in
    src) lab_exec mongo mongosh "$uri" "$@" ;;
    ora) LAB_EXEC_WORKDIR=/opt/lab lab_exec oracle mongosh "$uri" "$@" ;;
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
  drive_bind_keys
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
  # Clear the pane first (Ctrl-L at the prompt, then the scrollback), so the
  # audience sees only this command and its output.
  tmux send-keys -t "$target" C-l
  sleep 0.2
  tmux clear-history -t "$target"
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

# One shared screen: bring the window the audience needs to the front, so the
# presenter never switches windows. macOS only (AppleScript): the console tab
# in Chrome, or the Terminal tab attached to the tmux session.
# Terminal.app window holding the tab on tty $1: "front" selects the tab and
# brings the window to the front (un-minimized); "min" minimizes it.
term_window() {
  osascript - "$1" "${2:-front}" <<'OSA' >/dev/null
on run argv
  set d to item 1 of argv
  set act to item 2 of argv
  tell application "Terminal"
    -- Hold the window by id: "repeat with w in windows" is a reference by
    -- position, and un-minimizing reorders the windows under it.
    set wid to missing value
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is d then
          set wid to id of w
          set selected of t to true
          exit repeat
        end if
      end repeat
      if wid is not missing value then exit repeat
    end repeat
    if wid is missing value then error "no tab"
    if act is "min" then
      set miniaturized of window id wid to true
    else
      set miniaturized of window id wid to false
      set index of window id wid to 1
      activate
    end if
    return "ok"
  end tell
  error "no tab"
end run
OSA
}
focus_tty() { term_window "$1" front; }
lab_tty() { tmux list-clients -t "$TMUX_SESSION" -F '#{client_tty}' 2>/dev/null | head -1; }

# The terminal this command was started from (Claude's own session): the
# first ancestor process that has a tty. Prints /dev/ttysNNN.
home_tty() {
  local p=$$ t=""
  while [ "${p:-1}" -gt 1 ]; do
    t="$(ps -o tty= -p "$p" | tr -d ' ')"
    case "$t" in ''|'??') p="$(ps -o ppid= -p "$p" | tr -d ' ')" ;; *) break ;; esac
  done
  case "$t" in ''|'??') return 1 ;; esac
  echo "/dev/$t"
}

# Claude's terminal window follows the speaker notes: on the notes' display,
# at their upper left, sized to cover the speaker view's current-slide
# preview (LAB_NOTES_PREVIEW: its width and height in % of the view, 45 50 for
# the tall layout; LAB_NOTES_CHROME: the popup's title and address bars, px).
# No notes window: nothing moves.
claude_place() {
  [ "$(uname)" = Darwin ] || return 0
  local t nb; t="$(home_tty)" || return 0
  nb="$(osascript -e 'tell application "Google Chrome" to get bounds of (first window whose title of active tab is "'"$NOTES_TITLE"'")' 2>/dev/null | tr -d ' ')" || return 0
  [ -n "$nb" ] || return 0
  local l tp r b px py ch
  IFS=, read -r l tp r b <<<"$nb"
  read -r px py <<<"${LAB_NOTES_PREVIEW:-45 50}"
  ch="${LAB_NOTES_CHROME:-56}"
  osascript - "$t" "$l" "$tp" "$((l + (r - l) * px / 100))" "$((tp + ch + (b - tp - ch) * py / 100))" <<'OSA' >/dev/null 2>&1
on run argv
  tell application "Terminal"
    set ids to id of every window
    repeat with i in ids
      set w to window id (contents of i)
      repeat with tb in tabs of w
        if tty of tb is (item 1 of argv) then
          set bounds of w to {(item 2 of argv) as integer, (item 3 of argv) as integer, (item 4 of argv) as integer, (item 5 of argv) as integer}
          return "ok"
        end if
      end repeat
    end repeat
  end tell
end run
OSA
}

# Chrome to the front with only its main window raised (window index 1):
# AppleScript's activate raises every Chrome window, the notes too, above
# Claude's terminal.
chrome_activate_main() {
  osascript -l JavaScript -e 'ObjC.import("AppKit"); var a = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.google.Chrome"); if (a.count > 0) a.objectAtIndex(0).activateWithOptions(0); ""' >/dev/null
}

drive_focus() {
  mkdir -p "$DRIVE_DIR"
  [ "$(uname)" = Darwin ] || { echo "FAIL  drive focus needs macOS: switch the window by hand" >&2; return 1; }
  case "${1:-}" in
    console)
      osascript - "$CONSOLE_URL" <<'OSA' >/dev/null || { echo "FAIL  no console tab in Chrome: open $CONSOLE_URL" >&2; return 1; }
on run argv
  set u to item 1 of argv
  tell application "Google Chrome"
    repeat with w in windows
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        if URL of t starts with u then
          set active tab index of w to i
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  error "no tab"
end run
OSA
      # Terminal.app raises all its windows when it activates (focus home):
      # keep the tmux window minimized while the console is the one on show.
      local lt; lt="$(lab_tty)"; [ -n "$lt" ] && term_window "$lt" min
      echo console > "$DRIVE_DIR/focus"
      echo "OK    console in front" ;;
    term)
      local tty; tty="$(lab_tty)"
      [ -n "$tty" ] || { echo "FAIL  no terminal attached: run tmux attach -t $TMUX_SESSION" >&2; return 1; }
      focus_tty "$tty" || { echo "FAIL  the tmux terminal is not a Terminal.app tab: switch by hand" >&2; return 1; }
      echo term > "$DRIVE_DIR/focus"
      echo "OK    terminal in front" ;;
    home)
      local t; t="$(home_tty)" || { echo "FAIL  no terminal found for this session" >&2; return 1; }
      t="${t#/dev/}"
      claude_place
      focus_tty "/dev/$t" || { echo "FAIL  /dev/$t is not a Terminal.app tab: switch by hand" >&2; return 1; }
      # Activating Terminal raises the tmux window too: minimize it again
      # unless it is the window on show.
      if [ "$(cat "$DRIVE_DIR/focus" 2>/dev/null)" != term ]; then
        local lt; lt="$(lab_tty)"; [ -n "$lt" ] && [ "$lt" != "/dev/$t" ] && term_window "$lt" min
      fi
      echo "OK    back to /dev/$t" ;;
    *) usage ;;
  esac
}

# One shared display (the external, or the only one): the deck, the console and
# the tmux terminal all live there, full size, and the presenter shares it once
# (in the room or in Zoom). The speaker notes stay on the laptop for the whole
# session. Between demos the deck is in front with the focus; during a demo the
# console or the terminal comes in front (drive focus). Nobody switches shares.
#   demo:   the notes on the laptop; the window a step uses comes up with focus.
#   slides: the notes on the laptop; tmux minimized, the deck in front with the
#           focus (the presenter's clicker).
drive_notes_home() {
  local screens box
  screens="$(launch_screens)" || { echo "FAIL  could not read the displays" >&2; return 1; }
  box="$(sed -n 's/^laptop //p' <<<"$screens")"
  osascript - "$NOTES_TITLE" "$box" <<'OSA' >/dev/null || { echo "FAIL  no speaker notes window: ./lab.sh launch --notes" >&2; return 1; }
on run argv
  set AppleScript's text item delimiters to " "
  set p to text items of (item 2 of argv)
  set AppleScript's text item delimiters to ""
  tell application "Google Chrome"
    set ids to id of every window
    repeat with i in ids
      set w to window id (contents of i)
      if title of active tab of w is (item 1 of argv) then
        set bounds of w to {(item 1 of p) as integer, (item 2 of p) as integer, (item 3 of p) as integer, (item 4 of p) as integer}
        return "ok"
      end if
    end repeat
  end tell
  error "no notes"
end run
OSA
}

drive_mode() {
  [ "$(uname)" = Darwin ] || { echo "FAIL  drive $1 needs macOS" >&2; return 1; }
  drive_notes_home || return 1
  mkdir -p "$DRIVE_DIR"
  case "$1" in
    demo)
      echo present > "$DRIVE_DIR/focus"
      echo "OK    demo on: the speaker notes stay on the laptop; the console or terminal comes up on the shared display" ;;
    slides)
      local lt; lt="$(lab_tty)"; [ -n "$lt" ] && term_window "$lt" min
      echo present > "$DRIVE_DIR/focus"
      local w; w="$(launch_window_ids)" || { echo "FAIL  no deck window: ./lab.sh launch" >&2; return 1; }
      launch_focus_deck "${w#* }" >/dev/null || return 1
      echo "OK    deck in front on the shared display, with the focus" ;;
    *) usage ;;
  esac
}

# ---------- autopilot: the presenter's clicker drives the demos ----------
# The clicker's next (Right arrow) reaches the console server from whichever
# window has the focus: the deck on a demo slide, the console page, or the
# tmux terminal (a key binding below). This loop on the host takes each press:
#   deck, demo slide dN  -> demo on: step 1's window in front
#   each press after it  -> the next step runs (terminal: typed, then Mark done)
#   a press after a FAIL -> that step's rehearsal result (--skip)
#   the press after the last step -> back to the deck, in front with the focus
# D2 and D4 reset in the background once the deck is back; D5's end starts
# D6 step 1 in the background. Presses during a step are dropped.
# Log: .lab/drive/autopilot.log (Claude watches it and relays each result).
AP_PAT='^ *[0-9]+  ([^ ]+)  (console|terminal)  (.*)$'
AP_CMD_PAT='^ +\$ (.*)$'

ap_log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" >> "$DRIVE_DIR/autopilot.log"; }

# The steps of demo $1 into AP_IDS, AP_LANES, AP_TITLES, AP_CMDS.
ap_plan() {
  drive_req GET "/api/remote/plan/$1" 2>/dev/null || return 1
  AP_IDS=(); AP_LANES=(); AP_TITLES=(); AP_CMDS=()
  local line
  while IFS= read -r line; do
    if [[ "$line" =~ $AP_PAT ]]; then
      AP_IDS+=("${BASH_REMATCH[1]}"); AP_LANES+=("${BASH_REMATCH[2]}")
      AP_TITLES+=("${BASH_REMATCH[3]}"); AP_CMDS+=("")
    elif [[ "$line" =~ $AP_CMD_PAT ]] && [ "${#AP_CMDS[@]}" -gt 0 ]; then
      AP_CMDS[${#AP_CMDS[@]}-1]="${BASH_REMATCH[1]}"
    fi
  done <<<"$BODY"
  [ "${#AP_IDS[@]}" -gt 0 ]
}

# Step $1 (1-based): its window to the front of the shared display, then the
# keyboard focus to the speaker notes on the laptop (Chrome raised by its
# key window only, so the shared display keeps the console or the terminal).
# The notes send every next to the autopilot; Terminal.app is never asked to
# take the keys (it would keep Page Down, and its focus can stay elsewhere).
ap_focus() {
  drive_focus "$([ "${AP_LANES[$1-1]}" = terminal ] && echo term || echo console)" >/dev/null 2>&1
  osascript -e "tell application \"Google Chrome\" to set index of (first window whose title of active tab is \"$NOTES_TITLE\") to 1" >/dev/null 2>&1 \
    && chrome_activate_main
}

# The demo running ('' between demos), for the deck and the notes.
ap_state() { curl -s --max-time 5 -o /dev/null -X POST "$CONSOLE_URL/api/remote/key/state?demo=$1" || true; }

# Step $1 (1-based) of AP_DEMO; $2 = skip shows the rehearsal result. Logs the outcome.
ap_run() {
  local i="$1" id="${AP_IDS[$1-1]}" lane="${AP_LANES[$1-1]}" cmd="${AP_CMDS[$1-1]}" out rc=0 tag
  tag="$AP_DEMO $i/${#AP_IDS[@]} $id"
  if [ "${2:-}" = skip ]; then
    out="$(drive_console "$AP_DEMO" "$id" --skip 2>&1)" || rc=1
    ap_log "$tag (rehearsal result): $(tail -1 <<<"$out")"; return "$rc"
  fi
  if [ "$lane" = terminal ]; then
    local pane=""
    case "$cmd" in *"--agent A"*) pane=A ;; *"--agent B"*) pane=B ;; esac
    out="$(drive_term $pane "$cmd" 2>&1)" || rc=1
    local took; took="$(grep -Eo 'restore took [0-9.]+ s' <<<"$out" | tail -1)"
    [ -n "$took" ] && ap_log "$tag: $took"
    if [ "$rc" != 0 ]; then ap_log "$tag: $(tail -1 <<<"$out") (next press: the rehearsal result)"; return 1; fi
    out="$(drive_console "$AP_DEMO" "$id" 2>&1)" || rc=1
  elif [ "$AP_DEMO" = d6 ] && [ "$i" = 1 ] && [ -n "${AP_D6_SEQ:-}" ]; then
    out="$(drive_wait "$AP_D6_SEQ" 2>&1)" || rc=1
    AP_D6_SEQ=""
  else
    out="$(drive_console "$AP_DEMO" "$id" 2>&1)" || rc=1
  fi
  ap_log "$tag: $(tail -1 <<<"$out")$([ "$rc" != 0 ] && echo ' (next press: the rehearsal result)')"
  return "$rc"
}

# Every tmux pane cleared (scrollback too), window main on show: each demo
# starts on a clean terminal.
drive_clear_tmux() {
  local pane
  for pane in main agents.0 agents.1; do
    tmux send-keys -t "$TMUX_SESSION:$pane" C-l 2>/dev/null
    tmux clear-history -t "$TMUX_SESSION:$pane" 2>/dev/null
  done
  tmux select-window -t "$TMUX_SESSION:main" 2>/dev/null
  return 0
}

ap_end() {
  drive_mode slides >/dev/null 2>&1 || ap_log "FAIL  could not bring the deck back: ./lab.sh drive slides"
  drive_clear_tmux
  ap_log "$AP_DEMO done: deck in front, tmux cleared"
  case "$AP_DEMO" in
    d2|d4) ap_log "$AP_DEMO reset running in the background"
           ( ./lab.sh reset "$AP_DEMO" >/dev/null 2>&1 && ap_log "$AP_DEMO reset OK" || ap_log "FAIL  $AP_DEMO reset: run ./lab.sh reset $AP_DEMO" ) & ;;
    d5) if ap_plan d6; then
          local o; o="$(drive_console d6 "${AP_IDS[0]}" --nowait 2>&1)"
          AP_D6_SEQ="$(grep -Eo 'drive wait [0-9]+' <<<"$o" | grep -Eo '[0-9]+$')"
          [ -n "$AP_D6_SEQ" ] && ap_log "d6 step 1 started in the background" || ap_log "FAIL  d6 step 1 did not start: $o"
        fi ;;
  esac
  AP_DEMO=""
  ap_state ""
}

drive_autopilot_loop() {
  mkdir -p "$DRIVE_DIR"
  AP_DEMO="" AP_I=0 AP_FAILED=0 AP_D6_SEQ=""
  ap_log "autopilot on"
  ap_state ""
  local from demo n
  while :; do
    if ! curl -s --max-time 30 -o "$DRIVE_DIR/key" -w '%{http_code}' "$CONSOLE_URL/api/remote/key?wait=25000" > "$DRIVE_DIR/key.code" 2>/dev/null; then
      sleep 2; continue
    fi
    [ "$(cat "$DRIVE_DIR/key.code")" = 200 ] || continue
    read -r from demo < "$DRIVE_DIR/key"
    if [ -z "$AP_DEMO" ]; then
      # Between demos only the deck's demo slides start one; stray presses are ignored.
      [ "$from" = deck ] && [ -n "${demo:-}" ] || continue
      if ! ap_plan "$demo"; then ap_log "FAIL  no plan for $demo"; drive_mode slides >/dev/null 2>&1; continue; fi
      AP_DEMO="$demo" AP_I=0 AP_FAILED=0
      ap_state "$demo"
      # The console on this demo's first step before it shows (not run), so it
      # never comes up on the last demo's result. D6 step 1 started at D5's end
      # has the console there already.
      [ "$demo" = d6 ] && [ -n "${AP_D6_SEQ:-}" ] || drive_console "$demo" "${AP_IDS[0]}" --show >/dev/null 2>&1
      drive_mode demo >/dev/null 2>&1
      ap_focus 1
      ap_log "$demo up: ${#AP_IDS[@]} steps; next press runs step 1 (${AP_IDS[0]})"
    else
      n="${#AP_IDS[@]}"
      if [ "$AP_FAILED" = 1 ]; then
        AP_FAILED=0; ap_run "$AP_I" skip
      elif [ "$AP_I" -lt "$n" ]; then
        AP_I=$((AP_I + 1))
        ap_focus "$AP_I"
        ap_run "$AP_I" || AP_FAILED=1
        [ "$AP_I" -lt "$n" ] || [ "$AP_FAILED" = 1 ] || ap_log "$AP_DEMO: last step done; next press goes back to the slides"
      else
        ap_end
      fi
    fi
    curl -s --max-time 5 -o /dev/null -X DELETE "$CONSOLE_URL/api/remote/key" || true
  done
}

# start | stop | status | run (foreground)
drive_autopilot() {
  mkdir -p "$DRIVE_DIR"
  local pidf="$DRIVE_DIR/autopilot.pid" pid
  pid="$(cat "$pidf" 2>/dev/null)"
  case "${1:-status}" in
    run) drive_autopilot_loop ;;
    start)
      [ -n "$pid" ] && kill "$pid" 2>/dev/null
      nohup ./lab.sh drive autopilot run >/dev/null 2>&1 &
      echo $! > "$pidf"
      echo "OK    autopilot on: the clicker drives the demos (log: $DRIVE_DIR/autopilot.log)" ;;
    stop)
      if [ -n "$pid" ] && kill "$pid" 2>/dev/null; then echo "OK    autopilot off"; else echo "OK    autopilot was not running"; fi
      rm -f "$pidf" ;;
    status)
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "OK    autopilot on (pid $pid)"; return 0; fi
      echo "FAIL  autopilot off: ./lab.sh drive autopilot start"; return 1 ;;
    *) usage ;;
  esac
}

# In the lab's tmux session, Right arrow (and Page Down) is the clicker's
# next: it goes to the console server, not to the shell. Other sessions keep
# their keys.
drive_bind_keys() {
  local k url="$CONSOLE_URL/api/remote/key?from=term"
  for k in Right NPage; do
    tmux bind-key -n "$k" if-shell -F "#{==:#{session_name},$TMUX_SESSION}" \
      "run-shell -b \"curl -s -o /dev/null -X POST '$url'\"" "send-keys $k"
  done
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
    focus)   [ $# -eq 1 ] || usage; drive_focus "$1" ;;
    demo|slides) drive_mode "$sub" ;;
    autopilot) drive_autopilot "$@" ;;
    # Older name: notes laptop = demo, notes external = slides.
    notes)   [ $# -eq 1 ] || usage; case "$1" in laptop) drive_mode demo ;; external) drive_mode slides ;; *) usage ;; esac ;;
    *)       usage ;;
  esac
}

# ---------- launch: the instructor's one-command setup (macOS windows) ----------
# Full reset (fresh volumes), data loaded, tmux staged, then the windows:
# the deck (in front, with the focus), the console and the tmux terminal on the
# external display, the one the presenter shares; the speaker notes on the laptop.
# One display: everything opens on it.
NOTES_TITLE='reveal.js - Speaker View'

# One line per display role: "laptop|external L T R B" (top-left coordinates,
# menu bar and Dock excluded). The laptop is the built-in screen, or the main
# screen when there is none; the external is the first other screen, or the
# laptop again when there is only one.
launch_screens() {
  osascript -l JavaScript <<'JXA'
ObjC.import('AppKit');
var s = $.NSScreen.screens, n = s.count, mainH = s.objectAtIndex(0).frame.size.height;
function box(i) {
  var v = s.objectAtIndex(i).visibleFrame, l = Math.round(v.origin.x),
      t = Math.round(mainH - (v.origin.y + v.size.height));
  return [l, t, l + Math.round(v.size.width), t + Math.round(v.size.height)].join(' ');
}
var lap = 0;
for (var i = 0; i < n; i++) {
  var nm = s.objectAtIndex(i).localizedName;
  if (nm && ObjC.unwrap(nm).indexOf('Built-in') >= 0) { lap = i; break; }
}
var ext = lap;
for (var j = 0; j < n; j++) if (j !== lap) { ext = j; break; }
'laptop ' + box(lap) + '\nexternal ' + box(ext) + '\ncount ' + n;
JXA
}

# Close the lab's Chrome tabs: the console, the deck and the speaker view.
launch_close_tabs() {
  # The deck by any path to this repo (it is often reached through a symlink).
  osascript - "$CONSOLE_URL" "/$(basename "$PWD")/deck/index.html" "$NOTES_TITLE" <<'OSA' >/dev/null
on run argv
  tell application "Google Chrome"
    set ids to id of every window
    repeat with i in ids
      set w to window id (contents of i)
      repeat with k from (count tabs of w) to 1 by -1
        set t to tab k of w
        set u to URL of t
        if u starts with (item 1 of argv) or (u starts with "file://" and u contains (item 2 of argv)) or title of t is (item 3 of argv) then close t
      end repeat
    end repeat
  end tell
end run
OSA
}

# Open URL $1 as a Chrome app window (--app: no address bar, no tabs), full
# size on the display box $2. A running Chrome takes the command line and
# opens the window itself. Prints the window id.
launch_app_window() {
  local before id="" limit=$((SECONDS + 15))
  before="$(osascript -e 'tell application "Google Chrome" to get id of every window' 2>/dev/null)"
  open -na "Google Chrome" --args --app="$1" || return 1
  while [ -z "$id" ] && [ "$SECONDS" -lt "$limit" ]; do
    sleep 0.5
    id="$(osascript - "$1" "$2" "$before" <<'OSA' 2>/dev/null
on run argv
  set AppleScript's text item delimiters to " "
  set p to text items of (item 2 of argv)
  set AppleScript's text item delimiters to ""
  tell application "Google Chrome"
    set ids to id of every window
    repeat with i in ids
      set w to window id (contents of i)
      if (item 3 of argv) does not contain ((id of w) as text) and URL of active tab of w starts with (item 1 of argv) then
        set bounds of w to {(item 1 of p) as integer, (item 2 of p) as integer, (item 3 of p) as integer, (item 4 of p) as integer}
        return (id of w) as text
      end if
    end repeat
  end tell
  error "not yet"
end run
OSA
)"
  done
  [ -n "$id" ] || return 1
  # Chrome can open a blank window along with the app window: close a new
  # window whose only tab is a New Tab page.
  osascript - "$before" <<'OSA' >/dev/null 2>&1
on run argv
  tell application "Google Chrome"
    set ids to id of every window
    repeat with i in ids
      set w to window id (contents of i)
      if (item 1 of argv) does not contain ((id of w) as text) and (count tabs of w) is 1 and URL of active tab of w is "chrome://newtab/" then close w
    end repeat
  end tell
end run
OSA
  echo "$id"
}

# Close earlier console, deck and speaker-view tabs, then open the console
# and the deck as app windows, both on the shared display.
# Prints "CONSOLE_ID DECK_ID".
launch_chrome() {
  local cid did
  launch_close_tabs || return 1
  cid="$(launch_app_window "$CONSOLE_URL/" "$2")" || return 1
  did="$(launch_app_window "$1" "$3")" || return 1
  echo "$cid $did"
}

# The speaker view window on the laptop display. Prints OK or FAIL.
launch_notes() {
  local did="$1" box="$2"
  # The deck opens the speaker view itself (?speaker=auto) when Chrome allows it
  # pop-ups; then System Events' S; then the presenter's S.
  if launch_place_notes "$box" 8; then return 0; fi
  if osascript - "$did" <<'OSA' >/dev/null 2>&1 && launch_place_notes "$box" 5; then return 0; fi
on run argv
  tell application "Google Chrome"
    set index of (window id ((item 1 of argv) as integer)) to 1
    activate
  end tell
  delay 0.5
  tell application "System Events" to keystroke "s"
end run
OSA
  echo "INFO  the deck could not open the speaker notes: allow pop-ups for it in Chrome (address bar icon), then press S in the deck (waiting 60 s)"
  launch_place_notes "$box" 60 && return 0
  echo "FAIL  no speaker view: allow pop-ups for the deck, press S in it, or run ./lab.sh launch --notes"
  return 1
}

# Wait up to $2 s for the speaker view window, then put it full size on the
# display box $1.
launch_place_notes() {
  local box="$1" limit=$((SECONDS + $2))
  while [ "$SECONDS" -lt "$limit" ]; do
    if osascript - "$NOTES_TITLE" "$box" <<'OSA' >/dev/null 2>&1; then
on run argv
  set AppleScript's text item delimiters to " "
  set p to text items of (item 2 of argv)
  set AppleScript's text item delimiters to ""
  tell application "Google Chrome"
    repeat with w in windows
      if title of active tab of w is (item 1 of argv) then
        set bounds of window id (id of w) to {(item 1 of p) as integer, (item 2 of p) as integer, (item 3 of p) as integer, (item 4 of p) as integer}
        return "ok"
      end if
    end repeat
  end tell
  error "not yet"
end run
OSA
      echo "OK    speaker notes: own window on the laptop display"; return 0
    fi
    sleep 0.5
  done
  return 1
}

# The tmux terminal: a new Terminal.app window on the external display, or the
# attached one moved there.
launch_terminal() {
  local box="$1" tty; tty="$(lab_tty)"
  if [ -z "$tty" ]; then
    osascript - "$PWD" "$TMUX_SESSION" <<'OSA' >/dev/null || return 1
on run argv
  tell application "Terminal"
    do script "cd " & quoted form of (item 1 of argv) & " && tmux attach -t " & (item 2 of argv)
  end tell
end run
OSA
    local limit=$((SECONDS + 10))
    while [ -z "$tty" ] && [ "$SECONDS" -lt "$limit" ]; do sleep 0.3; tty="$(lab_tty)"; done
    [ -n "$tty" ] || { echo "FAIL  the new terminal did not attach: run tmux attach -t $TMUX_SESSION"; return 1; }
  fi
  osascript - "$tty" "$box" "${LAB_TERM_PROFILE:-Clear Dark}" "${LAB_TERM_FONT_SIZE:-16}" <<'OSA' >/dev/null || { echo "FAIL  $tty is not a Terminal.app tab: move that window by hand"; return 1; }
on run argv
  set AppleScript's text item delimiters to " "
  set p to text items of (item 2 of argv)
  set AppleScript's text item delimiters to ""
  tell application "Terminal"
    set wid to missing value
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is (item 1 of argv) then set wid to id of w
      end repeat
    end repeat
    if wid is missing value then error "no tab"
    -- The shared terminal's look: the Clear Dark profile (LAB_TERM_PROFILE),
    -- skipped when this Mac has no profile by that name.
    try
      set current settings of (first tab of window id wid whose tty is (item 1 of argv)) to settings set (item 3 of argv)
      -- The audience reads it from the back of the room (LAB_TERM_FONT_SIZE).
      set font size of settings set (item 3 of argv) to ((item 4 of argv) as integer)
    end try
    set miniaturized of window id wid to false
    set bounds of window id wid to {(item 1 of p) as integer, (item 2 of p) as integer, (item 3 of p) as integer, (item 4 of p) as integer}
  end tell
end run
OSA
  echo "OK    terminal $tty attached to tmux session $TMUX_SESSION"
}

# Chrome window ids of the open console and deck tabs: "CONSOLE_ID DECK_ID".
launch_window_ids() {
  # The deck by any path to this repo: Chrome reports the symlink-resolved one.
  osascript - "$CONSOLE_URL" "/$(basename "$PWD")/deck/index.html" <<'OSA'
on run argv
  set c to ""
  set d to ""
  tell application "Google Chrome"
    repeat with w in windows
      repeat with t in tabs of w
        if c is "" and URL of t starts with (item 1 of argv) then set c to (id of w) as text
        if d is "" and URL of t starts with "file://" and URL of t contains (item 2 of argv) then set d to (id of w) as text
      end repeat
    end repeat
  end tell
  if c is "" or d is "" then error "missing"
  return c & " " & d
end run
OSA
}

# The lab off: its Chrome tabs closed, the tmux session ended (and its Terminal
# window closed when that is the window's only tab), the stack stopped.
# --wipe also deletes the data volumes.
cmd_shutdown() {
  local wipe=0 rc=0
  case "${1:-}" in --wipe) wipe=1 ;; '') ;; *) usage ;; esac
  drive_autopilot stop
  if [ "$(uname)" = Darwin ]; then
    launch_close_tabs && echo "OK    Chrome: console, deck and speaker notes closed" || { echo "FAIL  could not close the Chrome tabs"; rc=1; }
  fi
  if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    local tty; tty="$(lab_tty)"
    tmux kill-session -t "$TMUX_SESSION"
    if [ -n "$tty" ] && [ "$(uname)" = Darwin ]; then
      # Wait for the tmux client to exit: Terminal asks before closing a
      # window that still runs tmux, and that dialog would wait for a click.
      local n=0
      while ps -t "${tty#/dev/}" -o comm= 2>/dev/null | grep -q tmux && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
      local wid; wid="$(osascript - "$tty" <<'OSA' 2>/dev/null
on run argv
  tell application "Terminal"
    set ids to id of every window
    repeat with i in ids
      set w to window id (contents of i)
      if (count tabs of w) is 1 and tty of tab 1 of w is (item 1 of argv) then
        set wid to id of w
        close w
        return wid as text
      end if
    end repeat
  end tell
  return ""
end run
OSA
)"
      # Terminal can take several seconds to finish closing: wait for it.
      if [ -n "$wid" ]; then
        n=0
        # Closed means gone, or left in Terminal's window list with no tabs
        # (Terminal keeps a closed window there for a while, off screen).
        while [ "$(osascript -e "tell application \"Terminal\" to if exists window id $wid then count tabs of window id $wid" 2>/dev/null)" -gt 0 ] 2>/dev/null && [ "$n" -lt 30 ]; do sleep 0.5; n=$((n + 1)); done
        if [ "$n" -lt 30 ]; then echo "OK    tmux terminal window closed"
        else echo "FAIL  the tmux terminal window is still open: close it by hand"; rc=1; fi
      fi
    fi
    echo "OK    tmux session $TMUX_SESSION ended"
  else
    echo "OK    no tmux session $TMUX_SESSION"
  fi
  if [ "$wipe" = 1 ]; then
    compose --profile d4 down -v && echo "OK    stack stopped, data volumes deleted" || rc=1
  else
    compose --profile d4 down && echo "OK    stack stopped (volumes kept)" || rc=1
  fi
  return "$rc"
}

# The launch checklist, printed in the terminal that ran the launch: every
# line is checked live, not taken from the steps above. [x] passed, [ ] failed
# (with the fix). Returns the number of open items.
LAB_COLLECTIONS='regions catalog accounts subscribers orders carts orderEvents regionTopDevices'
ck() {   # status, label, fix (printed only when the item is open)
  if [ "$1" = 0 ]; then printf '  [x] %s\n' "$2"
  else printf '  [ ] %s%s\n' "$2" "${3:+   -> $3}"; CK_OPEN=$((CK_OPEN + 1)); fi
}
ck_counts() {   # $1 src|ora: "name=count ..." for the lab collections
  local js="var o=[]; '$LAB_COLLECTIONS'.split(' ').forEach(function(c){var n=0; try{n=db.getCollection(c).countDocuments({})}catch(e){} o.push(c+'='+n)}); print(o.join(' '))"
  case "$1" in
    src) lab_exec mongo mongosh --quiet 'mongodb://localhost:27017/telco?replicaSet=rs0&directConnection=true' --eval "$js" </dev/null ;;
    ora) lab_exec oracle mongosh --quiet "mongodb://MIG:${MIG_PASSWORD}@localhost:27017/MIG?authMechanism=PLAIN&authSource=\$external&tls=false&retryWrites=false&loadBalanced=true" --eval "$js" </dev/null ;;
  esac 2>/dev/null | tail -1
}
ck_get() { sed -nE "s/(^|.* )$2=([0-9]+).*/\2/p" <<<"$1"; }

launch_checklist() {
  CK_OPEN=0
  echo
  echo "Launch checklist"
  echo " Stack"
  probe_mongo;    ck $? "MongoDB source (rs0 primary, 127.0.0.1:27117)"
  probe_oracle;   ck $? "Oracle 26ai database (127.0.0.1:1523)"
  probe_ords;     ck $? "ORDS (127.0.0.1:8183)"
  probe_oramongo; ck $? "Oracle API for MongoDB (127.0.0.1:27119)"
  grep -q 'mongodb://mongo:27017/telco' "$APP_ENV" 2>/dev/null; ck $? "order service on the MongoDB source, normal mode" "./lab.sh reset d2"

  echo " Data"
  local src ora c n want bad=0 line="" sum=0
  src="$(ck_counts src)"
  for c in regions:8 catalog:300 accounts:20000 subscribers:30000 orders:200000 regionTopDevices:8; do
    n="$(ck_get "$src" "${c%%:*}")"; want="${c#*:}"
    [ "${n:-0}" = "$want" ] || bad=1
  done
  ck "$bad" "MongoDB source loaded: $(ck_get "$src" orders) orders, $(ck_get "$src" subscribers) subscribers, $(ck_get "$src" accounts) accounts, $(ck_get "$src" catalog) products, $(ck_get "$src" regions) regions" "./lab.sh generate"
  n="$(ck_get "$src" carts)"; [ "${n:-0}" -gt 0 ]; ck $? "carts still expiring live for D2: ${n:-0} left of 5,000" "./lab.sh generate"
  n="$(ck_get "$src" orderEvents)"; [ "${n:-0}" -gt 0 ]; ck $? "orderEvents: ${n:-0}"
  ora="$(ck_counts ora)"
  for c in $LAB_COLLECTIONS; do n="$(ck_get "$ora" "$c")"; sum=$((sum + ${n:-0})); done
  [ -n "$ora" ] && [ "$sum" = 0 ]; ck $? "Oracle MIG collections empty, ready for D2 (${sum} documents)" "./lab.sh reset d2"

  echo " Console and windows"
  drive_req GET /api/remote/status >/dev/null 2>&1 && grep -q '^OK    console page open' <<<"$BODY"; ck $? "console page open at $CONSOLE_URL" "reload it in Chrome"
  if [ "$(uname)" = Darwin ]; then
    local titles; titles="$(osascript -e 'tell application "Google Chrome" to get title of active tab of every window' 2>/dev/null)"
    grep -q 'Migration Deep Dive' <<<"$titles"; ck $? "deck window open (shared display)"
    grep -q "$NOTES_TITLE" <<<"$titles"; ck $? "speaker notes window open (laptop display)" "./lab.sh launch --notes"
  fi
  local tty; tty="$(lab_tty)"
  [ -n "$tty" ]; ck $? "tmux session $TMUX_SESSION attached on ${tty:-no terminal}" "./lab.sh launch"
  [ "$(tmux display -p -t "$TMUX_SESSION" '#{window_name}' 2>/dev/null)" = main ]; ck $? "tmux on window main, ready for D1"
  drive_autopilot status >/dev/null 2>&1; ck $? "autopilot on: the clicker drives the demos" "./lab.sh drive autopilot start"
  if [ "$(uname)" = Darwin ] && [ -n "$tty" ]; then
    local prof="${LAB_TERM_PROFILE:-Clear Dark}"
    [ "$(osascript - "$tty" <<'OSA' 2>/dev/null
on run argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is (item 1 of argv) then return name of current settings of t
      end repeat
    end repeat
  end tell
end run
OSA
)" = "$prof" ]; ck $? "tmux terminal uses the $prof profile" "./lab.sh launch"
  fi
  echo
  if [ "$CK_OPEN" = 0 ]; then echo "All checks passed: ready for D1."; else echo "$CK_OPEN item(s) open: fix them, then ./lab.sh launch --check"; fi
  return "$CK_OPEN"
}

# The deck in front on the shared display, with the focus (the presenter's
# clicker), raised alone so Claude's terminal stays above the notes.
launch_focus_deck() {
  osascript -e "tell application \"Google Chrome\" to set index of window id $1 to 1" >/dev/null 2>&1 \
    && chrome_activate_main || { echo "FAIL  could not focus the deck window"; return 1; }
  echo "OK    deck window in focus"
}

cmd_launch() {
  [ "$(uname)" = Darwin ] || { echo "FAIL  launch opens the windows with AppleScript: macOS only" >&2; return 1; }
  case "${1:-}" in
    --notes)
      # Retry the speaker notes only, on the windows already open.
      local w; w="$(launch_window_ids)" || { echo "FAIL  no console or deck window: run ./lab.sh launch"; return 1; }
      local lb; lb="$(launch_screens | sed -n 's/^laptop //p')"
      launch_notes "${w#* }" "$lb" || return 1
      drive_mode slides; return ;;
    --check) launch_checklist; return ;;
    '') ;;
    *) usage ;;
  esac
  # Always from scratch: fresh volumes (Oracle and ORDS rebuilt, the demo
  # state of any earlier rehearsal gone), the app back on the MongoDB source in
  # normal mode, then the data load.
  compose --profile d4 down -v && write_app_env mongo && compose up -d && cmd_check || return 1
  run_node gen/generate.mjs || { echo "FAIL  generate"; return 1; }
  drive_stage | grep -v '^Next:' || return 1
  # Ready for D1: window main on show, every pane cleared (scrollback too).
  drive_clear_tmux
  echo "OK    tmux on window main, panes cleared (ready for D1)"

  local screens ebox lbox n ids did rc=0
  screens="$(launch_screens)" || { echo "FAIL  could not read the displays"; return 1; }
  lbox="$(sed -n 's/^laptop //p' <<<"$screens")"
  ebox="$(sed -n 's/^external //p' <<<"$screens")"
  n="$(sed -n 's/^count //p' <<<"$screens")"
  if [ "$n" -gt 1 ]; then echo "OK    $n displays: deck, console and terminal on the external (share it), speaker notes on the laptop"
  else echo "INFO  one display: every window opens on it"; fi

  local deck_url="file://${PWD// /%20}/deck/index.html?speaker=auto"
  ids="$(launch_chrome "$deck_url" "$ebox" "$ebox")" || { echo "FAIL  could not open the Chrome windows"; return 1; }
  did="${ids#* }"
  echo "OK    Chrome app windows (no address bar): console ($CONSOLE_URL), deck"
  launch_notes "$did" "$lbox" || rc=1
  launch_terminal "$ebox" || rc=1

  # Shared display: the deck in front with the focus (console behind, tmux
  # minimized). Laptop: the speaker notes, Claude's terminal over the slide preview.
  drive_focus console >/dev/null || rc=1
  drive_mode slides >/dev/null || rc=1
  drive_autopilot start || rc=1
  echo "OK    deck in front on the shared display, in focus; speaker notes on the laptop (Claude's terminal over the slide preview)"
  launch_checklist || rc=1
  return "$rc"
}

usage() {
  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

# On a terminal, every command starts with its own command line in bold: a
# long output scrolls the typed line away, and the audience must see what
# caused what follows. Not for drive (Claude's side) or piped runs.
if [ -t 1 ] && [ $# -gt 0 ] && [ "$1" != "drive" ]; then
  printf '\n\033[1m$ ./lab.sh %s\033[0m\n' "$(shell_words "$@")"
fi

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
  exec)      [ $# -ge 2 ] || usage
             case "$2" in mongodump|mongorestore) tool_log lab_exec "$@" ;; *) lab_exec "$@" ;; esac ;;
  app-uri)   [ $# -eq 1 ] || usage; cmd_app_uri "$1" ;;
  app-mode)  [ $# -eq 1 ] || usage; cmd_app_mode "$1" ;;
  agent)     [ $# -ge 1 ] || usage; run_node demos/d7-etag/agent.mjs "$@" ;;
  migrate-entities) [ $# -eq 0 ] || usage; run_node demos/d2-ageout/migrate-cli.mjs ;;
  mongorestore-ora) cmd_mongorestore_ora "$@" ;;
  repl)      [ $# -eq 1 ] || usage; cmd_repl "$1" ;;
  bake-recordings) cmd_bake_recordings ;;
  drive)     cmd_drive "$@" ;;
  launch)    cmd_launch "$@" ;;
  shutdown)  cmd_shutdown "$@" ;;
  *)         usage ;;
esac
