---
title: "Packaging Feature Spec"
description: "How the Packaging step works: what it generates, data model, pipeline position, and what's not built yet."
date: 2026-02-27
last_updated: 2026-03-17
status: "implemented"
tags: ["feature", "packaging", "spec"]
---

# Packaging Feature Spec

## Overview

Packaging is **Step 4 of 4** in the MomentumX content pipeline. It answers: *"How do I present this video to get the most clicks and views?"*

Given a completed script and title, Packaging generates the assets needed to publish: optimized title variations, an SEO description, thumbnail design concepts, and a YouTube Shorts script. Each asset can be generated and regenerated independently.

---

## Pipeline Position

| Attribute | Value |
|---|---|
| Step | 4 of 4 |
| Requires | Script + title + selectedHook as context |
| Completion mechanic | Creator explicitly marks each item done |

Generation endpoints accept `script`, `title`, and optional `selectedHook` directly from the request body. `videoProjectId` can be passed to `POST /save` to link the packaging document to a video project.

---

## What's Built

### Title Variations

`POST /v1/packaging/generate-title` — generates 3 alternative title variations.

**Prompt:** `GENERATE_TITLE_PROMPT` — injects `{script}` and optional `{selectedHook}`. Returns:
```json
{ "titles": [{ "title": "...", "characterCount": 62 }, ...] }
```
Titles target 50–70 characters, different emotional angles, search-optimized.

---

### Description

`POST /v1/packaging/generate-description` — generates an SEO-optimized YouTube description.

**Prompt:** `GENERATE_DESCRIPTION_PROMPT` — injects `{script}`, `{title}`, and optional `{selectedHook}`. Returns:
```json
{ "description": "full description text" }
```
Hook visible before "Show More", keywords woven naturally, timestamp placeholders, CTA. Target: 200–400 words.

---

### Thumbnail Brief

`POST /v1/packaging/generate-thumbnail` — generates 3 thumbnail design concepts.

**Prompt:** `GENERATE_THUMBNAIL_PROMPT` — injects `{script}`, `{title}`, and optional `{selectedHook}`. Returns:
```json
{ "descriptions": ["plain string visual brief 1", "brief 2", "brief 3"] }
```
These are plain-text design briefs, not rendered images. Each describes layout, text overlay (3–5 words), colors, and visual approach.

---

### Shorts Script

`POST /v1/packaging/generate-shorts` — generates a segmented YouTube Shorts script.

**Prompt:** `GENERATE_SHORTS_PROMPT` — injects `{script}` and `{duration}`. Returns:
```json
{
  "segments": [
    { "startTime": "0:00", "endTime": "0:05", "content": "...", "type": "hook" },
    { "startTime": "0:05", "endTime": "0:40", "content": "...", "type": "point" },
    { "startTime": "0:55", "endTime": "1:00", "content": "...", "type": "cta" }
  ],
  "totalDuration": "1:00"
}
```
Segment types: `hook`, `point`, `transition`, `cta`. Word count targets ~2.5 words per second to fit the specified `duration`.

---

### Hooks Generation (Legacy — Stateless)

`POST /v1/packaging/generate-hooks` — generates 5 hook variations.

This endpoint is still available for stateless generation but is no longer the canonical hooks path. The dedicated `POST /v1/hooks/generate` endpoint (Step 3) generates hooks tied to a video project and should be used in the integrated pipeline. See [Hooks Feature Spec](../hooks/spec.md).

---

### Save, List, and Retrieve

- `POST /v1/packaging/save` — saves a packaging document with Firestore auto-ID
- `GET /v1/packaging/list` — list all packaging for the user, ordered by `createdAt` desc
- `GET /v1/packaging/:packagingId` — get single packaging document; ownership enforced

---

## Generation Config

All generation endpoints use `GENERATION_CONFIG_PACKAGING` (`responseMimeType: "application/json"`). Every response is parsed with `JSON.parse`. If `JSON.parse` throws, the prompt or config is misconfigured — the error propagates and the controller returns 500.

---

