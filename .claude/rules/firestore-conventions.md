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
  async saveTopic(topic: Topic) {
    await db.collection(Collection.TOPICS).doc(topic.id).set(topic);
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

---

## Document IDs

```typescript
// topics, scripts → UUID
import { randomUUID } from 'crypto';
const id = randomUUID();

// users → Firebase UID (req.userId from authMiddleware)

// packaging → Firestore auto-ID (let Firestore generate)
const ref = await db.collection(Collection.PACKAGING).add(data);
```

---

## Collection Names — Always Use Enum

```typescript
// ✅ Always
Collection.TOPICS
Collection.SCRIPTS
Collection.USERS
Collection.PACKAGING

// ❌ Never hardcode strings
'topics'
'scripts'
```

All collection names are in `src/constants/collection.ts`. Add new collections to the enum — never inline strings in repository code.

---

## Batch Writes for Multiple Documents

```typescript
// ✅ Batch when saving multiple documents at once (e.g. 10 topics)
const batch = db.batch();
topics.forEach(topic => {
  batch.set(db.collection(Collection.TOPICS).doc(topic.id), topic);
});
await batch.commit();

// ❌ Never loop individual writes
for (const topic of topics) {
  await db.collection(Collection.TOPICS).doc(topic.id).set(topic); // N writes, no atomicity
}
```

---

## Query Pattern — Always Filter by userId First

```typescript
// ✅ userId filter always first — security + index efficiency
db.collection(Collection.TOPICS)
  .where('createdBy', '==', userId)
  .orderBy('createdAt', 'desc')
  .limit(20)
  .get()
```

Filtering by `userId` first is required for both security (only return the user's own data) and Firestore composite index efficiency.

---

## Data Model Gap — Known Issue

Packaging documents have no `scriptId` or `topicId` foreign key. The packaging collection is disconnected from topics and scripts by design until the video project data model is formally defined.

**Do not** add new packaging features that depend on this link until the video project schema is decided. Flag this gap if a task requires cross-collection relationships involving packaging.

---

## Firestore Collections

```
users      — user profiles, onboarding data, channel/competitor info
topics     — generated title ideas with vector embeddings
scripts    — full video scripts (document ID = topic ID)
packaging  — packaged assets (currently disconnected from topics/scripts)
```
