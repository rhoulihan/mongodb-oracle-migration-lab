#!/bin/bash
# Start mongod as a replica set member, then initiate rs0 once (rs-init.js is a
# no-op when the set already exists, for example on a reused volume).
set -euo pipefail

docker-entrypoint.sh mongod --replSet rs0 --bind_ip_all \
  --setParameter ttlMonitorSleepSecs=5 &
MONGOD_PID=$!
trap 'kill -TERM "$MONGOD_PID" 2>/dev/null' TERM INT

until mongosh --quiet --eval 'db.adminCommand({ ping: 1 })' >/dev/null 2>&1; do
  kill -0 "$MONGOD_PID" 2>/dev/null || exit 1
  sleep 1
done
mongosh --quiet /lab/rs-init.js

wait "$MONGOD_PID"
