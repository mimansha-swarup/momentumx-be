---
title: "Product Roadmap & Status"
description: "Current build state, planned E2E flow, and identified gaps"
date: 2026-02-26
last_updated: 2026-02-27
status: "draft"
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
| Topic / Title Generation | ✅ | ❌ | AI-generated titles with KMeans clustering to avoid repetition |
| Script Generation | ✅ | ❌ | Full ~10-min script, streamed via SSE |
| Hooks | ✅ | ❌ | Currently lives inside Packaging module |
| Packaging | ✅ | ❌ | Title variations, description, thumbnail brief, shorts script |

---

## The Planned E2E Flow

The full product is a pipeline, but **navigation is flexible** — the creator is not forced through a strict linear sequence. At every step, options are presented to move forward, go back, or jump to another step. The pipeline is a default path, not a locked gate.

```
Onboarding → Research → Script → Hooks → Packaging
```

### Video Projects
When a creator selects a topic from Research, a **video project** is created for that topic. All subsequent work — script, hooks, packaging — is tied to that project. This gives creators a structured workspace per video rather than a disconnected collection of generated assets.

The video project lifecycle (formal stages, statuses, board view) is yet to be defined. See [Product Overview — Future Direction](./overview.md#future-direction).

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
- **Title ideas** — AI-generated YouTube title suggestions personalized to niche, audience, and competitive landscape
- **Competitor analysis** — surface what competitors are publishing and what's performing well
- **Trend discovery** — what's trending in the creator's niche right now
- **Keyword / SEO data** — search volume and keyword signals to inform topic selection

**Current build:** Title idea generation is built. Competitor analysis uses onboarding data (static). Trend discovery and keyword/SEO data are not yet built.

---

### Step 3: Script
Creator selects a title from Research and generates a full video script.

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

**Current build:** Built, currently lives inside the Packaging module. Will become its own step in the integrated flow.

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

**Feedback signals** — low friction, no typing required:
- Thumbs up / thumbs down on individual generated items
- Save / favourite specific outputs

**Regeneration** — creator-directed:
- Regenerate a specific item (e.g. one title out of ten)
- Regenerate all items in the current step
- Directional refinement via follow-up prompt (e.g. "make this more aggressive", "shorter", "different angle")

**Current build:** Not yet built. Editing is manual only (no AI refinement loop).

---

### Export

Export is available at every step — not just at the end of the pipeline. The creator can export their Research topics, their script, their hooks, or their full packaging at any point.

Export targets to be defined (Google Docs, copy-paste formatted output, YouTube Studio are candidates).

**Current build:** Not yet built.

---

## Shipping Sequence

Each phase ships as a complete, self-contained flow. A phase is not done until iteration and export are working within it.

### Phase 1: Research
**Goal:** Creator can go from onboarding to a shortlist of title ideas they're confident in.

Includes:
- Competitor analysis — what competitors are publishing and what's performing
- Trend discovery — what's trending in the creator's niche right now
- Title ideas — AI-generated suggestions personalized to niche, audience, and competitive landscape
- Keyword / SEO data — search volume and keyword signals to inform topic selection
- Iteration — feedback signals + regenerate specific or all topics
- Export — export selected topics

**Build status:** Title ideas built. Competitor analysis uses static onboarding data. Trend discovery and keyword/SEO not built.

---

### Phase 2: Script
**Goal:** Creator can take a selected topic and generate a full, publish-ready video script.

Includes:
- Full ~10-min script structured for retention
- Real-time streaming via SSE
- Iteration — feedback signals + regenerate specific sections or full script
- Export — export script

**Build status:** Core script generation built. Iteration and export not built.

---

### Phase 3: Hooks
**Goal:** Creator can generate and refine attention-grabbing opening lines for their video.

Includes:
- 5 hook variations per generation
- Varied styles: question, bold claim, story teaser, contrarian, pattern interrupt
- Iteration — feedback signals + regenerate specific or all hooks
- Export — export selected hooks

**Build status:** Built, currently inside Packaging module. Needs to be extracted into its own flow.

---

### Phase 4: Packaging
**Goal:** Creator can generate all supporting assets needed to publish the video.

Includes:
- Title variations (3 options, different psychological hook archetypes)
- SEO-optimized description
- Thumbnail brief (3 visual concepts)
- Shorts script (segmented with timestamps)
- Iteration — feedback signals + regenerate specific or all assets
- Export — export full package

**Build status:** Core generation built. Iteration and export not built.

---

## Identified Gaps

Gaps are grouped by when they get addressed: within a phase, or post all four phases.

### Within Phases (addressed as each phase is built)

**Research is partially built**
Trend discovery and keyword/SEO data have no backend foundation yet. These are required for Phase 1 to ship complete.

**No iteration or refinement**
Feedback signals and regeneration are not built at any step. Required before any phase ships.

**No export**
No export exists at any step. Required before any phase ships.

**Hooks lives inside Packaging**
Hooks need to be extracted from the Packaging module and rebuilt as a standalone flow for Phase 3.

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

**Packaging disconnected from script/topic**
The data model has no explicit link between a saved packaging and the script or topic it came from. Will create fragmentation and UX debt as the library grows.

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
| Stale cascade model | ✅ Resolved | Boolean flag, cascades downstream, creator resolves manually |
| Packaging item count | ✅ Resolved | 4 items: title, description, thumbnail, shorts (hooks moved to own step) |
| Hook selection → step completion | ✅ Resolved | Selecting a hook = completing the hooks step, stores `selectedHookId` on project |
| Shorts script ownership | ✅ Resolved | Stays in Packaging permanently, no plans to separate |

---

## Related Documentation

- [Product Overview](./overview.md) — What MomentumX is, positioning, and future direction
- [Pipeline Status Model](./pipeline-spec.md) — Finalized status schemas, Firestore schema, and implementation order
