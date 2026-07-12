---
title: "Research — API Contract"
description: "Endpoint reference for the Research step — idea generation, iteration, and export"
status: "implemented"
last_updated: 2026-07-12
tags: ["api", "research", "ideas"]
---

# Research — API Contract

Idea endpoints are under `/v1/ideas`. Research intelligence endpoints are under `/v1/research`. All require `Authorization: Bearer <token>`.

---

## Endpoints Summary

### `/v1/ideas` — Idea Lifecycle

| Method | URL | Purpose | Status |
|---|---|---|---|
| `POST` | `/v1/ideas/generate` | Generate 10 video ideas (new batch) | ✅ Built |
| `GET` | `/v1/ideas` | List saved ideas (paginated) | ✅ Built |
| `PATCH` | `/v1/ideas/edit/:ideaId` | Edit an idea title | ✅ Built |
| `POST` | `/v1/ideas/regenerate-all` | Archive current batch, generate 10 new | ✅ Built |
| `POST` | `/v1/ideas/:ideaId/regenerate` | Regenerate a single idea slot in-place | ✅ Built |
| `GET` | `/v1/ideas/export` | Export active batch as formatted text | ✅ Built |

### `/v1/video-projects` — Project Creation

| Method | URL | Purpose | Status |
|---|---|---|---|
| `POST` | `/v1/video-projects` | Create a video project from a selected idea | ✅ Built |

### `/v1/research` — Research Intelligence

| Method | URL | Purpose | Status |
|---|---|---|---|
| `GET` | `/v1/research/trending` | Trending YouTube videos in user's niche | ✅ Built |
| `GET` | `/v1/research/competitors` | Competitor top videos (fresh from YouTube API) | ✅ Built |
| `GET` | `/v1/research/keywords` | Keyword signals for a search query | ✅ Built |

---

## POST `/v1/ideas/generate`

Generates 10 new video ideas for the authenticated user using their onboarding context and KMeans clustering to avoid repetition. Saves all ideas to Firestore and returns them in a single JSON response.

Idea documents include `concept`, `ideaType`, and `evidence` fields grounding each idea in research signals.

### Auth
`Authorization: Bearer <token>` — required.

### Request
No body. No query params.

### Response — Success `200`

```json
{
  "success": true,
  "message": "successfully generated ideas",
  "data": [
    {
      "id": "a1b2c3d4-...",
      "title": "How I Built a $10K/Month Business Using Only Free AI Tools",
      "concept": "Building a sustainable side business with minimal overhead",
      "ideaType": "evergreen",
      "evidence": "Based on competitor analysis and trending topics in business niche",
      "createdBy": "uid_abc123",
      "createdAt": "2026-02-27T10:00:00.000Z",
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
- Generates exactly 10 ideas per call.
- KMeans clustering runs before generation. All previously saved ideas for this user (including archived) are clustered and passed to the prompt as "avoid these."
- All generated ideas are batch-saved to Firestore before the response is returned.
- `embedding` field will be removed from the response in a future cleanup — it is internal data. Do not build frontend UI that depends on it.

---

## GET `/v1/ideas`

Returns a paginated list of the authenticated user's saved ideas. Supports cursor-based pagination and filtering.

### Auth
`Authorization: Bearer <token>` — required.

### Query Parameters

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | `number` | `9` | Number of ideas to return per page |
| `createdAt` | `string` | `""` | Cursor: ISO timestamp of the last item from previous page |
| `docId` | `string` | `""` | Cursor: Firestore document ID of the last item from previous page |
| `searchText` | `string` | `""` | Prefix search on idea title |

> Pagination and search are mutually exclusive. If `searchText` is present, cursor pagination is ignored.

### Response — Success `200`

```json
{
  "success": true,
  "message": "successfully retrieved ideas",
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
        "concept": "Building a sustainable side business with minimal overhead",
        "ideaType": "evergreen",
        "createdBy": "uid_abc123",
        "createdAt": "2026-02-27T10:00:00.000Z"
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
  "message": "Failed to retrieve ideas",
  "detail": "..."
}
```

### Notes
- Results are ordered by `createdAt` descending (newest first) unless `searchText` is active, in which case they are ordered alphabetically by title prefix.
- `embedding` is not returned in this endpoint's response.

---

## PATCH `/v1/ideas/edit/:ideaId`

Updates fields on an idea document. Used when a creator manually edits a title.

### Auth
`Authorization: Bearer <token>` — required.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `ideaId` | `string` | The UUID of the idea to update |

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
  "message": "Failed to update idea",
  "detail": "..."
}
```

### Notes
- Ownership is checked — returns 403 if `ideaId` belongs to a different user.
- No validation on field names — any field key will be accepted and merged.

---

## POST `/v1/ideas/regenerate-all` ✅ Built

Archives all active (non-archived) ideas for the user and generates a fresh batch of 10. Triggers a stale cascade that fans out to **all** video projects backed by each archived idea.

### Auth
`Authorization: Bearer <token>` — required.

### Request Body
None.

### Response — Success `200`

```json
{
  "success": true,
  "message": "Ideas regenerated successfully",
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
- Old ideas are set to `archived: true` — they are not deleted, just hidden.
- A new `batchId` is generated for the fresh batch.
- For each archived idea, every video project backed by it (via `getProjectsByIdea` → `findByIdeaId`) has its `pipeline.script`, `.hooks`, and `.packaging` marked `stale`, and any linked packaging document is marked stale. The cascade reaches all projects on an idea, not just one.
- Implicit signal captured: `REGENERATE` event recorded in events collection.

---

## POST `/v1/ideas/:ideaId/regenerate` ✅ Built

Regenerates a single idea slot in-place. Replaces the concept, title, ideaType, and embedding while preserving the document ID and `batchId`.

### Auth
`Authorization: Bearer <token>` — required.

### Path Parameters

| Param | Type | Description |
|---|---|---|
| `ideaId` | `string` | The UUID of the idea to regenerate |

### Request Body
None.

### Response — Success `200`

```json
{
  "success": true,
  "message": "Idea regenerated",
  "data": {
    "id": "a1b2c3d4-...",
    "title": "New title replacing the old one",
    "concept": "New concept/theme",
    "ideaType": "evergreen",
    "evidence": "Updated research grounding",
    "createdBy": "uid_abc123",
    "batchId": "batch_xyz",
    "archived": false
  }
}
```

### Notes
- `batchId` stays the same — slot-replace within the existing batch.
- Does not trigger a stale cascade (only Regenerate All does).
- Ownership-checked: returns 403 if `ideaId` belongs to a different user.
- Implicit signal captured: `REGENERATE` event recorded in events collection.

---

## GET `/v1/ideas/export` ✅ Built

Returns the user's active idea batch as a formatted plain-text numbered list, ready to copy-paste. Records an implicit signal for telemetry.

### Auth
`Authorization: Bearer <token>` — required.

### Request
No body. No query params.

### Response — Success `200`

```json
{
  "success": true,
  "data": {
    "text": "Research Ideas — March 8, 2026\n──────────────────────────────────\n1. Title one\n2. Title two\n...",
    "count": 10
  }
}
```

### Notes
- Only returns active (non-archived) ideas.
- Ordered by `createdAt` ascending (original generation order).
- Implicit signal captured: `EXPORT` event recorded in events collection.

---

## POST `/v1/video-projects` ✅ Built

Creates a video project when a creator selects an idea. Writes `videoProjectId` back to the idea document. See [Video Project API Reference](../video-project/api.md) for the full contract. Records an implicit `PROJECT_CREATED` signal.

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
