# Rehearsal and run sheet

For the presenter. You need a Mac with Apple silicon, Podman and Chrome.
Node isn't needed: every demo, reset and terminal command runs inside the
lab containers. Never type a password. The `./lab.sh` wrappers read it from
the environment, so no password ever shows on screen or in the deck.

## 1. Mac setup from zero (once, with network)

1. Install Podman. Use the installer from podman.io, or run
   `brew install podman`. Then install a compose provider for
   `podman compose`: `brew install podman-compose`.
2. Create and start a machine big enough for Oracle:

   ```sh
   podman machine init --cpus 6 --memory 16384 --disk-size 60
   podman machine start
   ```

3. Clone the lab and fetch everything it needs. This is the only step that
   needs the network:

   ```sh
   git clone https://github.com/rhoulihan/mongodb-oracle-migration-lab.git
   cd mongodb-oracle-migration-lab          # the default branch, main
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
2. `time ./lab.sh reset`, then `./lab.sh generate`. Note the reset's wall
   time for section 3.
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
- [ ] Full reset wall time: run `time ./lab.sh reset` and paste the four
      `OK` lines and the `real` time (reset to four OK lines; 44 s on the
      Linux lab)
- [ ] D6 setup time: the seconds the console shows for the D6 step "Same
      data on both sides, statistics gathered" (about 2.5 min on the Linux
      lab; it decides how early you must click it in the session)
- [ ] D3 restore time: the last line of the restore command
      (`INFO  restore took N s on this laptop`)
- [ ] D6 ratio: the summary of the D6 step "Relative timing: MongoDB, the pipeline on Oracle, and $sql" (was "the pipeline vs
      $sql, same engine" (pipeline seconds, $sql seconds, ratio)
- [ ] The headless pass, **run twice in a row** with nothing done between the
      runs (the first command is a full reset). It needs no Node and takes
      about 12 minutes per pass on the Linux lab, likely longer on the Mac.
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
| 60 min before | Wi-Fi off. `./lab.sh reset` (it starts the stack if it is down, wipes the lab and ends with `./lab.sh check`: four OK lines) |
| 30 min before, no earlier | `./lab.sh generate` (carts expire over about 4 hours after `generate`, and some must still expire live in D2) |
| 20 min before | Chrome tab 1: the deck, `file:///.../deck/index.html`, with **S** for the speaker view. Tab 2: the console, http://127.0.0.1:3200. Two terminals side by side in the repo folder (D7 uses both). |
| 15 min before | Glance at the console's four dots: all green |

With the copilot (section 7): 30 min before, say "launch the lab" instead of
the first three rows. It does the reset, the data load and the windows, and
ends with a checklist. Wi-Fi stays on: Claude needs it, the lab doesn't.

A full reset recreates Oracle and ORDS from scratch, and `./lab.sh check`
waits up to 600 s for them (44 s on the Linux lab; the Mac is slower). A
`FAIL ... (not ready after N s)` line right after a reset means the stack is
still booting: re-run `./lab.sh check`. It is not broken.

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
| 2 | console | BSON type census on the MongoDB source | `!!` landmine rows: regex `skuPattern`, Timestamp `ts`, Decimal128, arrays |

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
| 1 | terminal | `./lab.sh exec mongo mongodump --archive=/dumps/telco.archive --gzip --db telco --verbose` | Mark done: the archive holds all 8 collections |
| 2 | terminal | `./lab.sh mongorestore-ora --archive=/dumps/telco.archive --gzip --nsFrom 'telco.*' --nsTo 'MIG.*' --numParallelCollections=4 --verbose` | "restoring to existing collection ... without dropping". The last line is `INFO  restore took N s on this laptop`: **read N out loud, live.** Don't quote a fixed number. Mark done: 8 collections, orders as dumped |
| 3 | console | Compare document counts at the dump snapshot | All 8 match the dump. carts and orderEvents run lower "now" (TTL) |
| 4 | console | The $type differential | Left, what differs: skuPattern regex vs object, `{$type:'regex'}` 300 vs rejected; Int64 exact; Decimal128 trailing zeros gone. Right, how to handle it: a fix per row, each rewritten query counting the same on both sides ($exists, $elemMatch, compare as numbers) |
| 5 | terminal | `./lab.sh app-uri oracle` | "order service now uses oracle". Mark done: health says backend oracle |
| 6 | console | Smoke-test the unchanged app on Oracle | All app calls pass |
| 7 | terminal | `./lab.sh mongosh ora --quiet --eval 'const q = db.orders.find({region:"R03",status:"provisioned"}).explain().queryPlanner; print(q.generatedSql); print(q.winningPlan)'` | SELECT STATEMENT, then INDEX RANGE SCAN (MULTI VALUE) on an index from the dump |

