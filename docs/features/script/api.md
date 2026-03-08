---
title: "Script — API Reference"
description: "All endpoints for script generation, retrieval, and editing."
date: 2026-02-27
last_updated: 2026-03-08
status: "implemented"
tags: ["api", "script"]
---

# Script API Reference

Base path: `/v1/content`

All endpoints require `Authorization: Bearer <token>` except `GET /stream/scripts/:scriptId` which uses `?token=` query param.

---

## Endpoints Summary

| Method | URL | Purpose | Status |
|---|---|---|---|
| `GET` | `/v1/content/stream/scripts/:scriptId` | Stream script generation via SSE | ✅ Built |
| `GET` | `/v1/content/scripts` | List all user scripts | ✅ Built |
| `GET` | `/v1/content/script/:scriptId` | Get single script | ✅ Built |
| `PATCH` | `/v1/content/script/edit/:scriptId` | Edit script text | ✅ Built |
| `POST` | `/v1/content/scripts/:scriptId/regenerate` | Regenerate script (non-SSE) | ✅ Built |
| `PATCH` | `/v1/content/scripts/:scriptId/feedback` | Record like/dislike on script | ✅ Built |
| `GET` | `/v1/content/scripts/:scriptId/export` | Export script as plain text | ✅ Built |

---

## GET `/v1/content/stream/scripts/:scriptId`

Streams a full YouTube video script for the given topic via SSE.

**Auth:** `?token=<firebase_jwt>` query param. Bearer headers not supported — browser `EventSource` API cannot send custom headers. Token verified manually in controller via Firebase Admin SDK.

**Note on `:scriptId`:** This is actually a **topicId**. The script document is saved to Firestore with this same ID. The naming reflects the client-side route.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `scriptId` | `string` | The topicId to generate a script for |

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
event: done\n
data: [done]\n\n
```

### Side Effects on Completion
- Script document saved to `scripts` collection with ID = `topicId`
- Topic document updated: `isScriptGenerated: true`

### Error Cases

| Status | Condition |
|---|---|
| 400 (via `sendError`) | `token` param missing |
| 403 (via `sendError`) | Token invalid or expired |
| 500 | Gemini generation failed or Firestore write failed |

### Notes
- If stream has already started (`res.headersSent`) when an error occurs, the error cannot be sent as a JSON response. The stream will end abruptly.
- No ownership check on the topic — any valid token holder who knows a `topicId` can generate a script for it.

---

## GET `/v1/content/scripts`

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
      "script": "string"
    }
  ]
}
```

### Error Cases

| Status | Condition |
|---|---|
| 500 | Firestore read failed |

---

## GET `/v1/content/script/:scriptId`

Returns a single script document by ID.

### Auth
`Authorization: Bearer <token>` — required.

Ownership enforced — `createdBy` must match the requesting user.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `scriptId` | `string` | Script document ID (equals the source `topicId`) |

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
    "script": "string"
  }
}
```

### Error Cases

| Status | Condition |
|---|---|
| 404 | Script not found |
| 500 | Firestore read failed |

---

## PATCH `/v1/content/script/edit/:scriptId`

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

Stored in the `scripts` Firestore collection. Document ID = source `topicId`.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Document ID, same as source `topicId` |
| `title` | `string` | Title of the topic this script was generated for |
| `createdBy` | `string` | `userId` of the owner |
| `createdAt` | `Timestamp` | Server-side Firestore timestamp |
| `script` | `string` | Full script text |

---

## POST `/v1/content/scripts/:scriptId/regenerate`

Regenerates the script for a topic without SSE. Returns the full script in the response body once generation is complete.

### Auth
`Authorization: Bearer <token>` — required. Ownership enforced — `createdBy` must match the requesting user.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `scriptId` | `string` | Script document ID (equals the source `topicId`) |

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

## PATCH `/v1/content/scripts/:scriptId/feedback`

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

## GET `/v1/content/scripts/:scriptId/export`

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
