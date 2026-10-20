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

Generation endpoints accept `script` / `title` from the request body and a `videoProjectId`. The selected hook is **no longer passed in the request body** — the server resolves it from the project's stored hook selection (`resolveSelectedHook`: reads `project.hooksId` + `project.selectedHookIndex`, then looks up the hook string). `videoProjectId` can also be passed to `POST /save` to link the packaging document to a video project. `generate-shorts` takes only `script` + `duration` and ignores hooks entirely.

---

## What's Built

### Title Variations

`POST /v1/packaging/generate-title` — generates 3 alternative title variations.

**Prompt:** `GENERATE_TITLE_PROMPT` — injects `{script}` and `{selectedHook}` (resolved server-side from `videoProjectId`). Returns:
```json
{ "titles": [{ "title": "...", "characterCount": 62 }, ...] }
```
Titles target 50–70 characters, different emotional angles, search-optimized.

---

### Description

`POST /v1/packaging/generate-description` — generates an SEO-optimized YouTube description.

**Prompt:** `GENERATE_DESCRIPTION_PROMPT` — injects `{script}`, `{title}`, and `{selectedHook}` (resolved server-side from `videoProjectId`). Returns:
```json
{ "description": "full description text" }
```
Hook visible before "Show More", keywords woven naturally, timestamp placeholders, CTA. Target: 200–400 words.

---

### Thumbnail Brief

`POST /v1/packaging/generate-thumbnail` — generates 3 thumbnail design concepts.

**Prompt:** `GENERATE_THUMBNAIL_PROMPT` — injects `{script}`, `{title}`, and `{selectedHook}` (resolved server-side from `videoProjectId`). Returns:
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

### Hooks Generation — not part of packaging

Hooks are their own pipeline step, collection, and endpoints (`POST /v1/hooks/generate`). The old
stateless `POST /v1/packaging/generate-hooks` route has been **removed**. Packaging resolves the
project's selected hook server-side for context; it never generates hooks. See
[Hooks Feature Spec](../hooks/spec.md).

---

### Save, List, and Retrieve

- `POST /v1/packaging/save` — persists **user edits only** (edited title/description text,
  thumbnail selection). Generated content is already written by the `generate-*` endpoints, so
  clients never round-trip it back through save. `script`/`hooks` are not accepted in the body —
  the server resolves both from the project.
- `GET /v1/packaging/list` — list all packaging for the user, ordered by `createdAt` desc
- `GET /v1/packaging/:packagingId` — get single packaging document; ownership enforced

---

## Generation Config

Each generation endpoint uses its own **responseSchema-enforced** config —
`GENERATION_CONFIG_TITLE_VARIATIONS`, `_DESCRIPTION`, `_THUMBNAIL`, `_SHORTS`. The schema-less
`GENERATION_CONFIG_PACKAGING` they once shared has been removed.

Responses are drained and parsed by `collectJson` (`src/utlils/ai.ts`), which turns the three
ways a generation can fail — stream blocked mid-flight, empty body, unparseable body — into a
**503 with a retryable message**, plus a structured log (`ai_stream_failed` / `ai_empty_response`
/ `ai_malformed_json`). It never repairs, cleans, or retries the output: malformed JSON means the
prompt or config is wrong and must be fixed there.

---

## Current Data Model

Packaging documents are saved with the client-provided fields plus server-set fields:

```typescript
{
  ...clientProvidedFields,       // whatever the client sends to /save
  accountId: string          // active channel tenancy key
  createdBy: string,             // userId from authMiddleware
  createdAt: Timestamp,          // serverTimestamp()
  itemStatuses: {                // per-item; set to "completed" by each generate-*
    title: PackagingItemStatus,  // call, and derived from content presence on save
    description: PackagingItemStatus,
    thumbnail: PackagingItemStatus,
    shorts: PackagingItemStatus,
  },
  isStale: boolean,              // true if any PACKAGING-OWNED item is "stale"
                                 // (description | thumbnail | shorts). NOT title —
                                 // see "Stale Clearing" below.
  staleReason: "script_regenerated" | "hooks_regenerated" | null,
  staleSince: Timestamp | null,
}
```

### Document ID — two paths

- **Generation path (normal):** `repo.upsertGeneratedItem` writes to a **deterministic** id —
  `doc(videoProjectId)` — inside a transaction. Persist-on-generate fires item writes
  concurrently, so a deterministic id makes concurrent first-generations converge on one
  document instead of racing two auto-id creates.
- **Save-first path (door / no prior generation):** `repo.save` creates a Firestore **auto-ID**
  document.

Always locate a document with `findByVideoProject` (a query on the `videoProjectId` field);
never assume `id === videoProjectId` on read.

### `videoProjectId` Linkage & Upsert

