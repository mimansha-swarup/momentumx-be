---
name: firestore-operations
description: Reference for Firestore repository patterns in MomentumX — CRUD operations, batch writes, queries, timestamps, and ID generation. Use when building or modifying repository layer code.
---

# Firestore Operations Reference

## Database Init

```typescript
// src/config/firebase.ts
import admin from 'firebase-admin';
export const db = admin.firestore();
export const FieldValue = admin.firestore.FieldValue;
```

## Collection Enum

```typescript
// src/constants/collection.ts
export enum Collection {
  USERS = 'users',
  TOPICS = 'topics',
  SCRIPTS = 'scripts',
  PACKAGING = 'packaging',
}
```

Always use `Collection.ENUM_VALUE` — never hardcode collection strings.

## Repository Pattern

```typescript
// src/repository/content.repository.ts
import { db, FieldValue } from '../config/firebase';
import { Collection } from '../constants/collection';
import { Topic } from '../types';
import { randomUUID } from 'crypto';

export class ContentRepository {
  // CREATE
  async saveTopics(topics: Omit<Topic, 'id'>[], userId: string): Promise<Topic[]> {
    const batch = db.batch();
    const topicsWithIds: Topic[] = topics.map(t => ({
      ...t,
      id: randomUUID(),
      createdBy: userId,
      createdAt: FieldValue.serverTimestamp(),
    }));

    topicsWithIds.forEach(topic => {
      const ref = db.collection(Collection.TOPICS).doc(topic.id);
      batch.set(ref, topic);
    });

    await batch.commit();
    return topicsWithIds;
  }

  // READ — single
  async getTopicById(topicId: string, userId: string): Promise<Topic | null> {
    const doc = await db.collection(Collection.TOPICS).doc(topicId).get();
    if (!doc.exists) return null;
    const data = doc.data() as Topic;
    if (data.createdBy !== userId) return null; // ownership check
    return data;
  }

  // READ — list (always filter by userId first)
  async getTopicsByUserId(userId: string): Promise<Topic[]> {
    const snap = await db.collection(Collection.TOPICS)
      .where('createdBy', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();
    return snap.docs.map(doc => doc.data() as Topic);
  }

  // UPDATE
  async updateTopic(topicId: string, updates: Partial<Topic>): Promise<void> {
    await db.collection(Collection.TOPICS).doc(topicId).update({
      ...updates,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  // DELETE
  async deleteTopic(topicId: string): Promise<void> {
    await db.collection(Collection.TOPICS).doc(topicId).delete();
  }
}
```

## Document ID Conventions

```typescript
// topics, scripts → UUID
import { randomUUID } from 'crypto';
const id = randomUUID();

// users → Firebase UID (req.userId from authMiddleware)
// No ID generation needed — Firestore doc ID = Firebase Auth UID

// packaging → Firestore auto-ID
const ref = await db.collection(Collection.PACKAGING).add(data);
const packagingId = ref.id;
```

## Timestamps — Always Server-Side

```typescript
// ✅ Correct
createdAt: FieldValue.serverTimestamp()
updatedAt: FieldValue.serverTimestamp()

// ❌ Never
createdAt: new Date()
createdAt: Date.now()
```

## Batch Writes

Use batch when saving multiple documents at once:

```typescript
const batch = db.batch();

items.forEach(item => {
  const ref = db.collection(Collection.TOPICS).doc(item.id);
  batch.set(ref, item);
});

await batch.commit();
```

Batch write is atomic — either all succeed or all fail. Maximum 500 operations per batch.

## Query Pattern

```typescript
// Always: userId filter first, then other filters
db.collection(Collection.TOPICS)
  .where('createdBy', '==', userId)   // first — security + index
  .where('status', '==', 'active')    // optional additional filter
  .orderBy('createdAt', 'desc')
  .limit(20)
  .get()
```

## Firestore Collections

```
users
  id: Firebase UID
  name, niche, targetAudience, website, websiteContent
  brandName, channelUrl
  competitors: string[]
  topTitles: string[]
  createdAt, updatedAt

topics
  id: UUID
  title: string
  embedding: number[]
  createdBy: string (userId)
  createdAt

scripts
  id: UUID (same as topic ID)
  content: string
  title: string
  createdBy: string (userId)
  createdAt, updatedAt

packaging
  id: Firestore auto-ID
  createdBy: string (userId)
  titles?: object
  description?: string
  thumbnail?: object
  hooks?: object
  shorts?: object
  createdAt
  NOTE: no scriptId or topicId foreign key (known data model gap)
```

## Error Handling in Repositories

```typescript
// Repositories do NOT throw on missing documents — return null
async getTopicById(topicId: string): Promise<Topic | null> {
  const doc = await db.collection(Collection.TOPICS).doc(topicId).get();
  if (!doc.exists) return null;
  return doc.data() as Topic;
}

// Services throw — they check for null and decide what to do
async getTopic(topicId: string, userId: string): Promise<Topic> {
  const topic = await this.repo.getTopicById(topicId, userId);
  if (!topic) throw new Error('Topic not found');
  return topic;
}
```
