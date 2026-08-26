---
title: "Phase 04 — Backfill Existing Data"
description: "Copy createdBy into accountId on every record that existed before Phase 03."
date: 2026-08-19
last_updated: 2026-08-26
status: "script written — not run (blocked on Phase 03 deploy)"
tags: ["multi-account", "phase-04", "migration"]
---

# Phase 04 — Backfill Existing Data

**Size:** small script, careful operation.
**Depends on:** Phase 03 deployed and running (so new records are already tagged).
**Blocks:** Phase 06.

---

## Where this stands (2026-08-26)

The script exists and is tested. **Nothing has been run against any database.**

| | |
|---|---|
| `src/scripts/backfill-account-id.ts` | written — backfill, `--dry-run` and `--verify` modes |
| `tests/unit/scripts/backfill-account-id.behaviour.test.ts` | 28 tests, each destructive path canary-verified |
| Managed export taken, and restored once into a scratch project | **outstanding — step 0, do it first** |
| Counts re-measured immediately before the run | **outstanding** (the 2026-08-24 numbers below are stale by then) |
| Backfill run | **blocked**: Phase 03 is merged, not deployed |
| Verification pass green | **outstanding** |

The block is real, not procedural. Phase 03 is live on no deploy artifact yet, and the SSE
script route is served only by Render — running this single pass now would tag whatever
exists and walk past every script document written between the run and the deploy.

The script refuses to start on an empty owner map for the same reason: with no accounts,
every document would quarantine as an orphan and the run would still look like it "worked".

### Running it

```bash
gcloud firestore export gs://video-topic-5bace-migration/pre-phase04-$(date +%Y%m%d)
node dist/scripts/backfill-account-id.js --dry-run     # counts only, writes nothing
node dist/scripts/backfill-account-id.js
node dist/scripts/backfill-account-id.js --verify      # exits non-zero on mismatched/missing
```

`--collection=ideas` scopes any mode to one collection. It must name one of the five
above and the script rejects anything else: the value used to reach `db.collection()`
unchecked, so `--collection=users` would have scanned a collection with no `createdBy`
and stamped `accountId: "__orphan"` across every user document.

---

## The idea in simple English

Phase 03 put an address label on every new box. This phase labels the boxes that were
already in the warehouse.

**This is a lookup, not a field copy.** An earlier version of this plan set
`accountId = createdBy`, which made it a pure field copy; that shortcut is gone — account ids
are UUID v4 and never equal a uid (decision 2026-08-25, see the README).

So the job builds a map first, then applies it:

```ts
// One pass over `accounts` — every account has exactly one owner at this point,
// because sharing does not exist until Phase 09.
const ownerToAccount = new Map<string, string>();
for (const account of await db.collection("accounts").get()) {
  for (const ownerUid of account.get("ownerUids") ?? []) {
    ownerToAccount.set(ownerUid, account.id);
  }
}
```

It is still **idempotent** — the map is derived from stored data, so a re-run produces the
same answer — and still cheap: at current volume the map is a handful of entries held in
memory for the duration of the job. That cheapness is the argument for running the backfill
*before* there is volume, not after.

---

## Before you start: measure

Run a `count()` aggregation on each collection. It's billed at roughly one read per
thousand documents, so it's nearly free, and it changes how you treat the job:

| Collection | Expected size | Notes |
|---|---|---|
| `ideas` | **largest** | 10 per generation, and archived ones accumulate |
| `events` | **largest, or bigger** | append-only telemetry, never deleted |
| `videoProjects`, `scripts`, `hooks`, `packaging` | small | roughly one per project |

If `ideas` is in the low thousands this is a script you run in a terminal. In the millions
it's a job you supervise.

Also count records where `createdBy` is `""` — the empty-owner bug fixed in Phase 01. Those
need quarantine, not copying (see below).

### Measured 2026-08-24 against `video-topic-5bace`

Both Phase 01 item 1 counts, run before any Phase 01 code landed:

| Collection | Total | Has `createdBy` | Absent | `""` |
|---|---|---|---|---|
| `ideas` | 10 | 10 | 0 | 0 |
| `scripts` | 2 | 2 | 0 | 0 |
| `hooks` | 2 | 2 | 0 | 0 |
| `packaging` | 2 | 2 | 0 | 0 |
| `videoProjects` | 2 | 2 | 0 | 0 |
| `events` | 12 | 12 | 0 | 0 |

