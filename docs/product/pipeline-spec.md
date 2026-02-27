---
title: "Pipeline Status Model"
description: "Finalized spec for video project status tracking, step state machines, regeneration behavior, stale cascade, and Firestore schema"
date: 2026-02-27
status: "final"
tags: ["product", "pipeline", "status", "schema", "video-project"]
---

# Pipeline Status Model

Finalized spec for how status is tracked across the MomentumX pipeline. All decisions here are locked — do not change without a product discussion.

---

## The Pipeline

```
Research → Script → Hooks → Packaging
```

**Strictly sequential.** Each step depends on the data output of the previous:

- Script requires: selected topic
- Hooks requires: script
- Packaging requires: script + title + selectedHook

There is no shortcut path from Research to Packaging — the data dependencies enforce the order.

---

## 3-Level Status Tracking

Status exists at three levels simultaneously:

```
Level 1: Dashboard          — all video projects at a glance
Level 2: Per-video tracker  — which step the video is currently at, overall progress
Level 3: Per-step status    — what's happening inside the current step
```

### Level 1 — Dashboard

Shows all of the creator's video projects. Each row shows:
- Video working title
- Current pipeline step (Research / Script / Hooks / Packaging)
- Top-level status (In Progress / Needs Review / Done)

### Level 2 — Per-video Tracker

Inside a single video project. Shows the four pipeline steps as a progress indicator. Each step shows whether it's completed, in progress, or not started.

The creator can navigate back to any completed step to review or regenerate content.

### Level 3 — Per-step Status

What's happening inside an individual step. State machine per step — see schemas below.

---

## Step State Machines

### Research Step

| Status | Meaning |
|---|---|
| `not_started` | No generation has run |
| `generating` | AI is generating topic ideas |
| `in_review` | Generation complete, awaiting creator selection |
| `completed` | Creator has selected a topic |

**Trigger table:**

| Action | Transition |
|---|---|
| Creator opens Research for first time | `not_started` → `generating` |
| Generation finishes | `generating` → `in_review` |
| Creator selects a topic | `in_review` → `completed` |
| Creator regenerates (Regenerate All) | `completed` → `generating` |
| Creator regenerates (Regenerate All) | `in_review` → `generating` |

**Note on stale:** If Script is regenerated, Research step itself is NOT marked stale. Research is upstream — Script being redone doesn't change the topic decision.

---

### Script Step

| Status | Meaning |
|---|---|
| `not_started` | No script generated yet |
| `generating` | Script is streaming |
| `in_review` | Script complete, creator reviewing |
| `completed` | Creator has marked the script done |

**Trigger table:**

| Action | Transition |
|---|---|
| Creator initiates script generation | `not_started` → `generating` |
| Stream ends | `generating` → `in_review` |
| Creator marks script done | `in_review` → `completed` |
| Creator regenerates | any → `generating` |

**Stale:** If script is regenerated while Hooks or Packaging exist downstream, those steps are marked `stale: true`.

---

### Hooks Step

| Status | Meaning |
|---|---|
| `not_started` | No hooks generated yet |
| `generating` | AI generating hooks |
| `in_review` | Hooks ready, creator reviewing |
| `completed` | Creator has selected a hook |

**Trigger table:**

| Action | Transition |
|---|---|
| Creator opens Hooks | `not_started` → `generating` |
| Generation finishes | `generating` → `in_review` |
| Creator selects a hook | `in_review` → `completed` |
| Creator regenerates | any → `generating` |

**Completion mechanic:** Selecting a hook = completing the hooks step. The selected hook ID is stored on the video project as `selectedHookId`. This feeds the Packaging step.

**Stale:** If hooks are regenerated while Packaging exists downstream, Packaging is marked `stale: true`.

---

### Packaging Step

Each packaging item has its own independent status. The step itself has no single top-level status — it's derived from the states of its items.

**Packaging items:**
- Title variations
- Description
- Thumbnail brief
- Shorts script

**Per-item status:**

| Status | Meaning |
|---|---|
| `not_started` | Not yet generated |
| `generating` | AI generating |
| `in_review` | Ready, creator reviewing |
| `completed` | Creator marked this item done |

**Nothing auto-advances to `completed`.** Items go from `generating` → `in_review` and wait for explicit creator action.

**Trigger table (per item):**

| Action | Transition |
|---|---|
| Creator triggers generation | `not_started` → `generating` |
| Generation finishes | `generating` → `in_review` |
| Creator marks item done | `in_review` → `completed` |
| Creator regenerates item | `completed` → `generating` |
| Creator regenerates item | `in_review` → `generating` |

---

## Stale Model

Stale is a **boolean flag overlaid on a step** — it is not a separate status value.

```
step.status = "completed"
step.stale = true   // downstream change invalidated this step's output context
```

### Stale Cascade Rules

| What changes | What goes stale |
|---|---|
| Script regenerated | Hooks step, Packaging step |
| Hook selection changes | Packaging step |
| Research topic changes (Regenerate All) | Script step, Hooks step, Packaging step |

