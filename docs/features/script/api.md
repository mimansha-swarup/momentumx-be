---
title: "Script — API Reference"
description: "All endpoints for script generation, retrieval, and editing."
date: 2026-02-27
last_updated: 2026-03-11
status: "implemented"
tags: ["api", "script"]
---

# Script API Reference

Base path: `/v1/scripts`

All endpoints require `Authorization: Bearer <token>` except `GET /scripts/stream/:projectId` which uses `?token=` query param.

---

## Endpoints Summary

| Method | URL | Purpose | Status |
|---|---|---|---|
| `GET` | `/v1/scripts/stream/:projectId` | Stream script generation via SSE (project-scoped) | ✅ Built |
| `GET` | `/v1/scripts` | List all user scripts | ✅ Built |
| `GET` | `/v1/scripts/:scriptId` | Get single script | ✅ Built |
| `PATCH` | `/v1/scripts/edit/:scriptId` | Edit script text | ✅ Built |
| `POST` | `/v1/scripts/:scriptId/regenerate` | Regenerate script (non-SSE) | ✅ Built |
| `PATCH` | `/v1/scripts/:scriptId/feedback` | Record like/dislike on script | ✅ Built |
| `GET` | `/v1/scripts/:scriptId/export` | Export script as plain text | ✅ Built |

---

## GET `/v1/scripts/stream/:projectId`

Streams a full YouTube video script for the given video project via SSE. The script is generated for the topic referenced by `project.topicId`.

**Auth:** `?token=<firebase_jwt>` query param, verified by `sseAuthMiddleware`. Bearer headers not supported — browser `EventSource` API cannot send custom headers.

**Note on `:projectId`:** This is the **video project ID**. The script document is saved under its own `randomUUID` id (reused across regenerations via `project.scriptId`), not the topic's id, and stores `topicId` + `videoProjectId` FKs.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `projectId` | `string` | The video project to generate a script for (topic derived from `project.topicId`) |

### Query Parameters

| Param | Type | Required | Description |
|---|---|---|---|
| `token` | `string` | Yes | Firebase JWT. Must be valid and non-expired. |

### Response — SSE stream `200`

Headers set before streaming:
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

Each chunk during generation (chunk text is JSON-stringified):
```
data: "chunk text here"\n\n
```

Stream end signal:
```
data: [DONE]\n\n
```

### Side Effects on Completion
- Script document saved to `scripts` collection under its own `randomUUID` id (reused via `project.scriptId` on regenerate), with `topicId` + `videoProjectId` FKs
- Topic document updated: `isScriptGenerated: true`
- Script linked to the project (`linkResource`) and the Script step completed (`completeStep`)

### Error Cases

These fire **before** the stream starts (headers not yet flushed), so they return a JSON error via `sendError`:

| Status | Condition |
|---|---|
| 401 | `token` query param missing |
| 403 | Token invalid/expired, or project not owned by requesting user |
| 404 | Video project not found, or its `topicId` topic not found |
| 500 | Gemini generation failed or Firestore write failed (before stream start) |

### Notes
- The project is loaded and ownership-checked before `flushHeaders()`, so 401/403/404 are returned as clean JSON responses.
- If the stream has already started (`res.headersSent`) when an error occurs, the error cannot be sent as a JSON response — the stream ends abruptly.

---

## GET `/v1/scripts`

Returns all scripts owned by the authenticated user, ordered by `createdAt` descending.

### Auth
`Authorization: Bearer <token>` — required.

### Response — `200`

```json
{
  "success": true,
  "message": "successfully retrieved scripts",
  "data": [
    {
      "id": "string",
      "title": "string",
      "createdBy": "string",
      "createdAt": "ISO timestamp",
      "script": "string",
      "topicId": "string",
      "videoProjectId": "string"
    }
  ]
}
```

### Error Cases

| Status | Condition |
|---|---|
| 500 | Firestore read failed |

---

## GET `/v1/scripts/:scriptId`

Returns a single script document by ID.

### Auth
`Authorization: Bearer <token>` — required.

Ownership enforced — `createdBy` must match the requesting user.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `scriptId` | `string` | Script document ID (its own `randomUUID`, not the topicId) |

