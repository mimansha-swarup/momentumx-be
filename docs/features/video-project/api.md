---
title: "Video Project — API Contracts"
description: "All endpoints for creating, reading, updating, and managing Video Project pipeline state"
date: 2026-02-27
last_updated: 2026-07-12
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
| `POST` | `/v1/video-projects` | Create project from an idea id or a new title |
| `GET` | `/v1/video-projects` | List user's projects (dashboard) |
| `GET` | `/v1/video-projects/:projectId` | Get single project with full pipeline state |
| `PATCH` | `/v1/video-projects/:projectId` | Update working title |
| `DELETE` | `/v1/video-projects/:projectId` | Soft delete |
| `PATCH` | `/v1/video-projects/:projectId/step/:stepName/start` | Mark step in_progress |
| `PATCH` | `/v1/video-projects/:projectId/step/:stepName/complete` | Mark step completed |
| `PATCH` | `/v1/video-projects/:projectId/link/:resourceType` | Link saved resource ID |

---

## POST `/v1/video-projects`

Create a new Video Project. Accepts **exactly one** of `ideaId` (commit an AI candidate) or `title` ("add your own idea"). Providing both or neither returns 400.

### Request Body
```json
{ "ideaId": "string" }
```
or
```json
{ "title": "string" }
```

### Server-Side Behavior
1. Validate exactly one of `ideaId` / `title` is present — 400 otherwise
2. **`title` path:** create the idea (with embedding) via `createFromTitle`, then proceed with the new idea's id
3. Fetch idea from `COLLECTIONS.IDEAS` — 404 if not found
4. Verify `idea.createdBy == req.userId` — 403 if not
5. Use `idea.title` as the project `title`
6. Create `videoProjects` document with Firestore auto-ID
7. Set all creation fields per schema in spec.md

### Response — `201`
```json
{
  "success": true,
  "data": {
    "id": "string",
    "title": "string",
    "ideaId": "string",
    "currentStep": "research",
    "overallStatus": "in_progress",
    "pipeline": {
      "research": { "status": "completed", "startedAt": null, "completedAt": "<timestamp>" },
      "script":   { "status": "not_started", "startedAt": null, "completedAt": null },
      "hooks":    { "status": "not_started", "startedAt": null, "completedAt": null },
      "packaging": { "status": "not_started", "startedAt": null, "completedAt": null }
    },
    "createdAt": "<timestamp>",
    "updatedAt": "<timestamp>"
  }
}
```

### Error Cases
| Status | Condition |
|---|---|
| `400` | Neither or both of `ideaId` / `title` provided |
| `403` | Idea belongs to a different user (`ideaId` path) |
| `404` | Idea not found (`ideaId` path) |
| `500` | Firestore write failed |

---

## GET `/v1/video-projects`

List all Video Projects for the authenticated user. Powers the dashboard.

### Query Parameters
| Param | Type | Default | Description |
|---|---|---|---|
| `status` | `string` | — | Filter by `overallStatus`: `in_progress`, `completed`, `stale` |
| `limit` | `number` | `20` | Max results. Maximum: 50 — clamped server-side (`utlils/pagination.ts`), not rejected: an out-of-range or unparseable value silently falls back rather than failing the page. |
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

`thumbnailHint` mirrors the brief the creator **selected** —
`packaging.thumbnail[selectedThumbnailIndex]`, falling back to the first. It is written when
packaging is linked to the project (on the first generated item, when `thumbnail` is still empty
→ `null`; and on `POST /packaging/save`) and refreshed on thumbnail regeneration. So it stays
`null` until a save or a thumbnail regenerate happens after briefs exist — generating thumbnails
alone does not set it.
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
    "ideaId": "string",
    "scriptId": "string | null",
    "hooksId": "string | null",
    "selectedHookIndex": "number | null",
    "packagingId": "string | null",
    "currentStep": "script",
    "overallStatus": "in_progress",
    "recommendedNextStep": "hooks",
    "pipeline": {
      "research": { "status": "completed", "startedAt": null, "completedAt": "<timestamp>" },
      "script":   { "status": "in_progress", "startedAt": "<timestamp>", "completedAt": null },
      "hooks":    { "status": "not_started", "startedAt": null, "completedAt": null },
      "packaging": { "status": "not_started", "startedAt": null, "completedAt": null }
    },
    "isDeleted": false,
    "createdAt": "<timestamp>",
    "updatedAt": "<timestamp>"
  }
}
```

`recommendedNextStep` (6A.4) is the guided-CTA target: the first non-completed pipeline step (`research` | `script` | `hooks` | `packaging`), or `null` when all are complete. **Read-time computed, never persisted** — a stale step surfaces here as the next action. Only on this single-project read (not the list endpoint).

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

Soft delete. Sets `isDeleted: true`. Linked documents (ideas, scripts, hooks, packaging) are NOT deleted.

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

## ~~PATCH `/v1/video-projects/:projectId/step/:stepName/start`~~ — REMOVED

**This route no longer exists and must not be re-added.** It is a 404, pinned by
`tests/integration/video-project.route.test.ts`.

A client-callable "start" is a lock the client can decline to take. Marking a step
`in_progress` now happens **server-side**, inside the generation endpoints, via the
transactional `acquireStep` — which takes the lock, checks ownership and enforces the
step's preconditions in the same transaction that writes. The old read-then-write pair
let two requests both read "free" and both proceed; that is a duplicate Gemini call
today and a double charge once credits land.

See `.claude/rules/api-design.md` (the "no /start route" note) and
`docs/multi-account/phase-01b-generation-seam.md`.

---

## PATCH `/v1/video-projects/:projectId/step/:stepName/complete`

Mark a step as `completed`. For the Script step the backend fires this automatically after the generated script is saved; Hooks/Title/Packaging complete via their own mechanics. The endpoint stays available for explicit/manual completion — notably the "Keep as-is" action on a stale step. Stale cascade does NOT apply here — only regeneration triggers staleness.

If all five steps are `completed`, sets `overallStatus = "completed"`.

**Response includes the updated `pipeline` and `overallStatus`**, not just `{id, currentStep}`.
The client patches its cached project from this body, so a partial response left it reading
`pipeline` on `undefined` — which threw in the reducer and silently aborted the whole update.

`overallStatus` is recomputed on every completion (not only when all steps are done), so
completing the last stale step actually clears the dashboard's "Needs Update" badge. The
completed step's `staleReason` is cleared at the same time.

**Completing a stale `packaging` step also clears the packaging document's stale markers**
(`isStale`, `staleReason`, `staleSince`, and any per-item `"stale"` → `"completed"`). Without it
the per-card "Outdated" indicators would outlive the banner the creator just dismissed.
Best-effort — logged as `packaging_stale_clear_failed`, never fails the request.

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
