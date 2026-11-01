#!/bin/bash
# Custom entrypoint: start Oracle (via the gvenzl base entrypoint), then install/
# validate ORDS, ORDS-enable MIG, turn on the Oracle API for MongoDB (TLS off
# for local dev), and serve ORDS. Both processes are monitored.
set -uo pipefail

ORDS_CONFIG="/etc/ords/config"
ORDS_LOG="/tmp/ords.log"
ORACLE_PDB="FREEPDB1"
# Pool config lives in the container-local /etc/ords, not on the data volume, so a
# recreated container re-runs install (a no-op/validate against an existing schema).
ORDS_POOL_CONFIG="$ORDS_CONFIG/databases/default/pool.xml"

# Start Oracle in the background using the base image entrypoint.
/opt/oracle/container-entrypoint.sh &
ORACLE_PID=$!

# On stop (TERM/INT): stop ORDS, then hand TERM to the base entrypoint, whose own
# handler runs SHUTDOWN IMMEDIATE, and wait for it so the database closes cleanly.
on_stop() {
  echo "=== Stop requested: stopping ORDS and shutting down Oracle ==="
  [ -n "${ORDS_PID:-}" ] && kill -TERM "$ORDS_PID" 2>/dev/null
  kill -TERM "$ORACLE_PID" 2>/dev/null
  wait "$ORACLE_PID"
  exit 0
}
trap on_stop TERM INT

echo "=== Waiting for Oracle to be ready ==="
until /opt/oracle/healthcheck.sh > /dev/null 2>&1; do sleep 2; done
echo "=== Oracle is ready ==="

ADMIN_PWD="${ORACLE_PASSWORD:-Sandbox2026}"

# The base image runs initdb scripts only when the database is first created.
# Re-run the (idempotent) grants every boot so grants added since then, such as
# the measurement views, also reach an existing data volume.
echo "=== Applying MIG grants ==="
sqlplus -s / as sysdba < /container-entrypoint-initdb.d/01-grants.sql

if [ ! -f "$ORDS_POOL_CONFIG" ]; then
  echo "=== No ORDS pool config: installing/validating ORDS ==="

  # On a recreated container over an existing volume, the installer needs the
  # ORDS_PUBLIC_USER password to rebuild the local wallet, so reset it to a known
  # value so the non-interactive install can proceed.
  sqlplus -s / as sysdba <<SQL
ALTER SESSION SET CONTAINER = $ORACLE_PDB;
DECLARE c PLS_INTEGER;
BEGIN
  SELECT COUNT(*) INTO c FROM dba_users WHERE username = 'ORDS_PUBLIC_USER';
  IF c = 1 THEN
    EXECUTE IMMEDIATE 'ALTER USER ORDS_PUBLIC_USER IDENTIFIED BY "$ADMIN_PWD" ACCOUNT UNLOCK';
  END IF;
END;
/
SQL

  printf '%s\n%s\n' "$ADMIN_PWD" "$ADMIN_PWD" | ords --config "$ORDS_CONFIG" install \
    --db-hostname localhost \
    --db-port 1521 \
    --db-servicename "$ORACLE_PDB" \
    --admin-user SYS \
    --proxy-user \
    --password-stdin \
    --feature-sdw true \
    --feature-db-api true \
    --log-folder /tmp 2>&1 || {
      echo "=== ORDS install exited $?. Log tail: ==="
      tail -50 /tmp/*.log 2>/dev/null || true
    }
fi

# ORDS-enable MIG so its duality views + JSON collection tables surface as
# collections over the Mongo wire protocol. ENABLE_SCHEMA is an idempotent upsert.
echo "=== ORDS-enabling MIG schema ==="
sqlplus -s / as sysdba <<'SQL'
ALTER SESSION SET CONTAINER = FREEPDB1;
BEGIN
  ORDS_METADATA.ORDS_ADMIN.ENABLE_SCHEMA(p_enabled => TRUE, p_schema => 'MIG',
                     p_url_mapping_type => 'BASE_PATH',
                     p_url_mapping_pattern => 'mig', p_auto_rest_auth => FALSE);
  COMMIT;
END;
/
SQL

# Turn the Mongo API on, plaintext (local dev). NB: the key is mongo.tls, not
# mongo.tls.enabled. Re-run every boot: /etc/ords is container-local.
ords --config "$ORDS_CONFIG" config set mongo.enabled true
ords --config "$ORDS_CONFIG" config set mongo.port 27017
ords --config "$ORDS_CONFIG" config set mongo.tls false

echo "=== Starting ORDS ==="
ords --config "$ORDS_CONFIG" serve --port 8181 > "$ORDS_LOG" 2>&1 &
ORDS_PID=$!

echo "=== Waiting for ORDS health ==="
for i in $(seq 1 90); do
  if curl -sf -o /dev/null -w '%{http_code}' http://localhost:8181/ 2>/dev/null | grep -q '302\|200'; then
    echo "=== ORDS is healthy ==="; break
  fi
  [ "$i" -eq 90 ] && { echo "=== ORDS not healthy after 3 min. Log tail: ==="; tail -30 "$ORDS_LOG" 2>/dev/null || true; }
  sleep 2
done

echo "=== Oracle + ORDS running. Monitoring... ==="
while true; do
  if ! kill -0 "$ORACLE_PID" 2>/dev/null; then
    echo "=== Oracle process died ==="; kill "$ORDS_PID" 2>/dev/null || true; exit 1
  fi
  if ! kill -0 "$ORDS_PID" 2>/dev/null; then
    echo "=== ORDS died, restarting ==="
    ords --config "$ORDS_CONFIG" serve --port 8181 > "$ORDS_LOG" 2>&1 &
    ORDS_PID=$!
  fi
  sleep 5
done