### Response — `200`

```json
{
  "success": true,
  "message": "successfully retrieved script",
  "data": {
    "id": "string",
    "title": "string",
    "createdBy": "string",
    "createdAt": "ISO timestamp",
    "script": "string",
    "topicId": "string",
    "videoProjectId": "string"
  }
}
```

### Error Cases

| Status | Condition |
|---|---|
| 404 | Script not found |
| 500 | Firestore read failed |

---

## PATCH `/v1/scripts/edit/:scriptId`

Merges provided fields onto the script document. Manual edit only — not AI-assisted.

### Auth
`Authorization: Bearer <token>` — required.

Ownership enforced — `createdBy` must match the requesting user.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `scriptId` | `string` | Script document ID to update |

### Request Body

Any subset of script fields to update. The update uses `{ merge: true }` — only provided fields are overwritten.

```json
{
  "script": "Updated full script text"
}
```

### Response — `200`

```json
{
  "success": true,
  "message": "Title updated successfully",
  "data": {
    "script": "Updated full script text",
    "scriptId": "string"
  }
}
```

### Error Cases

| Status | Condition |
|---|---|
| 500 | Firestore write failed |

---

## Script Document Schema

Stored in the `scripts` Firestore collection. Document ID is the script's own `randomUUID`; `topicId` and `videoProjectId` link back to the source topic and owning project.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Document ID — own `randomUUID`, NOT the topicId |
| `title` | `string` | Title of the topic this script was generated for |
| `createdBy` | `string` | `userId` of the owner |
| `createdAt` | `Timestamp` | Server-side Firestore timestamp |
| `script` | `string` | Full script text |
| `topicId` | `string` | FK → source topic |
| `videoProjectId` | `string` | FK → owning video project |

---

## POST `/v1/scripts/:scriptId/regenerate`

Regenerates the script for a topic without SSE. Returns the full script in the response body once generation is complete.

### Auth
`Authorization: Bearer <token>` — required. Ownership enforced — `createdBy` must match the requesting user.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `scriptId` | `string` | Script document ID (its own `randomUUID`, not the topicId) |

### Response — `200`

```json
{
  "success": true,
  "message": "Script regenerated successfully",
  "data": {
    "id": "string",
    "title": "string",
    "script": "string"
  }
}
```

### Side Effects on Completion
- `scripts` document updated with new `script` text
- If the script is linked to a video project, `pipeline.hooks` and `pipeline.packaging` are marked stale (fire-and-forget)

### Error Cases

| Status | Condition |
|---|---|
| 403 | Script not owned by requesting user |
| 404 | Script not found |
| 500 | Gemini generation failed or Firestore write failed |

---

## PATCH `/v1/scripts/:scriptId/feedback`

Records a like or dislike signal on a script. Overwrites any prior feedback value.

### Auth
`Authorization: Bearer <token>` — required. Ownership enforced.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `scriptId` | `string` | Script document ID |

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `feedback` | `"like" \| "dislike" \| null` | Yes | `null` clears existing feedback |

### Response — `200`

```json
{
  "success": true,
  "message": "Feedback updated",
  "data": {
    "id": "string",
    "userFeedback": "like"
  }
}
```

### Error Cases

| Status | Condition |
|---|---|
| 400 | `feedback` is not `"like"`, `"dislike"`, or `null` |
| 403 | Script not owned by requesting user |
| 404 | Script not found |

---

## GET `/v1/scripts/:scriptId/export`

Returns the script as a plain-text formatted string suitable for copy-paste or download.

### Auth
`Authorization: Bearer <token>` — required. Ownership enforced.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `scriptId` | `string` | Script document ID |

### Response — `200`

```json
{
  "success": true,
  "data": {
    "title": "string",
    "text": "full script text"
  }
}
```

### Error Cases

| Status | Condition |
|---|---|
| 403 | Script not owned by requesting user |
| 404 | Script not found |

---

## Related Documentation

- [Script Feature Spec](./spec.md)
- [Research API Reference](../research/api.md)
- [Pipeline Spec](../../product/pipeline-spec.md)
