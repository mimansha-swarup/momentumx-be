---
title: "Video Project — API Contracts"
description: "All endpoints for creating, reading, updating, and managing Video Project pipeline state"
date: 2026-02-27
last_updated: 2026-03-08
status: "implemented"
tags: ["api", "video-project", "phase-0"]
---

# Video Project — API Contracts

Base path: `/v1/video-projects`

All endpoints require `Authorization: Bearer <token>`. `authMiddleware` applied at router level. `userId` always from `req.userId` — never from request body.

---

## Endpoints Summary

| Method | URL | Purpose |
|---|---|---|
| `POST` | `/v1/video-projects` | Create project from a topic id or a new title |
| `GET` | `/v1/video-projects` | List user's projects (dashboard) |
| `GET` | `/v1/video-projects/:projectId` | Get single project with full pipeline state |
| `PATCH` | `/v1/video-projects/:projectId` | Update working title |
| `DELETE` | `/v1/video-projects/:projectId` | Soft delete |
| `PATCH` | `/v1/video-projects/:projectId/step/:stepName/start` | Mark step in_progress |
| `PATCH` | `/v1/video-projects/:projectId/step/:stepName/complete` | Mark step completed |
| `PATCH` | `/v1/video-projects/:projectId/link/:resourceType` | Link saved resource ID |

---

## POST `/v1/video-projects`

Create a new Video Project. Accepts **exactly one** of `topicId` (commit an AI candidate) or `title` ("add your own idea"). Providing both or neither returns 400.

### Request Body
```json
{ "topicId": "string" }
```
or
```json
{ "title": "string" }
```

### Server-Side Behavior
1. Validate exactly one of `topicId` / `title` is present — 400 otherwise
2. **`title` path:** create the topic (with embedding) via `createFromTitle`, then proceed with the new topic's id
3. Fetch topic from `Collection.TOPICS` — 404 if not found
4. Verify `topic.createdBy == req.userId` — 403 if not
5. Use `topic.title` as the project `title`
6. Create `videoProjects` document with Firestore auto-ID
7. Set all creation fields per schema in spec.md

### Response — `201`
```json
{
  "success": true,
  "data": {
    "id": "string",
    "title": "string",
    "topicId": "string",
    "currentStep": "research",
    "overallStatus": "in_progress",
    "pipeline": {
      "research": { "status": "completed", "startedAt": null, "completedAt": "<timestamp>" },
      "script":   { "status": "not_started", "startedAt": null, "completedAt": null },
      "hooks":    { "status": "not_started", "startedAt": null, "completedAt": null },
      "packaging": {
        "status": "not_started", "startedAt": null, "completedAt": null,
        "items": { "titles": "not_started", "description": "not_started",
                   "thumbnail": "not_started", "shorts": "not_started" }
      }
    },
    "createdAt": "<timestamp>",
    "updatedAt": "<timestamp>"
  }
}
```

### Error Cases
| Status | Condition |
|---|---|
| `400` | Neither or both of `topicId` / `title` provided |
| `403` | Topic belongs to a different user (`topicId` path) |
| `404` | Topic not found (`topicId` path) |
| `500` | Firestore write failed |

---

## GET `/v1/video-projects`

List all Video Projects for the authenticated user. Powers the dashboard.

### Query Parameters
| Param | Type | Default | Description |
|---|---|---|---|
| `status` | `string` | — | Filter by `overallStatus`: `in_progress`, `completed`, `stale` |
| `limit` | `number` | `20` | Max results. Maximum: 50. |
| `cursor` | `string` | — | Firestore document ID of last item from previous page |

### Response — `200`
```json
{
  "success": true,
  "data": {
    "projects": [
      {
        "id": "string",
        "title": "string",
        "currentStep": "script",
        "overallStatus": "in_progress",
        "updatedAt": "<timestamp>",
        "createdAt": "<timestamp>",
        "thumbnailHint": "string | null"
      }
    ],
    "hasMore": false,
    "nextCursor": "string | null"
  }
}
```

`thumbnailHint` is `null` until packaging is completed.
Full `pipeline` object is NOT returned here — use GET single project for that.

### Error Cases
| Status | Condition |
|---|---|
| `400` | Invalid `status` filter value |
| `500` | Firestore query failed |

---

## GET `/v1/video-projects/:projectId`

Get a single Video Project with full pipeline state.

