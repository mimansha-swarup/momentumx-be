---
title: "Packaging API Reference"
description: "Endpoint reference for packaging generation, save, list, and retrieval."
date: 2026-02-27
last_updated: 2026-02-27
status: "draft"
tags: ["api", "packaging"]
---

# Packaging API Reference

All endpoints require `Authorization: Bearer <token>`.

Base path: `/v1/packaging`

---

## Endpoints Summary

| Method | URL | Purpose | Status |
|---|---|---|---|
| `POST` | `/v1/packaging/generate-title` | Generate 3 title variations | ✅ Built |
| `POST` | `/v1/packaging/generate-description` | Generate SEO description | ✅ Built |
| `POST` | `/v1/packaging/generate-thumbnail` | Generate 3 thumbnail briefs | ✅ Built |
| `POST` | `/v1/packaging/generate-hooks` | Generate 5 hooks (stateless, legacy) | ✅ Built |
| `POST` | `/v1/packaging/generate-shorts` | Generate Shorts script | ✅ Built |
| `POST` | `/v1/packaging/save` | Save packaging to Firestore | ✅ Built |
| `GET` | `/v1/packaging/list` | List user's packaging | ✅ Built |
| `GET` | `/v1/packaging/:packagingId` | Get single packaging | ✅ Built |
| `POST` | `/v1/packaging/:packagingId/regenerate/:item` | Regenerate a specific packaging item | ✅ Built |
| `PATCH` | `/v1/packaging/:packagingId/feedback` | Record per-item like/dislike | ✅ Built |
| `GET` | `/v1/packaging/:packagingId/export` | Export packaging as plain text | ✅ Built |

---

## POST `/v1/packaging/generate-title`

Generate 3 alternative title variations. Titles are 50–70 characters, search-optimized, using different emotional angles.

### Request Body
| Field | Type | Required | Description |
|---|---|---|---|
| `script` | `string` | Yes | Full script text |
| `selectedHook` | `string` | No | If provided, AI uses this hook as context when generating titles |

### Response — `200`
```json
{
  "success": true,
  "data": {
    "titles": [
      { "title": "Why Your Morning Routine Is KILLING Your Productivity", "characterCount": 62 },
      { "title": "I Tried 10 Morning Hacks for 30 Days — Here's What Actually Works", "characterCount": 62 },
      { "title": "10 Productivity Hacks That Will Transform Your Morning Routine", "characterCount": 62 }
    ]
  }
}
```

### Error Cases
- `500` — Gemini generation failed or JSON parse error

---

## POST `/v1/packaging/generate-description`

Generate an SEO-optimized YouTube description. Hook before "Show More", keywords woven naturally, timestamp placeholders, CTA. Target: 200–400 words.

### Request Body
| Field | Type | Required | Description |
|---|---|---|---|
| `script` | `string` | Yes | Full script text |
| `title` | `string` | Yes | Video title |
| `selectedHook` | `string` | No | If provided, AI uses this hook as context |

### Response — `200`
```json
{
  "success": true,
  "data": {
    "description": "full description text here"
  }
}
```

### Error Cases
- `500` — Gemini generation failed or JSON parse error

---

## POST `/v1/packaging/generate-thumbnail`

Generate 3 thumbnail design concepts. Each is a design brief (not a rendered image) with text overlay, visual layout description, and psychological hook.

### Request Body
| Field | Type | Required | Description |
|---|---|---|---|
| `script` | `string` | Yes | Full script text |
| `title` | `string` | Yes | Video title |
| `selectedHook` | `string` | No | If provided, AI uses this hook as context |

### Response — `200`
```json
{
  "success": true,
  "data": {
    "descriptions": [
      "Split composition with bold red 'PRODUCTIVITY HACKS' text on left, person looking shocked on right, bright yellow background",
      "Minimalist design with large '10X' text in center, dark blue gradient with white text overlay",
      "Before/after split screen showing messy vs organized workspace, 'TRANSFORM' text in bold orange"
    ]
  }
}
```

### Error Cases
- `500` — Gemini generation failed or JSON parse error

---

## POST `/v1/packaging/generate-hooks`

Generate 5 hook variations. **Deprecated** — use `POST /v1/hooks/generate` instead. This endpoint is stateless and does not save to Firestore or link to a video project.

### Request Body
| Field | Type | Required |
|---|---|---|
| `script` | `string` | Yes |

### Response — `200`
```json
{
  "success": true,
  "data": {
    "hooks": ["hook1", "hook2", "hook3", "hook4", "hook5"]
  }
}
```

### Error Cases
- `500` — Gemini generation failed or JSON parse error

---

## POST `/v1/packaging/generate-shorts`

Generate a YouTube Shorts script. Structured as hook / body / CTA, written to fit the specified duration.

### Request Body
| Field | Type | Required | Description |
|---|---|---|---|
| `script` | `string` | Yes | Full script text |
| `duration` | `number` | Yes | Target duration in seconds (e.g. `60`) |

