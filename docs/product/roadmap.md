---
title: "Product Roadmap & Status"
description: "Current build state, planned E2E flow, and identified gaps"
date: 2026-02-26
last_updated: 2026-07-12
status: "final"
tags: ["product", "roadmap", "status", "gaps"]
---

# Product Roadmap & Status

This document captures where MomentumX stands today, the intended end-to-end product flow, and all identified gaps — both known and surfaced through review.

---

## Current Build State

All core features have been built as independent modules. **Nothing is integrated into a cohesive user flow yet.** The approach going forward is to ship one flow at a time — MVP-first — and expand iteratively.

| Module | Built | Integrated | Notes |
|---|---|---|---|
| Onboarding | ✅ | ❌ | Brand setup, website scraping, YouTube + competitor ingestion |
| Video Projects | ✅ | ❌ | CRUD + pipeline state machine (Sprint 2). Foundation for integration. |
| Idea / Title Generation | ✅ | ❌ | AI-generated ideas with KMeans clustering to avoid repetition (step 1); title variations at step 4 |
| Script Generation | ✅ | ❌ | Full ~10-min script, streamed via SSE |
| Hooks | ✅ | ❌ | Standalone pipeline step — `POST /v1/hooks/generate` + `POST /v1/hooks/:hooksId/select` |
| Packaging | ✅ | ❌ | Title variations, description, thumbnail brief, shorts script |

---

## The Planned E2E Flow

The full product is a pipeline, but **navigation is flexible** — the creator is not forced through a strict linear sequence. At every step, options are presented to move forward, go back, or jump to another step. The pipeline is a default path, not a locked gate.

```
Onboarding → Research → Script → Hooks → Packaging
```

### Video Projects
When a creator commits an idea from Research — or brings their own idea (`POST /v1/video-projects` accepts either `{ ideaId }` or `{ title }`) — a **video project** is created. All subsequent work — script, hooks, packaging — is tied to that project. Script generation is project-scoped (`GET /v1/scripts/stream/:projectId`), and each project owns its own script document, so multiple projects can share an idea. This gives creators a structured workspace per video rather than a disconnected collection of generated assets.

The Video Project entity is now built (Sprint 2). It holds the pipeline state machine (research → script → hooks → packaging), tracks `currentStep` and `overallStatus`, and links resources (`scriptId`, `hooksId`, `packagingId`) to the project. Integration with Research, Script, Hooks, and Packaging endpoints is the next step. See [Video Project Spec](../features/video-project/spec.md) for full schema and decisions.

### Step 1: Onboarding
Creator sets up their brand context once. MomentumX ingests:
- Brand name, niche, target audience
- YouTube channel URL → pulls top-performing titles
- Competitor channel URLs → pulls their top titles by view count
- Website URL → scrapes and extracts brand content

This context persists and personalizes every subsequent generation.

---

### Step 2: Research
The discovery and ideation phase. The creator uses Research to figure out what video to make next.

**Planned scope:**
- **Video ideas** — AI-generated video concepts personalized to niche, audience, and competitive landscape
- **Competitor analysis** — surface what competitors are publishing and what's performing well
- **Trend discovery** — what's trending in the creator's niche right now
- **Keyword / SEO data** — search volume and keyword signals to inform idea selection

**Current build:** Fully built. Video ideas (`GET /v1/ideas`), trend discovery (`GET /v1/research/trending`), competitor analysis (`GET /v1/research/competitors`), and keyword signals (`GET /v1/research/keywords`) are all live. Research data is fetched fresh from the YouTube Data API on every call — not static onboarding data.

---

### Step 3: Script
Creator selects an idea from Research and generates a full video script.

- ~10 minutes in length
- Structured for retention: Hook → Setup → Tension → Twist → Payoff → Resolution
- Written in first-person, human tone — raw and lived-in
- Streamed in real time via SSE so the creator sees it being written

**Current build:** Fully built.

---

### Step 4: Hooks
Dedicated hook generation for the video's opening seconds.

- 5 hook variations per generation
- Varied styles: question, bold claim, story teaser, contrarian, pattern interrupt
- Each hook is 1–3 sentences, written for immediate attention capture

**Current build:** Fully built as a standalone pipeline step. `POST /v1/hooks/generate` generates a 5-hook batch tied to a video project. `POST /v1/hooks/:hooksId/select` records the chosen hook index on the project (`selectedHookIndex`). No longer coupled to the Packaging module.

