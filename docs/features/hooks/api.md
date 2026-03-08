---
title: "Hooks API Reference"
description: "Endpoint reference for the Hooks step — hook generation and selection"
date: 2026-02-27
last_updated: 2026-03-08
status: "implemented"
tags: ["api", "hooks"]
---

# Hooks API Reference

Hooks is a standalone pipeline step. The dedicated `/v1/hooks` endpoints are live. The temporary `POST /v1/packaging/generate-hooks` endpoint still exists but is superseded.

---

## Endpoints Summary

| Method | URL | Status | Description |
|---|---|---|---|
| `POST` | `/v1/packaging/generate-hooks` | ✅ Built (deprecated) | Generate 5 hooks — temporary location in Packaging |
| `POST` | `/v1/hooks/generate` | ✅ Built | Generate a 5-hook batch tied to a video project |
| `POST` | `/v1/hooks/:hooksId/select` | ✅ Built | Select a hook index, stores it on the video project |

---

## POST `/v1/hooks/generate` ✅ Built

Generates 5 hook variations from a script. Saves the batch to the `hooks` Firestore collection and links it to the video project.

### Auth
`Authorization: Bearer <token>` — required.

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `videoProjectId` | `string` | Yes | ID of the video project |
| `script` | `string` | Yes | Full video script text |

### Response — `200`

```json
{
  "success": true,
  "message": "Hooks generated successfully",
  "data": {
    "id": "firestore-auto-id",
    "videoProjectId": "string",
    "createdBy": "uid_abc123",
    "hooks": [
      "What if everything you knew about growing on YouTube was completely wrong?",
      "Most creators waste their first 100 videos — here's exactly why.",
      "Three months ago I had 200 subscribers. Last week I hit 50K.",
      "Everyone says consistency is the key. They're missing the real reason.",
      "Stop. Before you post another video, you need to hear this."
    ],
    "createdAt": "<timestamp>"
  }
}
```

### Error Cases

| Status | Condition |
|---|---|
| 400 | `videoProjectId` or `script` missing |
| 403 | Video project not owned by user |
| 404 | Video project not found |
| 500 | Gemini generation failed or JSON parse error |

---

## POST `/v1/hooks/:hooksId/select` ✅ Built

Marks a specific hook index as selected. Stores `hooksId` and `selectedHookIndex` on the video project document.

### Auth
`Authorization: Bearer <token>` — required.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `hooksId` | `string` | ID of the hooks batch document to select from |

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `hookIndex` | `number` | Yes | Zero-based index (0–4) of the selected hook within the `hooks` array |
| `videoProjectId` | `string` | Yes | ID of the video project to update |

### Response — `200`

```json
{
  "success": true,
  "message": "Hook selected successfully",
  "data": {
    "id": "video-project-id",
    "hooksId": "hooks-batch-id",
    "selectedHookIndex": 2
  }
}
```

> `id` is the video project ID. `selectedHookIndex` is the index stored on the project.

### Error Cases

| Status | Condition |
|---|---|
| 400 | `hookIndex` or `videoProjectId` missing, or `hookIndex` out of range (0–4) |
| 403 | Hooks batch not owned by user |
| 404 | Hooks batch not found |

---

## POST `/v1/packaging/generate-hooks` ✅ Built (deprecated)

Generates 5 hook variations from a script and title. Returns JSON — not SSE. Does not save to Firestore.

**This endpoint is deprecated.** Use `POST /v1/hooks/generate` instead.

### Auth
`Authorization: Bearer <token>` — required.

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `script` | `string` | Yes | Full video script text |
| `title` | `string` | Yes | Video title |

### Response — `200`

```json
{
  "success": true,
  "data": {
    "hooks": [
      "hook variation 1",
      "hook variation 2",
      "hook variation 3",
      "hook variation 4",
      "hook variation 5"
    ]
  }
}
```

---

## Related Documentation

- [Hooks Feature Spec](./spec.md)
- [Packaging API Reference](../packaging/api.md)
- [Pipeline Spec](../../product/pipeline-spec.md)
- [Product Roadmap](../../product/roadmap.md)
