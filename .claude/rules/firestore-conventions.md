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

## Query Pattern — Always Filter by userId First

```typescript
// ✅ userId filter always first — security + index efficiency
db.collection(COLLECTIONS.IDEAS)
  .where('createdBy', '==', userId)
  .orderBy('createdAt', 'desc')
  .limit(20)
  .get()
```

Filtering by `userId` first is required for both security (only return the user's own data) and Firestore composite index efficiency.

---

## Firestore Collections

```
users          — user profiles, onboarding data, channel/competitor info
ideas          — generated video ideas with vector embeddings
scripts        — full video scripts (document ID = own UUID; ideaId + videoProjectId FKs link back.
                 Legacy docs may have ideaId field — handle as-is, do NOT backfill)
hooks          — hook batches tied to video projects
packaging      — packaged assets with per-item status tracking and stale cascade
videoProjects  — pipeline state machine linking ideas → scripts → hooks → packaging
events         — append-only telemetry collection (capture user actions: project creation, selections, exports)
```

Video projects connect the collections: each project links to an ideaId, scriptId, hooksId, and packagingId. Packaging documents track per-item generation status (`itemStatuses`) and stale state (`isStale`, `staleReason`, `staleSince`).
