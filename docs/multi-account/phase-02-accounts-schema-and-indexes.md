---
title: "Phase 02 — Accounts Schema and Indexes"
description: "Create the accounts collection and deploy every new index before any code needs them."
date: 2026-08-19
last_updated: 2026-08-19
status: "planned"
tags: ["multi-account", "phase-02", "schema", "indexes"]
---

# Phase 02 — Accounts Schema and Indexes

**Size:** medium. Mostly a config release plus new types.
**Depends on:** Phase 01.
**Blocks:** everything after it.

---

## Why indexes get their own phase

Firestore needs a pre-built index for most multi-field queries. A query with no matching
index doesn't fail at deploy time — it fails **at runtime**, for the user, with
`FAILED_PRECONDITION`. Building an index takes minutes to hours, during which the query
is simply broken.

This project has already had one production outage from exactly this, when a collection
rename left `firestore.indexes.json` pointing at a name that no longer existed. `/v1/ideas`
returned 500 to every user until the indexes were rebuilt.

So: **indexes ship on their own, ahead of any code that needs them, and are confirmed
`READY` before the next phase starts.**

### The rule that protects rollback

`firebase deploy --only firestore:indexes` will *offer* to delete indexes that aren't in
the file. It prompts before doing so, and under `--nonInteractive` without `--force` it
skips deletion entirely and tells you to re-run with `--force`
(`firebase-tools/lib/firestore/api.js`). So the CLI won't surprise you — but the moment
someone adds `--force`, or answers yes, the rollback path is gone.

That means you should **never replace** `createdBy` with `accountId` in one edit. If you
do, and then need to roll the code back, the old code queries indexes that no longer
exist and everything breaks — with a multi-hour rebuild to recover.

**Both sets stay in the file** until [Phase 10](./phase-10-cleanup.md).

---

## The new shape

### `accounts/{accountId}` — a channel

Everything that describes a channel moves here from `users/{uid}` — but **split across two
documents**, for a reason that only shows up under load:

```
accounts/{accountId}                     ← READ ON EVERY AUTHENTICATED REQUEST
  displayName         what the switcher shows (see below)
  handle              "@foo", derived from the channel URL; null until onboarded

  // membership
  memberUids: string[]                    // everyone, for "which channels can I see?"
  ownerUids:  string[]                    // owners only
  members: { [uid]: { role, addedAt } }   // the detail

  billingOwnerUid: string
  deletedAt: Timestamp | null             // tombstone — see Phase 05
  createdAt, updatedAt

accounts/{accountId}/context/channel      ← READ ONLY WHEN GENERATING
  userName            channel URL (legacy field name, kept)
  channelId, channelDescription, userTitle    scraped from YouTube
  niche, targetAudience, brandName
  website, websiteContent
  competitors[]       enriched { url, id, titles }
  format              "talking_head" | "faceless"
  purpose, description                     // see the note in Phase 06b
```

**Why the split.** Phase 05 reads `accounts/{accountId}` on *every authenticated request*
to check membership. `websiteContent` is scraped page text with **no length cap anywhere in
the code** — `extract.service.ts` does `fetch(url)` → `res.text()` →
`extractTextFromHTML(html)`, `utlils/regex.ts` strips tags and collapses whitespace without
truncating, and `utlils/content.ts:170` stores the result verbatim. A content-heavy
marketing site yields hundreds of KB.

Against the 1 MiB document limit that is survivable on its own. Co-located with the
membership fields it is not: a large scrape makes *membership writes* fail, and the failure
reads as "can't add a member to this channel" with nothing pointing at a website scrape. It
also multiplies every request's read size by the size of the blob.

**The split is free, which is why it wins.** Firestore bills per document read, not per
byte. The seven generation sites read exactly one document today (`users/{uid}`) and
exactly one after the migration (`.../context/channel`) — the count is identical either
way, and Phase 06b threads `accountId` into those sites regardless. What the split buys is
that a bad website scrape cannot make a membership write fail. Subcollections are excluded
from the parent document's 1 MiB limit.

The second reason is indexing. Firestore auto-indexes every field, and indexed values over
1500 bytes are truncated — "queries involving truncated field values may return
inconsistent results". Flat, that puts `websiteContent`, `channelDescription` and a 20×10
`competitors[].titles` array into the index fanout of the document every membership query
touches. The `fieldOverrides` exemptions listed below exist to contain that; needing them
on the hot document is the tell that those fields don't belong there.

**Capping the scrape is a Phase 01 item, not an optional aside.** 20 KB is generous and the
prompt effectively truncates it regardless. Do it as a second lock, not the primary one —
caps rot, and `channelDescription` already arrives unbounded from YouTube with nobody
capping it. The subcollection is the structural guarantee; the cap is defence in depth.

**`displayName` is required, and needs a fallback chain.** A user can complete onboarding
today with **no channel URL at all** — `momentumx-fe/src/pages/Onboarding/index.tsx` has a
first-class manual path, and `selectIsOnboarded` (`user.slice.ts:110-114`) passes on
`userName` **OR** (`niche` AND `targetAudience`). Those users' migrated accounts have no
`userName`, no `brandName` and no `userTitle`, so a switcher that renders the handle shows a
blank row. Compute once at `ensureDefaultAccount`, editable later:

```
brandName → userTitle → handle(userName) → niche → "Untitled channel"
```

**Why three membership fields and not one?** Firestore can't query inside a map. To answer
"which channels can I see?" you need `where("memberUids", "array-contains", uid)`, which
needs a plain array. The `members` map carries the roles. And `ownerUids` exists because
of two rules we have to enforce cheaply:

- *An account always keeps at least one owner* — checkable as `ownerUids.length >= 1`
  inside a transaction, without walking the map.
- *You can't delete your login while you're the last owner of any account* — one query,
  `where("ownerUids", "array-contains", uid)`. Without this field you'd have to fetch
  every account the person belongs to and filter in memory.

It is deliberate redundancy. The rule: **all three are always written together, in one
operation, by one helper.** Never let callers assemble them — that's how you get a member
who can query an account but has no role.

> **Firestore limit:** a query may contain **only one** `array-contains` clause. You
> cannot filter on `memberUids` and `ownerUids` in the same query. That is precisely why
> `ownerUids` is its own field rather than a second condition.

### `accountId` is a UUID v4 and never equals a uid

**Every** account id — including the one minted for a user's first and only channel — is
`randomUUID()` from `node:crypto`. There is no special case for migrated accounts.

> **This section used to say the opposite**, and the reversal is a deliberate decision
> (2026-08-25, recorded in the [README](./README.md#2-every-id-is-a-uuid-v4-accounts-do-not-reuse-the-uid)),
> not a drafting slip. The old design set `accountId = uid` because it collapsed the Phase 04
> backfill into a pure field copy. Do not reinstate it.

What reusing the uid would have cost, and what dropping it buys:

- **Deletion stays real.** With `accountId === uid`, deleting a channel leaves every
  document still pointing at a live id — the user's own — so a lazy re-create resurrects
  the "deleted" channel's data. A UUID is retired for good when its account is.
- **Type confusion becomes visible.** This is the big one. If account ids are uids, then a
  bug that passes `userId` where `accountId` belongs still isolates *correctly* between two
  users, and no test can see it. With disjoint id spaces the same bug fails immediately,
  on the first query, for everyone. Phase 06's acceptance criteria were built around
  manufacturing a non-uid fixture account to expose exactly this; that fixture is now
  redundant because it is the only shape that exists.
- **Not time-ordered, deliberately.** v4, not v6/v7. Firestore partitions by key *range*, so
  chronologically sortable ids funnel every new write onto one server — and per Firestore's
  own docs, adding splits does not help, the hotspot just moves. Full reasoning in the README.

**The cost is real and lands in Phase 04:** the backfill becomes a lookup rather than a field
copy — build `createdBy → accountId` from one pass over `accounts`, then apply it. That is a
map in memory, not a join, and Phase 04 is already written this way.

### Supporting collections

```
accounts/{accountId}/usage/{YYYY-MM}     per-channel usage counters (Phase 08)
billing/{uid}                            credit balance (Phase 08)
invites/{token}                          pending invitations (Phase 09)
```

Usage counters live in a **month-keyed sub-collection**, not on the account document.
Two reasons: writes naturally spread across documents instead of hammering one, and the
account document is read on every page load by the switcher — you don't want it to be a
hot write target too.

---

## Index changes

### Field ordering — the thing that's easy to get wrong

Within a composite index, all equality-filtered fields must come **before** the ordered
fields. Their order *relative to each other* doesn't affect matching. So for video
projects, `(isDeleted, accountId, updatedAt DESC, __name__ DESC)` works exactly as well as
putting `accountId` first — no need to reshuffle the existing pattern.

But that also means a search-and-replace of `createdBy` → `accountId` is wrong, for the
reason above: it *removes* the old index.

### The new indexes

Eight new composite indexes mirror the existing ones:

| Collection | Fields |
|---|---|
| `ideas` | `accountId`, `archived`, `createdAt DESC`, `__name__ DESC` |
| `ideas` | `accountId`, `archived`, `isScriptGenerated`, `createdAt DESC`, `__name__ DESC` |
| `ideas` | `accountId`, `archived`, `title` |
| `ideas` | `accountId`, `archived`, `isScriptGenerated`, `title` |
| `scripts` | `accountId`, `createdAt DESC` |
| `videoProjects` | `isDeleted`, `accountId`, `updatedAt DESC`, `__name__ DESC` |
| `videoProjects` | `isDeleted`, `accountId`, `overallStatus`, `updatedAt DESC`, `__name__ DESC` |
| `packaging` | `accountId`, `createdAt DESC` |

**No new indexes needed for:**

- `accounts` — the switcher query is a single `array-contains`, which uses the automatic
  single-field index. Sort the list in memory.
- `hooks` — has no queries at all, only get-by-id.
- `events` — has no reads at all. `event.repository.ts` exposes only `add()`.
- `invites` — looked up by document id (see Phase 09).
- Equality-only queries like `getIdeasForClustering` and `findByIdeaId`.

### Field exemptions

Firestore automatically indexes every field, including every sub-field of a map. For the
`members` map that means each member's uid becomes its own indexed field path — an
unbounded set of paths and pure write cost for something we never query.

Add to `fieldOverrides` (currently an empty array):

| Collection | Field | Why |
|---|---|---|
| `accounts` | `members` | Unbounded map keys, never queried |
| `accounts` | `websiteContent` | Large scraped text |
| `accounts` | `channelDescription` | Large text |
| `accounts` | `competitors` | Array of objects, never queried |
| `ideas` | `embedding` | Large float array, never queried — pure write cost today |

The `ideas.embedding` exemption is a free win unrelated to this project; take it while
the file is open.

### One index to delete — but not yet

`ideas (createdBy ASC, createdAt ASC)` matches no query in the codebase. Every `ideas`
query also filters `archived`, and orders `createdAt` **descending**. It's dead weight.
Don't create an `accountId` twin of it, and delete it in Phase 10.

**Index count, in the file:** 9 today → 17 during the coexistence window → 8 after cleanup.
The documented limit is 200 per database, so there's no pressure.

### The deployed set does not match the file — clean it up first

**Measured 2026-08-24 against `video-topic-5bace`:** the database has **17** composite
indexes, all `READY`. Nine of them match `firestore.indexes.json` exactly. The other
**eight are on the `topics` collection group**, which no longer exists — `topics` is absent
from the live collection list.

```
topics  createdBy, archived, title
topics  createdBy, archived, createdAt DESC
topics  createdBy, isScriptGenerated, createdAt DESC
topics  createdBy, archived, isScriptGenerated, createdAt DESC
topics  createdBy, isScriptGenerated, title
topics  createdBy, createdAt ASC
topics  createdBy, createdAt DESC
topics  createdBy, archived, isScriptGenerated, title
```

This is residue from the P6A `topics` → `ideas` rename — **the same event described at the
top of this document as the outage that justifies this phase.** The file was out of sync
with the database then in one direction, and is out of sync now in the other.

They cost nothing (an index on an empty collection group indexes nothing), but they make
the inventory unreadable exactly when the coexistence window doubles it, and Phase 10's
acceptance check inspects the *deployed* list and would find eight unexplained entries.

**Delete them before adding the new set**, so the coexistence diff is clean:

```bash
firebase deploy --only firestore:indexes --force
```

With the current file, `--force` removes exactly those eight and nothing else — every index
in the file already exists live. Confirm with a listing afterwards. Do this as its own
commit, before the new indexes are added to the file.

**Correction to an earlier draft of this plan:** `firebase deploy --only firestore:indexes`
does *not* delete without asking. Verified in firebase-tools 15.19.1
(`lib/firestore/api.js`): it prompts, and under `--nonInteractive` without `--force` it logs
`"there are N indexes defined in your project that are not present in your firestore indexes
file. To delete them, run this command with the --force flag."` and skips. That is why
`--force` is required above, and why Phase 10's cleanup would otherwise silently no-op.

**After this cleanup:** 9 deployed → 17 during coexistence → 8 after Phase 10, and the file
and the database agree at every step.

---

## Add the new collection names to the enum

`src/constants/collection.ts` has seven entries today. This plan introduces `accounts`,
`billing`, `invites`, `migrations`, and the `usage` subcollection. Add them here, with the
schema — `.claude/rules/firestore-conventions.md` requires it ("Add new collections to the
enum — never inline strings in repository code") and it is the kind of thing that gets
skipped and then hardcoded in four places.

Note that `functions/src/util/index.ts:16-23` carries its **own** copy of this enum and has
already drifted — it is missing `EVENTS`. It is currently harmless (Functions only writes
`users`), but if any new collection is ever written from `functions/`, both copies need it.

---

## Deploy order

1. **Delete the eight orphaned `topics` indexes** (above), as its own commit.
2. Merge the `firestore.indexes.json` change **with both index sets present**.
3. `firebase deploy --only firestore:indexes`
4. **Wait and verify every new index reports `READY`,** not `CREATING`. Do not skip this.
5. Only then proceed to Phase 03.

Verification (the same check used during last week's incident):

```bash
curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://firestore.googleapis.com/v1/projects/<project>/databases/(default)/collectionGroups/ideas/indexes" \
  | python3 -c "import json,sys; [print(i['state'], i['name'].split('/')[-1]) for i in json.load(sys.stdin)['indexes']]"
```

---

## How we'll know it worked

- Every new index reports `READY`.
- Every old index is **still present** — this is the rollback path.
- The app behaves identically. Nothing reads the new indexes yet.

---

## Rollback

Revert the file and redeploy. Because the old indexes were never removed, the running
code is unaffected. Removing the new ones is optional — unused indexes cost a little write
amplification and nothing else.

---

## Risks

**The main risk is skipping step 3.** Deploying indexes and immediately shipping code that
needs them is exactly how the last outage happened. The indexes exist in the config the
moment you deploy; they don't *work* until they finish building.