## Current Data Model

Packaging documents are saved with the client-provided fields plus server-set fields:

```typescript
{
  ...clientProvidedFields,       // whatever the client sends to /save
  createdBy: string,             // userId from authMiddleware
  createdAt: Timestamp,          // serverTimestamp()
  itemStatuses: {                // auto-derived from content presence on save
    title: PackagingItemStatus,
    description: PackagingItemStatus,
    thumbnail: PackagingItemStatus,
    shorts: PackagingItemStatus,
  },
  isStale: boolean,              // true if ANY item is "stale"
  staleReason: "script_regenerated" | "hooks_regenerated" | null,
  staleSince: Timestamp | null,
}
```

Firestore auto-generates the document ID.

### `videoProjectId` Linkage & Upsert

When `videoProjectId` is passed to `POST /save`, the service checks if a packaging document already exists for that project. If it does, the existing document is updated (upsert). If not, a new document is created. This prevents duplicate packaging documents per video project.

After save, `linkResource` is called fire-and-forget on the video project. Direct `scriptId` or `topicId` foreign keys still do not exist on packaging documents.

---

## Per-Item Status Tracking

Each of the 4 packaging items has its own independent status tracked in `itemStatuses`:

```typescript
type PackagingItemStatus = "not_started" | "completed" | "stale";

itemStatuses: {
  title:       PackagingItemStatus,
  description: PackagingItemStatus,
  thumbnail:   PackagingItemStatus,
  shorts:      PackagingItemStatus,
}
```

### State Transitions

| Transition | Trigger |
|---|---|
| `not_started → completed` | `savePackaging` with item content present, or `regenerateItem` succeeds |
| `completed → stale` | Upstream script or hooks regenerated (cascade) |
| `stale → completed` | `regenerateItem` for that specific item |
| `not_started` stays `not_started` | Cascade skips items that were never generated |

### Stale Tracking

When an upstream dependency is regenerated, the packaging document is marked stale:

- **Script regenerated** → all `completed` items flip to `stale`, `isStale: true`, `staleReason: "script_regenerated"`
- **Hooks regenerated** → all `completed` items flip to `stale`, `isStale: true`, `staleReason: "hooks_regenerated"`

`not_started` items are never flipped — there's nothing to invalidate.

### Stale Clearing

After any `regenerateItem` completes, the service checks all `itemStatuses`. If no items remain `"stale"`, the document-level stale fields are cleared: `isStale: false`, `staleReason: null`, `staleSince: null`.

### Atomic Writes

`regenerateItem` writes both the regenerated content and the status update (`itemStatuses.<item>: "completed"`) in a single Firestore `update()` call. On AI generation failure, the item status is rolled back to its previous value.

---

## Build Status

| Feature | Status |
|---|---|
| Generate title, description, thumbnail, shorts | ✅ Built |
| `selectedHook` injected into title/description/thumbnail prompts | ✅ Built |
| Input validation (400 on missing `script`/`title`) | ✅ Built |
| Save packaging to Firestore | ✅ Built |
| `videoProjectId` linkage on save | ✅ Built |
| Ownership check on get/save | ✅ Built |
| Regenerate per item (`POST /:packagingId/regenerate/:item`) | ✅ Built |
| Per-item feedback (`PATCH /:packagingId/feedback`) | ✅ Built |
| Export packaging (`GET /:packagingId/export`) | ✅ Built |
| Stale detection (`isStale` + `staleReason` + `staleSince`) | ✅ Built |
| Per-item status tracking (`itemStatuses` map) | ✅ Built |
| Stale cascade from script/hooks regeneration | ✅ Built |
| Upsert by `videoProjectId` (prevents duplicates) | ✅ Built |
| Direct `scriptId` / `topicId` foreign keys | ❌ Not built |

---

## Related Documentation

- [Packaging API Reference](./api.md)
- [Hooks Feature Spec](../hooks/spec.md)
- [Pipeline Spec](../../product/pipeline-spec.md)
- [Product Roadmap](../../product/roadmap.md)
