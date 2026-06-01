---
title: "Video Project — Feature Spec"
description: "User flow, design decisions, Firestore schema, and stale cascade rules for the Video Project entity"
date: 2026-02-27
last_updated: 2026-03-15
status: "implemented"
tags: ["feature", "video-project", "spec", "phase-0"]
---

# Video Project — Feature Spec

## Status
Phase 0 — **Implemented** (Sprint 2). All CRUD and pipeline state-machine endpoints are live.

---

## What This Feature Is

A Video Project is the central organizing entity in MomentumX. Every piece of content a creator generates — title ideas, scripts, hooks, packaging assets — belongs to a Video Project. Without this entity, the pipeline is a disconnected set of one-shot generators. With it, the pipeline becomes a managed workflow where the creator can see all their work, know where each video stands, and return to any step at any time.

This is the foundational data model for Phase 0. Research, Script, Hooks, and Packaging features all reference `videoProjectId`. Nothing else in Phase 0 should be built until this spec is locked.

---

## Key Design Decisions

### A. Creation Trigger — On Topic Selection or Own Idea

A Video Project is created either when the creator commits an AI-generated topic candidate, or when the creator brings their own idea. `POST /v1/video-projects` accepts **exactly one** of:

- `{ topicId }` — commit an existing AI candidate topic.
- `{ title }` — "add your own idea": the server creates the topic (with embedding) via `createFromTitle`, then creates the project from it.

Providing both or neither returns 400.

