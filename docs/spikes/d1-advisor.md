# Spike: can Oracle's MongoDB Compatibility Advisor run offline in the stack? (D1)

Date: 2026-11-01. Time box: 30 minutes (used about 15).

## Verdict

**No.** There is no advisor step in D1. The console step is labeled
"Scripted operator scan (built for this lab)" (`demos/d1-compat/opscan.mjs`).

## What was checked

1. **Oracle's migration page** (`oracle.com/database/mongodb-migration/`, read
   through search snippets; a direct fetch returned HTTP 403). It names an
   "Oracle MongoDB Compatibility Advisor" that "assesses source and target
   compatibility, looks for problematic content, and makes corrective
   recommendations", and a premigration step that evaluates JSON compatibility.
   Both are presented as part of the "MongoDB to Oracle Migration Tool",
   "deployed as a VS Code in SQL Developer": you register source and target
   databases in the SQL Developer extension for VS Code and pick an online or
   offline migration. Oracle Estate Explorer is positioned for estate-level
   planning.
2. **Oracle docs.** The API for MongoDB guide and the "Quick Start Guide for
   MongoDB Migrations" (`docs.oracle.com/en/database/oracle/mongodb-api/mdbqs/`)
   do not mention an advisor, a command-line mode, or an install path for one.
   No CLI or container form of the advisor was found.
3. **The oracle-ai-dev plugin reference** (`skills/mongodb-api-dev/references/assessment.md`):
   "Oracle publishes no assessment tool or formal compatibility-analysis
   methodology" (absence verified 2026-08). The marketing page above is newer
   than that note, but still gives no offline or scriptable form.
4. **The lab images.** `lab-oracle` (gvenzl/oracle-free 23.26.3 faststart +
   ORDS 26.3 + mongosh), `lab-mongo`, `lab-app` and the host SQLcl 26.3 carry
   nothing named advisor, premigration or MongoDB migration (searched the
   filesystems; the only hits are the in-memory advisor SQL scripts and an npm
   internal file).

## Why that rules it out for the session

- It is a GUI flow inside VS Code, not something the runner container can call,
  and the laptop is Podman-only (Ruling N): no VS Code, no SQL Developer.
- The session must run offline after one `./lab.sh pull` / `./lab.sh build`;
  an extension download and registration flow on stage is a live-demo risk.
- If a later release ships a CLI or container form, add a `terminal` step
  `advisor` to `demos/d1-compat/index.mjs` that runs it, keep the scan.

## Probes (2026-11-01, Oracle API for MongoDB, ORDS 26.3.0.r2721811, reports 7.0.22)

Run with the Node driver as MIG on a throwaway document in `MIG.regions`
(deleted afterwards). These back the "measured in this lab" entries in
`demos/d1-compat/compat-matrix.json`.

| Probe | Result |
|---|---|
| insert `Long(9007199254740993)`, then `$inc` by `Long(1)` | stored `9007199254740992` (should be ...994): `$inc` loses exactness above 2^53 |
| insert `Decimal128("1.10")`, read back | `1.1` (scale dropped, value kept) |
| `{arr: {$type: 'object'}}` on `arr: [{a: 1}]` | 0 (MongoDB matches the element: 1); `{arr: {$type: 'array'}}` gives 1 |
| `{x: {$type: 'regex'}}` | rejected: "Query filter is invalid or not supported $type value not supported" |
| `find({$where: 'true'})` | rejected: "invalid filter $where" |
| `{loc: {$near: [0, 0]}}` | rejected: "Operator loc must have at least one target." |
| `{loc: {$near: {$geometry: {type: 'Point', ...}}}}` | rejected: "Query syntax error." |
| `$setWindowFields` with `$rank` | rejected: "Aggregate stage $setWindowFields not supported" |
| `$graphLookup` over `accounts.parentAccountId` | **runs**, same chain sizes as MongoDB for the first 3 child accounts (1, 1, 2) |
| `$project` with `$strLenCP` | **runs**, correct lengths |
| `$expr` in `find()` and in `$match` | **runs**, correct match |

The last three contradict the plugin's reference matrix (written against ORDS
26.2.2 and an earlier Free build): on this lab's ORDS 26.3 they work. The
measured entries win in D1's classification; the reference entries are kept
in the JSON for traceability.
