---
title: "Multi-Account — Plan Overview"
description: "Splitting login from channel so one person can manage and share several YouTube channels, each with its own data."
date: 2026-08-19
last_updated: 2026-08-26
status: "planned"
tags: ["multi-account", "tenancy", "migration", "plan"]
---

# Multi-Account — Plan Overview

## The idea in one paragraph

Today your login **is** your channel. One person, one YouTube channel, and everything
you make belongs to you personally. After this change, your login and your channels
are separate things: you sign in as **you**, and you own or belong to one or more
**channels**. Each channel keeps its own ideas, scripts, hooks, titles and packaging,
completely separate from the others. You switch between them the way you switch
Google accounts or Slack workspaces. Channels can be shared with other people, with
three levels of access.

In the code a channel is called an **account**, stored in a new `accounts` collection.
The words are interchangeable in these documents — "channel" when talking about what
the user sees, "account" when talking about the record. `account` must never surface in
the UI; see the naming rule in the decisions table.

---

## Why this is a big change

One line explains the whole cost:

> **`createdBy == uid` WAS the only thing separating one user's data from another's,
> and it appeared in every query and every permission check in the system.**

The counts below describe the system **as it was before Phase 06**, which is what makes
the size of the change legible. As of Phase 06 they are all zero: no service compares
`createdBy`, no repository queries it, and `tests/unit/dual-write-coverage.test.ts` fails
if either comes back.

Six collections carry `createdBy` — `ideas`, `scripts`, `hooks`, `packaging`,
`videoProjects`, `events` — and four of them are *queried* by it (`hooks` is only ever
fetched by id; `events` is append-only and never read — `event.repository.ts` exposes
only `add()`). There are **17** hand-written `doc.createdBy !== userId → Forbidden()`
checks in the services, and **9** `.where("createdBy", ...)` query sites across three
repositories. Seven of the nine composite indexes in `firestore.indexes.json` lead with
`createdBy`; the two `videoProjects` ones lead with `isDeleted`, so they can't be edited
mechanically.

Adding a second dimension means touching all of it. That is why this plan is fifteen
small phases rather than one big one.

---

## Decisions already made

These were settled before the plan was written. They are not open for re-litigation
inside the phase documents; if one turns out to be wrong, change it here first.

| Decision | Choice |
|---|---|
| How a channel is added | **Paste a YouTube URL** — same as today's onboarding. No Google OAuth, no private analytics. |
| Sharing | **From day one.** Roles: `owner`, `editor`, `viewer`. |
| What a viewer can do | **Read and export only.** No generation — generation costs credits and writes data. |
| What an editor can do | Generate, edit, regenerate, delete projects. **No member management.** Adding a *new* channel is always allowed — it is a personal action, not a channel action. |
| Owner rule | An account **always keeps at least one owner**. |
| Invites | **Single-use expiring links**, shared out of band. The accepting user's verified email must match the invite. **No email is sent** — see the plan constraints below. |
| Billing | Each account names a **`billingOwnerUid`**. All usage in that account bills that person, whoever ran it. |
| Deleting your login | **Blocked** while you are the last owner of any account. |
| Metering unit | One **credit** balance with a price list, replacing the separate `stats.ideas` / `stats.scripts` counters. |
| **Credits reset** | **A monthly allowance that resets**, not a lifetime balance you top up. The reset is *lazy* — computed inside the debit transaction when the period is stale. A scheduled reset is forbidden; see the downgrade traps below. |
| **User-facing noun** | **"Channel"**, with the rule stated in copy: *a channel is the content context you're making videos for — its niche, audience and voice. It isn't proof you own it.* `account`, `X-Account-Id` and the error codes stay internal and must never be rendered raw. |

---

## Where this actually runs — three deploy artifacts

This was missing from the first draft and it invalidates any rollback plan that assumes
one deployment.

| Artifact | What it serves | How it deploys |
|---|---|---|
| **Vercel** (`momentumx-be.vercel.app`) | every route except the script stream | serverless, from committed `dist/` |
| **Render** (`momentumx-be.onrender.com`) | **only** `GET /v1/scripts/stream/:projectId` and `/v1/health` | persistent `node dist/server.js` (`package.json` `start`) |
| **Cloud Functions** (`functions/`) | the `onCreateUser` auth trigger | `firebase deploy --only functions`, own `package.json`, own build |