---

### Step 5: Packaging
All supporting assets generated from the script.

| Asset | Description |
|---|---|
| **Title variations** | 3 options using different psychological hook archetypes |
| **Description** | SEO-optimized, with visible hook before "Show More" and a CTA |
| **Thumbnail brief** | 3 visual concepts with layout, text overlay, color, and emotion guidance |
| **Shorts script** | Segmented with start/end timestamps, written for vertical video |

**Current build:** Fully built.

---

## Cross-Cutting Features

These are not phase-specific features. They ship **with every phase** and are present throughout the entire flow.

### Iteration & Refinement

Every step supports two modes of iteration:

**Implicit signal capture** — fire-and-forget telemetry:
- Project creation (`PROJECT_CREATED`)
- Hook selection (`HOOK_SELECTED`)
- Title finalization (`TITLE_SELECTED`)
- Every export (`EXPORT`)
- Every regeneration (`REGENERATE`)

**Regeneration** — creator-directed:
- Regenerate a specific item (e.g. one title out of ten)
- Regenerate all items in the current step
- Directional refinement via follow-up prompt (e.g. "make this more aggressive", "shorter", "different angle")

**Current build:** Fully built across all pipeline steps. Implicit signal capture is live; explicit like/dislike feedback has been replaced. Regeneration and export are available at all steps. Directional AI refinement (follow-up prompt — "make this shorter", "more aggressive") is not built at any step.

---

### Export

Export is available at every step — not just at the end of the pipeline. The creator can export their Research ideas, their script, their hooks, or their full packaging at any point. Export events are captured for telemetry.

Export targets to be defined (Google Docs, copy-paste formatted output, YouTube Studio are candidates).

**Current build:** Fully built across all pipeline steps. Ideas, Script, Hooks, and Packaging all have export endpoints live and capture export events. Export targets (Google Docs, YouTube Studio integration) are not yet defined.

---

## Shipping Sequence

Each phase ships as a complete, self-contained flow. A phase is not done until iteration and export are working within it.

### Phase 1: Research
**Goal:** Creator can go from onboarding to a shortlist of ideas they're confident in.

Includes:
- Competitor analysis — what competitors are publishing and what's performing
- Trend discovery — what's trending in the creator's niche right now
- Video ideas — AI-generated suggestions personalized to niche, audience, and competitive landscape
- Keyword / SEO data — search volume and keyword signals to inform idea selection
- Iteration — regenerate specific or all ideas
- Export — export selected ideas

**Build status:** Backend complete. All components are built and live:
- Video ideas — batch lifecycle (batchId, archived), regenerate-all, regenerate-one, export, implicit signal capture
- Competitor analysis — `GET /v1/research/competitors` (fresh YouTube Data API, not static onboarding data)
- Trend discovery — `GET /v1/research/trending`
- Keyword / SEO signals — `GET /v1/research/keywords`

Phase 1 is ready for front-end integration.

---

### Phase 2: Script
**Goal:** Creator can take a selected idea and generate a full, publish-ready video script.

Includes:
- Full ~10-min script structured for retention
- Real-time streaming via SSE
- Iteration — regenerate specific sections or full script
- Export — export script

**Build status:** Backend complete. Script generation, iteration (regenerate), export, and pipeline step auto-advancement are all built and live. Explicit feedback has been replaced by implicit signal capture.

---

### Phase 3: Hooks
**Goal:** Creator can generate and refine attention-grabbing opening lines for their video.

Includes:
- 5 hook variations per generation
- Varied styles: question, bold claim, story teaser, contrarian, pattern interrupt
- Iteration — regenerate hooks, select/finalize the chosen hook
- Export — export selected hooks

**Build status:** Backend complete. All components are built and live:
- `POST /v1/hooks/generate` — generates a 5-hook batch tied to a video project
- `POST /v1/hooks/:hooksId/select` — records selected hook index on the video project, captures implicit signal
- `POST /v1/hooks/:hooksId/regenerate` — regenerates hooks, cascades stale to packaging
- `GET /v1/hooks/:hooksId/export` — export hooks as plain text

---

### Phase 4: Packaging
**Goal:** Creator can generate all supporting assets needed to publish the video.

