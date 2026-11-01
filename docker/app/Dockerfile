# Node image for the lab's own services: the order service (app), the demo
# runner (Ruling O: `compose run runner`), the D4 replicator and, later, the
# web console (same image, different command). Dependencies are installed inside the image, so
# the laptop needs only Podman, not Node.
#
# Debian slim, not Alpine: the image also carries the MongoDB Database Tools
# (mongodump, mongorestore) and mongosh, so the runner can dump, restore and
# query over the compose network. MongoDB ships glibc builds of both for amd64
# and arm64; the tools have no Debian arm64 build, so arm64 takes the Ubuntu
# 22.04 one (needs glibc 2.34, Debian 12 has 2.36). Every download is pinned by
# version and SHA-256 and fetched only at build time.
#
# Build context is the repo root (see compose.yml); .dockerignore keeps
# node_modules, .git and .lab out of it. Demo, generator and target-prep code
# is baked in (nothing is bind-mounted), so rebuild with ./lab.sh build after
# changing it.
FROM docker.io/library/node:22-bookworm-slim

ARG TARGETARCH
ARG TOOLS_VERSION=100.20.0
ARG MONGOSH_VERSION=2.9.2

RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl libgssapi-krb5-2; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) tools="debian12-x86_64";  tools_sha=858d7bda37aa1ebb4c945887f639b28fc9910874693968d16979452ab807c55c; \
             sh="linux-x64";          sh_sha=b0febe385c10c9be755c29095ffa95a42bed16ea6625ea3fbde36ae33b42da79 ;; \
      arm64) tools="ubuntu2204-arm64"; tools_sha=cb3fc5ec3cba9513de078fa65a02b79eb670a03e28541287cf0fe9e705ea7661; \
             sh="linux-arm64";        sh_sha=e8cd0a2279acb6d29bdb0555457f6cfc6207dd95a40ed091b57318b4ed566104 ;; \
      *) echo "unsupported arch ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl -fsSL -o tools.tgz "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-${tools}-${TOOLS_VERSION}.tgz"; \
    echo "${tools_sha}  tools.tgz" | sha256sum -c -; \
    curl -fsSL -o mongosh.tgz "https://downloads.mongodb.com/compass/mongosh-${MONGOSH_VERSION}-${sh}.tgz"; \
    echo "${sh_sha}  mongosh.tgz" | sha256sum -c -; \
    tar xzf tools.tgz --strip-components=2 -C /usr/local/bin --wildcards '*/bin/*'; \
    tar xzf mongosh.tgz --strip-components=2 -C /usr/local/bin --wildcards '*/bin/*'; \
    rm -f tools.tgz mongosh.tgz; \
    apt-get purge -y curl; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*; \
    mongodump --version; mongorestore --version; mongosh --version; \
    mkdir -p /dumps /state && chown node:node /dumps /state

WORKDIR /lab
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY lib/ lib/
COPY gen/ gen/
COPY oracle/ oracle/
COPY app/ app/
COPY demos/ demos/
COPY replicator/ replicator/

ENV LAB_IN_CONTAINER=1 NODE_ENV=production
USER node
CMD ["node", "app/server.mjs"]
