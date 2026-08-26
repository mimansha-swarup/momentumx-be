---
title: "Phase 03 — Dual-Write the Account Tag"
description: "Start stamping accountId on every new record while everything still reads createdBy."
date: 2026-08-19
last_updated: 2026-08-26
status: "code-complete — not yet deployed"
tags: ["multi-account", "phase-03", "migration"]
---

# Phase 03 — Dual-Write the Account Tag

**Size:** small — one new field on every write path, plus account creation.
**Depends on:** Phase 02 (indexes must exist and be `READY`).
**Blocks:** nothing. (It blocked Phase 04, which was dropped.)

---

## Where this stands (2026-08-26)

Merged on `feature/phase-3-onboarding`, **not deployed**. Suite: 821 tests, 56 suites,
green; `tsc` clean; `dist/` current.

| | |
|---|---|
| Account creation + lazy resolver | done (`account.service.ts`, `account.repository.ts`) |
| `accountId` stamped on all 7 write paths | done, each canary-verified individually |
| Reads / permissions unchanged | done, pinned by ratchets |
| **Deployed to Vercel / Render / Cloud Functions** | **outstanding** |
| **One document of each kind generated per artifact** | **outstanding** |

`status` is deliberately not `complete`: this phase's own bar is *deployed*, not merged
(see "Live means live on all three deploy artifacts" below).

It no longer gates a migration — Phase 04 was dropped (see
[phase-04](./phase-04-backfill.md)) — but the dual-write is only true of records written
by deployed code, which is what makes wiping-before-Phase-06 sufficient.

---

## The idea in simple English

Before we can move a house, we put an address label on every box. Nothing moves yet.

This phase starts writing `accountId` onto every **new** record. Nothing reads it. Every
query still filters by `createdBy`, exactly as today. If this phase is working correctly,
**users notice nothing at all.**

The reason it comes first is timing. If we backfilled the old records and *then* started
writing the new field, everything created during the gap would have no `accountId` and
would vanish the moment reads switch over. Writing first means the backfill only ever has
to deal with records that already existed when it started — it's a closed set.

---

## What we'll do

### 1. Create an account for every existing and new user

Each user gets exactly one account, with a **UUID v4 `accountId`** — deliberately NOT their
`uid` (decision 2026-08-25, see the README). Reusing the uid was a migration shortcut that
made the backfill a field copy; it also made channel deletion impossible to do properly,
because every document still pointed at the resurrectable id.

**Where does it get created?** Not in the Cloud Function auth trigger. That trigger is
already unreliable (see Phase 01, item 2), it's a separate deploy artifact, and a user
landing with a profile but no account would be stuck with no way to fix it from the UI.

**Instead: lazily, on the first authenticated request.** A small helper called from
`accountMiddleware` (added in Phase 05) or from the profile read until then:

```
ensureDefaultAccount(uid):
  // accountId is a UUID v4, NOT the uid (decision 2026-08-25, see README).
  // So existence cannot be probed by document id — check the pointer, then
  // membership, and only create when both come back empty.
  if users/{uid}.lastActiveAccountId → return that account
  if any account where memberUids array-contains uid → return the first
  accountId = randomUUID()
  create accounts/{accountId} with:              // membership only — see Phase 02
      displayName (fallback chain), handle
      memberUids: [uid]
      ownerUids:  [uid]
      members:    { [uid]: { role: "owner", addedAt: now } }
      billingOwnerUid: uid
  create accounts/{accountId}/context/channel with:
      all channel fields copied from users/{uid}
  set users/{uid}.lastActiveAccountId = accountId
```

**Channel fields go in the subcollection, not on the account document.** The account
document is read on every authenticated request to check membership; the context document
is read only when generating. Phase 02 explains why they are split — putting the scraped
`websiteContent` blob on the hot document is the exact failure that split exists to
prevent. All three writes go in one `WriteBatch`.

Self-healing: any user who somehow lacks an account gets one on their next request.

**Use a transaction, not a `WriteBatch`.** An earlier version of this section prescribed a
batch and argued a transaction "isn't needed, because a dangling account with no pointer
repairs itself on the next call". That is true and irrelevant — it reasons about the wrong
failure. The dangerous one is **two accounts, not a half-built one**:

```
request A: pointer? no → membership? no →      mint acc-1 → commit
request B: pointer? no → membership? no → mint acc-2 → commit
```

Both requests read before either wrote, so both mint. One user now owns two channels, their
records split between them, and `users/{uid}.lastActiveAccountId` points at whichever
committed last. Nothing surfaces until Phase 06 switches reads, at which point roughly half
their content disappears — the precise outcome this phase exists to prevent, reached from a
direction the batch reasoning never considered. It is reachable in practice because
`eventService.capture` also resolves an account, so two parallel requests from a brand-new
user are enough.

