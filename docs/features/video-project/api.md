---
title: "Video Project — API Contracts"
description: "All endpoints for creating, reading, updating, and managing Video Project pipeline state"
date: 2026-02-27
last_updated: 2026-02-27
status: "draft"
tags: ["api", "video-project", "phase-0"]
---

# Video Project — API Contracts

Base path: `/v1/video-projects`

All endpoints require `Authorization: Bearer <token>`. `authMiddleware` applied at router level. `userId` always from `req.userId` — never from request body.

---

## Endpoints Summary

| Method | URL | Purpose |
|---|---|---|
| `POST` | `/v1/video-projects` | Create project from selected topic |
| `GET` | `/v1/video-projects` | List user's projects (dashboard) |
| `GET` | `/v1/video-projects/:projectId` | Get single project with full pipeline state |
| `PATCH` | `/v1/video-projects/:projectId` | Update working title |
| `DELETE` | `/v1/video-projects/:projectId` | Soft delete |
| `PATCH` | `/v1/video-projects/:projectId/step/:stepName/start` | Mark step in_progress |
| `PATCH` | `/v1/video-projects/:projectId/step/:stepName/complete` | Mark step completed |
| `PATCH` | `/v1/video-projects/:projectId/step/:stepName/stale` | Apply stale cascade |
| `PATCH` | `/v1/video-projects/:projectId/link/:resourceType` | Link saved resource ID |

---

## POST `/v1/video-projects`

Create a new Video Project from a selected topic. Called when the creator picks a topic in Research.

### Request Body
```json
{ "topicId": "string" }
```

### Server-Side Behavior
1. Validate `topicId` present
2. Fetch topic from `Collection.TOPICS` — 404 if not found
3. Verify `topic.createdBy == req.userId` — 403 if not
4. Fetch `topic.title` for `workingTitle`
5. Create `videoProjects` document with Firestore auto-ID
6. Set all creation fields per schema in spec.md

### Response — `201`
```json
{
  "success": true,
  "data": {
    "projectId": "string",
    "workingTitle": "string",
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
    "lastUpdatedAt": "<timestamp>"
  }
}
```

### Error Cases
| Status | Condition |
|---|---|
| `400` | `topicId` missing |
| `403` | Topic belongs to a different user |
| `404` | Topic not found |
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
        "projectId": "string",
        "workingTitle": "string",
        "currentStep": "script",
        "overallStatus": "in_progress",
        "lastUpdatedAt": "<timestamp>",
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
    "projectId": "string",
    "workingTitle": "string",
    "topicId": "string",
    "scriptId": "string | null",
    "hooksId": "string | null",
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
    "lastUpdatedAt": "<timestamp>"
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

Update mutable project fields. Currently only `workingTitle`.

### Request Body
```json
{ "workingTitle": "New title" }
```

At least one field required. Empty body returns 400. Empty string `workingTitle` returns 400.

### Response — `200`
```json
{
  "success": true,
  "data": { "projectId": "string", "workingTitle": "string", "lastUpdatedAt": "<timestamp>" }
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
  "data": { "projectId": "string", "isDeleted": true, "deletedAt": "<timestamp>" }
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
    "projectId": "string",
    "currentStep": "script",
    "pipeline": {
      "script": { "status": "in_progress", "startedAt": "<timestamp>", "completedAt": null }
    },
    "lastUpdatedAt": "<timestamp>"
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

Mark a step as `completed`. Requires explicit creator action. Stale cascade does NOT apply here — only regeneration triggers staleness.

If all four steps are `completed`, sets `overallStatus = "completed"`.

Idempotent — if step already `completed`, returns 200.

### Error Cases
| Status | Condition |
|---|---|
| `400` | Invalid `stepName` or step is `not_started` |
| `403` | Not owner |
| `404` | Not found or soft-deleted |

---

## PATCH `/v1/video-projects/:projectId/step/:stepName/stale`

Apply stale cascade when content is regenerated. Called by other services (e.g., content service when script is regenerated), not directly by the user.

Cascade rules per spec.md:
- `script` → sets `hooks` and `packaging` to `stale`
- `hooks` → sets `packaging` to `stale`
- `research` → sets `script`, `hooks`, `packaging` to `stale`

Only updates steps that are NOT `not_started`.

### Response — `200`
```json
{
  "success": true,
  "data": {
    "projectId": "string",
    "overallStatus": "in_progress",
    "pipeline": {
      "hooks":    { "status": "stale", "startedAt": "<timestamp>", "completedAt": null },
      "packaging": { "status": "stale", "startedAt": "<timestamp>", "completedAt": null }
    },
    "lastUpdatedAt": "<timestamp>"
  }
}
```

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
    "projectId": "string",
    "scriptId": "string | null",
    "hooksId": "string | null",
    "packagingId": "string | null",
    "lastUpdatedAt": "<timestamp>"
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
router.patch('/:projectId/step/:stepName/stale', controller.markStale);
router.patch('/:projectId/link/:resourceType', controller.linkResource);
```

Register in `src/routes/index.ts`:
```typescript
import videoProjectRouter from './v1/video-project.route';
app.use('/v1/video-projects', videoProjectRouter);
```

---

## Collection Enum Addition Required

```typescript
// src/constants/collection.ts
export enum Collection {
  USERS = 'users',
  TOPICS = 'topics',
  SCRIPTS = 'scripts',
  PACKAGING = 'packaging',
  VIDEO_PROJECTS = 'videoProjects',  // ADD THIS
}
```

---

## Related Documentation

- [Video Project Feature Spec](./spec.md)
- [Pipeline Spec](../../product/pipeline-spec.md)
- [Product Roadmap](../../product/roadmap.md)
