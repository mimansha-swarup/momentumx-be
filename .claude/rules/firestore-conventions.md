---
name: firestore-conventions
description: Firestore-specific rules for data access, timestamps, IDs, collection naming, and batching in MomentumX.
---

# Firestore Conventions

Firestore-specific rules for data access, timestamps, IDs, and collection naming. Prevents data inconsistency and keeps the repository pattern clean.

---

## Repository-Only Access — Always

Only repositories touch Firestore. No exceptions.

```typescript
// ✅ Only repositories touch Firestore
class ContentRepository {
  async saveIdea(idea: Idea) {
    await db.collection(COLLECTIONS.IDEAS).doc(idea.id).set(idea);
  }
}

// ❌ Never in services or controllers
await db.collection('topics').doc(id).get(); // wrong layer
```

---

## Timestamps — Always Server-Side

```typescript
// ✅ Server-side timestamp
createdAt: firebase.firestore.FieldValue.serverTimestamp()
updatedAt: firebase.firestore.FieldValue.serverTimestamp()

// ❌ Never client-side
createdAt: new Date()
createdAt: Date.now()
```

This applies to **stored** fields. Computing a `Date` in code for a query boundary (e.g. "videos from the last 30 days" in `research.repository.ts`) is fine — the rule is that timestamps written to documents come from the server, so clock skew can't corrupt ordering.

---

## Document IDs

```typescript
// ideas, scripts → UUID
import { randomUUID } from 'crypto';
const id = randomUUID();

// users → Firebase UID (req.userId from authMiddleware)

// packaging → DETERMINISTIC id = videoProjectId. ALWAYS. Both creation paths.
// Persist-on-generate fires item writes concurrently (round 1 title+shorts,
// round 2 desc+thumbnail); a deterministic id makes concurrent first-generations
// converge on ONE doc instead of racing two auto-id creates, and the transaction
// makes the "all four done?" check see a consistent snapshot.
const ref = db.collection(COLLECTIONS.PACKAGING).doc(videoProjectId);
// READ IT AS A POINT READ: repo.get(videoProjectId). No lookup query.
//
// This section used to say the opposite — "legacy/door docs may still have
// auto-IDs, always LOCATE by findByVideoProject, never assume id ===
// videoProjectId". That was true while the SAVE path minted auto-IDs and only
// persist-on-generate used the deterministic key. Phase 05a made the save path
// deterministic too (repo.saveWithId), which is what retired the warning.
//
// There is NO locate query left, in either direction: `findByVideoProject` is
// deleted, `savePackaging` point-reads, and `upsertGeneratedItem` point-reads
// inside its transaction. Do not reintroduce one. The transaction is for the
// itemStatuses read-modify-write, not for finding the document.
```

---

## Collection Names — Always Use Enum

```typescript
// ✅ Always
COLLECTIONS.IDEAS
COLLECTIONS.SCRIPTS
COLLECTIONS.USERS
COLLECTIONS.PACKAGING
COLLECTIONS.HOOKS
COLLECTIONS.VIDEO_PROJECTS
COLLECTIONS.EVENTS

// ❌ Never hardcode strings
'ideas'
'scripts'
```

All collection names are in `src/constants/collection.ts`. Add new collections to the enum — never inline strings in repository code.

---

## Batch Writes for Multiple Documents

```typescript
// ✅ Batch when saving multiple documents at once (e.g. 10 ideas)
const batch = db.batch();
ideas.forEach(idea => {
  batch.set(db.collection(COLLECTIONS.IDEAS).doc(idea.id), idea);
});
await batch.commit();

// ❌ Never loop individual writes
for (const idea of ideas) {
  await db.collection(COLLECTIONS.IDEAS).doc(idea.id).set(idea); // N writes, no atomicity
}
```

---

## Query Pattern — Always Filter by accountId First

```typescript
// ✅ accountId filter always first — security + index efficiency
db.collection(COLLECTIONS.IDEAS)
  .where('accountId', '==', accountId)   // from req.accountId, never the body
  .orderBy('createdAt', 'desc')
  .limit(20)
  .get()
```

**This section used to say `createdBy`, and said it with security authority.** Phase 06
moved tenancy from the person to the channel, so a query written from the old rule is
correctly indexed, correctly shaped and **wrongly scoped** — which is the exact failure
that phase exists to prevent, reintroduced by the instructions.

- `accountId` is the **permission** field. It decides what a request may read or touch.
- `createdBy` is **authorship** only. Still written on every record, still useful for
  "who made this", and never a permission decision.

The distinction is invisible today, because every account has one member — a check on
either field admits the same person. It stops being invisible in Phase 09, when a channel
gains a second member and a `createdBy` check starts refusing a co-member on a document
their own channel owns.

Both are enforced mechanically by `tests/unit/dual-write-coverage.test.ts`: no service may
compare `createdBy`, and no repository may `.where("createdBy", ...)`.

```typescript
// ✅ Permission check on an already-loaded document
if (doc.accountId !== owner.accountId) throw Forbidden();

// ❌ The pre-Phase-06 shape. Passes every test until sharing exists.
if (doc.createdBy !== userId) throw Forbidden();
```

The account reaches a service as a `RecordOwner` (`src/utlils/content.ts`) — one object,
never two loose strings, because `userId` and `accountId` are both `string` and a
positional parameter accepts whichever the caller happens to hold. Controllers build it
with `ownerOf(req)`; nothing else may assemble one.

---

## Firestore Collections

```
accounts       — channels: members, roles, owner, display name, tombstone (deletedAt).
                 Deleting one tombstones the account and then PURGES the six tenancy
                 collections by accountId plus the context subcollection — Firestore
                 cascades nothing, and after the tombstone none of it is reachable
                 (+ a `context/channel` SUBCOLLECTION — the scrape is uncapped and the
                  account doc is read on every request, so it must not live on it)
billing        — Phase 08, unused
invites        — Phase 09, unused
users          — IDENTITY ONLY: uid, name, email, photoURL, stats, and
                 `lastActiveAccountId` (the pointer accountMiddleware repairs).
                 NOT the channel — Phase 06b moved niche, targetAudience,
                 brandName, the channel URL, the website scrape and competitors
                 into `accounts/{id}/context/channel`. Writing them here again
                 makes onboarding a second channel overwrite the first one's,
                 and makes every channel report the first one's onboarded state.
ideas          — generated video ideas with vector embeddings
scripts        — full video scripts (document ID = own UUID; ideaId + videoProjectId FKs link back.
                 Legacy docs may have ideaId field — handle as-is, do NOT backfill)
hooks          — hook batches tied to video projects
packaging      — packaged assets with per-item status tracking and stale cascade
videoProjects  — pipeline state machine linking ideas → scripts → hooks → packaging
events         — append-only telemetry collection (capture user actions: project creation, selections, exports)
```

Video projects connect the collections: each project links to an ideaId, scriptId, hooksId, and packagingId. Packaging documents track per-item generation status (`itemStatuses`) and stale state (`isStale`, `staleReason`, `staleSince`).
