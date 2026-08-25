---
title: "Phase 03 — Dual-Write the Account Tag"
description: "Start stamping accountId on every new record while everything still reads createdBy."
date: 2026-08-19
last_updated: 2026-08-19
status: "planned"
tags: ["multi-account", "phase-03", "migration"]
---

# Phase 03 — Dual-Write the Account Tag

**Size:** small — one new field on every write path, plus account creation.
**Depends on:** Phase 02 (indexes must exist and be `READY`).
**Blocks:** Phase 04.

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

Self-healing: any user who somehow lacks an account gets one on their next request. Use a
`WriteBatch` so the account, its context and the pointer land together — a transaction
isn't needed, because a dangling account with no pointer repairs itself on the next call.

### 2. Stamp `accountId` on every write

Every place that creates a record gains one field. In this phase every user has exactly one
account, so `accountId` is *that user's single account id* — resolved via
`ensureDefaultAccount`, never assumed to equal the `uid`.

| Collection | Where it's written | Shape assembled at |
|---|---|---|
| `ideas` | `content.repository.ts` → `batchSaveIdeas()` | `utlils/content.ts` → **`formatGeneratedTitle()`** (used by `formatGeneratedIdea` *and* directly by the bring-your-own-title path), called from **four** sites: `idea.controller.ts:57`, `content.service.ts:416`, `content.service.ts:443`, `video-project.service.ts:95` |
| `scripts` | `content.repository.ts` → `saveScript()` | `formatGeneratedScript()`, called from `content.service.ts:331` |
| `hooks` | `hooks.repository.ts` → `save()` | assembled in `hooks.service.ts:123` |
| `packaging` | `packaging.repository.ts` → `save()` **and** `upsertGeneratedItem()` (both create documents) | `packaging.service.ts:385`, `packaging.repository.ts:116` |
| `videoProjects` | `video-project.repository.ts` → `create()` | `video-project.service.ts:59` |
| `events` | `event.repository.ts` → `add()` | `event.service.ts:21` |

**`accountId` is stamped server-side, after any request-body spread.** The packaging save
path builds `{ ...normalized, createdBy: userId, videoProjectId: projectId }`
(`packaging.service.ts:383-387`) — the trusted fields come last, which is the only reason a
client cannot spoof `createdBy` today. Stamp `accountId` the same way, and do not let field
ordering be the guarantee: Phase 01 item 7 adds the schema that stops these keys reaching
the service at all. If that schema is not in place yet, this table's packaging row is a
cross-tenant write primitive rather than a field copy.

### The write site that a layer-scoped grep cannot find

**`idea.controller.ts:57` assembles the idea write shape inside a *controller*** — it calls
`formatGeneratedIdea(idea, req.userId, batchId)` and then `saveBatchIdeas` at `:67`. That is
the `POST /v1/ideas/generate` path, the highest-volume write in the system.

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

Worth adding: a small integration test asserting that a generated idea carries an
`accountId`. It's the cheapest guard against a write path being missed, and a missed one
is invisible until Phase 06 makes those records disappear.

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
