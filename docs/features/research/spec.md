---
title: "Research — Feature Spec"
description: "User flow, states, regeneration behavior, and edge cases for the Research step"
status: "implemented"
last_updated: 2026-03-17
tags: ["feature", "research", "topics", "spec"]
---

# Research — Feature Spec

The Research step is the entry point of the MomentumX pipeline. The creator uses it to discover what video to make next — generating AI-powered title ideas personalized to their channel, niche, and competitive landscape.

---

## Overview

| | |
|---|---|
| **Pipeline position** | Step 1 of 4 |
| **Input** | User's onboarding data (channel, competitors, website, niche, audience) |
| **Output** | A selected topic that unlocks the Script step |
| **Blocks** | All downstream steps (Script → Hooks → Packaging) depend on a selected topic |

---

## User Flow

### First-time (no existing topics)

1. Creator opens the Research step.
2. System shows an empty state with a **Generate Ideas** CTA.
3. Creator clicks Generate Ideas.
4. System generates 10 title ideas using the creator's channel and competitor context.
5. Ideas are displayed as cards — status transitions to `in_review`.
6. Creator reviews the 10 ideas.
7. Creator selects one → a **video project** is created, status transitions to `completed`.
8. Creator is taken to the Script step with the selected topic pre-loaded.

### Returning (topics already exist)

1. Creator opens the Research step.
2. System loads the most recent active batch of topic cards.
3. If a topic is already selected (step is `completed`), the selected card is highlighted.
4. Creator can select a different topic from the current batch (replaces current selection).
5. Creator can regenerate the full batch (Regenerate All).
6. Creator can replace a single card (Regenerate One).

---

## States & Transitions

The Research step follows this state machine on the video project.

```
not_started → generating → in_review → completed
```

| Status | Meaning | What the UI shows |
|---|---|---|
| `not_started` | No generation has run | Empty state, Generate Ideas CTA |
| `generating` | AI is generating ideas | Loading state, "Generating your ideas..." |
| `in_review` | Generation complete, awaiting selection | 10 topic cards, all selectable |
| `completed` | Creator has selected a topic | Selected card highlighted, proceed to Script unlocked |

**Transition triggers:**

| Action | From | To |
|---|---|---|
| Creator clicks Generate Ideas | `not_started` | `generating` |
| Generation completes | `generating` | `in_review` |
| Creator selects a topic | `in_review` | `completed` |
| Creator clicks Regenerate All | `in_review` | `generating` |
| Creator clicks Regenerate All | `completed` | `generating` |
| Creator clicks Regenerate One (single slot) | any | that slot regenerates; step status unchanged |

**Stale note:** Research is never marked stale by downstream changes. Research is upstream — regenerating a script or hooks does not change the topic selection.

---

## Personalization Context

Every generation uses the creator's onboarding data:

| Context used | Where it comes from |
|---|---|
| Brand name, niche, target audience | Onboarding form |
| Creator's own top-performing titles | YouTube Data API (fetched at onboarding) |
| Competitor top titles | YouTube Data API (fetched at onboarding) |
| Website brand voice | Scraped at onboarding |

**Known gap:** Competitor data is fetched once at onboarding and never refreshed. If a competitor publishes a viral video after onboarding, MomentumX will not surface it. See roadmap for the data refresh plan.

---

## Repetition Avoidance (KMeans)

To prevent the AI from suggesting titles it has suggested before, MomentumX runs KMeans clustering on all previously generated topics for the user before each generation.

- All past topic titles (including archived batches) are fetched.
- Titles are clustered by semantic similarity using their vector embeddings.
- Representative titles from each cluster are passed to the AI prompt as "Avoid these."
- This ensures each generation explores new idea space.

