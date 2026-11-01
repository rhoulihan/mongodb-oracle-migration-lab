# MongoDB 8.2 source for the migration demos: a single-node replica set (rs0),
# so change streams work, plus the MongoDB Database Tools (mongodump, mongoexport).
# mongo:8.2, not 8.0: mongod 8.0 refuses to start on Linux kernel 6.19 and newer
# (SERVER-121912), which includes current Linux hosts and podman machine VMs.
# mongo:8.2 is multi-arch (amd64 + arm64). The MongoDB apt repo is already set up
# in the base image, and apt picks the package for the build architecture.
FROM docker.io/library/mongo:8.2

RUN apt-get update \
 && apt-get install -y --no-install-recommends mongodb-database-tools \
 && rm -rf /var/lib/apt/lists/*

COPY rs-init.js /lab/rs-init.js
COPY start.sh /lab/start.sh
RUN chmod +x /lab/start.sh

# ttlMonitorSleepSecs=5: the TTL monitor runs every 5 s instead of 60 s, so
# document expiry shows up live during the demo.
CMD ["/lab/start.sh"]