**Why two web hosts:** Vercel is serverless and enforces an execution timeout; the SSE
script stream runs 60–180 s and gets killed. Render holds the connection. Introduced in
`momentumx-fe` commit `203120b` ("render hack", 2025-10-17), which routes
`getApiDomain(true)` — `momentumx-fe/src/utils/network.ts:6` — to Render, and added the
13-minute `/v1/health` keep-alive in the same commit because Render's free instance spins
down after ~15 minutes idle.

**There is no Render config file in this repo.** It is dashboard-configured, so any
environment variable a phase adds (`ALLOWED_ORIGINS`, `TENANCY_READ`, …) must be set
there by hand, separately.

**Consequences that are now hard rules:**

- "Phase 03 is live" means live on **all three**, not merged. This was Phase 04's
  precondition; with the backfill dropped it is no longer a gate on anything, but a
  Vercel-only deploy still leaves script documents untagged, because the SSE route runs
  only on Render.
- Phase 06's read flip must land on Vercel and Render **together**, or one host queries
  `accountId` while the other queries `createdBy`.
- Phase 08's credit gate has to cover the SSE route — which is the one path served by
  Render, and the most expensive generation in the price list. Vercel shipping the gate
  while Render lags means script generation runs ungated.

**Measured, 2026-08-24:** a cold Render instance did not respond to `/v1/health` within
45 s; Vercel answered in 4 s. That is the cold-start window Phase 07 and Phase 08 have to
account for.

---

## Plan constraints: Blaze now, Spark later

**The project is on the Blaze (paid) plan today.** The intent is to operate within Spark
(free) constraints. An earlier draft of this plan asserted the project was *on* Spark;
that was wrong and never measured, and one review inherited the error.

The working rule:

> **The migration window may use Blaze. The steady state may not.**

So a managed export before Phase 04 and before Phase 10 is available and should be taken.
But nothing in the shipped design may *depend* on a Blaze-only feature.

### Blaze-only features, and where the plan would have leaned on them

| Feature | Status | Where it mattered |
|---|---|---|
| Managed export / import, PITR | Blaze only | Phase 04 and Phase 10 rollback — **use it now, during the window** |
| TTL deletes | Blaze only | `invites.expiresAt`, `events.expireAt` |
| Cloud Scheduler | Blaze only | a scheduled monthly credit reset |
| Outbound network from Functions | Blaze only | transactional email for invites |
| Daily quota (50k reads / 20k writes) | **Spark only** — no cap on Blaze | Phase 04's backfill sizing |

### The downgrade traps — mitigations that would fail *silently* on Spark

These are the dangerous ones. Each works today and stops working quietly.

1. **A scheduled monthly credit reset.** On Spark it never fires, every user stays pinned
   at last period's `consumed`, and everyone is hard-blocked from generating with no error
   that points at the cause. **Therefore the reset is lazy, inside the debit transaction —
   and a scheduler-based reset is forbidden, not merely discouraged.**
2. **TTL on `events.expireAt`.** `events` is the largest append-only collection and is
   never read. TTL is its only brake. On Spark the policy stops firing, `events` grows into
   the **1 GiB stored-data cap**, and hitting that cap fails writes **across the whole
   database** — months later, with nothing connecting it to the plan change. Either cap
   `events` at write time, or accept it as a reason the project cannot downgrade.
3. **TTL on `invites.expiresAt`.** Correctness survives: expiry is checked inside the
   acceptance transaction, which is the enforcement. Only storage reclamation stops. The
   risk is someone deleting the transaction check as redundant *because* TTL exists.
4. **Managed export as Phase 10's rollback.** Phase 10 deletes eleven fields from every
   user document. If it lands after a downgrade, no backup can be taken. Either bind it to
   the same billing window as Phase 04, or use the in-database snapshot described in
   Phase 10.
