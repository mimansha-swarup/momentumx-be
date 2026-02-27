---
title: "Hooks API Reference"
description: "Endpoint reference for the Hooks step — hook generation and selection"
date: 2026-02-27
last_updated: 2026-02-27
status: "draft"
tags: ["api", "hooks"]
---

# Hooks API Reference

Hooks generation currently lives inside the Packaging module. The dedicated Hooks endpoints are Phase 0 work.

---

## Endpoints Summary

| Method | URL | Status | Description |
|---|---|---|---|
| `POST` | `/v1/packaging/generate-hooks` | ✅ Built | Generate 5 hooks (temporary location in Packaging) |
| `POST` | `/v1/hooks/generate` | ❌ Not built | Dedicated hooks endpoint (Phase 0) |
| `POST` | `/v1/hooks/:hookId/select` | ❌ Not built | Select a hook, complete the Hooks step (Phase 0) |

---

## POST `/v1/packaging/generate-hooks` ✅ Built

Generates 5 hook variations from a script and title. Returns JSON — not SSE. Does not save to Firestore.

**This endpoint is temporary.** It will be superseded by `POST /v1/hooks/generate` in Phase 0. Do not build permanent dependencies on this path.

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
      "What if everything you knew about growing on YouTube was completely wrong?",
      "Most creators waste their first 100 videos — here's exactly why, and how to not be one of them.",
      "Three months ago I had 200 subscribers. Last week I hit 50K. This is what changed.",
      "Everyone says consistency is the key to YouTube growth. They're missing the real reason channels blow up.",
      "Stop. Before you post another video, you need to hear this."
    ]
  }
}
```

### Error Cases

| Status | Condition |
|---|---|
| 400 | `script` or `title` missing |
| 500 | Gemini generation failed or JSON parse error |

### Notes
- No Firestore write — caller is responsible for saving the result
- Response is parsed from Gemini JSON — if model returns malformed JSON, a 500 is returned

---

## POST `/v1/hooks/generate` ❌ Not Built

Generates 5 hook variations for a video project. Pulls script from the video project. Saves the batch to the `hooks` Firestore collection.

### Auth
`Authorization: Bearer <token>` — required.

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `videoProjectId` | `string` | Yes | ID of the video project |

### Response — `200`

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "videoProjectId": "string",
    "batchId": "string",
    "hooks": [
      "hook variation 1",
      "hook variation 2",
      "hook variation 3",
      "hook variation 4",
      "hook variation 5"
    ],
    "archived": false,
    "createdAt": "<timestamp>"
  }
}
```

### Error Cases

| Status | Condition |
|---|---|
| 400 | `videoProjectId` missing |
| 403 | Project not owned by user |
| 404 | Video project not found |
| 500 | Script not available on project, or Gemini generation failed |

---

## POST `/v1/hooks/:hookId/select` ❌ Not Built

Marks a hook as selected. Stores `selectedHookId` on the video project and transitions the Hooks step to `completed`. Unlocks the Packaging step.

### Auth
`Authorization: Bearer <token>` — required.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `hookId` | `string` | ID of the hooks document to select from |

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `hookIndex` | `number` | Yes | Index (0–4) of the selected hook within the `hooks` array |

### Response — `200`

```json
{
  "success": true,
  "message": "Hook selected",
  "data": {
    "hookId": "string",
    "selectedHookIndex": 2,
    "videoProjectId": "string",
    "hooksStepStatus": "completed"
  }
}
```

### Error Cases

| Status | Condition |
|---|---|
| 400 | `hookIndex` missing or out of range |
| 403 | Hook document not owned by user |
| 404 | Hooks document not found |
| 500 | Firestore write failed |

---

## Related Documentation

- [Hooks Feature Spec](./spec.md)
- [Packaging API Reference](../packaging/api.md)
- [Pipeline Spec](../../product/pipeline-spec.md)
- [Product Roadmap](../../product/roadmap.md)
