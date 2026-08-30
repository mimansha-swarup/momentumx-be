---
title: "Phase 10 — Cleanup"
description: "Delete the old indexes and the legacy profile fields, once nothing needs them."
date: 2026-08-19
last_updated: 2026-08-19
status: "planned"
tags: ["multi-account", "phase-10", "cleanup"]
---

# Phase 10 — Cleanup

**Size:** small.
**Depends on:** Phase 06 in production long enough to be confident, and Phase 07 shipped.
**Blocks:** nothing.

---

## Why this is a separate phase

Everything here removes a safety net. Each item is only correct **after** the new path has
been proven in production — not after it merged, not after it passed tests. Doing any of it
early destroys the rollback path.

There is no rush. Unused indexes and unread fields cost a little write amplification and
nothing else. **When in doubt, wait.**

---

## 1. Delete the old indexes

Phase 02 deliberately kept all nine `createdBy` composite indexes alongside the new
`accountId` ones, so that a rollback always had working indexes to land on.

**Removing them from the file is not enough.** `firebase deploy --only firestore:indexes`
prompts before deleting, and under `--nonInteractive` without `--force` it *skips* the
deletion and logs a note telling you to re-run with `--force`. So a CI deploy will leave
all nine in place while the file says otherwise — and the acceptance check below has to
inspect the **database**, not the file.

Once you're certain you'll never roll back to `createdBy` reads, remove them:

| Collection | Index to remove |
|---|---|
| `ideas` | `createdBy, archived, createdAt DESC, __name__ DESC` |
| `ideas` | `createdBy, archived, isScriptGenerated, createdAt DESC, __name__ DESC` |
| `ideas` | `createdBy, archived, title` |
| `ideas` | `createdBy, archived, isScriptGenerated, title` |
| `ideas` | `createdBy, createdAt ASC` — **already dead**, matched no query even before this project |
| `scripts` | `createdBy, createdAt DESC` |
| `videoProjects` | `isDeleted, createdBy, updatedAt DESC, __name__ DESC` |
| `videoProjects` | `isDeleted, createdBy, overallStatus, updatedAt DESC, __name__ DESC` |
| `packaging` | `createdBy, createdAt DESC` |

