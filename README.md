# MongoDB to Oracle Migration Lab

Lab stack and demos for the MongoDB to Oracle migration deep dive session. One
compose stack runs the migration source (MongoDB) and the target (Oracle AI
Database 26ai Free with ORDS and the Oracle API for MongoDB) on your laptop.
After a one-time setup it runs fully offline.

## What runs

| Service | Container | What it is |
|---|---|---|
| `mongo` | `lab-mongo` | MongoDB 8.2, single-node replica set `rs0` (the source) |
| `oracle` | `lab-oracle` | Oracle AI Database 26ai Free + ORDS + Oracle API for MongoDB (the target) |
| `console` | `lab-console` | Web console for the demos |
| `replicator` | `lab-replicator` | Stand-in for Oracle GoldenGate, used in demo 4 only (profile `d4`) |

The Oracle app schema is `MIG` (password from `MIG_PASSWORD`, default
`MigUser2026`). It is created and ORDS-enabled when the database first boots.

MongoDB is 8.2 rather than 8.0 because mongod 8.0 will not start on Linux
kernel 6.19 or newer (MongoDB issue SERVER-121912).

## Ports

Every port binds to `127.0.0.1` only. Nothing is published to the network.

| Host port | Service |
|---|---|
| 27117 | MongoDB source (`mongodb://localhost:27117/telco?replicaSet=rs0&directConnection=true`) |
| 1523 | Oracle SQL (`localhost:1523/FREEPDB1`) |
| 8183 | ORDS and Database Actions (`http://localhost:8183/ords/`) |
| 27119 | Oracle API for MongoDB |
| 3200 | Lab console |
| 3300 | Order service app (added with the demos) |

## One-time setup on the Mac (Apple silicon)

1. Install Podman and create a machine big enough for Oracle:

   ```sh
   podman machine init --cpus 6 --memory 16384 --disk-size 60
   podman machine start
   ```

2. Install Node.js 22 or newer, then the Node packages: `npm install`.
3. With network, fetch and build the images:

   ```sh
   ./lab.sh pull
   ./lab.sh build
   ```

4. Confirm the laptop is ready: `./lab.sh preflight`. It checks the CPU is
   arm64, the Podman machine has at least 12 GB of memory, every image is
   present, and nothing else is listening on the lab ports.

On Linux the same commands work with Docker. `lab.sh` uses `podman compose`
when `podman` is on your PATH (or `PODMAN=1` is set), otherwise `docker compose`.

## Everyday commands

| Command | What it does |
|---|---|
| `./lab.sh pull` | Pull the base images (needs network) |
| `./lab.sh build` | Build the lab images (needs network the first time) |
| `./lab.sh up` | Start the stack in the background |
| `./lab.sh check` | Wait up to 300 s until MongoDB, Oracle, ORDS and the Oracle API for MongoDB all answer; prints one line per service |
| `./lab.sh preflight` | Laptop readiness checks (see above) |
| `./lab.sh down` | Stop the stack and keep the data |
| `./lab.sh reset` | Wipe the lab data volumes and start fresh |
| `./lab.sh reset dN` | Reset one demo to its starting state |
| `./lab.sh demo dN [--step S]` | Run a demo from the terminal |
| `./lab.sh exec <service> <cmd...>` | Run a command inside a lab container, for example `./lab.sh exec mongo mongosh` |

The first Oracle boot can take a few minutes. Run `./lab.sh check` after
`./lab.sh up` and wait for four `OK` lines.

## Tests

```sh
npm test                 # everything (integration tests need the stack up)
npm run test:unit
npm run lint:copy        # copy rules: no em dashes, say 26ai, no private references
```