5. **The daily write cap is invisible on Blaze.** One project walkthrough writes roughly
   30–50 documents. At 20k writes/day that is a few hundred walkthroughs across all users,
   before the backfill takes a share. Every write-amplification decision in this plan is
   currently being made without feeling that ceiling.

---

## The phases

Each phase is a separate document and is meant to be shippable on its own.

| # | Phase | What it does | Reversible? | Status |
|---|---|---|---|---|
| [00](./phase-00-secure-database-rules.md) | Secure the database rules | Replace expired test-mode rules with an explicit deny-all, in the repo | Yes | ✅ done |
| [01](./phase-01-fix-foundations.md) | Fix foundations | Repair the bugs that make a safe migration impossible, and close the unvalidated-resource holes | Yes | ✅ done |
| [01b](./phase-01b-generation-seam.md) | **The generation seam** | One place where locking, preconditions, credits and telemetry attach to a model call | Yes | 🟡 partial — 2/11 calls |
| [02](./phase-02-accounts-schema-and-indexes.md) | Accounts schema and indexes | Create the `accounts` collection and deploy every new index **before** any code needs them | Yes | ✅ done |
| [03](./phase-03-dual-write-account-tag.md) | Dual-write the account tag | Start stamping `accountId` on new records; nothing reads it yet | Yes | 🟡 merged, **not deployed** |
| [04](./phase-04-backfill.md) | ~~Backfill existing data~~ | **Dropped** — dev data is disposable, so it gets wiped before Phase 06 instead of migrated | n/a | ⬜ dropped |
| [05](./phase-05-account-context-api.md) | Account context in the API | `X-Account-Id` header, membership check, `req.accountId`, the error-code contract | Yes | 🟡 built, not deployed |
| [05a](./phase-05a-packaging-deterministic-key.md) | **Packaging: one deterministic key** | Every packaging doc keyed on `videoProjectId`; every lookup query deleted | No | ✅ done |
| [06](./phase-06-switch-reads-and-permissions.md) | Switch reads and permissions | Queries and permission checks move from `createdBy` to `accountId` | Yes, until Phase 07 | 🟡 code-complete, **not deployed** |
| [06a](./phase-06a-accounts-api.md) | **The Accounts API** | List, create and activate channels — the endpoints the switcher talks to | Yes | 🟡 code-complete, **not deployed** |
| [06b](./phase-06b-move-channel-context.md) | Move channel context to the account | Generation reads niche/competitors/website from the channel, not the person | ⚠️ Step 4 is a second door | 🟡 backend code-complete; frontend outstanding |
| [07](./phase-07-frontend-account-switching.md) | Frontend account state and switching | Switcher UI, add a channel, per-channel onboarding | ⚠️ **One-way door** | — |
| [08](./phase-08-credits-and-metering.md) | Credits and metering | Monthly allowance, price list, check-and-consume through the seam | Yes | — |
| [09](./phase-09-sharing-invites-and-roles.md) | Sharing: invites and roles | Invite links, role enforcement, read-only UI | Yes | — |
| [10](./phase-10-cleanup.md) | Cleanup | Delete the old indexes and the legacy profile fields | No (final) | — |

Not a phase, but kept alongside them:
[known-defects.md](./known-defects.md) — bugs found while reviewing this plan that are **not**
part of it. They don't get worse under multi-account, so filing them into a phase would
inflate the critical path with work that has no deadline. Recorded so they aren't rediscovered
as surprises mid-migration.

### Conventions change with the code, not at the end

The files in `.claude/rules/` are loaded into every session as instructions. A phase that
changes a convention updates the convention file **in the same commit** — `api-design.md` in
Phases 05, 06a and 09; `firestore-conventions.md` in Phases 05a and 06. Deferring them to
Phase 10 would mean the whole migration is carried out while the standing rules describe the
system being migrated away from. Phase 10 keeps only the final verification pass.

### The doors

**Phase 07 cannot be rolled back once a user creates a second channel.** Reverting to
the old model would merge two channels' content into one jumbled view — the data
carries an `accountId` the old code doesn't read.

