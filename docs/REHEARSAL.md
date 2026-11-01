# Rehearsal and run sheet

For the presenter. You need a Mac with Apple silicon, Podman and Chrome.
Node isn't needed: every demo, reset and terminal command runs inside the
lab containers. Never type a password. The `./lab.sh` wrappers read it from
the environment, so no password ever shows on screen or in the deck.

## 1. Mac setup from zero (once, with network)

1. Install Podman. Use the installer from podman.io, or run
   `brew install podman`. Then install a compose provider for
   `podman compose`: `brew install docker-compose`.
2. Create and start a machine big enough for Oracle:

   ```sh
   podman machine init --cpus 6 --memory 16384 --disk-size 60
   podman machine start
   ```

3. Clone the lab and fetch everything it needs. This is the only step that
   needs the network:

   ```sh
   git clone https://github.com/rhoulihan/mongodb-oracle-migration-lab.git
   cd mongodb-oracle-migration-lab
   git checkout build/session-v1
   ./lab.sh pull && ./lab.sh build
   ./lab.sh up
   ./lab.sh check          # wait for four OK lines (the first Oracle boot takes a few minutes)
   ./lab.sh generate
   ```

4. Turn Wi-Fi off, then run `./lab.sh preflight`. Every line should read
   `OK`: CPU arm64, `podman compose` works, Podman machine memory at least 12288 MiB, all three lab
   images present, and each lab port either free or in use by this stack.

## 2. The "turn off Wi-Fi and rerun everything" check

Do this once at rehearsal, with Wi-Fi off the whole time:

1. `./lab.sh down`, then `./lab.sh up`, then `./lab.sh check`. You should
   get four OK lines.
2. `./lab.sh reset`, then `./lab.sh generate`.
3. Open the deck straight from disk in Chrome:
   `file:///<path>/mongodb-oracle-migration-lab/deck/index.html`. Press
   **S** for the speaker view. Every slide should render with its fonts and
   figures.
4. Open the console at http://127.0.0.1:3200. The four dots at the top
   should turn green.
5. Run the whole run sheet below, D1 to D7, in the console.
6. In each demo, click **Skip to result** on one step. It should show the
   recording, labeled "Recorded at rehearsal" with its time.

If anything reaches for the network, it fails here and not in the room.

## 3. Report back to Claude

Paste these back after the Mac rehearsal:

- [ ] `uname -m` (expect `arm64`)
- [ ] The full output of `./lab.sh preflight`, run with Wi-Fi off
- [ ] Pass or fail for each demo, D1 to D7, in the console. For a failure,
      include the step and its summary text.
- [ ] D3 restore time: the last line of the restore command
      (`INFO  restore took N s on this laptop`)
- [ ] D6 ratio: the summary of the D6 step "Relative timing: the pipeline vs
      $sql, same engine" (pipeline seconds, $sql seconds, ratio)
- [ ] The headless pass, **run twice in a row** with nothing done between the
      runs (the first command is a full reset). It needs no Node and takes
      about 9 minutes per pass on the Linux lab, likely longer on the Mac.
      For each pass, paste the last line of each demo's block and whether
      `ALL DEMOS PASSED` printed:

      ```sh
      ./lab.sh reset && ./lab.sh generate && ./lab.sh demo d1 && ./lab.sh demo d2 && ./lab.sh reset d2 \
        && ./lab.sh demo d3 && ./lab.sh demo d4 && ./lab.sh reset d4 && ./lab.sh demo d5 \
        && ./lab.sh demo d6 && ./lab.sh demo d7 && echo ALL DEMOS PASSED
      ```

      The D3 line `ok  restore  restored N documents ... in X s` gives a
      second restore time. The D6 line `ok  timing ...` gives the ratio over
      3 pipeline runs.

## 4. Session day

| When | Do this |
|---|---|
| 60 min before | Wi-Fi off. `./lab.sh up`, then `./lab.sh check` (four OK lines) |
| 30 min before, no earlier | `./lab.sh reset`, then `./lab.sh generate` (carts expire over about 4 hours after `generate`, and some must still expire live in D2) |
| 20 min before | Chrome tab 1: the deck, `file:///.../deck/index.html`, with **S** for the speaker view. Tab 2: the console, http://127.0.0.1:3200. Two terminals side by side in the repo folder (D7 uses both). |
| 15 min before | Glance at the console's four dots: all green |

The full reset also wipes the console's own recordings. After it, **Skip to
result** shows the copy saved in the repo, labeled "(saved in the repo)".

## 5. Run sheet

The demos run in session order. Each terminal command below is typed
exactly as shown; the console's **Copy** button gives the same text. After
each terminal command, press **Mark done** in the console. The console never
runs commands itself.