**Why archived batches are included:** Archived batches are kept forever and included in the clustering data. More historical data = better coverage of already-explored ideas = less repetition over time. See [batch retention policy](../../product/pipeline-spec.md#batch-retention-policy).

---

## Regeneration Behavior

### Regenerate All

Creates a completely fresh batch of 10 topic ideas. Old batch is archived, not deleted.

- Old topics: `archived: true` on all documents in the old batch.
- New topics get a new `batchId`.
- KMeans clustering includes the newly archived batch for the next generation.
- **Stale cascade:** If a video project has a selected topic from the old batch, the Script, Hooks, and Packaging steps are marked `stale: true`. The video project is not deleted — the stale warning prompts the creator to take action.

### Regenerate One

Replaces a single topic card in the current batch. The slot position is preserved.

- Only that one document is replaced.
- `batchId` stays the same.
- No stale cascade — the step-level status is unaffected.
- If the replaced card was the selected topic, the selection is cleared and step reverts to `in_review`.

---

## Output: Topic Document Shape

Each generated topic is saved to Firestore with:

```
{
  id: string                   // UUID
  title: string                // AI-generated YouTube title
  createdBy: string            // userId
  createdAt: Timestamp         // server-side
  isScriptGenerated: boolean   // true once a script has been generated for this topic
  embedding: number[]          // vector embedding (gemini-embedding-001) for KMeans
  batchId: string              // identifies the generation batch
  archived: boolean            // true if this topic was superseded by Regenerate All
  videoProjectId: string | null // set when this topic is linked to a video project
  userFeedback: "like" | "dislike" | null  // per-topic feedback signal
}
```

---

## Edge Cases & Error States

| Scenario | Behavior |
|---|---|
| Generation fails (Gemini error) | Error response returned. Status stays `not_started` or `in_review`. Creator can retry. |
| All generated titles fail embedding | Titles where embedding fails are silently dropped from the batch. If zero succeed, a "Unable to generate at the moment" error is returned. |
| Creator has no onboarding data | Generation will produce generic output. No explicit error — this is a product gap to address with onboarding enforcement. |
| Creator regenerates while a video project has a selected topic | Old batch is archived, selected topic is stale-cascaded to downstream steps (Script, Hooks, Packaging). Creator is warned. |
| Creator selects a topic from an archived batch | Not currently prevented. Will need a guard once video project model ships. |

---

## Out of Scope (Current Build)

These are planned for future phases but explicitly not part of the current Research build:

| Feature | Notes |
|---|---|
| Topic refinement via follow-up prompt | "Make these more aggressive" style iteration. Not built. |
| Live competitor data refresh | Refreshing competitor channel data beyond onboarding. Not built. |

---

## Build Status

| Capability | Status | Notes |
|---|---|---|
| Generate 10 topic ideas | ✅ Built | `POST /v1/topics/generate` |
| Save topics to Firestore | ✅ Built | Batch write with embeddings |
| Paginated topic list | ✅ Built | `GET /v1/topics` |
| Edit a topic title | ✅ Built | `PATCH /v1/topics/edit/:topicId` |
| KMeans repetition avoidance | ✅ Built | Runs before every generation |
| Regenerate All | ✅ Built | `POST /v1/topics/regenerate-all` |
| Regenerate One (slot-replace) | ✅ Built | `POST /v1/topics/:topicId/regenerate` |
| Per-topic feedback (like/dislike) | ✅ Built | `PATCH /v1/topics/:topicId/feedback` |
| Export topics | ✅ Built | `GET /v1/topics/export` |
| `archived` + `batchId` fields on topics | ✅ Built | Set on generation |
| Stale cascade on Regenerate All | ✅ Built | Marks downstream video project steps stale |
| Trend discovery | ✅ Built | `GET /v1/research/trending` |
| Competitor performance analysis | ✅ Built | `GET /v1/research/competitors` |
| Keyword / SEO data | ✅ Built | `GET /v1/research/keywords` |
| Video project creation on topic selection | ✅ Built — handled by the video projects module (`POST /v1/video-projects`) |

---

## Related Documentation

- [Pipeline Status Model](../../product/pipeline-spec.md) — Full state machine spec and Firestore schema
- [Research API Contract](./api.md) — Endpoint reference
- [Product Roadmap](../../product/roadmap.md) — Phase timeline