The fix is small: re-read `users/{uid}.lastActiveAccountId` **inside** the transaction and
return it if another request already claimed one, writing nothing. The loser adopts the
winner's id. `createWithContext` therefore returns the **winning `accountId`**, and the
caller must use that return value rather than the id it optimistically minted.

**Also: never trust an id read back from membership.** The fallback adopts
`memberUids`-matched account, and an account document with a blank `id` would be adopted and
stamped onto every record that user writes. `""` is worse than a missing tag — it is a real
value shared by every affected record across *every* user, so Phase 04 resolves them all
into one bucket that reads as a tenancy leak. Re-check the id is a non-empty string and skip
the malformed document.

### 2. Stamp `accountId` on every write

Every place that creates a record gains one field. In this phase every user has exactly one
account, so `accountId` is *that user's single account id* — resolved via
`ensureDefaultAccount`, never assumed to equal the `uid`.

Line numbers below are as-shipped (2026-08-26) and will rot; the `grep` under "Risks" is the
check that does not.

| Collection | Where it's written | Shape assembled at | Stamp asserted by |
|---|---|---|---|
| `ideas` | `content.repository.ts` → `batchSaveIdeas()` | `utlils/content.ts` → **`formatGeneratedTitle()`** (used by `formatGeneratedIdea` *and* directly by the bring-your-own-title path), called from **four** sites: `idea.controller.ts:79`, `content.service.ts:446`, `content.service.ts:482`, `video-project.service.ts:96` | `tests/unit/utils/record-owner.behaviour.test.ts` |
| `scripts` | `content.repository.ts` → `saveScript()` | `formatGeneratedScript()`, called from `content.service.ts:357` | `record-owner`, `content.service.script-iteration` |
| `hooks` | `hooks.repository.ts` → `save()` | assembled in `hooks.service.ts:103` | `service/hooks.flow.behaviour` |
| `packaging` | `packaging.repository.ts` → `save()` **and** `upsertGeneratedItem()` (both create documents) | `packaging.service.ts:390`, `packaging.repository.ts:135` | `packaging.service.iteration`, `packaging.repository` |
| `videoProjects` | `video-project.repository.ts` → `create()` | `video-project.service.ts:59` | `video-project.service` |
| `events` | `event.repository.ts` → `add()` | `event.service.ts` → `capture()` | `event.service` |

Every row was canary-verified: drop that one stamp and exactly that suite fails. Assert the
written document's **value**, not that the source text contains `accountId` — a text match
passes on `accountId: batchId`, which is the mistake that actually happened here (see
"positional arguments" below).

**`accountId` is stamped server-side, after any request-body spread.** The packaging save
path builds `{ ...normalized, createdBy: userId, videoProjectId: projectId }`
(`packaging.service.ts:383-387`) — the trusted fields come last, which is the only reason a
client cannot spoof `createdBy` today. Stamp `accountId` the same way, and do not let field
ordering be the guarantee: Phase 01 item 7 adds the schema that stops these keys reaching
the service at all. If that schema is not in place yet, this table's packaging row is a
cross-tenant write primitive rather than a field copy.

### The write site that a layer-scoped grep cannot find

**`idea.controller.ts:79` assembles the idea write shape inside a *controller*** — it calls
`formatGeneratedIdea(idea, owner, batchId)` and then `saveBatchIdeas` at `:94`. That is
the `POST /v1/ideas/generate` path, the highest-volume write in the system.

### Positional arguments will not enumerate the write sites — an object will

The plan here was to make `accountId` a required parameter so the compiler would list every
caller. It does not work, and it looks like it does. `userId`, `accountId` and `batchId` are
all `string`, so `formatGeneratedIdea(idea, userId, batchId)` kept compiling with `batchId`
sitting in the account slot: a wrong tag, written silently, on the highest-volume path. Two
of five sites errored; three did not.

Pass an **object** the bare string cannot satisfy:

```ts
export interface RecordOwner { userId: string; accountId: string; }
```

All five then fail to compile until updated. Same treatment for
`packaging.repository.upsertGeneratedItem`, which had the same run of positional strings.

It matters beyond being one more line, because **none of the five shape-assembly sites
contains the string `createdBy`.** That name appears only inside the helpers in
`src/utlils/content.ts` and in the nine `.where("createdBy", ...)` calls in
`src/repository/`. So the obvious self-check — "grep `createdBy` across `src/repository/`" —
greps the one layer that structurally *cannot* contain a shape assembly, and reports clean
whether or not the list is complete.

**Use this instead:**

```bash
grep -rn "formatGeneratedTitle(\|formatGeneratedIdea(\|formatGeneratedScript(" src/
```