### Response — `200`
```json
{
  "success": true,
  "data": {
    "segments": [
      { "startTime": "0:00", "endTime": "0:05", "content": "Hook text here.", "type": "hook" },
      { "startTime": "0:05", "endTime": "0:40", "content": "Main point content.", "type": "point" },
      { "startTime": "0:40", "endTime": "0:55", "content": "Transition content.", "type": "transition" },
      { "startTime": "0:55", "endTime": "1:00", "content": "Follow for more.", "type": "cta" }
    ],
    "totalDuration": "1:00"
  }
}
```

### Error Cases
- `500` — Gemini generation failed or JSON parse error

---

## POST `/v1/packaging/save`

Save a packaging document to Firestore. Document ID is Firestore auto-generated. Client controls which fields are included. `createdBy` and `createdAt` are set server-side.

If `videoProjectId` is provided, the server verifies ownership of the video project before saving, then calls `linkResource` (fire-and-forget) to record the `packagingId` on the project.

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `videoProjectId` | `string` | No | If provided, links this packaging to the video project |
| *(any packaging fields)* | `unknown` | No | All other fields are passed through and persisted as-is |

### Response — `200`
```json
{
  "success": true,
  "message": "Packaging saved successfully",
  "data": {
    "id": "firestore-auto-id"
  }
}
```

### Error Cases

| Status | Condition |
|---|---|
| 403 | `videoProjectId` provided but not owned by requesting user |
| 404 | `videoProjectId` provided but project not found |
| 500 | Firestore write failed |

---

## GET `/v1/packaging/list`

List all packaging documents for the authenticated user, ordered by `createdAt` descending.

### Response — `200`
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "createdBy": "string",
      "createdAt": "<timestamp>"
    }
  ]
}
```

Additional fields per document depend on what was passed to `/save`. No fixed schema enforced on read.

### Error Cases
- `500` — Firestore read failed

---

## GET `/v1/packaging/:packagingId`

Get a single packaging document. Ownership is enforced — `createdBy` must match the requesting user.

### Path Parameters
| Param | Type | Description |
|---|---|---|
| `packagingId` | `string` | Firestore auto-generated document ID |

### Response — `200`
```json
{
  "success": true,
  "data": {
    "id": "string",
    "createdBy": "string",
    "createdAt": "<timestamp>"
  }
}
```

### Error Cases

| Status | Condition |
|---|---|
| 403 | Document not owned by requesting user |
| 404 | Document not found |
| 500 | Firestore read failed |

---

---

## POST `/v1/packaging/:packagingId/regenerate/:item`

Regenerates a single packaging item and overwrites it on the existing document. Ownership enforced.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `packagingId` | `string` | Packaging document ID |
| `item` | `string` | One of: `title`, `description`, `thumbnail`, `shorts` |

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `script` | `string` | Yes | Full script text |
| `title` | `string` | No | Required when `item` is `description` or `thumbnail` |
| `duration` | `number` | No | Required when `item` is `shorts` |
| `selectedHook` | `string` | No | Passed as context for `title`, `description`, `thumbnail` |

### Response — `200`

```json
{
  "success": true,
  "message": "Packaging item regenerated successfully",
  "data": {
    "id": "string",
    "item": "title",
    "data": {}
  }
}
```

### Error Cases

| Status | Condition |
|---|---|
| 400 | `script` missing, `item` not in allowed list, or required conditional field missing |
| 403 | Not owned by requesting user |
| 404 | Packaging document not found |

---

## PATCH `/v1/packaging/:packagingId/feedback`

Records a like or dislike signal on a specific packaging item. Overwrites any prior feedback for that item.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `packagingId` | `string` | Packaging document ID |

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `item` | `string` | Yes | One of: `title`, `description`, `thumbnail`, `shorts` |
| `feedback` | `"like" \| "dislike" \| null` | Yes | `null` clears existing feedback |

### Response — `200`

```json
{
  "success": true,
  "message": "Feedback updated successfully",
  "data": {
    "id": "string",
    "item": "title",
    "feedback": "like"
  }
}
```

### Error Cases

| Status | Condition |
|---|---|
| 400 | `item` or `feedback` missing, or invalid values |
| 403 | Not owned by requesting user |
| 404 | Packaging document not found |

---

## GET `/v1/packaging/:packagingId/export`

Returns the packaging document formatted as a human-readable plain-text string.

### Auth
`Authorization: Bearer <token>` — required. Ownership enforced.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `packagingId` | `string` | Packaging document ID |

### Response — `200`

```json
{
  "success": true,
  "message": "Packaging exported successfully",
  "data": {
    "text": "Video Package — March 8, 2026\n══...\n\nTITLES\n..."
  }
}
```

The `text` field is a multi-section plain-text document containing titles, description, thumbnail brief, and shorts script.

### Error Cases

| Status | Condition |
|---|---|
| 403 | Not owned by requesting user |
| 404 | Packaging document not found |

---

## Related Documentation

- [Packaging Feature Spec](./spec.md)
- [Hooks Feature Spec](../hooks/spec.md)
- [Pipeline Spec](../../product/pipeline-spec.md)
- [Product Roadmap](../../product/roadmap.md)