Includes:
- Title variations (3 options, different psychological hook archetypes)
- SEO-optimized description
- Thumbnail brief (3 visual concepts)
- Shorts script (segmented with timestamps)
- Iteration — regenerate specific or all assets, select/finalize chosen title
- Export — export full package

**Build status:** Backend complete. Per-item generation, regeneration, export, per-item status tracking (`itemStatuses`), stale detection (`isStale`, `staleReason`, `staleSince`), stale cascade from script/hooks regeneration, title selection/finalization (`select-title`), and upsert-by-videoProjectId are all built and live. Explicit feedback has been replaced by implicit signal capture.

---

## Identified Gaps

Gaps are grouped by when they get addressed: within a phase, or post all four phases.

### Within Phases (addressed as each phase is built)

**End-to-end integration not wired for frontend**
All backend modules are built and the video project state machine auto-advances (startStep / completeStep / linkResource wired in script, hooks, and packaging generation). No frontend integration exists yet — the UI has not been built. This is the primary remaining blocker before any phase ships as a cohesive product experience.

---

### Post Phase 4 (requires the full pipeline to be working)

**Competitor data goes stale**
Competitor channel data is fetched once at onboarding and never refreshed. If a competitor publishes a viral video, MomentumX won't surface it. Undermines the competitive intelligence pillar over time.

**No performance feedback loop**
No mechanism to feed YouTube analytics back in — CTR, retention, view count. The AI cannot get smarter about what works for a specific creator over time. Every generation starts from scratch contextually.

**Thumbnail is a brief, not an image**
The thumbnail step generates design instructions, not an actual image. Creators expect AI image generation. High user expectation gap.

**No content calendar or pipeline view**
No way to plan ahead, assign topics to dates, or track video status (idea → scripted → packaged → published). Important for creators publishing consistently.

**Packaging disconnected from script/idea** *(Partially resolved — Sprint 2/3)*
The Video Project entity holds `scriptId`, `hooksId`, and `packagingId` references, and scripts now carry `ideaId` + `videoProjectId` foreign keys (the script doc id is its own UUID, decoupled from the idea id). Packaging endpoints now resolve the selected hook server-side from the project rather than the client body. Direct `packaging → script` foreign key still does not exist — that Firestore data model gap remains.

**No hook or asset library**
Generated hooks, titles, and CTAs are not saved as reusable assets. No personal swipe file or pattern library builds over time.

---

## Open Decisions

| Decision | Status | Notes |
|---|---|---|
| Board / workspace visual model | Open | Kanban, dashboard, or another model — TBD |
| Video project lifecycle stages | ✅ Resolved | See [Pipeline Status Model](./pipeline-spec.md) |
| Batch retention policy | ✅ Resolved | Keep archived batches forever — KMeans benefits from history, no cleanup needed in Phase 0 |
| Regeneration behavior (All vs. One) | ✅ Resolved | Regenerate All = override batch (archive old), Regenerate One = slot-replace |
| Stale cascade model | ✅ Resolved | Stored as `status = "stale"` (not a boolean field), cascades downstream, creator resolves manually |
| Packaging item count | ✅ Resolved | 4 items: title, description, thumbnail, shorts (hooks moved to own step) |
| Hook selection → step completion | ✅ Resolved | Selecting a hook = completing the hooks step, stores `selectedHookIndex` (number) on the video project |
| Shorts script ownership | ✅ Resolved | Stays in Packaging permanently, no plans to separate |
| Entity naming (topic → idea) | ✅ Resolved | Step 1 = **Idea** generation; step 4 = **Title** variations. Routes, collections, types all renamed (P6A). |
| Feedback mechanism | ✅ Resolved | Explicit like/dislike endpoints removed (P6A). Replaced by implicit signal capture (events collection). |
| Packaging door | ✅ Resolved | `POST /v1/packaging/save` without `videoProjectId` lazily creates shallow project (P6A). |
| Title finalization | ✅ Resolved | New `POST /v1/packaging/:packagingId/select-title` endpoint persists selection + updates project title (P6A). |

---

## Related Documentation

- [Product Overview](./overview.md) — What MomentumX is, positioning, and future direction
- [Pipeline Status Model](./pipeline-spec.md) — Finalized status schemas, Firestore schema, and implementation order