When `videoProjectId` is passed to `POST /save`, the service checks if a packaging document already exists for that project. If it does, the existing document is updated (upsert). If not, a new document is created. This prevents duplicate packaging documents per video project.

Pipeline sync (`linkResource` → `startStep` → `completeStep`) is awaited inside a try/catch and
is **best-effort**: the content is already persisted, so a transition failure is logged
(`pipeline_transition_failed`) and never fails the request. Direct `scriptId` or `ideaId` foreign
keys still do not exist on packaging documents.

### What a save is allowed to change

A save carries **user edits**, so it deliberately does not own document or pipeline state:

- **`itemStatuses` is written on create only.** It is derived purely from "does this field have
  content", so recomputing it on update would rewrite a `"stale"` item back to `"completed"`.
  With auto-save firing on every committed edit and every thumbnail click, that silently
  un-staled packages. Generation and regeneration own those statuses after creation.
- **Empty content fields are dropped from the payload.** Clients post the whole snapshot; one
  that hasn't hydrated yet posts `description: ""` / `thumbnail: []` / `shorts.segments: []`,
  which would wipe generated content. No endpoint or UI offers "clear this field".
- **`startStep`/`completeStep` run only when the packaging content is actually complete** —
  description, thumbnail and shorts all present, the same rule persist-on-generate uses.
  Saving is not an achievement: the Title screen auto-saves through this endpoint, and
  completing on save marked packaging (and whole projects) done with nothing generated.
- **A stale package stays stale through a save.** `completeStep` promotes `stale` straight to
  `completed`, so the transitions are skipped entirely when the stored doc is stale. Clearing
  staleness is explicit: regenerate the item, or `PATCH /:projectId/step/packaging/complete`
  ("Keep as-is"), which also clears the document's stale markers via `packagingRepo.clearStale`.

### Selection fields

`selectedTitleIndex` is set by `POST /:packagingId/select-title`, which also renames the project.
`selectedThumbnailIndex` drives the project's `thumbnailHint` (the brief shown on the dashboard
card) and is reset to `0` when thumbnails are regenerated, since the new briefs replace the ones
the old index pointed at.

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

After any `regenerateItem` completes, the service checks the **three packaging-owned** items — `description`, `thumbnail`, `shorts`. If none remain `"stale"`, the document-level stale fields are cleared: `isStale: false`, `staleReason: null`, `staleSince: null`.

**`title` is deliberately excluded from that count**, and this section used to say "all `itemStatuses`" (four items), which described a deadlock rather than a design. Since P6A, Title is its own pipeline step: its staleness lives on `pipeline.title` and is cleared by `selectTitle` / `reopenTitleStep`, not by anything in this document. Counting it here made the banner permanently undismissable — completion counted three items while un-staling counted four, so regenerating every item the Packaging screen offers still left `isStale: true` forever. The code (`packaging.service.ts` → `PACKAGING_OWNED_ITEMS`) is correct; this doc was not.

### Atomic Writes

`regenerateItem` writes both the regenerated content and the status update (`itemStatuses.<item>: "completed"`) in a single Firestore `update()` call. On AI generation failure, the item status is rolled back to its previous value.

---

## Build Status

| Feature | Status |
|---|---|
| Generate title, description, thumbnail, shorts | ✅ Built |
| Selected hook resolved server-side (from `videoProjectId`) and injected into title/description/thumbnail prompts | ✅ Built |
| Input validation (400 on missing `script`/`title`) | ✅ Built |
| Save packaging to Firestore | ✅ Built |
| `videoProjectId` linkage on save | ✅ Built |
| Ownership check on get/save | ✅ Built |
| Regenerate per item (`POST /:packagingId/regenerate/:item`) | ✅ Built |
| Export packaging (`GET /:packagingId/export`) | ✅ Built |
| Select and finalize a title (`POST /:packagingId/select-title`) | ✅ Built (P6A) |
| Stale detection (`isStale` + `staleReason` + `staleSince`) | ✅ Built |
| Per-item status tracking (`itemStatuses` map) | ✅ Built |
| Stale cascade from script/hooks regeneration | ✅ Built |
| Upsert by `videoProjectId` (prevents duplicates) | ✅ Built |
| Implicit signal capture on select/regenerate/export | ✅ Built (P6A: `TITLE_SELECTED`, `REGENERATE`, `EXPORT` events) |
| Direct `scriptId` / `ideaId` foreign keys | ❌ Not built |

---

## Related Documentation

- [Packaging API Reference](./api.md)
- [Hooks Feature Spec](../hooks/spec.md)
- [Pipeline Spec](../../product/pipeline-spec.md)
- [Product Roadmap](../../product/roadmap.md)

## Channel tenancy and roles

Content is scoped by `accountId`, resolved from verified channel membership.
`createdBy` records authorship only. Owners and editors may mutate/generate; viewers
may read and export. Member management and channel deletion require owner.
