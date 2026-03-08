---
title: "Hooks API Reference"
description: "Endpoint reference for the Hooks step — hook generation and selection"
date: 2026-02-27
last_updated: 2026-03-08
status: "implemented"
tags: ["api", "hooks"]
---

# Hooks API Reference

Hooks is a standalone pipeline step. The dedicated `/v1/hooks` endpoints are live. The legacy `POST /v1/packaging/generate-hooks` endpoint still exists for stateless generation but is deprecated — use `/v1/hooks/generate` instead.

---

## Endpoints Summary

| Method | URL | Status | Description |
|---|---|---|---|
| `POST` | `/v1/hooks/generate` | ✅ Built | Generate a 5-hook batch tied to a video project |
| `POST` | `/v1/hooks/:hooksId/select` | ✅ Built | Select a hook index, stores it on the video project |
| `POST` | `/v1/hooks/:hooksId/regenerate` | ✅ Built | Regenerate hooks for the same video project |
| `PATCH` | `/v1/hooks/:hooksId/feedback` | ✅ Built | Record per-hook like/dislike |
| `GET` | `/v1/hooks/:hooksId/export` | ✅ Built | Export hooks as plain text |
| `POST` | `/v1/packaging/generate-hooks` | ✅ Built (deprecated) | Stateless hook generation — legacy path |

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
    "hookFeedback": {},
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

## POST `/v1/hooks/:hooksId/regenerate` ✅ Built

Regenerates hooks for the same video project, overwriting the existing batch in place. Marks the downstream packaging document stale (fire-and-forget).

### Auth
`Authorization: Bearer <token>` — required. Ownership enforced — `createdBy` must match requesting user.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `hooksId` | `string` | ID of the hooks batch document to regenerate |

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `script` | `string` | Yes | Full video script text (may be updated since first generation) |

### Response — `200`

```json
{
  "success": true,
  "message": "Hooks regenerated successfully",
  "data": {
    "id": "hooks-batch-id",
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

### Side Effects on Completion
- Existing hooks batch overwritten in place (`hooks` and `hookFeedback` reset)
- If linked packaging exists, `pipeline.packaging.status` is set to `"stale"` on the video project (fire-and-forget)

### Error Cases

| Status | Condition |
|---|---|
| 400 | `script` missing |
| 403 | Hooks batch not owned by user |
| 404 | Hooks batch not found |
| 500 | Gemini generation failed or Firestore write failed |

---

## PATCH `/v1/hooks/:hooksId/feedback` ✅ Built

Records a like or dislike signal on a specific hook within the batch. Overwrites any prior feedback for that hook index.

### Auth
`Authorization: Bearer <token>` — required. Ownership enforced.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `hooksId` | `string` | ID of the hooks batch document |

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `hookIndex` | `number` | Yes | Zero-based index (0–4) of the hook being rated |
| `feedback` | `"like" \| "dislike" \| null` | Yes | `null` clears existing feedback for that hook |

### Response — `200`

```json
{
  "success": true,
  "message": "Feedback updated",
  "data": {
    "id": "hooks-batch-id",
    "hookFeedback": {
      "0": "like",
      "2": "dislike"
    }
  }
}
```

### Error Cases

| Status | Condition |
|---|---|
| 400 | `hookIndex` or `feedback` invalid |
| 403 | Hooks batch not owned by user |
| 404 | Hooks batch not found |

---

## GET `/v1/hooks/:hooksId/export` ✅ Built

Returns all hooks in the batch as a plain-text formatted string suitable for copy-paste or download.

### Auth
`Authorization: Bearer <token>` — required. Ownership enforced.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `hooksId` | `string` | ID of the hooks batch document |

### Response — `200`

```json
{
  "success": true,
  "data": {
    "text": "Hooks — March 8, 2026\n──────────────────────────────────\n1. hook one\n2. hook two\n3. hook three\n4. hook four\n5. hook five",
    "count": 5
  }
}
```

### Error Cases

| Status | Condition |
|---|---|
| 403 | Hooks batch not owned by user |
| 404 | Hooks batch not found |

---

## POST `/v1/packaging/generate-hooks` ✅ Built (deprecated)

Generates 5 hook variations from a script. Returns JSON — not SSE. Does not save to Firestore or link to a video project.

**This endpoint is deprecated.** Use `POST /v1/hooks/generate` instead.

### Auth
`Authorization: Bearer <token>` — required.

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `script` | `string` | Yes | Full video script text |

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
