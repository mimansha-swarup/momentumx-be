---
title: "Phase 04 — Backfill Existing Data (dropped)"
description: "Superseded: pre-production data is disposable, so it gets wiped rather than migrated."
date: 2026-08-19
last_updated: 2026-08-27
status: "dropped — superseded by a wipe"
tags: ["multi-account", "phase-04", "migration", "dropped"]
---

# Phase 04 — Backfill Existing Data (dropped)

**Decision, 2026-08-27:** the product has no users. Everything in Firestore is
development data, and it will be deleted rather than migrated. This phase is dropped and
its script deleted.

**Nothing blocks Phase 06 any more.** The dependency chain this document created —
Phase 03 deployed → backfill run → `--verify` clean → Phase 06 — is gone with it.

---

## What was deleted

| | |
|---|---|
| `src/scripts/backfill-account-id.ts` | the paged full scan, `--dry-run` / `--verify` modes |
| `tests/unit/scripts/backfill-account-id.behaviour.test.ts` | 33 tests |
| `COLLECTIONS.MIGRATIONS` | progress documents for this job and the 05a re-key |

Recoverable from git if it is ever needed again — the last commit that held it is the one
immediately before this document changed.

---

## What replaces it

Delete the six collections (`ideas`, `scripts`, `hooks`, `packaging`, `videoProjects`,
`events`) **before Phase 06 lands**, not after the plan finishes.

The timing is the only part worth being careful about. Phase 06 is the commit that flips
reads from `createdBy` to `accountId`; every document written before Phase 03 is deployed
has no `accountId`, so the moment that flip ships those records stop being visible. Wipe
afterwards and the intervening phases are developed against a database full of content
that renders as missing — empty idea lists and absent projects that are working exactly as
designed, and cost an evening to prove so.

`users` can stay: it is keyed by Firebase UID, Phase 03 does not tag it, and Phase 06
does not filter it. Auth users and their profiles survive a content wipe.

---

## What did NOT go away with it

The **dual-write** is app code, not migration code, and all of it stays: every write path
stamps `accountId` at creation (`content.service`, `hooks.service`, `packaging.service`,
`video-project.service`, `event.service`, `idea.controller`), pinned by
`tests/unit/dual-write-coverage.test.ts`. That is what makes the wipe sufficient — after
it, every record in the database carries an `accountId` from the moment it is written, so
there is nothing left for a backfill to do.

`ensureDefaultAccount` and the lazy account creation in Phase 03 are likewise untouched.

---

## If this decision is ever reversed

The reversal condition is a real user signing up. At that point their data is not
disposable, the wipe is destructive, and the backfill has to come back — restore the
script from git rather than rewriting it, and re-read the constraints it encoded:
`__orphan` quarantining instead of guessing an owner, `flush()` before the resume cursor,
verifying the *mapped value* rather than the field's presence, and the empty-owner-map
guard that stops a run from quarantining the entire database.