**Reasoning:** Committing a topic (whether AI-suggested or the creator's own) expresses intent. Creating the project at that moment captures intent immediately and ensures no orphaned topics exist without project context.

**Implication:** The frontend calls `POST /v1/video-projects` with `{ topicId }` or `{ title }`. The backend creates the project and returns its `id`. All subsequent calls (Script, Hooks, Packaging) pass that value as the `:projectId` path param.

### B. No Blank Project State

Topic selection is always Step 1. A project cannot exist without a topic. The project's `title` is set from the selected topic's title at creation.

**Conflict with pipeline-spec flag:** `pipeline-spec.md` describes Research as a step with `not_started` status, implying Research could happen inside a project created before topic selection. This spec overrides that. The project is created only after a topic is selected. Research-inside-a-project (to replace the topic) is a future feature, not Phase 0.

### C. Dashboard Fields — Minimal but Scannable

The list endpoint returns 7 fields per project: enough to identify and navigate, not the full pipeline state.

```
id, title, currentStep, overallStatus, updatedAt, createdAt, thumbnailHint
```

`thumbnailHint` is `null` until packaging is reached. Full pipeline detail is only on the single-project GET.

### D. Step Navigation — Freely Jumpable, Status Not Regressed on Review

The creator can jump to any step at any time, including completed steps. Viewing a completed step does not change its status. Only regenerating content within a step changes its status (back to `in_progress`) and triggers the stale cascade.

### E. Project Deletion — Soft Delete Only

`isDeleted: true` + `deletedAt`. Linked topic, script, hooks, and packaging documents are NOT deleted. Dashboard list filters `isDeleted == false`. Recoverable.

### F. Step Completion Mechanics

Each step completes by its own mechanic:

- **Research:** auto-completed at project creation — already done when you pick a topic.
- **Script:** auto-completed server-side as soon as the generated script is saved (no explicit "approve" action). The creator can still edit the saved script afterward.
- **Hooks:** completed when the creator selects a hook (`POST /v1/hooks/:hooksId/select`).
- **Packaging:** items complete as they are saved/regenerated on the packaging document.

The generic `PATCH /v1/video-projects/:projectId/step/:stepName/complete` endpoint remains available (idempotent), but for the Script step completion is fired automatically by the backend after save.

### G. Multiple Projects Per Topic — Supported

A creator can start multiple Video Projects on the same topic. No lock on topics — they are references only, not consumed by project creation. Each project owns its **own** script document (the script's id is a per-project `randomUUID`, not the topic id), so projects on the same topic never collide on their script. When the topic is regenerated, the stale cascade fans out to **all** projects backed by it (see Stale Cascade Rules).

---

## User Flow

### Dashboard — List of Video Projects

```
1. Creator opens MomentumX dashboard.
2. System fetches all video projects (isDeleted == false), ordered by updatedAt desc.
3. Creator sees project cards: working title, current step, status, last updated.
4. Creator clicks a card to open the project.
5. Creator is taken to the current active step.
```

### Creating a New Project (Topic Selection or Own Idea)

```
1a. Creator runs Research (POST /v1/topics/generate), then selects a topic — existing flow.
    Frontend calls POST /v1/video-projects with { topicId }.
1b. OR the creator brings their own idea.
    Frontend calls POST /v1/video-projects with { title }.
    Backend creates the topic (with embedding) via createFromTitle, then the project.
2. Backend creates the project:
   - title = topic.title
   - pipeline.research.status = "completed"
   - all other steps = "not_started"
3. Backend returns { id, title, pipeline }.
4. Frontend navigates creator to the Script step.
```

### Script Step

```
1. Creator opens Script step.
2. Frontend calls PATCH /video-projects/:projectId/step/script/start → status = "in_progress".
3. Creator generates script via GET /v1/scripts/stream/:projectId (project-scoped; topic derived from project.topicId).
4. Script saves under its own UUID → backend sets project.scriptId AND auto-completes the Script step.
5. Script step = "completed". Frontend shows "Next: Hooks".
6. Creator may still edit the saved script (PATCH /scripts/edit/:scriptId) without changing step status.
```

### Hooks Step

```
1. Creator navigates to Hooks.
2. Frontend calls PATCH /video-projects/:projectId/step/hooks/start.
3. Creator generates 5 hooks (POST /v1/hooks/generate with videoProjectId).
4. Creator selects one hook → POST /v1/hooks/:hooksId/select.
5. project.selectedHookIndex set. Hooks step = "completed".
```

### Packaging Step

```
1. Creator navigates to Packaging.
2. Frontend calls PATCH /video-projects/:projectId/step/packaging/start.
3. Creator generates assets in any order (title, description, thumbnail, shorts).
4. Each sub-item has its own status (not_started / in_progress / completed).
5. Creator marks each item done as they go.
6. Creator clicks "Complete Packaging".
7. Frontend calls PATCH /video-projects/:projectId/step/packaging/complete.
8. If all steps completed → overallStatus = "completed".
```

### Stale Cascade (Script Regenerated After Hooks Exist)

```
1. Creator completed Script and Hooks. Packaging is in_progress.
2. Creator jumps back to Script and regenerates.
3. POST /v1/scripts/:scriptId/regenerate is called.
4. ContentService.regenerateScript() calls markStale("script") server-side (fire-and-forget).
5. Backend applies cascade:
   - pipeline.hooks.status = "stale"
   - pipeline.packaging.status = "stale"
   - overallStatus = "stale"
6. Creator sees stale warning on Hooks and Packaging.
7. Creator re-does Hooks and Packaging.
```

> There is no client-callable stale endpoint. Stale cascade is triggered automatically server-side by regeneration services.

### Stale Recovery (Clearing a Stale Step)

Stale clears only by regenerating the affected step — there is no "dismiss" action. Re-completing a step recomputes `overallStatus` (it stays `"stale"` while any step is still stale, becomes `"completed"` when all steps are completed, else `"in_progress"`):

- **Packaging:** when the last stale packaging item is regenerated, `PackagingService.regenerateItem` clears the packaging document's stale flags and calls `VideoProjectService.refreshPackagingStep`, which flips `pipeline.packaging.status` `stale → completed` and recomputes `overallStatus`. Best-effort: a sync failure is logged and never fails the regeneration.
- **Script / Hooks:** re-completing these steps through their normal flow (script save, hook re-selection) clears their stale status the same way.

---

## Firestore Schema

### Collection: `videoProjects`

Document ID: Firestore auto-generated.

```typescript
interface VideoProject {
  id: string;                     // Firestore auto-generated doc ID
  userId: string;                 // from req.userId
  title: string;           // from topic.title at creation; can be renamed

  topicId: string;                // always set — required for creation
  scriptId: string | null;        // set when script is saved
  hooksId: string | null;         // set when hooks are saved
  selectedHookIndex: number | null; // set when creator selects a hook via POST /v1/hooks/:hooksId/select
  packagingId: string | null;     // set when packaging is saved

  pipeline: {
    research: StepState;
    script: StepState;
    hooks: StepState;
    packaging: StepState;  // per-item status lives on the packaging document, not here
  };

  overallStatus: "in_progress" | "completed" | "stale";
  currentStep: "research" | "script" | "hooks" | "packaging";

  isDeleted: boolean;
  deletedAt: Timestamp | null;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface StepState {
  status: "not_started" | "in_progress" | "completed" | "stale";
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
}
```

### Fields Set at Creation

```
id                auto-id
userId            req.userId
title      from topic.title
topicId           from request body
scriptId             null
hooksId              null
selectedHookIndex    null
packagingId          null
overallStatus     "in_progress"
currentStep       "research"
isDeleted         false
deletedAt         null
createdAt         serverTimestamp()
updatedAt     serverTimestamp()
pipeline.research   { status: "completed", startedAt: null, completedAt: serverTimestamp() }
pipeline.script     { status: "not_started", startedAt: null, completedAt: null }
pipeline.hooks      { status: "not_started", startedAt: null, completedAt: null }
pipeline.packaging  { status: "not_started", startedAt: null, completedAt: null }
```

### Indexes Required

```
Composite index 1: userId ASC, isDeleted ASC, updatedAt DESC
  → powers dashboard list query

Composite index 2: userId ASC, isDeleted ASC, overallStatus ASC
  → powers filtered list (e.g., "show only in_progress")
```

### Changes to Existing Collections

**`topics`** — no change. Project holds `topicId` as a reference. Topics remain reusable across projects.

**`scripts`** — the script document id is its own `randomUUID` (no longer the topic id). It stores `topicId` and `videoProjectId` foreign keys, both set when the script is saved for a project. Older documents may use the legacy `id == topicId` scheme and lack these FKs; do not backfill.

**`packaging`** — add `projectId: string | null`. Resolves the long-standing data model gap (packaging disconnected from topics/scripts). `null` on pre-existing documents. Do not backfill.

---

## Stale Cascade Rules

Applied server-side. Frontend reads stale state from the project's pipeline object — never computes it.

| Step regenerated | Steps that become stale |
|---|---|
| Research (topic changed, Regenerate All) | script, hooks, packaging — on **every** project backed by the topic |
| Script | hooks, packaging |
| Hooks | packaging |
| Packaging | none (leaf node) |

Only update steps that are NOT `not_started` — stale is meaningless on unvisited steps.

For Research (Regenerate All), the cascade fans out to all projects on each archived topic: `ContentService.regenerateAll` → `getProjectsByTopic(topic.id)` → `findByTopicId`, then `markStale` + `markPackagingDocumentStale` per project. A topic can back multiple projects, so keying off a single `topic.videoProjectId` would miss the others.

---

## Out of Scope (Phase 0)

- Replacing the topic on an existing project
- Collaborator access / multi-user projects
- Project archiving (distinct from soft delete)
- Project templates

---

## Related Documentation

- [Video Project API Reference](./api.md)
- [Pipeline Spec](../../product/pipeline-spec.md)
- [Product Roadmap](../../product/roadmap.md)