(It is also an outlier because it violates `.claude/rules/backend-standards.md` — embedding
generation and document assembly do not belong in a controller. Fixing that layering is out
of scope here; knowing it exists is not.)

**Don't forget `events`.** `eventService.capture(userId, type, meta)` is a module-level
singleton called from **12** controller sites with no request context. Adding the account
means either changing the signature everywhere or threading the request through. It is easy
to overlook, and the whole point of per-channel usage reporting is that these records are
correctly tagged.

`event.service.ts:21` is also the one write site with no request context at all, which makes
it the most likely to end up with an undefined `accountId` — and `src/config/firebase.ts:19`
sets `ignoreUndefinedProperties: true`, so that failure is silent. See Phase 01, item 1.

### 3. Keep `createdBy` exactly as it is

Both fields are written. Nothing is removed. `createdBy` continues to be the field every
query and permission check uses, right up until Phase 06.

---

## What explicitly does NOT change

- No query gains an `accountId` filter.
- No permission check changes.
- No API surface changes — no `X-Account-Id` yet.
- The frontend is untouched.

---

## How we'll know it worked

- Create a project end to end in a test environment; confirm every resulting document has
  **both** `createdBy` and `accountId`. They will NOT be equal — assert that `accountId`
  matches the caller's account id, not their uid.
- Confirm an account exists for a fresh sign-up, with the right membership arrays, and that
  `users/{uid}.lastActiveAccountId` points at it. The id is a UUID — assert it is NOT the uid,
  or a regression to the old shortcut would pass unnoticed.
- Confirm an existing user who signs in gets an account created without touching anything.
- The full test suite passes — behaviour is unchanged, so it should.

**An integration test over the route will not do this.** That was the original suggestion
here and it is a trap in this codebase: `tests/integration/ideas.route.behaviour.test.ts`
mocks `utlils/content` — as do all nine suites that touch the formatters — so the
`accountId` it "asserts" is a value the mock returned. It cannot fail when the stamp is
removed. Test the **formatter** directly (`tests/unit/utils/record-owner.behaviour.test.ts`);
it is the only layer no suite mocks.

Whatever is written, verify it by canary: delete the stamp, confirm the test fails, restore.
A dual-write test that has never been seen to fail is indistinguishable from one asserting
its own fixture.

### What the suite now pins, and what it cannot

Automated (821 tests, 56 suites):

- Both owner fields, by value, on all seven write paths — each canary-verified.
- `accountId` is a UUID v4, never the uid, never `""`, never defaulted from `userId`.
- Two independently-constructed `AccountService`s resolve one user to the same account
  (`event.service.ts` really does build its own, to avoid an import cycle with the
  container — "one account per user" holds only because the cache is module-scoped).
- The channel context copies every field from `users/{uid}` with the user's real values.
  TypeScript only enforces that the *keys* exist; a field wired to the wrong source key
  compiles clean and Phase 06b then generates against a wrong channel.
- The non-goals: no query filters `accountId`, no ownership check compares it, no route
  reads an account id from the request.

Not automated, and the reason Phase 04 is still blocked: **everything above runs against
mocked Firestore.** None of it proves the field reaches a real document, which is what the
per-artifact check below is for.

---

## Rollback

Stop writing the field. The extra data is inert — nothing reads it. Existing accounts can
stay; they're harmless.

---

## Risks

**A missed write path is the real risk**, and it's silent. A record created without an
`accountId` looks completely normal until reads switch over in Phase 06, at which point it
becomes invisible to its owner — which looks exactly like data loss.

Mitigations, in order of how much they actually prove:

1. **Phase 04's verification pass** — it resolves each document's `createdBy` through the
   `createdBy → accountId` map and asserts the document's `accountId` matches, reporting a
   `mismatched`/`missing` count. This is the only one that proves completeness rather than
   intent. (It was `accountId === createdBy` while account ids reused the uid; that scheme
   is dead — account ids are UUID v4, so the check needs the map.)
2. **The shape-helper grep**, not the `createdBy` grep:
   `grep -rn "formatGeneratedTitle(\|formatGeneratedIdea(\|formatGeneratedScript(" src/`.
   A `createdBy` grep over `src/repository/` cannot find a shape assembled in a controller,
   which is where the highest-volume write path lives.
3. The table above.

**"Live" means live on all three deploy artifacts.** Phase 04's precondition is that this
phase is deployed, not merged — and there are three targets (Vercel, Render, Cloud
Functions; see the README). The SSE script route is served *only* by Render, so a Vercel-only
deploy leaves every script document written during the window untagged, and Phase 04's
single pass will already have scanned past them.

**Prove it per artifact, not per merge.** Generate one document of each kind after the
deploy and confirm both fields are present — including a script, which exercises Render
specifically.
