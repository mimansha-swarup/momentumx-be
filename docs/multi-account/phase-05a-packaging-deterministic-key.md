---
title: "Phase 05a — Packaging: One Deterministic Key"
description: "Every packaging document is keyed on videoProjectId, and the lookup query is gone."
date: 2026-08-24
last_updated: 2026-08-27
status: "complete"
tags: ["multi-account", "phase-05a", "data-shape"]
---

# Phase 05a — Packaging: One Deterministic Key

**Size:** small.
**Depends on:** Phase 05.
**Blocks:** nothing — this is done.

---

## Where this stands (2026-08-27)

Complete. It was planned as two commits, the second gated on a migration run; the
migration was dropped when the data became disposable (see
[phase-04](./phase-04-backfill.md)), so the delete commit landed on its own.

| | |
|---|---|
| `savePackaging` writes `doc(videoProjectId)` (`repo.saveWithId`) | done |
| Auto-ID `repo.save()` deleted, with its no-op try/catch | done |
| `findByVideoProject` deleted | done |
| `PackagingService.locateForProject` + its `packaging_legacy_autoid_read` log deleted | done |
| The locate query inside `upsertGeneratedItem`'s transaction deleted | done |
| `src/scripts/rekey-packaging.ts` + its 16 tests deleted | done — never run |
| `.claude/rules/firestore-conventions.md` rewritten | done |

---

## The invariant this establishes

**The packaging document id IS the `videoProjectId`, on every path, and every read is a
point read.**

Both creation paths agree on it:

| Path | Where |
|---|---|
| Persist-on-generate | `packaging.repository.ts` → `upsertGeneratedItem` |
| The save path | `packaging.repository.ts` → `saveWithId`, from `packaging.service.ts` |

Because they agree, nothing needs to *locate* a packaging document. There were three
lookups and all three are gone: `findByVideoProject`, the fallback in
`locateForProject` (which collapsed to `this.repo.get(projectId)`), and the
`where("videoProjectId", "==", ...)` query inside `upsertGeneratedItem`'s transaction.

That last one is the easiest to reintroduce by accident, because the transaction looks
like the reason for it. It is not — the transaction exists so the `itemStatuses`
read-modify-write and the "all four done?" check see a consistent snapshot while
persist-on-generate fires four item writes concurrently. Finding the document was never
its job. `tests/unit/packaging.repository.test.ts` throws a named error if a query
appears there again, inside the transaction or outside it.

There is no index to remove. That query was equality-only and was served automatically.

---

## Why it was originally two commits

The split existed because deleting the query before re-keying the legacy documents would
send every legacy document's project down the create path — writing a fresh empty package
over the top, and the user's packaging silently disappears. With no legacy documents to
protect, that ordering constraint has no subject.

Worth keeping in mind if this ever runs against real data: the constraint was real, and
it is the same shape as the one in Phase 06 (a filtered lookup that misses an existing
document and creates a replacement is a silent data loss, not a 404).

---

## How we know it worked

- `savePackaging` on a project with an existing package updates it rather than creating a
  second one — `tests/unit/service/packaging.flow.behaviour.test.ts`.
- A second generated item lands on the same document as the first —
  `tests/unit/packaging.repository.test.ts`.
- Door save (no `videoProjectId`) still creates exactly one project and keys the package
  on it, as Phase 03's contract requires.
