---
title: "Script — API Reference"
description: "All endpoints for script generation, retrieval, and editing."
date: 2026-02-27
last_updated: 2026-02-27
status: "draft"
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

Each chunk during generation:
```
data: <text chunk>\n\n
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

**Security gap:** No ownership check. Any authenticated user who knows a `scriptId` can retrieve it.

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

**Security gap:** No ownership check. Any authenticated user who knows a `scriptId` can overwrite its content.

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
| `createdAt` | `Date` | Creation time (`new Date()` — not server timestamp, known gap) |
| `script` | `string` | Full script text |

---

## Not Yet Built

| Endpoint | Status |
|---|---|
| Regenerate script | ❌ |
| Script step state tracking | ❌ |
| Ownership check on GET single script | ❌ |
| Ownership check on PATCH edit | ❌ |
| `videoProjectId` field on script documents | ❌ |

---

## Related Documentation

- [Script Feature Spec](./spec.md)
- [Research API Reference](../research/api.md)
- [Pipeline Spec](../../product/pipeline-spec.md)
