---
title: "Research — API Contract"
description: "Endpoint reference for the Research step — topic generation, listing, and editing"
status: "draft"
last_updated: 2026-02-27
tags: ["api", "research", "topics"]
---

# Research — API Contract

All endpoints are under `/v1/content`. All require `Authorization: Bearer <token>` unless noted.

---

## Endpoints Summary

| Method | URL | Purpose | Status |
|---|---|---|---|
| `GET` | `/v1/content/stream/topics` | Generate 10 topic ideas | ✅ Built |
| `GET` | `/v1/content/topics` | List saved topics (paginated) | ✅ Built |
| `PATCH` | `/v1/content/topics/edit/:topicId` | Edit a topic title | ✅ Built |
| `POST` | `/v1/content/topics/:topicId/regenerate` | Regenerate a single topic slot | ❌ Not built |
| `POST` | `/v1/video-projects` | Create a video project from a selected topic | ❌ Not built |

---

## GET `/v1/content/stream/topics`

Generates 10 new topic ideas for the authenticated user using their onboarding context and KMeans clustering to avoid repetition. Saves all topics to Firestore and returns them in a single JSON response.

> **Note on naming:** The route is named `/stream/topics` but it is not an SSE endpoint — it returns a standard JSON response after all generation is complete. The name is a legacy artifact.

### Auth
`Authorization: Bearer <token>` — required.

### Request
No body. No query params.

### Response — Success `200`

```json
{
  "success": true,
  "message": "successfully generated topics",
  "data": [
    {
      "id": "a1b2c3d4-...",
      "title": "How I Built a $10K/Month Business Using Only Free AI Tools",
      "createdBy": "uid_abc123",
      "createdAt": "2026-02-27T10:00:00.000Z",
      "isScriptGenerated": false,
      "embedding": [0.012, -0.045, ...]
    }
  ]
}
```

> `embedding` is a 768-dimension float array. Frontend typically should not display or store this — it is used server-side for KMeans clustering only.

### Response — Error `500`

```json
{
  "success": false,
  "message": "Unable to generate at the moment"
}
```

### Notes
- Generates exactly 10 titles per call: 5 long-form (60–65 chars) and 5 Shorts titles (under 50 chars).
- KMeans clustering runs before generation. All previously saved topics for this user (including archived) are clustered and passed to the prompt as "avoid these."
- All generated topics are batch-saved to Firestore before the response is returned.
- `isScriptGenerated` is set to `true` on a topic when a script has been generated for it.
- `embedding` field will be removed from the response in a future cleanup — it is internal data. Do not build frontend UI that depends on it.

---

## GET `/v1/content/topics`

Returns a paginated list of the authenticated user's saved topics. Supports cursor-based pagination and filtering.

### Auth
`Authorization: Bearer <token>` — required.

### Query Parameters

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | `number` | `9` | Number of topics to return per page |
| `createdAt` | `string` | `""` | Cursor: ISO timestamp of the last item from previous page |
| `docId` | `string` | `""` | Cursor: Firestore document ID of the last item from previous page |
| `searchText` | `string` | `""` | Prefix search on topic title |
| `isScriptGenerated` | `string` | `""` | Pass `"true"` to return only topics that have a script generated |

> Pagination and search are mutually exclusive. If `searchText` is present, cursor pagination is ignored.

### Response — Success `200`

```json
{
  "success": true,
  "message": "successfully retrieved topics",
  "data": {
    "meta": {
      "nextCursor": {
        "createdAt": "2026-02-26T09:00:00.000Z",
        "docId": "a1b2c3d4-..."
      },
      "hasNextPage": true
    },
    "lists": [
      {
        "id": "a1b2c3d4-...",
        "title": "How I Built a $10K/Month Business Using Only Free AI Tools",
        "createdBy": "uid_abc123",
        "createdAt": "2026-02-27T10:00:00.000Z",
        "isScriptGenerated": false
      }
    ]
  }
}
```

> `nextCursor` is `null` when there are no more pages.
> `hasNextPage` is `true` when `lists.length === limit`. Pass `nextCursor.createdAt` and `nextCursor.docId` as query params on the next request to fetch the next page.

### Response — Error `500`

```json
{
  "success": false,
  "message": "Failed to retrieve topics",
  "detail": "..."
}
```

