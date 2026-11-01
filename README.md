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
| `app` | `lab-app` | Order service the demos drive (its backend is switchable) |
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
| 3300 | Order service app |

## One-time setup on the Mac (Apple silicon)

1. Install Podman and create a machine big enough for Oracle:

   ```sh
   podman machine init --cpus 6 --memory 16384 --disk-size 60
   podman machine start
   ```

2. With network, fetch and build the images:

   ```sh
   ./lab.sh pull
   ./lab.sh build
   ```

3. Confirm the laptop is ready: `./lab.sh preflight`. It checks the CPU is
   arm64, the Podman machine has at least 12 GB of memory, every image is
   present, and nothing else is listening on the lab ports.

That is all a presenter needs: Podman. Node is not required on the laptop.
Demos, resets, the data generator and every terminal command run inside the
lab containers. Node.js 22 or newer (plus `npm install`) is only for
developers who run the test suite (see Tests).

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
| `./lab.sh demo dN [--step S]` | Run a demo from the terminal (`--help` for usage) |
| `./lab.sh generate [--scale S]` | Load the deterministic dataset into the MongoDB source (`--scale demo` by default, `--seed N` to change the seed) |
| `./lab.sh mongosh src [args...]` | mongosh against the MongoDB source (`telco`), run inside `lab-mongo` |
| `./lab.sh mongosh ora [args...]` | mongosh against the Oracle API for MongoDB as `MIG`, run inside `lab-oracle` |
| `./lab.sh exec <service> <cmd...>` | Run a command inside a lab container, for example `./lab.sh exec mongo mongosh` |
| `./lab.sh app-uri <mongo\|oracle>` | Point the order service at MongoDB or at the Oracle API for MongoDB, then restart it |

`demo`, `reset dN` and `generate` run Node inside the `lab-app` container, so
the stack must be up. Their code (`lib/`, `gen/`, `oracle/`, `app/`,
`demos/`) is baked into the app image, not mounted, so after changing any of
it run `./lab.sh build` and `./lab.sh up` again. Developers can run them with
the host's Node instead by setting `LAB_HOST_NODE=1`.

Example terminal commands:

```sh
./lab.sh mongosh src --eval 'db.orders.countDocuments()'
./lab.sh mongosh ora --eval 'db.getCollectionNames()'
```

The first Oracle boot can take a few minutes. Run `./lab.sh check` after
`./lab.sh up` and wait for four `OK` lines.

## Dataset

`./lab.sh generate --seed 20261114 --scale demo` drops the MongoDB
database `telco` and loads a deterministic telecom dataset: the same seed always
gives the same documents (only `carts.updatedAt` and `orderEvents.createdAt`
follow the load clock). On the
Linux lab it builds and loads in about 7 s.

| Collection | `demo` | `tiny` (unit tests) |
|---|---|---|
| `regions` | 8 | 8 |
| `catalog` (120 devices, 60 plans, 120 add-ons) | 300 | 300 |
| `accounts` (family plans up to 3 levels) | 20,000 | 200 |
| `subscribers` | 30,000 | 300 |
| `orders` | 200,000 | 2,000 |
| `carts` (TTL 120 s on `updatedAt`) | 5,000 | 50 |
| `orderEvents` (TTL 7 days on `createdAt`) | 300,000 | 3,000 |
| `regionTopDevices` (Top 10 devices per region) | 8 | 8 |

Planted BSON types a migration has to carry: `catalog.skuPattern` is a regular
expression, `orders.version` is a 64-bit integer (one order holds
9007199254740993, more than 2^53), `orderEvents.ts` is a BSON Timestamp, and
prices and totals are Decimal128.

Carts get `updatedAt` spread from 2 minutes before the load to 58 minutes after
it, so they expire steadily over the first hour. Each order event gets a
`createdAt` Date between 7 days before the load and the load itself, so the event
log ages out steadily over the next week. The TTL index sits on `createdAt`
because a TTL index only expires Date values; `ts` stays a BSON Timestamp.

## Oracle target prep

Before any data moves, the target collections are created explicitly in SQL,
never by a first write through the MongoDB API (implicit schema creation is a
known ORA-00600 risk once supplemental logging is on).
`oracle/sql/00-target-prep.sql` creates one JSON collection table per source
collection in the `MIG` schema, with quoted names that match the MongoDB
collection names exactly (`"orderEvents"`, `"regionTopDevices"`).
`prepareTarget({ drop })` in `oracle/prep.mjs` runs it (dropping the tables
first when `drop` is true, for an empty target) and confirms `MIG` is
ORDS-enabled through `user_ords_schemas`. It is idempotent and
shared by demos 2, 3 and 4. Indexes are not created here: `mongorestore` carries them.

## Order service app

`app/server.mjs` is a small order service written the way a typical MongoDB
app is written (`find`, `insertOne`, `updateOne` with `$set`, `$inc`, `$push`,
`$sort`, `$slice`). Its only setting is `APP_MONGO_URI`, which is what demos 3
and 4 flip. It is built into its own image (`docker/app/Dockerfile`, which runs
`npm ci` inside the image), so the laptop needs only Podman: `./lab.sh build`
builds it and `./lab.sh preflight` checks it is present. Rebuild after changing
the app code. In compose it reads `.lab/app.env`; `./lab.sh app-uri oracle`
rewrites that file and recreates the container.

| Route | What it does |
|---|---|
| `GET /orders/:id` | One order, as canonical Extended JSON (Decimal128 totals, Int64 versions) |
| `POST /orders` | Body `{subscriberId, lines: [{sku, qty}]}`. Writes the order, its `orderEvents` entry, and keeps the region's Top 10 in `regionTopDevices` exact. Returns `{_id}` |
| `PATCH /orders/:id` | Body `{status}` and/or `{deviceSwap: {from, to}}` |
| `GET /dashboard/top-devices/:region` | The region's Top 10 devices |
| `GET /health` | `{backend: 'mongodb' or 'oracle', ok}` |

`/health` tells the backends apart through `buildInfo`: MongoDB includes a
`gitVersion`, the Oracle API for MongoDB reports only a MongoDB-compatible
version (7.0.22 on 26ai Free) and names itself through `serverStatus.ordsVersion`.

## Tests

Developers only: needs Node.js 22 or newer and `npm install` on the host. The
tests run Node on the host (`LAB_HOST_NODE=1` where they call `lab.sh`).

```sh
npm test                 # everything (integration tests need the stack up)
npm run test:unit
npm run lint:copy        # copy rules: no em dashes, say 26ai, no private references
```