**Phase 06b step 4 is a second, quieter door.** Once writes stop hitting `users/{uid}`,
that record freezes. Reverting after step 4 serves channel context that is stale by
however long step 4 has been live — the same class of failure the phase exists to prevent,
and equally invisible. Rolling back after step 4 requires a reverse re-sync (account →
user), which must be **written and tested before step 4 ships**, not after it is needed.

Phase 07's full precondition checklist lives in that document. Two items are easy to
defer and expensive to skip: a frontend test covering the account-switch state reset, and
removing generate-on-mount from the four pipeline screens.

---

## The shape of the data, before and after

**Before**

```
users/{uid}          identity + channel context + stats     ← doing two jobs
ideas | scripts | hooks | packaging | videoProjects | events
                     createdBy: uid                          ← the only tenancy key
```

**After**

```
users/{uid}                    identity only + lastActiveAccountId
accounts/{accountId}           members + billingOwnerUid + name   ← read on every request
accounts/{accountId}/context/channel
                               niche, audience, competitors, website text
                                                                  ← read only on generation
accounts/{accountId}/usage/{YYYY-MM}   per-channel usage counters
billing/{uid}                  credit allowance, consumed, periodStart
invites/{token}                pending invitations
ideas | scripts | hooks | packaging | videoProjects | events
                               accountId: string   ← tenancy key, filtered in the repo
                               createdBy: string   ← authorship only, never permissions
```

`createdBy` is deliberately kept. It stops being *who is allowed to see this* and
becomes *who wrote this*, which starts to matter as soon as two people share a channel.

**Why channel context is a subcollection and not fields on the account:** the account
document is read on *every authenticated request* (Phase 05). `websiteContent` is scraped
page text with no length cap anywhere in the code — `extract.service.ts` fetches,
`utlils/regex.ts` strips tags without truncating, `utlils/content.ts` stores it verbatim.
Co-locating an uncapped blob with the membership fields means a large scrape makes
*membership writes* fail, and nobody would connect that to a website scrape. Splitting it
also keeps the per-request read small.

---

## Corrections that shaped this plan

Each of these contradicts the obvious approach, and each came out of review.

**1. Flip the permission checks early, not late.**
The instinct is to leave the **17** `createdBy !== userId` checks alone until sharing
arrives in Phase 09. That would put the most security-sensitive rewrite in the project at
the very end, after users are already in multi-account. Instead they flip in **Phase 06**,
while every account still has exactly one member — the change is behaviour-preserving,
and it can be tested before a second account can exist.

**2. Behaviour-preserving also means bug-preserving.** A mistake in Phase 06 — missing one
of the 17 call sites — is *also* behaviour-preserving while every account has one member,
and invisible to a suite that only checks two separate users isolate from each other. Phase
06 therefore requires a fixture where **one user owns two accounts** with documents in both.

> This used to also warn that passing `userId` where `accountId` belongs would isolate
> correctly and be invisible, and to require a fixture account with a non-uid id. Decision
> 2 below killed that bug class outright: account ids are UUID v4 and never equal a uid, so
> a swapped pair matches nothing and fails on the first query.

**3. Separating documents is not enough — the *context* has to move too.**
Tagging every record with a channel makes storage separate. But generation doesn't read
storage, it reads *who you are*: niche, competitors, website text, top titles. Without
[Phase 06b](./phase-06b-move-channel-context.md), channel B generates content using channel
A's identity — correct `accountId` on every document, entirely wrong content, no error
anywhere. This phase was missing from the first draft.

**4. The plan needed an Accounts API, and had none.**
Nothing in the original thirteen documents specified how a second account gets created or
listed. `ensureDefaultAccount` makes exactly one per user. Phase 06b's acceptance test and
Phase 07's switcher were both written against endpoints that did not exist. That is
[Phase 06a](./phase-06a-accounts-api.md).

**5. Old and new indexes must coexist.**
Swapping `createdBy` for `accountId` in one commit would destroy the rollback path:
reverting the code would leave it querying indexes that no longer exist, and rebuilding
an index takes minutes to hours during which the query fails outright. Both sets stay
in the file until Phase 10.

