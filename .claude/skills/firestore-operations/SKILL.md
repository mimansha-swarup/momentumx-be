---
name: firestore-operations
description: Reference for Firestore repository patterns in MomentumX — imports, CRUD, batch writes, queries, timestamps, IDs, and current document shapes. Use when building or modifying repository layer code.
---

# Firestore Operations Reference

The enforced rules (repository-only access, server timestamps, enum-only collection names, batch writes, userId-first queries) live in `.claude/rules/firestore-conventions.md`. This file shows the actual imports, call shapes, and document schemas.

## Imports

```typescript
// src/config/firebase.ts exports: { db, firebase, auth }
import { db, firebase } from "../config/firebase.js";
import { COLLECTIONS } from "../constants/collection.js";
import { randomUUID } from "crypto";

// Server timestamp — via the namespaced admin SDK
firebase.firestore.FieldValue.serverTimestamp()
```

## Collection Enum (`src/constants/collection.ts`)

```typescript
export const enum COLLECTIONS {
  USERS = "users",
  SCRIPTS = "scripts",
  TOPICS = "topics",
  PACKAGING = "packaging",
  VIDEO_PROJECTS = "videoProjects",
  HOOKS = "hooks",
}
```

Always `COLLECTIONS.X` — never hardcode strings. It's a `const enum`: values are inlined at compile time.

## Repository Pattern

```typescript
export default class ContentRepository {
  // CREATE — batch for multiple docs
  saveTopics = async (topics: Omit<ITopic, "id">[], userId: string): Promise<ITopic[]> => {
    const batch = db.batch();
    const withIds = topics.map((t) => ({
      ...t,
      id: randomUUID(),
      createdBy: userId,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    }));
    withIds.forEach((topic) => {
      batch.set(db.collection(COLLECTIONS.TOPICS).doc(topic.id), topic);
    });
    await batch.commit(); // atomic; max 500 ops per batch
    return withIds;
  };

  // READ single — ownership checked in the repository, null when missing OR not owned
  getTopicById = async (topicId: string, userId: string): Promise<ITopic | null> => {
    const doc = await db.collection(COLLECTIONS.TOPICS).doc(topicId).get();
    if (!doc.exists) return null;
    const data = doc.data() as ITopic;
    if (data.createdBy !== userId) return null;
    return data;
  };

  // READ list — userId filter FIRST, always bounded
  getTopicsByUserId = async (userId: string): Promise<ITopic[]> => {
    const snap = await db
      .collection(COLLECTIONS.TOPICS)
      .where("createdBy", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();
    return snap.docs.map((d) => d.data() as ITopic);
  };

  // UPDATE — always bump updatedAt
  updateTopic = async (topicId: string, updates: Partial<ITopic>): Promise<void> => {
    await db.collection(COLLECTIONS.TOPICS).doc(topicId).update({
      ...updates,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  };
}
```

Repositories return `null` for missing/not-owned documents — services turn `null` into a thrown error; controllers turn thrown errors into `sendError`.

## Document ID Conventions

```
topics, scripts → randomUUID()
users           → Firebase UID (doc ID = req.userId)
packaging       → Firestore auto-ID (collection.add(data); use ref.id)
```

## Collections and Document Shapes

Authoritative shapes are the interfaces in `src/types/routes/` (`content.ts`, `hooks.ts`, `user.ts`, `video-project.ts`, `title-intelligence.ts`) — check them before adding fields. Summary:

```
users          — profile, onboarding data, channel/competitor info (competitors, topTitles)
topics         — ITopic: title, embedding number[], createdBy, feedback, archived
scripts        — IScript: own UUID doc ID; topicId + videoProjectId FKs link back.
                 ⚠ Legacy docs may have id == topicId — handle both, do NOT backfill.
hooks          — IHooksBatch: hook batch tied to a videoProjectId, per-hook feedback
packaging      — per-item statuses (IPackagingItemStatuses) + stale cascade fields
                 (isStale, staleReason, staleSince) + videoProjectId
videoProjects  — IVideoProject: pipeline state machine.
                 StepName: research | script | hooks | packaging
                 StepStatus: not_started | in_progress | completed | stale
                 StaleReason: research_regenerated | script_regenerated | hooks_regenerated
                 Links: topicId, scriptId, hooksId, packagingId
```

Any change that touches these relationships goes through `src/service/video-project.service.ts` (stale cascade lives there) — never update linkage fields ad hoc from another service.