### Notes
- Results are ordered by `createdAt` descending (newest first) unless `searchText` is active, in which case they are ordered alphabetically by title prefix.
- `isScriptGenerated` filter: only filters when the param value is truthy. Passing `"false"` is treated as not filtering (known quirk — rely on absence of the param to get all topics).
- `embedding` is not returned in this endpoint's response.

---

## PATCH `/v1/content/topics/edit/:topicId`

Updates fields on a topic document. Used when a creator manually edits a title.

### Auth
`Authorization: Bearer <token>` — required.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `topicId` | `string` | The UUID of the topic to update |

### Request Body

```json
{
  "title": "Updated title text"
}
```

Any Firestore-compatible field can be passed. The update uses `{ merge: true }` — only the provided fields are overwritten.

### Response — Success `200`

```json
{
  "success": true,
  "message": "Title updated successfully",
  "data": {
    "title": "Updated title text",
    "id": "a1b2c3d4-..."
  }
}
```

### Response — Error `500`

```json
{
  "success": false,
  "message": "Failed to update topic",
  "detail": "..."
}
```

### Notes
- No ownership check currently — any authenticated user can technically edit any topic if they know the `topicId`. This is a known security gap to fix in Phase 0.
- No validation on field names — any field key will be accepted and merged.

---

## POST `/v1/content/topics/:topicId/regenerate` ❌ Not Built

Regenerates a single topic slot (Regenerate One). Replaces the existing topic document at that ID with a freshly generated title, preserving the slot position in the batch.

> This endpoint does not exist yet. The contract below is the planned design for Phase 0.

### Auth
`Authorization: Bearer <token>` — required.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `topicId` | `string` | The UUID of the topic to regenerate |

### Request Body
None.

### Response — Success `200`

```json
{
  "success": true,
  "message": "Topic regenerated",
  "data": {
    "id": "a1b2c3d4-...",
    "title": "New title replacing the old one",
    "createdBy": "uid_abc123",
    "createdAt": "2026-02-27T10:05:00.000Z",
    "isScriptGenerated": false,
    "batchId": "batch_xyz"
  }
}
```

### Notes
- Must verify that `topicId` belongs to the authenticated user before regenerating.
- `batchId` stays the same as the topic being replaced — it is a slot-replace within the existing batch.
- If the regenerated topic was the currently selected topic on a video project, the selection should be cleared.
- Does not trigger a stale cascade on downstream steps (only Regenerate All does).

---

## POST `/v1/video-projects` ❌ Not Built

Creates a video project when a creator selects a topic. This is the action that completes the Research step and unlocks the Script step.

> This endpoint does not exist yet. The contract below is the planned design for Phase 0. It belongs in a `/v1/video-projects` router, not `/v1/content`.

### Auth
`Authorization: Bearer <token>` — required.

### Request Body

```json
{
  "topicId": "a1b2c3d4-..."
}
```

### Response — Success `201`

```json
{
  "success": true,
  "message": "Video project created",
  "data": {
    "id": "auto_generated_firestore_id",
    "userId": "uid_abc123",
    "title": "How I Built a $10K/Month Business Using Only Free AI Tools",
    "topicId": "a1b2c3d4-...",
    "scriptId": null,
    "selectedHookId": null,
    "pipeline": {
      "research": { "status": "completed", "stale": false },
      "script":   { "status": "not_started", "stale": false },
      "hooks":    { "status": "not_started", "stale": false },
      "packaging": {
        "title":       { "status": "not_started", "stale": false },
        "description": { "status": "not_started", "stale": false },
        "thumbnail":   { "status": "not_started", "stale": false },
        "shorts":      { "status": "not_started", "stale": false }
      }
    },
    "createdAt": "2026-02-27T10:00:00.000Z"
  }
}
```

### Response — Error `400`

```json
{
  "success": false,
  "message": "topicId is required"
}
```

### Response — Error `404`

```json
{
  "success": false,
  "message": "Topic not found"
}
```

### Notes
- Must verify that `topicId` belongs to the authenticated user.
- Sets `topics.videoProjectId = videoProjectId` on the topic document.
- Sets Research step `status = "completed"` on the new video project.
- If the creator already has a video project with this `topicId`, return the existing project (idempotent).

---

## Related Documentation

- [Research Feature Spec](./spec.md) — User flow, states, edge cases
- [Pipeline Status Model](../../product/pipeline-spec.md) — Full status schemas and Firestore schema
