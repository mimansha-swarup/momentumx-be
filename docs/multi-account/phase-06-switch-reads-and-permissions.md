---
title: "Phase 06 — Switch Reads and Permissions"
description: "Queries and permission checks move from createdBy to accountId. The tenancy flip."
date: 2026-08-19
last_updated: 2026-08-19
status: "planned"
tags: ["multi-account", "phase-06", "security", "tenancy"]
---

# Phase 06 — Switch Reads and Permissions

**Size:** medium in reach, small per file. Two items that were originally here have moved:
the unvalidated-resource fixes to **Phase 01 item 6** (they need no tenancy work and are
exploitable today), and the packaging key change to **Phase 05a** (it is a data-shape
migration and must not ride in the tenancy release).
**Depends on:** Phase 05 and Phase 05a. (Phase 04 was dropped — see
[phase-04](./phase-04-backfill.md). **Wipe the content collections immediately before this
phase lands**: it is the commit that makes untagged records invisible.)
**Blocks:** Phase 06a.

---

## Why this happens now and not later

The obvious plan is to leave permissions alone until sharing arrives. That would be a
mistake, and it was the single most valuable correction from review.

Right now every account has **exactly one member**. So `accountId` and `createdBy` hold
the same value, and swapping one for the other **cannot change behaviour**. That makes
this the only moment when the most security-critical rewrite in the project is verifiable
against a system you already understand: if anything breaks, it's a bug in the swap, not
an interaction with sharing.

Do it after Phase 07 and you're rewriting permissions while multiple accounts already
exist, with real data behind them, and no baseline to compare to.

---

## What changes

### 1. Queries filter on the account

Every query that filters `createdBy` filters `accountId` instead:

| Where | Method |
|---|---|
| `content.repository.ts` | `getIdeas`, `getIdeasForClustering`, `getActiveBatch`, `archiveUserIdeas`, `getScripts` |
| `video-project.repository.ts` | `list`, `findByIdeaId`, `findByScriptId` |
| `packaging.repository.ts` | `getByUserId` |

The indexes for all of these were built in Phase 02 and are `READY`.

`findByVideoProject` is deliberately absent from this table — [Phase 05a](./phase-05a-packaging-deterministic-key.md)
deleted it and turned both of its callers into point reads on `doc(videoProjectId)`. Phase
02 declares exactly one packaging composite (`accountId`, `createdAt DESC`), which serves
`getByUserId`; there is no index that would support a filtered `videoProjectId` query,
because after 05a nothing performs one.

**A real bug this fixes:** `getIdeasForClustering` builds the "avoid repeating ideas" list.
Scoped to the user, your cooking channel's ideas would suppress your finance channel's.
Scoped to the account, it does what it should.

**Note on `getIdeas` — the search branch now has TWO cursor shapes.** Fixed 2026-08-25: the
prefix-search path orders by `title`, so it emits and accepts a `{title, docId}` cursor,
while the default path keeps `{createdAt, docId}`. When this phase adds the `accountId`
filter, it applies to both branches equally — the filter goes on the shared query before the
ordering splits, so there is nothing extra to do. Just do not collapse the two branches back
into one ordering; that is the bug that made search paging re-return page 1 forever.

### 2. Permission checks compare the account

**Seventeen** places do this (`grep -rn 'createdBy\s*!==' src/` — the count is exact):

```ts
if (doc.createdBy !== userId) throw Forbidden();
```

They become:

```ts
if (doc.accountId !== req.accountId) throw Forbidden();
```

Found in `packaging.service.ts`, `video-project.service.ts`, `hooks.service.ts` and
`content.service.ts` — on `getPackaging`, `selectTitle`, `regenerateItem`, `exportPackaging`,
`getById`, `delete`, `select`, `regenerate`, `exportHooks`, `editIdeas`, `editScript`,
`getScriptById`, `regenerateScript`, `exportScript` and others.

Grep for `createdBy !==` to get the definitive list. Every hit must be either changed or
consciously left with a comment saying why.

### 3. The repository rule, restated

**Phase 01 item 6 already closed the exploitable holes** (`linkResource` for all three
resource types, and the `ContextService` resolvers) using `createdBy`, because they needed
no tenancy work and were live. **Phase 05a already deleted `findByVideoProject`** and made
packaging deterministic, in the required order.

What remains here is turning those `createdBy` comparisons into `accountId` ones, along
with the other 17, and holding the rule going forward:

> A repository method that takes a bare document id returns `null` unless the document
> belongs to the caller's account.

Phrase it that way, not as "every method takes an `accountId` and filters". Firestore cannot
filter a point read, and four repository methods are point reads by design —
`content.repository.ts:17`, `hooks.repository.ts:27`, `packaging.repository.ts:31`,
`video-project.repository.ts:40` are all `doc(id).get()`. An implementer following the
stricter wording literally would convert them into queries for no benefit.

**Two deliberate exceptions**, both of which must read before they can know the account:

- `resolveAccountFromProject` on the SSE route (Phase 05).
- `acquireStep` (Phase 01b), which does its ownership check *inside* its own transaction.

Give both a distinct method name (`findByIdUnchecked`) so the exception is auditable rather
than assumed.

The same rule applies to mutators that take a bare `projectId` — `markStale`,
`markPackagingDocumentStale`, `abandonStep`. Not exploitable today because every caller
passes an already-checked id, but the same shape, one careless caller away.

---

## The test that matters most

Add an integration test asserting **cross-account access is refused**, for every route
addressed by a document id:

```
/v1/packaging/:packagingId          GET, /regenerate/:item, /select-title, /export
/v1/hooks/:hooksId                  GET, /select, /regenerate, /export
/v1/scripts/:scriptId               GET, /edit, /regenerate, /export
/v1/video-projects/:projectId       GET, PATCH, DELETE, /step, /link
/v1/scripts/stream/:projectId       GET  ← the SSE route; highest-value single assertion
```

Also cover the routes that take an **owning id in the body**, which the list above misses:
`PATCH /:projectId/link/:resourceType` with a foreign `resourceId`, all four
`POST /v1/packaging/generate-*` with a foreign `videoProjectId`, `POST /v1/hooks/generate`,
`POST /v1/video-projects` with a foreign `ideaId`, and `PATCH /v1/ideas/edit/:ideaId`.

**A caution about the harness:** `tests/integration/video-project.route.test.ts` mocks
Firestore and the service layer entirely. Built on it, these tests prove the `if` statements
and nothing about query scoping or repository filters — which is where the real tenancy bugs
live. Either add the Firestore emulator for this one suite, or say plainly in the test file
that query scoping is covered only by manual verification.

Set up two accounts, request one's documents while acting as the other, assert 403 or 404
every time — around two dozen assertions once the body-supplied-id cases are included.

This is the single highest-value test in the whole plan: the only thing that catches
someone reintroducing a direct-object-reference hole six months from now.

---

## Update the convention file in this commit

This is the phase that makes `.claude/rules/firestore-conventions.md` actively wrong, and it
is the most dangerous of the rules files because it states its query pattern as a **security**
requirement:

> `.where('createdBy', '==', userId)` … *"Filtering by `userId` first is required for both
> security (only return the user's own data) and Firestore composite index efficiency."*

After this phase that sentence points at the wrong field while still carrying security
authority. Someone adding a query mid-migration follows it and writes something correctly
indexed, correctly shaped and wrongly scoped — which is precisely the failure this phase
exists to prevent, reintroduced by the instructions.

Update in this commit:

- The query pattern → `.where('accountId', '==', req.accountId)`, with `createdBy` described
  as authorship only, never permissions.
- The permission-check example → `doc.accountId !== req.accountId`.
- The collections list → add `accounts`, `billing`, `invites`, `migrations`.

Waiting until Phase 10 means every session between here and the end of the plan is being
told to build single-tenant queries.

---

## How we'll know it worked

The obvious criteria for this phase are **vacuous**, and it is worth saying so plainly.
"Everything behaves exactly as before" is satisfied by a system with the filters entirely
absent, since a single-channel user's documents all carry the same `accountId` either way.
"No `account_mismatch` events" is true if the middleware is never exercised with a foreign
id. A grep is a lint, not a behaviour test.

So the criteria that actually prove something:

- **The cross-account suite passes, run against two separately-signed-up users.** Each has
  their own account via `ensureDefaultAccount`, which is sufficient — this phase does not
  need the Accounts API (that is Phase 06a, and it is what Phase 06b needs).
- **A second account owned by the SAME user, with documents in both.** Two different users
  isolating correctly proves much less than it looks — the interesting bug is a query
  filtering on the right *user* but the wrong *account*. Give `uidA` two accounts, tag
  documents to each, point `lastActiveAccountId` at one, and assert the listing returns
  exactly that account's documents and none of the same user's from the other.

  > An earlier version of this bullet asked for a fixture account "whose id is NOT a uid",
  > because under the old `accountId === uid` scheme a bug passing `userId` where
  > `accountId` belongs isolated correctly and was invisible. That scheme is dead — account
  > ids are UUID v4 and never equal a uid — so the id spaces are disjoint everywhere and
  > that whole bug class fails loudly on the first query. The fixture is no longer needed;
  > the same-user-two-accounts case above is what still has teeth.
- **The SSE route is tested against a project in an account the caller is not a member of** —
  not merely a project owned by someone else. Per Phase 05, that route derives its account
  from the project, so the ownership comparison can never fail there; only the membership
  lookup can.
- Everything behaves as before for a normal user. Necessary, not sufficient.
- A grep for `createdBy` in `src/repository/` and `src/service/` returns only authorship
  reads, never permission decisions.

**A caution about the harness, unchanged from the original draft and still true:**
`tests/integration/video-project.route.test.ts` mocks Firestore and the service layer
entirely. Tests built on it prove the `if` statements and nothing about query scoping or
repository filters — which is where the real tenancy bugs live. Either add the Firestore
emulator for this one suite, or state plainly in the test file that query scoping is covered
only by manual verification. For the phase the plan calls the security-critical rewrite, the
emulator is the right answer.

---

## Rollback

Revert the code. The old `createdBy` indexes are still deployed (Phase 02 kept them), and
every record still has its `createdBy` field — nothing was removed. This is the last phase
where rollback is genuinely clean, which is why Phase 07 is separated from it.

---

## Risks

**A missed query** shows a user an empty list or somebody else's data. The cross-account
test suite is the mitigation; the grep is the backstop.

**A missed permission check** is the serious one — it's an access-control hole that no
user will report because it never affects them until it does. Same mitigation.

**Untagged records become invisible.** Their owner sees content silently disappear, which
is indistinguishable from data loss. With the backfill dropped, the mitigation is that
nothing untagged survives into this phase — wipe the content collections first. If this
plan ever runs against real data, the backfill and its verification pass come back and
become a hard gate.
