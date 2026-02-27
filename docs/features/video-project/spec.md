---
title: "Video Project — Feature Spec"
description: "User flow, design decisions, Firestore schema, and stale cascade rules for the Video Project entity"
date: 2026-02-27
last_updated: 2026-02-27
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

### A. Creation Trigger — Automatic on Topic Selection

A Video Project is created the moment the creator selects a topic from Research results. There is no explicit "Create Project" button.

**Reasoning:** Selecting a topic already expresses intent. Creating the project at that moment captures intent immediately, keeps the UI simple, and ensures no orphaned topics exist without project context.

**Implication:** When a topic is selected, the frontend calls `POST /v1/video-projects` with `{ topicId }`. The backend creates the project and returns `projectId`. All subsequent calls (Script, Hooks, Packaging) include `projectId`.

### B. No Blank Project State

Topic selection is always Step 1. A project cannot exist without a topic. The project's `workingTitle` is set from the selected topic's title at creation.

**Conflict with pipeline-spec flag:** `pipeline-spec.md` describes Research as a step with `not_started` status, implying Research could happen inside a project created before topic selection. This spec overrides that. The project is created only after a topic is selected. Research-inside-a-project (to replace the topic) is a future feature, not Phase 0.

### C. Dashboard Fields — Minimal but Scannable

The list endpoint returns 7 fields per project: enough to identify and navigate, not the full pipeline state.

```
projectId, workingTitle, currentStep, overallStatus, lastUpdatedAt, createdAt, thumbnailHint
```

`thumbnailHint` is `null` until packaging is reached. Full pipeline detail is only on the single-project GET.

### D. Step Navigation — Freely Jumpable, Status Not Regressed on Review

The creator can jump to any step at any time, including completed steps. Viewing a completed step does not change its status. Only regenerating content within a step changes its status (back to `in_progress`) and triggers the stale cascade.

### E. Project Deletion — Soft Delete Only

`isDeleted: true` + `deletedAt`. Linked topic, script, hooks, and packaging documents are NOT deleted. Dashboard list filters `isDeleted == false`. Recoverable.

### F. Script Step Completion — Explicit "Use This Script" Action

The Script step (and Hooks, Packaging) are completed by an explicit user action. Moving to the next step does NOT auto-complete the previous step.

**Research exception:** Research is auto-completed at project creation — it's already done when you pick a topic.

**API mechanic:** `PATCH /v1/video-projects/:projectId/step/script/complete`

### G. Multiple Projects Per Topic — Allowed

A creator can start multiple Video Projects using the same topic. No lock on topics. Topics are references only — not consumed or modified by project creation.

---

## User Flow

### Dashboard — List of Video Projects

```
1. Creator opens MomentumX dashboard.
2. System fetches all video projects (isDeleted == false), ordered by lastUpdatedAt desc.
3. Creator sees project cards: working title, current step, status, last updated.
4. Creator clicks a card to open the project.
5. Creator is taken to the current active step.
```

### Creating a New Project (Topic Selection)

```
1. Creator runs Research (GET /v1/content/stream/topics) — existing flow.
2. Creator selects a topic.
3. Frontend calls POST /v1/video-projects with { topicId }.
4. Backend creates the project:
   - workingTitle = topic.title
   - pipeline.research.status = "completed"
   - all other steps = "not_started"
5. Backend returns { projectId, workingTitle, pipeline }.
6. Frontend navigates creator to the Script step.
```

### Script Step

```
1. Creator opens Script step.
2. Frontend calls PATCH /video-projects/:projectId/step/script/start → status = "in_progress".
3. Creator generates script (existing SSE endpoint, now includes projectId).
4. Script saves → backend sets project.scriptId.
5. Creator edits, iterates.
6. Creator clicks "Use This Script".
7. Frontend calls PATCH /video-projects/:projectId/step/script/complete.
8. Script step = "completed". Frontend shows "Next: Hooks".
```

### Hooks Step

