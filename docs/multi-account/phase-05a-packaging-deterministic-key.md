---
title: "Phase 05a — Packaging: One Deterministic Key"
description: "Make every packaging document keyed on videoProjectId, and delete the lookup query."
date: 2026-08-24
last_updated: 2026-08-26
status: "code-complete — migration not run"
tags: ["multi-account", "phase-05a", "data-shape"]
---

# Phase 05a — Packaging: One Deterministic Key

**Size:** small, but it is a data-shape migration.
**Depends on:** Phase 05.
**Blocks:** Phase 06.

---

## Where this stands (2026-08-26)

Code done, **migration not run**. This phase is deliberately TWO commits and only
the first has landed.

| | |
|---|---|
| `savePackaging` writes `doc(videoProjectId)` (`repo.saveWithId`) | done |
| Auto-ID `repo.save()` deleted, with its no-op try/catch | done |
| `mergePackaging` + `src/scripts/rekey-packaging.ts` | done, 9 tests, merge canary-verified |
| `.claude/rules/firestore-conventions.md` rewritten | done, same change |
| **Migration run, collisions triaged** | **outstanding** |
| **Delete commit** — remove `findByVideoProject` + the locator fallback | **outstanding, gated on the run** |

**`findByVideoProject` is still here on purpose.** `PackagingService.locateForProject`
point-reads `doc(videoProjectId)` first and falls back to the query, logging
`packaging_legacy_autoid_read` when it fires. Deleting the fallback before the re-key runs
sends every legacy document's project down the create path, writing a fresh empty package
over the top — the user's packaging silently disappears. That is the same data-loss ordering
the "order matters" section below describes, reached from inside this phase rather than from
Phase 06.

The log line is the signal for when the delete is safe: once a full run of the migration is
clean and nothing emits `packaging_legacy_autoid_read`, there is nothing left for the query
to find.

```bash
node dist/scripts/rekey-packaging.js --dry-run   # counts + collisions, writes nothing
node dist/scripts/rekey-packaging.js             # exits 2 if any collision was logged
```

---

## Why this is its own phase

This was originally item 4 inside Phase 06. It was extracted for one reason: **it is a
data-shape migration wearing a refactor's clothes**, and Phase 06 is the tenancy flip. Two
kinds of risk in one release means a rollback can't tell you which half broke.

There is also a strict ordering constraint, and getting it backwards loses user data — see
"The order matters" below.

---

## The situation today

Packaging documents are created two different ways:

| Path | Key | Where |
|---|---|---|
| Persist-on-generate | **deterministic** — `doc(videoProjectId)` | `packaging.repository.ts:102` (`upsertGeneratedItem`) |
| The save path | **auto-ID** — `doc()` with no argument | `packaging.repository.ts:16-24` (`save`), reached from `packaging.service.ts:410` |

So `findByVideoProject` (`packaging.repository.ts:147-151`) is not only a legacy-document
locator, as an earlier draft of this plan assumed. The live save path *still* mints auto-ID
documents today.

`.claude/rules/firestore-conventions.md` already documents the deterministic id and warns:
*"Legacy/door docs may still have auto-IDs — always LOCATE by findByVideoProject, never
assume id === videoProjectId on read."* This phase is what makes that warning retirable.

---

## What changes

1. **`savePackaging` becomes deterministic.** `packaging.service.ts:402-410` currently does
   `findByVideoProject` → if missing, `repo.save()` (auto-ID). It becomes a `set` with
   `merge` on `doc(videoProjectId)`, the same key `upsertGeneratedItem` already uses.
2. **A one-off migration** re-keys existing auto-ID packaging documents onto their
   `videoProjectId`, and repoints `videoProjects.packagingId` at the new id.
3. **`findByVideoProject` is deleted**, and every caller becomes a point read on
   `doc(videoProjectId)`.
4. **`repo.save()` is deleted** if it has no other caller after step 1. (While you are in
   that file: `packaging.repository.ts:17-23` wraps its body in `try { … } catch (error) {
   throw error }`, which is a no-op — delete it.)

There is no index to remove. That query is equality-only and is served automatically.

---

## The order matters, and backwards it loses data

**`savePackaging` must become deterministic BEFORE Phase 06 adds an account filter to any
packaging lookup.**

In the other order: a filtered lookup misses a legacy auto-ID document, falls through to the
create path, writes a fresh empty document, relinks the project to it — and the user's
packaging silently disappears. The old document is still in Firestore, but nothing points at
it.

That is why this is a hard gate on Phase 06 rather than a tidy-up inside it.

---

## The migration

Small enough to be a single pass — packaging is 1:1 with a project, so the row count is the
number of projects that reached packaging.

For each packaging document whose id ≠ its `videoProjectId`:

1. Read the target `doc(videoProjectId)`. If it already exists, **merge field-by-field
   rather than overwrite** — persist-on-generate may have created it for a project that also
   has a legacy save document. Prefer the newer `updatedAt` per field; log every collision.
2. Write the merged document to `doc(videoProjectId)`.
3. Update `videoProjects/{videoProjectId}.packagingId` to the new id.
4. **Do not delete the old document in the same pass.** Mark it `supersededBy:
   <videoProjectId>` and leave it. Deleting it is a separate, later commit, once the
   collision log is clean — that is the rollback path.

Record the run in `migrations/packaging-rekey` the same way Phase 04 records its passes:
`{ scanned, rekeyed, merged, collisions, completedAt }`.

---

## Update the convention file in this commit

`.claude/rules/firestore-conventions.md:55-63` currently instructs:

> *"Legacy/door docs may still have auto-IDs — always LOCATE by `findByVideoProject`, never
> assume `id === videoProjectId` on read."*

This phase retires exactly that. Rewrite the section to state the invariant it establishes —
the packaging document id **is** the `videoProjectId`, every read is a point read — and note
that the migration merged the auto-ID documents.

Do it here, not in Phase 10. The file is loaded into every session, so until it is corrected
it instructs anyone touching packaging to reintroduce the lookup this phase deleted.

---

## How we'll know it worked

- Every document in `packaging` has `id === videoProjectId`, except the superseded ones,
  which all carry `supersededBy`.
- Every `videoProjects.packagingId` points at a document that exists.
- The collision count is zero, or every collision has a written decision.
- Generate a packaging item on a project that had a legacy auto-ID document, then reload:
  the content is the same. This is the specific case the migration can get wrong.
- Door save (no `videoProjectId`) still works — it creates one project and returns it, as
  Phase 03's contract requires.

---

## Rollback

Before the delete commit: the superseded documents are untouched, so repointing
`videoProjects.packagingId` back at them restores the previous state exactly. After the
delete commit there is no rollback — which is why the delete is deliberately separated and
gated on a clean collision log.

---

## Risks

**The merge case is the whole risk.** A project with both a legacy save document and a
persist-on-generate document is the one shape where "just re-key it" silently drops fields.
Merging field-by-field with a logged collision list is the mitigation; overwriting is not.

**Low volume makes this feel safe, and it mostly is** — but it runs against live data, so
take the same managed export Phase 04 takes (see the README's deployment and backup notes).