Deploy with `--force` (this is the one place it's wanted), then **list the live indexes
and confirm the nine are actually gone** — the file alone proves nothing.

Then verify the app still works. **This is the irreversible step in this phase** —
recreating an index means another build window.

---

## 2. Remove the channel fields from the user record

After Phase 06, nothing reads the channel half of `users/{uid}`. Those fields — `userName`,
`channelId`, `channelDescription`, `userTitle`, `niche`, `targetAudience`, `brandName`,
`website`, `websiteContent`, `competitors`, `format` — are duplicated onto the account and
now diverge silently whenever a channel is edited.

Duplicated data that nobody reads is a trap: the next person to open the user record will
reasonably assume it's current.

**Do it as its own script**, after confirming that no code path reads them from the user
record. Use the grep from Phase 06b — `grep -rnE "\.repo\.get\(|userRepo\.get\(" src/service/`
— **not** a `userRepo.get` grep, which misses `UserService` entirely because that class names
the field `repo` (`user.service.ts:22`). The two sites it misses are `getProfile`
(`user.service.ts:93`) and `refreshContext` (`user.service.ts:118`), and the second one
*writes*: after these fields are deleted it would silently re-enrich from nothing and
overwrite good account data.

Keep `stats` until Phase 08's migration is settled.

### This step needs a backup, and it is the one most likely not to have one

This is the only destructive step in the plan that touches user data, and its implicit
rollback is "we have a backup". Two problems:

- **Managed export and PITR are Blaze-only.** If this step lands after a downgrade to Spark,
  no backup can be taken — and the failure is discovered at the exact moment it is needed.
- **`competitors[]` is not cheaply re-derivable.** Each competitor costs ~101 YouTube quota
  units to re-enrich (`extract.repository.ts:8`, see Phase 08), against a project-wide
  10,000/day. Recovery across a user base would be rate-limited for days.

**Pick one before running this:**

1. **Bind it to a billing window.** Take `gcloud firestore export` immediately before, and
   restore it once to prove it is real.
2. **Or snapshot in-database, which works on either plan.** Copy the eleven fields into a
   single `legacyChannelSnapshot` map on the same user document — one write per user, no new
   collection, small. Add a `fieldOverrides` exemption so it isn't indexed, and delete it
   after 90 days.

Option 2 is the more robust default precisely because it does not depend on the billing
plan. "We're confident" is not a rollback path.

---

## 3. Make `X-Account-Id` required

Phase 05 deliberately falls back to `lastActiveAccountId` when the header is missing, so
already-loaded browser tabs kept working through the transition.

Once every client sends it, drop the fallback and return **400** when it's absent. The
fallback is ambient state — it decides which channel you're writing to based on something
other than the request — and that's exactly the class of ambiguity this project set out to
remove.

Check your logs for requests arriving without the header before flipping this.

---

## 4. Tidy the leftovers

- **Field exemptions.** Confirm the `fieldOverrides` from Phase 02 are in place —
  `members`, `websiteContent`, `channelDescription`, `competitors`, and the free win on
  `ideas.embedding`.
- **TTL policies.** Declare them in `firestore.indexes.json` via `fieldOverrides`
  (`"ttl": true`), not in the console — see Phase 09. **But know that TTL deletes are
  Blaze-only.** On Spark the policies exist and never fire, which is fine for
  `invites.expiresAt` (expiry is enforced in the acceptance transaction; TTL only reclaims
  storage) and **not** fine for `events`: it is the largest append-only collection, is never
  read, and TTL would be its only brake. Unchecked it grows into Spark's **1 GiB stored-data
  cap**, and hitting that cap fails writes **across the whole database**. If a downgrade is
  ever likely, cap `events` at write time instead of relying on TTL.
- ~~**The `migrations/{collection}` documents** from Phase 04 and Phase 05a.~~ **VOID —
  they do not exist.** Phase 04 was dropped and its script deleted; Phase 05a's
  `rekey-packaging.ts` was deleted having never been run; `COLLECTIONS.MIGRATIONS` is gone
  from the enum. There is no backfill audit trail to keep, because there was no backfill.
- **Orphaned `topics` indexes.** If Phase 02's cleanup was skipped, eight indexes on the
  dead `topics` collection group are still deployed and will show up in step 1's
  verification as unexplained entries. Confirm they are gone.
- **`functions/` collection names.** `functions/src/util/index.ts` keeps its own copy of the
  collection constants and has already drifted — it's missing `EVENTS`. Either re-sync it
  or, better, make it import from one shared source so it can't drift again.
- **Docs.** Update `docs/features/*/spec.md` and `docs/product/pipeline-spec.md`, which still
  describe `createdBy` as the tenancy key.

  **The `.claude/rules/` files are no longer this phase's job** — each is updated by the phase
  that changes it, in the same commit: `api-design.md` by Phase 05 (the `code` field), 06a and
  09 (route inventories); `firestore-conventions.md` by Phase 05a (packaging document ids) and
  Phase 06 (the query pattern and permission check). Those files are loaded into every session
  as instructions, so deferring them to here would mean the entire migration is carried out
  while the standing rules describe the system it is migrating away from.

  What remains here is verification: read both rules files against the finished system and
  confirm nothing describes the old model.

---

## How we'll know it worked

- The app works normally with the old indexes gone.
- The **deployed** index list — not just the file — contains only `accountId` indexes.
- No code reads channel fields from `users/{uid}`.
- No requests arrive without `X-Account-Id`.
- The conventions doc describes the system as it now is.

---

## Rollback

**Index deletion is the one thing here you can't quickly undo** — recreating means another
build window with failing queries. Everything else (field removal, header strictness) is a
normal revert.

That asymmetry is the reason to be slow about item 1 and relaxed about the rest.

---

## Definition of done for the whole project

- One person can manage several channels, with genuinely separate data.
- Channels can be shared at three access levels, enforced on the server.
- Credits are metered against a nominated billing owner.
- No document is reachable outside its channel — proven by the cross-account test suite
  from Phase 06.
- No `createdBy` remains as a permission decision anywhere; it means authorship only.
- The docs describe the system that actually exists.