```
1. Creator navigates to Hooks.
2. Frontend calls PATCH /video-projects/:projectId/step/hooks/start.
3. Creator generates 5 hooks (POST /v1/hooks/generate with videoProjectId).
4. Creator selects one hook → POST /v1/hooks/:hookId/select.
5. project.selectedHookId set. Hooks step = "completed".
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
3. Frontend calls PATCH /video-projects/:projectId/step/script/stale.
4. Backend applies cascade:
   - pipeline.hooks.status = "stale"
   - pipeline.packaging.status = "stale"
   - overallStatus = "in_progress"
5. Creator sees stale warning on Hooks and Packaging.
6. Creator re-does Hooks and Packaging.
```

---

## Firestore Schema

### Collection: `videoProjects`

Document ID: Firestore auto-generated.

```typescript
interface VideoProject {
  projectId: string;              // same as Firestore doc ID, stored for queries
  userId: string;                 // from req.userId
  workingTitle: string;           // from topic.title at creation; can be renamed

  topicId: string;                // always set — required for creation
  scriptId: string | null;        // set when script is saved
  hooksId: string | null;         // set when hooks are saved
  packagingId: string | null;     // set when packaging is saved

  pipeline: {
    research: StepState;
    script: StepState;
    hooks: StepState;
    packaging: PackagingStepState;
  };

  overallStatus: "in_progress" | "completed" | "stale";
  currentStep: "research" | "script" | "hooks" | "packaging";

  isDeleted: boolean;
  deletedAt: Timestamp | null;

  createdAt: Timestamp;
  lastUpdatedAt: Timestamp;
}

interface StepState {
  status: "not_started" | "in_progress" | "completed" | "stale";
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
}

interface PackagingStepState extends StepState {
  items: {
    titles:      "not_started" | "in_progress" | "completed";
    description: "not_started" | "in_progress" | "completed";
    thumbnail:   "not_started" | "in_progress" | "completed";
    shorts:      "not_started" | "in_progress" | "completed";
  };
}
```

### Fields Set at Creation

```
projectId         auto-id
userId            req.userId
workingTitle      from topic.title
topicId           from request body
scriptId          null
hooksId           null
packagingId       null
overallStatus     "in_progress"
currentStep       "research"
isDeleted         false
deletedAt         null
createdAt         serverTimestamp()
lastUpdatedAt     serverTimestamp()
pipeline.research   { status: "completed", startedAt: null, completedAt: serverTimestamp() }
pipeline.script     { status: "not_started", startedAt: null, completedAt: null }
pipeline.hooks      { status: "not_started", startedAt: null, completedAt: null }
pipeline.packaging  { status: "not_started", startedAt: null, completedAt: null,
                      items: { titles: "not_started", description: "not_started",
                               thumbnail: "not_started", shorts: "not_started" } }
```

### Indexes Required

```
Composite index 1: userId ASC, isDeleted ASC, lastUpdatedAt DESC
  → powers dashboard list query

Composite index 2: userId ASC, isDeleted ASC, overallStatus ASC
  → powers filtered list (e.g., "show only in_progress")
```

### Changes to Existing Collections

**`topics`** — no change. Project holds `topicId` as a reference. Topics remain reusable across projects.

**`scripts`** — add `projectId: string | null`. Set when script is saved for a project. `null` on documents created before video projects existed. Do not backfill.

**`packaging`** — add `projectId: string | null`. Resolves the long-standing data model gap (packaging disconnected from topics/scripts). `null` on pre-existing documents. Do not backfill.

---

## Stale Cascade Rules

Applied server-side. Frontend reads stale state from the project's pipeline object — never computes it.

| Step regenerated | Steps that become stale |
|---|---|
| Research (topic changed) | script, hooks, packaging |
| Script | hooks, packaging |
| Hooks | packaging |
| Packaging | none (leaf node) |

Only update steps that are NOT `not_started` — stale is meaningless on unvisited steps.

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