**Zero orphans of either kind, and 30 documents in the entire database.**

Two consequences, and the second one matters more than the first:

1. The orphan-quarantine path is currently dead code. Keep it — it is cheap, and Phase 01's
   guard is what keeps the count at zero, not luck — but do not spend time hardening it.
2. **This is a pre-launch database, so the backfill is a script that finishes instantly.**
   `BulkWriter`, `FieldPath.documentId()` paging and the `migrations/{collection}` progress
   documents are all still worth writing, because they are the difference between a job you
   can resume and one you restart blind — but calibrate the effort to 30 documents, not to
   the million-document job this section was written to survive. Re-run these counts
   immediately before the backfill; if the product has launched by then, the numbers above
   are worthless and the original guidance applies.

Firestore has no "field missing" filter — documents lacking a field are absent from its
index entirely — so the `absent` column is derived: `total − count(orderBy("createdBy"))`,
since `orderBy` returns only documents that have the field.

---

## What we'll do

### Skip `events` entirely

`events` is append-only telemetry that **nothing reads** — `event.repository.ts` exposes
only `add()`. It will be the largest collection and backfilling it buys nothing.

New events carry `accountId` from Phase 03. Leave the history keyed by `createdBy`; if
anyone ever needs to report across the boundary, join on the user. If storage becomes a
concern, a Firestore **TTL policy** on an `expireAt` field deletes old telemetry
automatically, which is cheaper than migrating it.

### The script

Backfill five collections: `ideas`, `scripts`, `hooks`, `packaging`, `videoProjects`.

**Page by document ID, never by offset.** Firestore bills reads for documents an `offset()`
skips over, so paging that way costs more the further you go:

```ts
query.orderBy(FieldPath.documentId()).startAfter(lastId).limit(500)
```