**If a step stalls:** click **Skip to result** in the console and say out
loud that it's the rehearsal recording. If the console itself is the
problem, play the demo's video, `clips/dN.webm`, in Chrome. The clips are
made on the Linux lab host and aren't in git, so copy its `clips/` folder
into the repo folder on the Mac before the session.

**Timings wait for proof:** in D5, read times appear only after "Same
document, three ways" passes. In D6, times appear only after "Equal results,
proven before any timing" passes. That's by design, not a
fault: no time goes on screen until the results are proven equal.

### D1: Compatibility check and type census

Segment 1, slide 8 (clock 0:10, 3 min). Console only, read only.

| # | Lane | Do | Expect |
|---|---|---|---|
| 1 | console | Scripted operator scan (built for this lab) | Operators sorted into supported, caveat and unsupported, for the app and for the D5/D6 pipelines. Say: not Oracle's advisor |
| 2 | console | BSON type census on the MongoDB source | `!!` landmine rows: regex `skuPattern`, Timestamp `ts`, Int64 above 2^53, Decimal128, arrays |

Reset after: none.

### D2: Age out

Segment 2, slide 16 (clock 0:22, 4 min).

| # | Lane | Do | Expect |
|---|---|---|---|
| 1 | terminal | `./lab.sh migrate-entities` | Mark done: entity counts match the source; Oracle holds no orders, carts or events |
| 2 | terminal | `./lab.sh app-mode ageout` | "order service now in age-out mode: orders before ... read from MongoDB" |
| 3 | console | A new order lands in Oracle | On Oracle, not on MongoDB |
| 4 | console | One read across the cutoff: MongoDB rows, Oracle rows, merged | Merged list equals the union by `_id`, newest first |
| 5 | console | Carts expire in MongoDB: nothing to move | The cart count drops live; Oracle has 0 carts. Disclose the planted cart |

**Reset after: `./lab.sh reset d2`.** It puts the order service back on
MongoDB in normal mode and empties MIG. D3 starts there. Skip it and D3's
restore check fails.

### D3: Dump, restore, prove it

Segment 3, slide 22 (clock 0:36, 4 min).

| # | Lane | Do | Expect |
|---|---|---|---|
| 1 | terminal | `./lab.sh exec mongo mongodump --archive=/dumps/telco.archive --gzip --db telco` | Mark done: the archive holds all 8 collections |
| 2 | terminal | `./lab.sh mongorestore-ora --archive=/dumps/telco.archive --gzip --nsFrom 'telco.*' --nsTo 'MIG.*' --numParallelCollections=4` | "restoring to existing collection ... without dropping". The last line is `INFO  restore took N s on this laptop`: **read N out loud, live.** Don't quote a fixed number. Mark done: 8 collections, orders as dumped |
| 3 | console | Compare document counts at the dump snapshot | All 8 match the dump. carts and orderEvents run lower "now" (TTL) |
| 4 | console | The $type differential | skuPattern: regex vs object; `{$type:'regex'}` gives 300 vs rejected; Int64 exact; Decimal128 trailing zeros gone |
| 5 | terminal | `./lab.sh app-uri oracle` | "order service now uses oracle". Mark done: health says backend oracle |
| 6 | console | Smoke-test the unchanged app on Oracle | All app calls pass |
| 7 | terminal | `./lab.sh mongosh ora --eval 'db.orders.find({region:"R03",status:"provisioned"}).explain()'` | SELECT STATEMENT, then INDEX RANGE SCAN (MULTI VALUE) on an index from the dump |

Reset after: none. D4's first step reloads Oracle from a fresh dump.

### D4: Live sync and cutover

Segment 4, slide 29 (clock 0:50, 4 min). Say first: the replicator is a
**stand-in for Oracle GoldenGate**, not GoldenGate.

| # | Lane | Do | Expect |
|---|---|---|---|
| 1 | console | Initial load: MongoDB copied to Oracle | About a minute: same orders count on both sides |
| 2 | terminal | `./lab.sh repl fwd` | The log ends in `ready`. Mark done: forward replicator running |
| 3 | console | Write to MongoDB through the app, watch the lag | The lag climbs, then falls to 0; every new order lands on Oracle |
| 4 | terminal | `./lab.sh repl stop && ./lab.sh app-uri oracle` | Drains to lag 0, stops; the app flips. Mark done: same counts |
| 5 | terminal | `./lab.sh repl rev` | `ready`. The first reverse lag can read about 49 s: those are Oracle's TTL deletes from the forward phase |
| 6 | console | Write to Oracle through the app, watch it land in MongoDB | Every new order shows up on MongoDB |
| 7 | console | No lost or duplicated writes: counts and hashes on both sides | Same count and sha-256 on both sides |