Reset after: none. D4's first step reloads Oracle from a fresh dump.

### D4: Live sync and cutover

Segment 4, slide 29 (clock 0:50, 4 min). Say first: the replicator is a
**stand-in for Oracle GoldenGate**, not GoldenGate.

| # | Lane | Do | Expect |
|---|---|---|---|
| 1 | console | Initial load: MongoDB copied to Oracle | About a minute: same orders count on both sides |
| 2 | terminal | `./lab.sh repl fwd` | The log ends in `ready`. Mark done: forward replicator running |
| 3 | console | Write to MongoDB through the app, watch the lag | About 20 s of steady writes (25/s). The lag stays live while they flow; read p50 and p95 off the summary (Mac: about 20 and 30 ms). Every new order lands on Oracle |
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
| 2 | console | (a) Embedded counters: one document per region, sorted by the client | Redo per order (about 17 KB); the R03 document holds 120 devices, about 9.5 KB, rewritten by each $inc |
| 3 | console | (b) Counter documents and a $lookup pipeline the app owns | INDEX RANGE SCAN on the deviceSales counters under COUNT STOPKEY; read time hidden. Say: the query lives in the app |
| 4 | console | (c) Converged: counter rows, read as one document through a JSON view | INDEX RANGE SCAN on DEVICE_SALES_TOPN under COUNT STOPKEY. Say: the query lives in the database |
| 5 | console | Same document, three ways | All 8 dashboards identical, **then** the read times appear (Mac: embedded about 0.6 ms, counter pipeline 0.6 to 0.7, converged about 0.4; redo per order, the order included, about 17 / 5 / 3.5 KB) |
| 6 | terminal | `./lab.sh mongosh ora --eval 'db.region_top_devices_v.findOne({_id:"R03"})'` | Ten devices, sorted. Mark done |

If step 1 fails: `./lab.sh reset d5`. Reset after: none.

### D6: Pipeline vs $sql

Segment 5, slide 38 (clock 1:08, 4 min).

**Setup timing.** Click D6 step 1 right after D5's last step, and no later
than clock 1:05. If D5 runs long, click **Skip to result** on its remaining
steps so D6 setup starts on time. If setup is still running when you reach
slide 38, talk the `$setWindowFields` compatibility note (slide 38 notes)
until it finishes. Measure the Mac's setup time at rehearsal (section 3).

| # | Lane | Do | Expect |
|---|---|---|---|
| 1 | console | Same data on both sides, statistics gathered | **Click it right after D5's last step**, then go back to the deck for slides 35 to 37 while it runs (about 2.5 min: statistics, then one untimed warm-up run of the pipeline and of $sql). Expect: same window counts, stats gathered, both sides warmed once. Say "both sides warmed once during setup" |
| 2 | console | (1) The pipeline on MongoDB: the stage tree, timed | COLLSCAN, three $lookups, $unwinds, $groups, $sort; median of 3 runs, hidden until step 5 |
| 3 | console | (2) The same pipeline on Oracle through the MongoDB API | **One timed run, warm, about 35 s** (34 to 35 s measured on the Mac). The timer runs. Narrate the plan while it runs: it is one run, not three, to keep the demo inside its 4 minutes. Then the summary: the same 160 rows as MongoDB, and both times (Mac: about 34 s against about 4.5 s, about 7.6x slower). Say why, and lead into $sql: the API translates stage by stage, the optimizer never sees the whole question |
| 4 | terminal | `./lab.sh mongosh ora demos/d6-sql/sql-stage.js` | The first 10 of 160 rows. Mark done: 160 rows, ranks 1 to 5 for 32 pairs |
| 5 | console | Equal results, proven before any timing | 160 rows identical on all three; **now** the times appear |
| 6 | console | Both Oracle plans, side by side | Nested loops vs hash joins + WINDOW SORT PUSHED RANK |
| 7 | console | Relative timing: MongoDB, the pipeline on Oracle, and $sql | All three times (Mac: MongoDB about 4.4 s, pipeline on Oracle about 34 s, $sql about 0.4 s). The ratios, read live (Mac, warm against warm: $sql about 85 to 90x the pipeline on Oracle, about 11x MongoDB). Laptop, relative only. Then the field number: 3 to 15x |

