---
title: "Packaging Feature Spec"
description: "How the Packaging step works: what it generates, data model, pipeline position, and what's not built yet."
date: 2026-02-27
last_updated: 2026-02-27
status: "draft"
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

Currently takes `script` and `title` directly from the request body. The `selectedHook` context and `videoProjectId` linkage are Phase 0 work.

---

## What's Built

### Title Variations

`POST /v1/packaging/generate-title` — generates 3 alternative title variations.

**Prompt:** `PACKAGING_TITLE_PROMPT` — injects `{script}` and `{title}`. Returns:
```json
{ "titles": ["title1", "title2", "title3"] }
```
Titles target 50–70 characters, different emotional angles, search-optimized.

---

### Description

`POST /v1/packaging/generate-description` — generates an SEO-optimized YouTube description.

**Prompt:** `PACKAGING_DESCRIPTION_PROMPT` — injects `{script}` and `{title}`. Returns:
```json
{ "description": "full description text" }
```
Hook visible before "Show More", keywords woven naturally, timestamp placeholders, CTA. Target: 200–400 words.

---

### Thumbnail Brief

`POST /v1/packaging/generate-thumbnail` — generates 3 thumbnail design concepts.

**Prompt:** `PACKAGING_THUMBNAIL_PROMPT` — injects `{script}` and `{title}`. Returns:
```json
{
  "thumbnails": [
    {
      "concept": "brief concept name",
      "textOverlay": "suggested text",
      "visualDescription": "visual elements and layout",
      "emotionalTrigger": "psychological hook"
    }
  ]
}
```
These are design briefs, not rendered images. Text overlay is 3–5 words max.

---

### Shorts Script

`POST /v1/packaging/generate-shorts` — generates a segmented YouTube Shorts script.

**Prompt:** `PACKAGING_SHORTS_PROMPT` — injects `{script}` and `{title}`. Returns:
```json
{
  "shortsScript": {
    "hook": "opening 3 seconds",
    "body": "main content",
    "callToAction": "closing 5 seconds",
    "estimatedDuration": "XX seconds"
  }
}
```
Target: under 60 seconds at natural speaking pace.

---

### Hooks Generation (Temporary — Moving to Its Own Step)

`POST /v1/packaging/generate-hooks` — generates 5 hook variations.

**This is NOT a permanent Packaging endpoint.** Hooks will be extracted into its own pipeline step (Step 3) in Phase 0. Documented here only because it currently ships with the Packaging module. See [Hooks Feature Spec](../hooks/spec.md).

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

Packaging documents are saved with whatever fields the client sends in `req.body`, plus three server-set fields:

```typescript
{
  ...clientProvidedFields,       // whatever the client sends to /save
  createdBy: string,             // userId from authMiddleware
  createdAt: Timestamp,          // serverTimestamp()
  updatedAt: Timestamp,          // serverTimestamp()
}
```

Firestore auto-generates the document ID.

### Critical Gap: No Foreign Keys

Packaging documents have **no `scriptId`, `topicId`, or `videoProjectId`**. The packaging collection is fully disconnected from topics and scripts. This is a known, intentional gap — the video project schema was not defined when packaging was built.

**Do not** build any feature that depends on linking packaging to topics or scripts until `videoProjectId` is added in Phase 0.

---

## Per-Item Status (Planned — Phase 0)

Each of the 4 packaging items will have its own independent status:

```
not_started → generating → in_review → completed
```

Nothing auto-advances to `completed`. The creator explicitly marks each item done.

Items can be regenerated at any time. Regeneration resets that item's status to `generating`.

The packaging document will gain an `itemStatuses` map in Phase 0:

```typescript
itemStatuses: {
  title:       "not_started" | "generating" | "in_review" | "completed"
  description: "not_started" | "generating" | "in_review" | "completed"
  thumbnail:   "not_started" | "generating" | "in_review" | "completed"
  shorts:      "not_started" | "generating" | "in_review" | "completed"
}
```

---

## What's Not Built

| Gap | Notes |
|---|---|
| `videoProjectId` foreign key | Packaging has no link to a video project, script, or topic. Blocked on Phase 0 video project schema. |
| Per-item status tracking | No `itemStatuses` field. No `not_started → in_review → completed` lifecycle. |
| Stale detection | No `stale` flag. No mechanism to mark packaging stale when the script is regenerated or selected hook changes. |
| `selectedHook` context in generation | Hooks exist but selected hook is not injected into title/description/thumbnail prompts. |
| Hooks extraction | `generate-hooks` must move to its own step before integration. |
| Input validation | No server-side check that `script` or `title` are present. Missing fields produce degraded Gemini output, not a 400. |

---

## Phase 0 Planned Changes

- **`videoProjectId`** added to packaging documents when video project schema ships
- **`itemStatuses`** map added for per-item state tracking
- **`stale: boolean`** added and set to `true` when script is regenerated or selected hook changes after packaging was created
- **Input change** — generation endpoints currently take `{ script, title }`. In Phase 0 they will take `videoProjectId` and pull context from the video project document. This is a breaking API change.
- **Hooks extraction** — `generate-hooks` removed from this module, becomes Step 3

---

## Related Documentation

- [Packaging API Reference](./api.md)
- [Hooks Feature Spec](../hooks/spec.md)
- [Pipeline Spec](../../product/pipeline-spec.md)
- [Product Roadmap](../../product/roadmap.md)