*(Correction to an earlier draft: `firebase deploy --only firestore:indexes` does **not**
delete unasked. Verified in firebase-tools 15.19.1, `lib/firestore/api.js` — it prompts,
and under `--nonInteractive` without `--force` it logs "run this command with the --force
flag" and skips deletion. Coexistence is still correct — it protects rollback — but the
CLI is not going to surprise you.)*

**6. The deployed index set does not match the repo.**
`firestore.indexes.json` declares **9** indexes. The database has **17**, all `READY`. The
extra **8** are on the `topics` collection group, which no longer exists — residue from the
P6A `topics` → `ideas` rename, which is the same event cited below as the outage that
justifies Phase 02. Delete them before the coexistence window makes the inventory
unreadable; see Phase 02.

---

## Known risks

**The frontend has no test framework at all** — no vitest, no jest, no `*.test.*` files,
and `package.json` has no test script (only `dev`, `build`, `preview`, `lint`, `format`,
`typecheck`). The highest-risk phase in
the plan (07) lands on the codebase with the least coverage. Phase 07 names the minimum:
one test over the root reducer and the account-switch reset, which is the only cheap way to
catch the two failure modes that fail *open* and are invisible until a second channel exists.

**Backend suite status, measured 2026-09-07:** 1038 tests, 66 suites, **all passing.** An earlier draft of Phase 01 claimed the suite "fails about one
run in three". That is **not currently reproducible** — thirteen consecutive clean runs
have now been observed across two sessions. The claim has been removed rather than
repeated. If intermittent failures return, treat it as a Phase 01 blocker for the reason
originally given: during a tenancy migration, a genuine data-isolation bug and a flake look
identical, and the habit of re-running until green hides the real one.

**Index changes have already caused one production outage** on this project, when a
renamed collection left `firestore.indexes.json` stale. Phase 02 exists so that never
happens again: indexes ship in their own release, ahead of the code, and are confirmed
`READY` before anything queries them.

**Cross-account bleed is the bug class this codebase keeps producing.** Cached hooks and
scripts have leaked between projects twice; a research fetch looped because "empty" was
confused with "not fetched". The same mistakes at account level would show one channel's
work under another channel's name. Phase 07 handles this with a single root-level state
reset rather than per-slice resets, which is what failed before.

**Generation is triggered by navigation today.** All four pipeline screens generate on
mount, with no click — `momentumx-fe/src/pages/ProjectScript/index.tsx:93-98`,
`ProjectHooks/index.tsx:143-150`, `ProjectTitles/index.tsx:76-84`,
`ProjectPackaging/index.tsx:150-162`. Under Phase 08 that spends credits by navigating;
under Phase 09 a viewer auto-fires an editor-gated endpoint and lands on an error screen
whose only control retries into the same error. **Removing it is a precondition of both
phases**, and the fix is specified in Phase 08.

---

## Measure these before Phase 04

Do not guess any of them. Aggregation costs about one read per thousand documents.

```ts
// scripts/measure.ts — npx tsx --env-file=.env scripts/measure.ts
import { db } from "../src/config/firebase.js";

for (const c of ["ideas","scripts","hooks","packaging","videoProjects","events"]) {
  const total    = (await db.collection(c).count().get()).data().count;
  // A range filter on a string excludes docs missing the field entirely, and
  // `createdBy ASC` is an automatic single-field index, so this needs no composite.
  const hasOwner = (await db.collection(c).where("createdBy", ">=", "").count().get()).data().count;
  const empty    = (await db.collection(c).where("createdBy", "==", "").count().get()).data().count;
  console.log(c, "total:", total, "| missing createdBy:", total - hasOwner, "| empty:", empty);
}
console.log("users:", (await db.collection("users").count().get()).data().count, "→ accounts to create");
```

`total - hasOwner` is the number Phase 01's census currently misses: documents with **no**
`createdBy` field at all, as opposed to an empty string. It matters because
`src/config/firebase.ts:19` sets `ignoreUndefinedProperties: true`, which turns a backfill
write derived from a missing field into a silent no-op that the completion counter records
as success.

Also record from the Firebase console → Firestore → Usage:

- **daily reads/writes over a normal week** — divide 20,000 by the daily write average to
  see how many days of headroom a Spark downgrade would leave.
