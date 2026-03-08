---
title: "Research — API Contract"
description: "Endpoint reference for the Research step — topic generation, iteration, feedback, and export"
status: "implemented"
last_updated: 2026-03-08
tags: ["api", "research", "topics"]
---

# Research — API Contract

Topic endpoints are under `/v1/content`. Research intelligence endpoints are under `/v1/research`. All require `Authorization: Bearer <token>`.

---

## Endpoints Summary

### `/v1/content` — Topic Lifecycle

| Method | URL | Purpose | Status |
|---|---|---|---|
| `GET` | `/v1/content/stream/topics` | Generate 10 topic ideas (new batch) | ✅ Built |
| `GET` | `/v1/content/topics` | List saved topics (paginated) | ✅ Built |
| `PATCH` | `/v1/content/topics/edit/:topicId` | Edit a topic title | ✅ Built |
| `POST` | `/v1/content/topics/regenerate-all` | Archive current batch, generate 10 new | ✅ Built |
| `POST` | `/v1/content/topics/:topicId/regenerate` | Regenerate a single topic slot in-place | ✅ Built |
| `PATCH` | `/v1/content/topics/:topicId/feedback` | Set like/dislike signal on a topic | ✅ Built |
| `GET` | `/v1/content/topics/export` | Export active batch as formatted text | ✅ Built |

### `/v1/video-projects` — Project Creation

| Method | URL | Purpose | Status |
|---|---|---|---|
| `POST` | `/v1/video-projects` | Create a video project from a selected topic | ✅ Built |

### `/v1/research` — Research Intelligence

| Method | URL | Purpose | Status |
|---|---|---|---|
| `GET` | `/v1/research/trending` | Trending YouTube videos in user's niche | ✅ Built |
| `GET` | `/v1/research/competitors` | Competitor top videos (fresh from YouTube API) | ✅ Built |
| `GET` | `/v1/research/keywords` | Keyword signals for a search query | ✅ Built |

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

## POST `/v1/content/topics/regenerate-all` ✅ Built

Archives all active (non-archived) topics for the user and generates a fresh batch of 10. Triggers a stale cascade on any video project linked to an active topic.

### Auth
`Authorization: Bearer <token>` — required.

### Request Body
None.

### Response — Success `200`

```json
{
  "success": true,
  "message": "Topics regenerated successfully",
  "data": [
    {
      "id": "new-uuid",
      "title": "New title 1",
      "batchId": "new-batch-uuid",
      "archived": false
    }
  ]
}
```

### Notes
- Old topics are set to `archived: true` — they are not deleted, just hidden.
- A new `batchId` is generated for the fresh batch.
- If any active topic has `videoProjectId` set, `pipeline.script`, `.hooks`, and `.packaging` on that project are marked `stale`.

---

## POST `/v1/content/topics/:topicId/regenerate` ✅ Built

Regenerates a single topic slot in-place. Replaces the title and embedding while preserving the document ID and `batchId`.

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
    "batchId": "batch_xyz",
    "archived": false
  }
}
```

### Notes
- `batchId` stays the same — slot-replace within the existing batch.
- Does not trigger a stale cascade (only Regenerate All does).
- Ownership-checked: returns 403 if `topicId` belongs to a different user.

---

## PATCH `/v1/content/topics/:topicId/feedback` ✅ Built

Records a like or dislike signal on a topic. Used for feedback collection — does not affect generation.

### Auth
`Authorization: Bearer <token>` — required.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `topicId` | `string` | The UUID of the topic |

### Request Body

```json
{ "feedback": "like" }
```

| Field | Type | Values |
|---|---|---|
| `feedback` | `string \| null` | `"like"`, `"dislike"`, or `null` (to clear) |

### Response — Success `200`

```json
{
  "success": true,
  "data": { "id": "a1b2c3d4-...", "userFeedback": "like" }
}
```

### Error Cases

| Status | Condition |
|---|---|
| 400 | `feedback` value is not `"like"`, `"dislike"`, or `null` |
| 403 | Topic belongs to a different user |
| 404 | Topic not found |

---

## GET `/v1/content/topics/export` ✅ Built

Returns the user's active topic batch as a formatted plain-text numbered list, ready to copy-paste.

### Auth
`Authorization: Bearer <token>` — required.

### Request
No body. No query params.

### Response — Success `200`

```json
{
  "success": true,
  "data": {
    "text": "Research Topics — March 8, 2026\n──────────────────────────────────\n1. Title one\n2. Title two\n...",
    "count": 10
  }
}
```

### Notes
- Only returns active (non-archived) topics.
- Ordered by `createdAt` ascending (original generation order).

---

## POST `/v1/video-projects` ✅ Built

Creates a video project when a creator selects a topic. Writes `videoProjectId` back to the topic document. See [Video Project API Reference](../video-project/api.md) for the full contract.

---

## GET `/v1/research/trending` ✅ Built

Returns trending YouTube videos in the user's niche (pulled fresh from YouTube Data API on each call).

### Auth
`Authorization: Bearer <token>` — required.

### Request
No body. No query params. Niche is read from the user's profile.

### Response — Success `200`

```json
{
  "success": true,
  "data": [
    {
      "title": "Why Most YouTube Channels Fail in Year 2",
      "channelTitle": "Creator Insights",
      "videoId": "dQw4w9WgXcQ"
    }
  ]
}
```

---

## GET `/v1/research/competitors` ✅ Built

Returns top videos from the user's competitor channels (fetched fresh from YouTube Data API on each call). Competitor channel IDs are read from the user's profile (set during onboarding).

### Auth
`Authorization: Bearer <token>` — required.

### Request
No body. No query params.

### Response — Success `200`

```json
{
  "success": true,
  "data": [
    {
      "channelTitle": "Competitor Channel Name",
      "titles": [
        "Their top video title 1",
        "Their top video title 2"
      ]
    }
  ]
}
```

### Notes
- Returns an empty array if no competitors are set on the user's profile.
- Each competitor is fetched in parallel.

---

## GET `/v1/research/keywords` ✅ Built

Returns related keyword signals for a search query (YouTube Data API relevance search).

### Auth
`Authorization: Bearer <token>` — required.

### Query Parameters

| Param | Type | Required | Description |
|---|---|---|---|
| `query` | `string` | Yes | Search term to look up keyword signals for |

### Response — Success `200`

```json
{
  "success": true,
  "data": [
    {
      "title": "Related video title",
      "channelTitle": "Channel Name"
    }
  ]
}
```

### Error Cases

| Status | Condition |
|---|---|
| 400 | `query` param missing or empty |

---

## Related Documentation

- [Research Feature Spec](./spec.md) — User flow, states, edge cases
- [Pipeline Status Model](../../product/pipeline-spec.md) — Full status schemas and Firestore schema
- [Video Project API Reference](../video-project/api.md) — Project creation contract
