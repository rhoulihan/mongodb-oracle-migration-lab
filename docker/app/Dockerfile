# Node image for the lab's own services: the order service (app) now, and the
# web console later (same image, different command). Dependencies are
# installed inside the image, so the laptop needs only Podman, not Node.
# Build context is the repo root (see compose.yml); .dockerignore keeps
# node_modules, .git and .lab out of it.
FROM docker.io/library/node:22-alpine

WORKDIR /lab
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY lib/ lib/
COPY gen/ gen/
COPY app/ app/
COPY demos/ demos/

ENV LAB_IN_CONTAINER=1 NODE_ENV=production
USER node
CMD ["node", "app/server.mjs"]