- **stored data**, against the 1 GiB Spark cap. `ideas.embedding` dominates.

---

## Related

- [Pipeline Spec](../product/pipeline-spec.md)
- [Product Roadmap](../product/roadmap.md) — Teams & Agencies is the phase this unlocks
- [API Design rules](../../.claude/rules/api-design.md) — the `userId`-never-from-the-body
  rule that `X-Account-Id` has to satisfy
- [Firestore conventions](../../.claude/rules/firestore-conventions.md) — the deterministic
  packaging id that [Phase 05a](./phase-05a-packaging-deterministic-key.md) finishes

---

## Decisions taken 2026-08-25

These override anything earlier in this plan that contradicts them.

### 1. `POST /v1/ideas/generate` is ADDITIVE — "Generate More"

It adds ten ideas and archives nothing; only `regenerate-all` replaces. The button already
says "Generate More". No code change — the missing `archiveUserIdeas` call in `/generate` is
deliberate and marked as such in `.claude/rules/api-design.md`, so it does not get "fixed"
by mistake.

### 2. Every id is a **UUID v4**. Accounts do NOT reuse the uid.

**All document ids in this system are UUID v4** (`randomUUID()` from `node:crypto`), including
the account id for a user's FIRST channel. `accountId === uid` is dead — it was a migration
shortcut, and it is not being taken.

**Why not a time-ordered UUID (v6 / v7).** Both put a timestamp in the leading bits so ids
sort chronologically. Firestore partitions by key RANGE, so lexicographically adjacent ids
live on the same server and every new write funnels onto one machine. Firestore's docs are
explicit — *"Do not use monotonically increasing document IDs… Such sequential IDs can lead
to hotspots"* — and note that the usual remedy fails here: *"Creating more splits doesn't help
… the surge of traffic simply moves to the newly created split."* Firestore's own auto-ids use
a **scatter** algorithm for exactly this reason. Time-ordering is a genuine win in Postgres
(B-tree locality) and a pathology in Firestore. It also buys nothing we don't already have:
ordering comes from `createdAt` server timestamps, which do not lie about when the write
actually landed.

**What this improves over the original plan:**

- **Deletion becomes real.** With `accountId === uid`, deleting a channel left every document
  pointing at that id and the next request lazily recreated it — [Phase 05](./phase-05-account-context-api.md)
  called this out as *"deletion would not be deletion"*. That whole failure mode is gone.
- **[Phase 06a's open decision disappears.](./phase-06a-accounts-api.md)** There is no longer
  a first-channel special case, so there are not two kinds of channel behaving differently.

**What this costs — read before Phase 03:**

- **The Phase 04 backfill is a lookup, not a field copy.** It must build
  `ownerUid → accountId` from the `accounts` collection first, then set
  `accountId = map[createdBy]` per document. At current volume (30 documents, one pass into a
  `Map`) this is nothing — which is the argument for doing the backfill *before* there is
  volume, not after.
- **The Phase 04 gate changes** from `accountId === createdBy || "__orphan"` to
  `accountId === ownerToAccount[createdBy] || "__orphan"`.
- **`ensureDefaultAccount` can no longer probe `accounts/{uid}`.** It checks
  `users/{uid}.lastActiveAccountId`, falls back to a membership query
  (`memberUids array-contains uid`), and only creates when both come back empty.
- **[Phase 06's test note still stands, for a better reason.](./phase-06-switch-reads-and-permissions.md)**
  It warned that with `accountId === uid` a bug passing `userId` where `accountId` belongs
  would still isolate correctly and stay invisible. With distinct ids that bug now fails
  loudly — but the cross-account fixtures are still worth having.

**Unchanged:** packaging documents stay keyed on `videoProjectId`. That id is *derived*, not
sequential, and it is what makes concurrent first-generations converge on one document
instead of racing two creates.

### 3. Credits start fresh

Every existing user begins with a full allowance; lifetime `stats.ideas` / `stats.scripts` are
NOT converted into consumed credits. Simplest, most generous, and right for a product this
young — converting would greet the most engaged users with a balance they had already spent.
See [Phase 08](./phase-08-credits-and-metering.md).