**Reset after: `./lab.sh reset d4`**, before anything else. It stops the
replicator, drops the capture objects and points the app back at MongoDB.
Use the terminal command, not the console's Reset button: only the
terminal command stops the replicator container. Each D4 run adds about 550
orders to the source; `./lab.sh generate` puts that back.

### D5: Top-N counter, three ways

Segment 5, slide 34 (clock 1:00, 4 min).

| # | Lane | Do | Expect |
|---|---|---|---|
| 1 | console | Start all three from the same truth | The counter rows match a fresh count of the orders |
| 2 | console | (a) Embedded Top-N document: every order rewrites it | Redo per order; the Top-N document is about 800 bytes |
| 3 | console | (b) $lookup pipeline: every read re-aggregates the orders | Plan shown, read time hidden |
| 4 | console | (c) Converged: one counter row per order, a pre-sorted index | INDEX RANGE SCAN on DEVICE_SALES_TOPN under COUNT STOPKEY |
| 5 | console | Same document, three ways | All 8 dashboards identical, **then** the read times appear |
| 6 | terminal | `./lab.sh mongosh ora --eval 'db.region_top_devices_v.findOne({_id:"R03"})'` | Ten devices, sorted. Mark done |

If step 1 fails: `./lab.sh reset d5`. Reset after: none.

### D6: Pipeline vs $sql

Segment 5, slide 38 (clock 1:08, 4 min).

| # | Lane | Do | Expect |
|---|---|---|---|
| 1 | console | Same data on both sides, statistics gathered | Same window counts; stats gathered |
| 2 | console | (1) The pipeline on MongoDB: the stage tree (plan shape only, no timing) | COLLSCAN, three $lookups, $unwinds, $groups, $sort |
| 3 | console | (2) The same pipeline on Oracle through the MongoDB API | **One timed run, about 2 min 15 s** (130 to 135 s measured on the Linux lab: the first run after the restore is cold; warm runs take 82 to 89 s). The timer runs. Narrate the plan while it runs: it is one run, not three, to keep the demo inside its 4 minutes. No time is shown yet |
| 4 | terminal | `./lab.sh mongosh ora demos/d6-sql/sql-stage.js` | The first 10 of 160 rows. Mark done: 160 rows, ranks 1 to 5 for 32 pairs |
| 5 | console | Equal results, proven before any timing | 160 rows identical on all three; **now** the times appear |
| 6 | console | Both Oracle plans, side by side | Nested loops vs hash joins + WINDOW SORT PUSHED RANK |
| 7 | console | Relative timing: the pipeline vs $sql, same engine | The ratio, read live (Linux lab: about 180 to 205x for this cold single run; about 138x warm, median of 3, headless). Laptop, relative only. Then the field number: 3 to 15x |

If setup fails: `./lab.sh reset d6`. It always re-runs D3's dump and
restore, about a minute. Reset after: none.

### D7: ETags, two agents, one order

Segment 5, slide 43 (clock 1:15, 3 min). Terminal A on the left, B on the
right.

| # | Lane | Do | Expect |
|---|---|---|---|
| 1 | console | One order, two agents, nothing read yet | orders_dv built; demo order picked; change log empty |
| 2 | terminal A | `./lab.sh agent read --agent A` | The order and its ETag |
| 3 | terminal B | `./lab.sh agent read --agent B` | Same document, same ETag |
| 4 | terminal A | `./lab.sh agent write --agent A` | Accepted: provisioned, 1 update |
| 5 | terminal B | `./lab.sh agent write --agent B` | **Rejected: ORA-42699.** Still 1 update |
| 6 | terminal B | `./lab.sh agent retry --agent B` | Accepted: provisioned, the new device, 2 updates |
| 7 | console | The final order: both changes, 2 updates applied | The change log has exactly 2 rows |

If a step fails: `./lab.sh reset d7`, then start again from step 1.

## 6. Between rehearsals

To rehearse again from the top, run the session-day sequence:
`./lab.sh reset`, then `./lab.sh generate`, then D1 to D7 with the two
resets above (`reset d2` after D2, `reset d4` after D4). You never need to
reset by hand between two full runs: the full reset at the top puts
everything back. The full-run smoke test
(`test/integration/full-run.test.mjs`) runs this exact sequence and passes
twice in a row.

To refresh the recorded fallbacks after a demo changes (developers, Linux
lab):

```sh
node scripts/record-clips.mjs      # clean run in the console; writes clips/dN.webm; exit 0 only if every step passed
./lab.sh bake-recordings           # copy /state/recorded into fallback/recorded/
./lab.sh build                     # bake them into the image
git add fallback/recorded && git commit
```