If setup fails live: click **Skip to result** on each step and say it's
the rehearsal recording. Before the segment only: `./lab.sh reset d6`. It
always re-runs D3's dump and restore, gathers statistics and warms both
sides once, about 3 to 4 minutes, too long to run in the middle of the
demo. Reset after: none.

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

## 7. Let Claude drive (optional)

Claude Code can run the demos for you while you talk. It brings each window
to the front of the shared screen itself, runs each step there, and tells
you the result and the line to say. The audience sees the same console timer
and the same terminal output as when you do it yourself. Overview and screen
layout: README, "Hands-off copilot".

**Claude needs internet. The lab doesn't.** If the venue network drops, click
and type the steps yourself as in section 5. Nothing else changes.

**Setup (once):** `brew install tmux`, and Claude Code installed. Allow
pop-ups for the deck in Chrome. Add this to `.claude/settings.local.json` in
the repo, so no permission prompt appears on stage:

```json
{ "permissions": { "allow": ["Bash(./lab.sh drive:*)", "Bash(./lab.sh launch:*)", "Bash(./lab.sh shutdown:*)"] } }
```

**Before the session:** start `claude` in the repo folder, in a terminal you
don't share, and say "launch the lab" (the `launch-lab` skill). It runs
`./lab.sh launch`: full reset, data load, tmux session `lab` (window `main`,
and window `agents` split into A and B for D7), the console, speaker notes
and tmux terminal on the external display, the deck on the laptop. Check
that the checklist it prints ends "All checks passed: ready for D1". Mind
the 30-minute rule in section 4: if the session starts more than about 3
hours later, run `./lab.sh generate` again.

By hand instead: `./lab.sh drive stage`, `tmux attach -t lab` in the
terminal you share (font large), the console open in Chrome, then
`./lab.sh drive status` (three OK lines and `INFO  idle`).

**During the session:** say "run demo D3" (the `drive-demo` skill).

- Claude switches the shared window itself (`./lab.sh drive focus console`
  or `term`). If a switch fails, it says **Share the Console** or **Share the
  Terminal**: switch by hand and reply "ready".
- After each step, Claude replies with the result and the line to say. Say
  "next" or "go" to continue.
- On a failure, Claude offers **Skip to result** (the rehearsal recording)
  and never debugs on stage.

**After the session:** say "shut down the lab" (the `shutdown-lab` skill):
the lab's windows close and the stack stops, keeping the volumes.

| Command | What it does |
|---|---|
| `./lab.sh drive stage` | Create the tmux session `lab` |
| `./lab.sh drive status` | Console page open, tmux attached, services ready |
| `./lab.sh drive plan dN` | List a demo's steps |
| `./lab.sh drive console dN STEP [--skip] [--nowait]` | Run a console step (`--skip`: the rehearsal result) |
| `./lab.sh drive wait SEQ` | Wait for a step started with `--nowait` |
| `./lab.sh drive term [A\|B] 'CMD'` | Type a command into the tmux pane (A and B: D7) |
| `./lab.sh drive focus console\|term\|home` | Bring the console, the tmux terminal or Claude's terminal to the front (macOS) |

**Rehearse it once this way, D1 to D7.** Each step adds a few seconds while
Claude responds, so note where D5 and D6 run long.