### Response — `200`
```json
{
  "success": true,
  "data": {
    "id": "string",
    "title": "string",
    "topicId": "string",
    "scriptId": "string | null",
    "hooksId": "string | null",
    "selectedHookIndex": "number | null",
    "packagingId": "string | null",
    "currentStep": "script",
    "overallStatus": "in_progress",
    "pipeline": {
      "research": { "status": "completed", "startedAt": null, "completedAt": "<timestamp>" },
      "script":   { "status": "in_progress", "startedAt": "<timestamp>", "completedAt": null },
      "hooks":    { "status": "not_started", "startedAt": null, "completedAt": null },
      "packaging": {
        "status": "not_started", "startedAt": null, "completedAt": null,
        "items": { "titles": "not_started", "description": "not_started",
                   "thumbnail": "not_started", "shorts": "not_started" }
      }
    },
    "isDeleted": false,
    "createdAt": "<timestamp>",
    "updatedAt": "<timestamp>"
  }
}
```

### Error Cases
| Status | Condition |
|---|---|
| `403` | Project belongs to a different user |
| `404` | Not found or soft-deleted |
| `500` | Firestore read failed |

---

## PATCH `/v1/video-projects/:projectId`

Update mutable project fields. Currently only `title`.

### Request Body
```json
{ "title": "New title" }
```

At least one field required. Empty body returns 400. Empty string `title` returns 400.

### Response — `200`
```json
{
  "success": true,
  "data": { "id": "string", "title": "string", "updatedAt": "<timestamp>" }
}
```

---

## DELETE `/v1/video-projects/:projectId`

Soft delete. Sets `isDeleted: true`. Linked documents (topics, scripts, hooks, packaging) are NOT deleted.

Idempotent — if already deleted, returns 200.

### Response — `200`
```json
{
  "success": true,
  "message": "Project deleted successfully",
  "data": { "id": "string", "isDeleted": true, "deletedAt": "<timestamp>" }
}
```

---

## PATCH `/v1/video-projects/:projectId/step/:stepName/start`

Mark a step as `in_progress`. Called when creator first opens a step.

**Valid `stepName` values:** `script`, `hooks`, `packaging` (never `research` — always completed at creation)

Idempotent — if step is already `in_progress` or `completed`, returns 200 with no write.

### Response — `200`
```json
{
  "success": true,
  "data": {
    "id": "string",
    "currentStep": "script",
    "pipeline": {
      "script": { "status": "in_progress", "startedAt": "<timestamp>", "completedAt": null }
    },
    "updatedAt": "<timestamp>"
  }
}
```

### Error Cases
| Status | Condition |
|---|---|
| `400` | Invalid `stepName` or attempting to start `research` |
| `403` | Not owner |
| `404` | Not found or soft-deleted |

---

## PATCH `/v1/video-projects/:projectId/step/:stepName/complete`

Mark a step as `completed`. For the Script step the backend fires this automatically after the generated script is saved; Hooks/Packaging complete via their own mechanics. The endpoint stays available for explicit/manual completion. Stale cascade does NOT apply here — only regeneration triggers staleness.

If all four steps are `completed`, sets `overallStatus = "completed"`.

Idempotent — if step already `completed`, returns 200.

### Error Cases
| Status | Condition |
|---|---|
| `400` | Invalid `stepName` or step is `not_started` |
| `403` | Not owner |
| `404` | Not found or soft-deleted |

---

## PATCH `/v1/video-projects/:projectId/link/:resourceType`

Link a saved resource to the project. Called after a script, hooks batch, or packaging document is saved.

**Valid `resourceType` values:** `script`, `hooks`, `packaging`

### Request Body
```json
{ "resourceId": "string" }
```

### Server-Side Behavior
- `script` → sets `scriptId = resourceId`
- `hooks` → sets `hooksId = resourceId`
- `packaging` → sets `packagingId = resourceId`

### Response — `200`
```json
{
  "success": true,
  "data": {
    "id": "string",
    "scriptId": "string | null",
    "hooksId": "string | null",
    "packagingId": "string | null",
    "updatedAt": "<timestamp>"
  }
}
```

### Error Cases
| Status | Condition |
|---|---|
| `400` | Invalid `resourceType` or missing `resourceId` |
| `403` | Not owner |
| `404` | Not found or soft-deleted |

---

## Route File

```typescript
// src/routes/v1/video-project.route.ts
router.use(authMiddleware);
router.post('/', controller.create);
router.get('/', controller.list);
router.get('/:projectId', controller.getById);
router.patch('/:projectId', controller.update);
router.delete('/:projectId', controller.delete);
router.patch('/:projectId/step/:stepName/start', controller.startStep);
router.patch('/:projectId/step/:stepName/complete', controller.completeStep);
router.patch('/:projectId/link/:resourceType', controller.linkResource);
```

✅ Already registered in `src/routes/v1/index.ts` — `router.use("/video-projects", videoProjectRouter)`.

---

## Collection Enum Addition

✅ `VIDEO_PROJECTS = "videoProjects"` already added to `src/constants/collection.ts`.

---

## Related Documentation

- [Video Project Feature Spec](./spec.md)
- [Pipeline Spec](../../product/pipeline-spec.md)
- [Product Roadmap](../../product/roadmap.md)