**Use `BulkWriter`** from the Admin SDK rather than hand-rolling batches. It handles the
500-operations-per-batch cap, retries failures, and ramps write throughput correctly. (Note
`content.repository.ts` chunks manually at 450 — don't copy that pattern here.)

**Skip records that already have the field:**

```ts
if (doc.get("accountId")) continue;
```

This is what makes the job re-runnable. It matters because **Firestore cannot query for
"this field is missing"** — there's no such filter. So the backfill is a full scan with an
in-memory skip, and being interruptible is essential.

**Quarantine orphans rather than guessing — and test the type, not truthiness.** A record
with `createdBy: ""` must not get `accountId: ""` — that's a real value shared by every such
record across all users, which would mix unrelated people's data.

But there is a second, quieter case the original draft missed: `createdBy` **absent
entirely**. `src/config/firebase.ts:19` sets `ignoreUndefinedProperties: true`, so
`set({ accountId: doc.get("createdBy") }, { merge: true })` on such a document writes
**nothing at all** and returns success. The document stays untagged, the `patched` counter
increments, and it goes invisible to its owner the moment Phase 06 flips reads — which is
indistinguishable from data loss.

```ts
const owner = doc.get("createdBy");
const accountId =
  typeof owner === "string" && owner.length > 0
    ? ownerToAccount.get(owner) ?? "__orphan"   // no account for this owner = orphan too
    : "__orphan";
if (accountId === "__orphan") {
  console.warn(JSON.stringify({ event: "backfill_orphan", path: doc.ref.path, owner }));
}
```

Never let `undefined` reach a write. For ideas, the true owner can sometimes be recovered
via `videoProjectId` → the project's `createdBy`; do that as a follow-up, by hand, with the
counts in front of you.

**Record progress so a re-run resumes:**

```
migrations/{collection}
  startedAt, lastCursor, scanned, patched, orphaned, skipped, failed, completedAt
```

`patched` counts writes **attempted**, which is all the scan loop can know — the
BulkWriter completes them afterwards. `failed` is what the writer's error handler
reports, and a non-zero `failed` exits non-zero, so a partially-written collection
cannot be read as a finished one. `--verify` remains the actual gate.

**`flush()` before `lastCursor`, in that order.** `set()` only enqueues; BulkWriter
batches, rate-limits and retries on its own schedule. Storing the cursor for a page whose
writes are still in flight makes the cursor claim a durability the data does not have — kill
the process there and those documents are skipped by every later run, because resume starts
past them. `--verify` would report them `missing` while the obvious repair (re-run the job)
resumes past them and fixes nothing; the operator would have to know to clear `lastCursor` by
hand. This is why the two writes are ordered, and it is the only reason the resume is
trustworthy.

### Verify before moving on — assert the invariant, not the field

The original gate was "zero records without an `accountId`". That is verifiable — Firestore
has no "field missing" filter, so a full scan with a counter is the only option — but it
checks the wrong thing.

**Field-present is not field-correct.** Every realistic backfill bug — a shared mutable
cursor, a mis-scoped `let` in a loop, a copy-paste that pages `ideas` while writing to
`scripts` — produces a document whose `accountId` is present and **wrong**. Wrong
`accountId` is exactly the data-mixing outcome this entire plan exists to prevent, and it
sails through a presence check. The old gate also passes with orphans present, since
`"__orphan"` is truthy.

The verification pass is the same scan. Make it assert:

```ts
const ok =
  doc.get("accountId") === ownerToAccount.get(doc.get("createdBy")) ||
  doc.get("accountId") === "__orphan";
```

and record in `migrations/{collection}`:

```
scanned, matched, mismatched, orphaned, missing, completedAt
```

**Phase 06 ships only when `mismatched === 0 && missing === 0`,** and `orphaned` has a
written triage decision. One extra comparison takes the gate from "we wrote something" to
"we wrote the right thing".

The `migrations` documents are the completion signal. Without them, "is the backfill done?"
has no answer other than someone's memory.

### Take a backup first — it is available today

**Step 0, before any of the above:**

```bash
gcloud firestore export gs://video-topic-5bace-migration/pre-phase04-$(date +%Y%m%d)
```

The project is on Blaze right now, so managed export works. It is not available on Spark
(export/import, PITR, backup and restore are all excluded from free usage), and the intent
is to operate within Spark constraints — so **take the export while the window is open.**
See the README's plan-constraints section.

Restore it once, into a scratch project, to prove the backup is real. An untested backup is
a belief, not a rollback.

**Note on quota:** an earlier draft of this document sized the job without reference to a
daily cap and recommended an operation budget in the script. On Blaze there is no daily cap —
only cost, and the cost is trivial (roughly $0.60 per million reads, $1.80 per million
writes). **Delete the op-budget code**; it was quota plumbing, not correctness. Set a GCP
budget alert at $20 instead — one console setting rather than a scheduler in a script.

Everything in this document about batching, cursors and `flush()` still applies: it is what
makes the job resumable, which is independent of billing.

---

## What about records created during the backfill?

Already handled — that's exactly what Phase 03 bought. Anything created while the script
runs was written with an `accountId` from the start. One pass is sufficient; a second pass
is a cheap safety net and costs only reads.

---

## How we'll know it worked

- A managed export exists, and has been restored once into a scratch project.
- `migrations/{collection}` has a `completedAt` for all five collections.
- The verification pass reports `mismatched === 0` and `missing === 0`.
- The orphan count is known, recorded here, and either zero or explicitly triaged.
- Spot-check: pick a user, list their ideas by `createdBy`, list by `accountId`, confirm
  the two sets are identical.
- The counts from the README's measurement script are recorded in this document *before*
  the run, so "scanned" can be checked against a number that was known in advance.

That last check is the real proof, and it's worth doing for two or three users with
different amounts of history.

---

## Rollback

The backfill only **adds** a field. Nothing reads it yet. To undo, either leave it (inert)
or run the same script in reverse to delete the field. There is no data loss path here,
which is precisely why the backfill is separated from the read switch.

---

## Risks

**Cost and time on a large `ideas` collection.** Every document is read once and written
once. Measure first.

**Getting the orphan handling wrong** is the one genuinely destructive mistake available in
this phase. Copying an empty `createdBy` straight through would merge unrelated users into
a single fake account. Quarantine, don't guess.

**Running it before Phase 03 is fully deployed** would leave a gap of untagged records.
Confirm Phase 03 is live everywhere first — not merged, *live*.