### Stale Resolution

When a creator visits a stale step, the UI warns them:
- "This was generated with an older version of your script. Regenerate to update."

Creator options:
- Regenerate (clears stale, re-runs generation with new context)
- Keep as-is (stale flag cleared — creator acknowledged and accepted the content)

---

## Regeneration Behavior

### Regenerate All

Replaces the entire current batch of generated items. Old batch is **archived** (not deleted). Used when the creator wants a completely fresh set of ideas.

- Triggers: `any status` → `generating`
- Old items: `archived: true` on all documents in the old batch
- New batch gets a new `batchId`
- Stale cascade fires on downstream steps

### Regenerate One

Replaces a single item in the current batch (slot-replace). The slot position is preserved — the new item appears in the same position as the one being replaced.

- Triggers: that item's status → `generating`
- Other items in batch: unaffected
- No batch ID change
- Stale cascade: does NOT fire (same step, same item slot)

---

## Batch Retention Policy

**Decision: Keep archived batches forever (no cleanup in Phase 0).**

Rationale:
1. **KMeans clustering actively benefits from archived batches.** `getAllTopicTitles()` queries all topic documents for a user — including archived ones. More historical titles = better clustering = less repetitive suggestions in future generations.
2. **No users yet.** Storage cost is not a real concern at current scale.
3. **No cleanup logic needed.** Anything beyond "keep forever" requires TTLs, batch counters, or Cloud Functions — all out of scope for Phase 0.
4. **Easily revisited.** Add `expiresAt` or a cleanup job when it becomes a real problem (thousands of users, tens of thousands of archived topics per user).

---

## Concurrent Video Projects

A creator can have multiple video projects active simultaneously. Each video project is independent — status transitions on one do not affect any other. There is no cross-project KMeans context — clustering is already per-user globally.

---

## Firestore Schema

### New Collection: `videoProjects`

```
videoProjects/{videoProjectId}
  id: string                  // Firestore auto-ID
  userId: string              // owner — always filter by this first
  title: string               // working title (from selected topic)
  topicId: string             // ref to topics collection
  scriptId: string | null     // ref to scripts collection
  selectedHookId: string | null  // ref to hooks collection

  pipeline: {
    research: {
      status: "not_started" | "generating" | "in_review" | "completed"
      stale: boolean
    }
    script: {
      status: "not_started" | "generating" | "in_review" | "completed"
      stale: boolean
    }
    hooks: {
      status: "not_started" | "generating" | "in_review" | "completed"
      stale: boolean
    }
    packaging: {
      title:       { status: PackagingItemStatus, stale: boolean }
      description: { status: PackagingItemStatus, stale: boolean }
      thumbnail:   { status: PackagingItemStatus, stale: boolean }
      shorts:      { status: PackagingItemStatus, stale: boolean }
    }
  }

  createdAt: Timestamp       // server-side
  updatedAt: Timestamp       // server-side
```

### New Collection: `hooks`

```
hooks/{hookId}
  id: string                 // UUID
  videoProjectId: string
  userId: string
  batchId: string            // groups hooks generated in the same run
  hooks: string[]            // 5 hook variations
  archived: boolean          // true when batch superseded by Regenerate All
  createdAt: Timestamp
```

### Updated: `topics`

Add to existing topic documents:
```
  archived: boolean          // true when batch superseded by Regenerate All
  batchId: string            // groups topics from the same generation run
  videoProjectId: string | null  // set when creator selects this topic
```

### Updated: `scripts`

Add to existing script documents:
```
  videoProjectId: string | null
  stale: boolean
```

### Updated: `packaging`

Add to existing packaging documents:
```
  videoProjectId: string | null
  stale: boolean
  itemStatuses: {
    title:       PackagingItemStatus
    description: PackagingItemStatus
    thumbnail:   PackagingItemStatus
    shorts:      PackagingItemStatus
  }
```

---

## Backend Implementation Order

Phase 0 is the prerequisite for all pipeline-aware features:

1. Add `videoProjects` collection and `Collection.VIDEO_PROJECTS` enum entry
2. Add `hooks` collection and `Collection.HOOKS` enum entry
3. Create `VideoProjectRepository` — CRUD for `videoProjects`
4. Create `HooksRepository` — CRUD for `hooks`
5. Create `VideoProjectService` — orchestration (create project when topic selected, status transitions, stale cascade)
6. Create `HooksService` — hook generation (extract from packaging service)
7. Add `videoProjectId`, `archived`, `batchId` fields to `topics` and `scripts` write paths
8. Add `videoProjectId`, `stale`, `itemStatuses` fields to `packaging` write paths
9. Add new routes: `/v1/video-projects`, `/v1/hooks`

Do not begin Phase 0 implementation until API contracts are formally defined by the Product Designer.

---

## Related Documentation

- [Product Overview](./overview.md)
- [Product Roadmap](./roadmap.md)
