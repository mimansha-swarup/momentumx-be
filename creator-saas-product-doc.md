# MomentumX — Product Doc

> Living document. Updated as we discuss. Last updated: 2026-07-07
> Repo: github.com/mimansha-swarup/momentumx-be (backend + /docs)
> **Status:** all product decisions closed except ONE — the growth/distribution
> mechanic (§7, §9). Full decision log in §9.

**"Trello for Creators — with AI built in."** A YouTube-native creator OS: every
video is a project that moves through a structured, context-aware AI pipeline
from idea to publish-ready.

---

## At a Glance (read this first)

- **What:** MomentumX — an AI YouTube creator workflow OS. A context-aware pipeline
  that takes a creator from **idea → publish-ready** (title, script, hooks, thumbnail,
  description, Shorts), all tuned to _their_ channel.
- **Who (ICP):** growth-stage (1k–50k) creators in **business / finance / AI /
  productivity / educational** (talking-head) niches.
- **Core model:** _Projects are the container, Tools are the doors_ (§0). Every
  action lives in a Video Project; users can enter via any tool and are guided
  through the pipeline.
- **Pipeline:** `Idea → Script → Hooks → Title/Packaging` (+ Thumbnail).
  **Guided-jumpable** — a curated next-step CTA, but any order allowed.
- **Free vs paid:** free doors = **Idea** + limited watermarked **Thumbnail** + **one
  full project**; paid ($9/mo at launch) = the **connected workflow**, unlimited text,
  metered images. Conversion = the free-project wall.
- **Launch:** the **whole product at once**. Backend + React frontend already exist;
  the one genuinely net-new, critical-path build is **thumbnail image generation**.
- **Full v1 engineering checklist:** §4.1. **Decision log:** §9. **One open
  question:** the growth/distribution mechanic (§7).

---

## 0. Core Architecture Decision — DECIDED: "Projects are the container, Tools are the doors"

Resolves pipeline-first vs tools-first. **Not an either/or** — a standalone tool
use is just a pipeline entered late and exited early.

- **Everything happens inside a Video Project** → keeps the whole moat (context
  injection, history, stale cascade, continuity). Nothing built is discarded.
- **A user can start from any door.** Using a tool without a project silently
  spins up a lightweight/shallow project behind it. User feels "one tool";
  we get a project.
- **Every tool output nudges into the next step** → organic taster → pipeline →
  paid path.

**Tools-first is the _entry experience_; pipeline-first is the _architecture_.**

### Doors vs Pipeline-native (by required context)

| Tool                           |     Standalone door?      | Role                                                              |
| ------------------------------ | :-----------------------: | ----------------------------------------------------------------- |
| **Idea** (video concepts)      |            ✅             | Door — free, high-frequency (channel context only). The seed.     |
| Thumbnail                      |  ✅ (degrade w/o script)  | Door — the paid wow                                               |
| Description                    | ~ (works from idea/title) | Soft door                                                         |
| Script                         | needs an idea (1 line ok) | Pipeline-native                                                   |
| Hooks                          |      needs a script       | Pipeline-native                                                   |
| **Title** (optimized headline) |      needs a script       | Pipeline-native — refined, script-contextful. The polished final. |
| Shorts                         |      needs a script       | Pipeline-native                                                   |

**Idea vs Title:** they are NOT the same tool twice — they are _draft seed →
optimized final_. See §5.2.

**The door/pipeline split ≈ the free/paid split.** Cheap high-frequency tools (Idea)
= free acquisition doors; heavy tools = paid pipeline depth. Architecture and
business model agree. _Caveat:_ "door" = navigation (1-step reach), NOT "free
unlimited" — Thumbnail is a door but paid-gated (free watermarked taste, pay for
full). See §6.

### Build changes required (targeted, not a rebuild)

1. **Lazily create a project** — only when the user takes the 2nd step (continues
   into the pipeline), NOT on every door use. Avoids dashboard clutter from one-off
   quick uses.
2. **Downgrade hard deps → "best-available context"** — e.g. thumbnail uses
   channel context + title always; enriches with script/hook if present; degrades
   gracefully if not. _(Key engineering change.)_
3. **Kill legacy stateless endpoints** — one model: everything project-scoped,
   projects can be shallow. No dual path.
4. **Add "continue the workflow" nudges** on every tool output (the upsell).

### Explicitly NOT doing

- Not making Hooks/Shorts standalone (meaningless without a script).
- Not building separate "tools mode" vs "pipeline mode" UIs — one surface, tool is
  just the entry point, project always underneath.

### Why not the pure options

- **Pure pipeline-first:** paid wow buried at step 4, free tier can't function,
  every user must commit to the full flow → kills acquisition.
- **Pure tools-first:** throws away stale cascade / continuity / context
  accumulation (the moat) → becomes another AI-wrapper → kills defensibility.

---

## 1. Vision & Core Insight

- **The workflow (pipeline) is the product, not the individual tools.** Standalone
  generation is a commodity (ChatGPT, VidIQ, TubeBuddy). The moat is the
  connected, context-aware pipeline where each step carries context forward.
- **Not a bolt-on AI tool — a creator operating system.** Plan, research, write,
  package every video with AI embedded at every step.
- **Context is the moat.** Output must sound like _their_ channel. Already built:
  onboarding enriches with website scrape + competitor titles + own top titles.
- **Pitch:** sell **time saved + consistency**, not "AI generates X."

### Problems it targets (from overview.md)

1. **Ideation fatigue** — what to make next. ✅ served by the Idea door + embedded
   trending/competitor intelligence (§5.3).
2. **Production overhead** — scripts, titles, thumbnails, descriptions. ✅ served
3. **No workflow structure** — ideas scattered across notes/docs/DMs. ✅ served by
   the project spine + home/workspace (§5.4).

---

## 2. Target User (ICP) — DECIDED (revised after red-team)

- **Niche = business/finance/AI/productivity/educational (talking-head).** The build
  (10-min retention scripts + SEO + competitor analysis) is tuned for this; wrong
  for gaming/vlog/entertainment.
- **Funnel = GROWTH-STAGE (1k–50k) in-niche creators.** Hungry, time-poor, early
  monetization → can pay, no team yet. **Dropped the "beginners as mass funnel"
  assumption** — beginners barely exist in business/finance, so that overlap was
  thin and mismatched.
- **Free tier = a TRIAL for growth-stage creators, NOT a mass beginner funnel.** Its
  job = let a growth creator feel the workflow before subscribing (not viral
  beginner acquisition).

**Implication:** free tier must showcase the paid workflow's value (the 1 free
project); output quality must clear the growth-stage creator's bar. Growth mechanic
is NOT watermark-virality (see §7) — needs a real channel.

---

## 3. Feature Set

### Built (backend + React frontend exist; we're deciding product/UX changes, not UI)

| Feature            | Detail                                                                                                                                                                                  | Status |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Onboarding         | Brand/niche/audience, YouTube URL, competitor URLs, website scrape; pulls own + competitor top titles. Partial-failure isolated. No input validation.                                   | ✅ BE  |
| Video Projects     | Central entity. CRUD, soft-delete, freely-jumpable steps, multi-project-per-topic, stale cascade. **Bring-your-own-idea:** create project from `{topicId}` OR `{title}`.                | ✅ BE  |
| Research (Step 1)  | 10 titles/session (5 long, 5 Shorts), KMeans repetition avoidance (archived batches kept forever). **Also built:** `/research/trending`, `/research/competitors`, `/research/keywords`. | ✅ BE  |
| Script (Step 2)    | ~10 min, SSE streamed, retention framework. Own UUID (decoupled from topic). Manual edit only (no AI-assisted edit).                                                                    | ✅ BE  |
| Hooks (Step 3)     | 5 variations (Question/Shock/Story/Challenge/Promise). Select one → completes step.                                                                                                     | ✅ BE  |
| Packaging (Step 4) | Title variations, SEO description, **thumbnail BRIEF (text, not image)**, Shorts script. Per-item status.                                                                               | ✅ BE  |
| Iteration          | Regenerate across all steps. Like/dislike **CUT from v1**; capture implicit signal (selects/downloads/regens) instead. Explicit feedback loop = post-launch                             | ⚠️ BE  |
| Export             | Available at every step                                                                                                                                                                 | ✅ BE  |

### Pipeline

```
Onboarding → Research → Script → Hooks → Packaging   ( → Publish, future)
```

Project created only after a topic/idea is committed (research auto-completes at
creation). Stale cascade: regenerate upstream → downstream `stale`, fanning out to
every project on that topic. _(UX note: with jumping, stale badges can pile up —
present them gently/legibly as "refresh recommended," never as "broken.")_
✅ **DECIDED — GUIDED-JUMPABLE + contextful:** steps can be done in any order so
creators build to their own workflow; every step stays contextful of whatever else
exists in the project (best-available context, per §0). Resolves seq-vs-jumpable in
favor of jumpable.
**Guided default path:** each tool's output surfaces a _curated primary CTA_ to the
recommended next step (the path we want users to follow — the §0 "continue
workflow" nudge), while jumping elsewhere is always available as a secondary
action. Happy path = path of least resistance, never a rail. Leads new users (less
decision paralysis) while letting confident creators deviate freely.

### Launch feature scope → see §4. Post-launch roadmap below.

**Post-launch — Retention (novelty → habit)**

- **Content calendar / scheduling** — core to "consistency" promise.
- **Asset & brand library** — saved brand voice, hooks, thumbnail templates, series.
- **Analytics feedback loop** — pull published-video performance back to improve
  suggestions + prove ROI. Long-term moat (also unlocks the OAuth path).
- **Feedback → regeneration** — the like/dislike signal cut from v1 (§9).
- **Trending-as-door** — the "what's hot in your niche" entry feed (§5.3, deferred).

**Post-launch — Expansion (value + TAM)**

- **Cross-platform repurposing** — Shorts exists; add X threads, LinkedIn,
  community posts, newsletter. One video → many assets.
- **Teams / agencies** — future (shared workspaces, roles).
- **Idea inbox** — quick-capture raw ideas that feed into projects (BYO-idea via
  `{title}` already supported in the backend).

---

## 3.5 Feature-by-Feature Review (historical snapshot — "Bad/risky" now largely resolved; see §9)

### ✅ Good — keep

- **Video Project spine** — soft-delete, jumpable steps, multi-project-per-topic.
  The "workflow is the product" thesis, actually built.
- **Stale cascade** — the thing that makes a pipeline > 5 disconnected tools.
  Sophisticated; fans out across all projects on a topic. Moat, implemented.
- **KMeans repetition avoidance** — archived batches kept forever; gets better
  with usage. Defensible.
- **Context injection everywhere** — personalization moat is real.
- **Bring-your-own-idea** — you don't force AI titles; good.

### ⚠️ Bad/risky & 🔧 Must-decide → ALL RESOLVED

Every risk & open item from the original review is now decided — see the **§9
Decision Log**. (Note: feedback was decided OUT of v1 — do NOT wire it in for launch.)

---

## 4. Launch Model — WHOLE PRODUCT AT ONCE

**Not a phased/wedge rollout.** "One by one" = build cadence, not GTM. Most
features are built; launch ships the full product once the decisions in this doc
are applied. Think whole-product, not MVP slice.

### Launch scope (single release)

- Onboarding — DECIDED (§5.1): soft-mandatory tiny gate, hybrid entry
- **Doors** surfaced on home: **Idea, Thumbnail** (1-step entry). NOTE: Idea is the
  free door, NOT Title — Title is pipeline-native/paid (see §0, §5.2).
- Full pipeline: Idea → Script → Hooks → Title/Packaging — **GUIDED-JUMPABLE**, each
  step contextful of the others
- **Thumbnail image-gen** (real images) — CRITICAL PATH, the one genuinely
  unbuilt piece + the most visible wow. **Committed: must be done PROPERLY
  (quality-gated) before ship** — validate output quality + per-image cost early.
- §0 changes: **lazy** project creation (on 2nd step), best-available context, kill
  legacy stateless endpoints, "continue workflow" nudges
- Credits / free-tier gating — DECIDED (§6): freemium + 1 sub; paid centerpiece =
  workflow; conversion = free-project wall
- **Context freshness:** on-demand refresh + scheduled refresh (scheduled gated to
  active/paid users)
- **Feedback:** like/dislike OUT of v1; capture IMPLICIT signal (selects/downloads/
  regens) from day 1
- **Onboarding:** value-first (aha, then ask) — §5.1
- Research intelligence embedded at point-of-action (§5.3)
- Frontend: **already exists (React)** — UI is a separate concern, not decided here

### Paid wow — it's placement, not timeline

- Thumbnail image-gen = launch critical path (no interim brief-only door).
- **Idea + Thumbnail** reachable directly as doors on home (1 step); Title + rest
  live inside the pipeline. Wow (thumbnail) is not buried behind script + hooks.

### Post-launch (later, not gating)

Retention/expansion: content calendar, asset library, analytics feedback loop,
cross-platform repurposing, teams, trending-as-door. (Full list in §3.)

---

## 4.1 v1 Build Scope — Engineering Checklist

Consolidated from §0/§4/§5/§6. Backend + React frontend exist; these are the
net-new builds and changes to existing code for the single launch release.

1. **Thumbnail image generation (real images)** — NET-NEW, critical path, must be
   **quality-gated** (validate output quality + per-image cost). Replaces the current
   text-only thumbnail brief. (§4, §8)
2. **Lazy project creation** — create a Video Project only when the user takes the
   2nd step, NOT on every door use. Avoids one-off clutter. (§0)
3. **Best-available context** — downgrade hard dependencies: each tool uses channel
   context + whatever upstream outputs exist, degrading gracefully (e.g. thumbnail
   from just a title). Key change enabling doors. (§0)
4. **Kill legacy stateless endpoints** — one project-scoped model; no dual path. (§0)
5. **"Continue workflow" CTAs** — curated primary next-step CTA on each tool output;
   deviating stays available (guided-jumpable). (§0, §3)
6. **Onboarding = value-first** — instant first Idea from background URL auto-pull,
   ask for context _after_ the aha. **Hybrid entry** (URL-primary AI auto-prefill +
   manual fallback). **Add input validation + completeness meter** (none today). (§5.1)
7. **Relabel Idea vs Title** — Research output = "Idea"; Packaging title = "Title"
   across UI/copy. Not the same tool twice. (§5.2)
8. **Embed research intelligence at point-of-action** — trending + competitors in the
   Idea step; keywords in Packaging/Title. No standalone dashboard. (§5.3)
9. **Context refresh** — on-demand "refresh my channel data" button + scheduled cron;
   scheduled refresh gated to active/paid users (cost). (§9)
10. **Implicit signal capture** from day 1 (topic selects, thumbnail downloads,
    regenerations); like/dislike UI OUT of v1 (no dead buttons). (§9)
11. **Billing + metering** — freemium + $9/mo single tier. Free = 1 full project +
    ~5 Idea/day + ~2 watermarked thumbnails/day. Paid = unlimited text + ~50 images/mo.
    Watermark on free thumbnails; free-project wall = the paywall. Build on existing
    `stats.topics` / `stats.scripts` counters. (§6)
12. **Gentle stale-state UX** — present the stale cascade as "refresh recommended,"
    never "broken." (§3)

> Numbers (#11) are launch defaults to tune with data. Thumbnail image-gen (#1) is
> the highest-risk item — do it properly.

---

## 5. User Journey

```
Login → Onboarding (capture context) → Idea → Script → Hooks → Title/Packaging
                    ↓                     ↑
              channel context ────────────┘ (feeds every step)
```

1. **Login** — frictionless (Firebase). NOTE: not YouTube OAuth; channel data comes
   from the public YouTube Data API via the pasted channel URL.
2. **Onboarding** — captures the context that powers everything (see §5.1).
3. **Idea** — the free door / front door, uses context (§5.2).
4. **Rest of workflow** — each step inherits accumulated context (guided-jumpable).

### Core end-to-end flows

**Flow A — First-time creator (value-first happy path)**

1. Sign up (Firebase) → land on the Idea door: _"What's your next video?"_
2. Paste channel URL (or, no channel → enter niche + audience). Background: pull top
   titles + channel description.
3. **Instant first Idea batch** — 10 ideas (5 long-form 60–65 chars, 5 Shorts <50
   chars), grounded in trending + competitor signals.
4. Aha → optional: confirm/enrich the AI-prefilled context (niche/audience/brand) to
   sharpen future output.
5. Select an idea → a Video Project is created (working title = the idea). Primary
   CTA → **Script**.
6. **Script** streams in (~10 min, retention framework); edit inline if wanted.
   Auto-completes → CTA → **Hooks**.
7. **Hooks** — 5 opening-line variations; pick one → CTA → **Packaging**.
8. **Packaging** (any order): **Title** (3 optimized variations), **Description**
   (SEO), **Thumbnail** (image), **Shorts**. Keywords surface here.
9. **Export** any asset. Video is publish-ready.

**Flow B — Standalone door (quick use → upsell)**

1. Land → pick a single tool (e.g. Thumbnail or Idea).
2. Generate from minimal input (channel context + title/idea; best-available context).
3. No project yet (lazy); on **Continue**, a project spins up + guided CTA into the
   pipeline. Leave → they still got value; continue → they're in the workflow.

**Flow C — Returning creator**

1. Land → home shows projects + pipeline state (current step, stale badges).
2. Resume at the current step, or jump to any step (guided-jumpable).
3. Stale badges = "refresh recommended" where upstream changed.

**Flow D — Iteration / regeneration**

- Regenerate any step (ideas: Regenerate All / Regenerate One; others: regenerate).
- Regenerating upstream marks downstream **stale** (cascade) → user re-does or
  acknowledges. Implicit signals (selects, downloads, regens) captured silently.

**Flow E — Free → paid conversion**

- Free: 1 full project + ~5 ideas/day + ~2 watermarked thumbnails/day.
- Hit the **free-project wall** → "upgrade to keep creating." Watermark on free
  thumbnails = secondary nudge.
- Upgrade ($9/mo) → unlimited text, ~50 images/mo, no watermark.

### What each tool produces (+ user actions)

| Tool            | Output                                                   | Actions                                    |
| --------------- | -------------------------------------------------------- | ------------------------------------------ |
| **Idea**        | 10 ideas (5 long, 5 Shorts); KMeans avoids repeats       | select→project, regen all/one, edit        |
| **Script**      | ~10-min streamed script, retention framework             | regenerate, manual edit, export            |
| **Hooks**       | 5 opening lines (Question/Shock/Story/Challenge/Promise) | select one, regenerate, export             |
| **Title**       | 3 optimized headlines (50–70 chars, varied angles)       | regenerate, edit, export                   |
| **Description** | SEO desc (200–400w; hook, keywords, CTA, timestamps)     | regenerate, edit, export                   |
| **Thumbnail**   | 3 image concepts (real images — v1 build)                | regenerate, download (watermarked on free) |
| **Shorts**      | segmented vertical script w/ timestamps                  | regenerate, export                         |

### Key states (design + build must handle)

- **Empty:** no projects → value-first Idea prompt; a step not started → generate CTA.
- **Loading:** Script streams live (SSE); other tools show a generating state.
- **Stale:** upstream changed → gentle "refresh recommended," never "broken."
- **Error / thin context:** generation fails → retry; thin context → completeness
  nudge (never a silent generic output).

## 5.1 Onboarding — Deep-Dive Decisions (DECIDED)

Current build = 8-field form (channel URL, brand, niche, purpose, audience,
competitors, website, description); pulls own + competitor top titles + website
scrape on submit. No validation. URL-paste, **not** OAuth.

**Core tension:** context = moat, but an 8-field wall kills completion. Resolved by
two moves:

- **Split minimum-to-start from progressive enrichment.** First great output needs
  only the essentials; the rest fills over time (completeness meter nudges it).
- **Channel URL does the heavy lifting** — one URL → titles + description → AI
  pre-fills the rest → user just confirms.

### Decisions

- **Timing = VALUE-FIRST (aha, then ask).** First Idea is generated immediately —
  paste URL (or niche) → auto-pull context in the background → instant first output.
  Context enrichment is asked AFTER the aha. **No gate before first value.**
  - _Synergy with ICP:_ growth-stage creators all have a channel, so the URL
    auto-pull yields a strong first output even pre-onboarding — this neutralizes the
    "thin first-context" risk of value-first.
  - _Still soft-mandatory for depth:_ going beyond the first taste / into the
    pipeline applies the tiny context minimum — kept truly tiny, framed as VALUE
    ("so your titles sound like _you_"), not admin. If it creeps → it becomes a wall.
- **Entry model = HYBRID (URL-primary, manual fallback):**
  - _Has channel (default/curated path):_ required = paste URL → auto-pull titles
    - description → AI pre-fills niche/audience/brand → user confirms/edits. ~15s.
  - _No channel (fallback):_ required = niche + audience (2 fields). Rest progressive.
  - Cost note: manual form + URL lookup already exist; only NEW piece is the AI
    auto-prefill/confirm step. Not two new paths.
- **Connect method = URL-paste for v1.** OAuth deferred to when analytics feedback
  loop is built (needs private view/CTR/retention data).
- **Degraded output = transparent, never silent.** Completeness meter + enrichment
  nudges ("add competitors to sharpen titles"). **Add validation** (currently none)
  to enforce the minimum.
- **Editable profile** — re-submittable anytime (already idempotent); hosts the
  decided context-refresh (on-demand + scheduled).

## 5.2 Idea vs Title — Two Title Surfaces (DECIDED)

**Problem:** the build says "title" twice — Research generates 10 title _ideas_
(step 1); Packaging generates 3 title _variations_ (step 4). Same word, two jobs,
far apart → users think it's the same thing generated twice.

**Decision — relabel + reinforce (no reorder needed; build already runs
idea→script→title):**

|               | Surface 1 → **"Idea"**      | Surface 2 → **"Title"**              |
| ------------- | --------------------------- | ------------------------------------ |
| Stage         | Step 1 (start)              | Step 4 (after script)                |
| Job           | choose _what video to make_ | _optimize how to headline it_        |
| Context       | channel + competitors       | script + selected hook               |
| Role          | **free door** (the seed)    | **pipeline-native** (polished final) |
| Publish with? | working name only           | ✅ this is what you publish          |

- **Rename:** Surface 1 = "Idea", Surface 2 = "Title". (Optional: make S2 explicit
  — "Optimize Title" / "Final Title" — to drive the relationship home.)
- **Mental model:** draft seed → optimized final. Not the same tool twice.
- **Order already correct:** Title generated last = maximally script-contextful.
  Guided CTAs teach idea → script → title (Idea's CTA → Script; Title only appears
  post-script), so no "why titles again?" confusion.
- **Continuity:** the chosen Idea = the project's working title until the optimized
  Title lands at packaging. Answers "which do I publish with?" → the Title.
- **Doors reconciliation:** fixes §0 — the free door is **Idea** (channel-context
  only), NOT a script-dependent title. Title becomes a reward for the pipeline.

## 5.3 Research Intelligence — Placement (DECIDED)

Three backends exist, no UI: `/research/trending`, `/research/competitors`,
`/research/keywords`. They are **intelligence, not generation** — research inputs.

**Strategic principle:** DON'T build an analytics dashboard — that's VidIQ/
TubeBuddy's turf and we lose there. **We win on workflow.** So surface each insight
**embedded at the point of action**, not as a destination to browse.

### Decision — embedded at point-of-action

- **Trending + Competitors → the Idea step** — grounding/evidence behind AI ideas
  ("trending in your niche," "competitor got 500k on this angle"). Makes ideas feel
  researched, not guessed. Attacks stated problem #1 (ideation fatigue).
- **Keywords → Packaging (Description/tags) + Title** — SEO shown where SEO is
  applied, not cross-referenced from a dashboard.
- **No standalone Research/Analytics hub** (off-strategy + scope).

### Deferred (future feature — keep in doc)

- **Trending as a lightweight entry "door"** — a "what's hot in your niche" feed,
  each item a CTA to generate ideas (ideation + daily-return hook, funnel:
  trend → idea → pipeline). Backend ready; add post-launch, not v1.

### Context object (draft — reconcile with BE)

```
channelContext = { niche, audience, tone, topPerformingTitles[],
                   competitorTopTitles[], thumbnailStyle, brandVoice, language }
sessionContext = { idea, chosenTitle, script?, hooks?, packaging?, ... }

everyTool(channelContext + sessionContext) → output
```

## 5.4 Home / Workspace — product decided; VISUAL model = UI (design's call)

The visual model (Kanban vs dashboard vs list) is a **UI/design decision, not a
product one** — out of scope here. The product-level requirements are already fixed:

- **Adaptive landing:** new user (no projects) → value-first Idea door front-and-
  center; returning user → projects + doors (§5.1).
- **Entry points:** Idea + Thumbnail doors start something in 1 step (§0).
- **Project state surfaced:** current step + status + stale, from the existing Video
  Project list endpoint (title, currentStep, overallStatus, …).
- **Guided-jumpable:** each project's primary CTA = continue its current step (§3).
- **Monetization surface:** free-project wall + upgrade nudge live here (§6).

→ **Nothing open at the product level.** Hand the visual to design with these as
guardrails: whatever the layout, it must surface pipeline state + doors + adapt for
new users.

---

## 6. Monetization — Credits & Gating (DECIDED)

**Model = Freemium + ONE subscription.** Credits are used ONLY as (a) the free-tier
limiter and (b) a cap on the expensive tool (thumbnail image gen) — NOT per-use
billing for everything (a running meter kills the daily habit).

**Key nuance — "door" ≠ "free unlimited":** door = navigation (1-step reach);
billing is separate. Thumbnail is a door you can walk up to, but its free taste is
deliberately limited (watermark + cap) because it's the paid wow AND image gen
costs real money per image.

### FREE tier

- **Idea:** generous **daily refill** (~5/day) — cheap, high-frequency, daily-return
  hook + funnel top.
- **Thumbnail:** limited free taste — **watermarked + small cap** (cost control + it
  IS the wow).
- **Full pipeline** (Script/Hooks/Title/Description/Shorts): **ONE free end-to-end
  project** — feel the whole connected workflow once, then hit the wall.

### PAID tier — **$9/mo single tier at launch** (low-friction, DECIDED)

- Idea: unlimited / very generous
- Thumbnail: full-res, no watermark, **~50/mo metered quota** (real cost)
- Full pipeline: unlimited fair-use
- **3-tier decoy pricing = POST-LAUNCH**, designed on real usage data (not guessed):
  Starter $9 (entry) / Creator ~$15 (decoy) / Pro ~$19 (target). $9 stays the
  low-friction entry; decoy lifts ARPU without raising entry bar. Differentiator at
  launch = volume (projects/mo, thumbnails/mo); premium features (analytics,
  repurposing) come later.

### Paid centerpiece = THE WORKFLOW (not thumbnails)

DECIDED: users pay for connected idea→publish **speed**, not any single output. The
pipeline is the product, not just retention. Consequences: (1) the guided CTAs +
end-to-end feel ARE the value — integration must feel genuinely fast/connected;
(2) accepts the "no single visceral wow" risk (§8) — harder to market.

### Conversion engine

**PRIMARY = the free-project wall:** "you've used your free project — upgrade to keep
creating." The watermarked thumbnail is a SECONDARY nudge (pay to unlock
full-res/no-watermark), NOT the centerpiece.
**North-star metric:** free → paid conversion (trial project → subscription).

### Maps to original instinct

- "try everything once" → **1 free full project** (feels the connected workflow, not
  5 disconnected one-offs)
- "3 credits for light tools" → **daily Idea refill** (recurring > one-time)
- "lock heavy tools" → pipeline behind the free-project wall; Thumbnail behind watermark

### Launch default numbers (tune with data)

- Free Idea: **~5/day** refill · Free Thumbnail: **~2/day**, watermarked
- Free pipeline: **1 full project** (DECIDED — max urgency over OS-taste)
- Paid image quota: **~50/mo** · Paid text tools: unlimited fair-use
- Price: **$9/mo** single tier at launch; 3-tier decoy post-launch (above)
- Build metering on existing `stats.topics` / `stats.scripts` counters.

⚠️ **Coherence watch:** 1 free project + workflow-as-paid means that single project
must showcase enough of the connected value to convert, and the daily Idea refill
carries ongoing free engagement. The upgrade nudge at the wall must be strong.

### Not a product decision

Context-object schema reconciliation (draft vs Firestore) = engineering task; removed
from the product agenda.

---

## 7. Go-to-Market

- **Positioning:** lead with the WORKFLOW — "idea → publish-ready in minutes."
  Speed + consistency, not any single output (matches paid centerpiece = workflow).
- **⚠️ Growth mechanic is OPEN (needs a dedicated GTM session).** The old
  "watermarked output IS the ad" is DROPPED — creators will not publish watermarked
  thumbnails, so watermark = a conversion lever, NOT distribution. Real channels for
  growth-stage business/finance creators: content/SEO, niche creator communities
  (Discord/Skool), referral, partnerships, opt-in "made with" for those who want it.
- Reddit (r/NewTubers) skews beginner → LOWER priority now that funnel = growth-stage.

---

## 8. Key Risks

- **Thumbnail is only a brief, not an image** — undercuts the wow + paywall thesis.
  Image-gen is the launch critical-path build (§4). _Mitigation (committed):_ done
  properly / quality-gated — validate output quality + per-image cost before ship.
- **Churn** (AI-wrapper category). Anti-churn: channel context (personal output) +
  daily reason to return (title refills, trend nudges).
- **No single visceral wow** — paid centerpiece = workflow (§6), so conversion rests
  on the aggregate idea→publish _feel_, which is harder to market and to trigger than
  a single wow. The end-to-end experience must genuinely deliver speed/magic.
- **Script quality** — highest expectation; weak script taints the whole product.
- **Defensibility vs VidIQ/TubeBuddy** — answer = YouTube-native workflow +
  competitive intelligence + better output. Keep sharpening.
- **Onboarding discipline** — soft-mandatory minimum only works if it stays tiny +
  framed as value; if it creeps, it becomes a wall (§5.1).
- **Free image-gen cost** — thumbnails cost real money; free cap must be tight or it
  bleeds cash on non-payers (§6).

---

## 9. Decision Log & Agenda

### ✅ Decided (with § references)

- **Primary model** → Projects = container, Tools = doors; lazy project creation (§0)
- **ICP** → business/finance/AI/edu niche; funnel = growth-stage 1k–50k; free = trial (§2)
- **Launch model** → whole product at once; thumbnail image-gen = critical path (§4)
- **Navigation** → guided-jumpable: curated CTA, free to deviate; gentle stale (§3)
- **Onboarding** → value-first (aha, then ask); soft-mandatory tiny gate; hybrid
  URL-primary entry; URL-paste (OAuth later); add validation (§5.1)
- **Idea vs Title** → relabel: Idea = free door/seed, Title = pipeline-native/final (§5.2)
- **Research intelligence** → embedded at point-of-action; no dashboard;
  trending-as-door deferred (§5.3)
- **Home / workspace** → product reqs decided (adaptive landing, doors, state, CTAs,
  nudge); visual model = UI/design, out of scope (§5.4)
- **Monetization** → freemium + $9/mo single tier; paid centerpiece = THE WORKFLOW;
  conversion = free-project wall; watermark secondary (§6)
- **Pricing tuning** → $9 single at launch; 3-tier decoy post-launch on real data (§6)
- **Launch numbers** → 1 free project; ~5 Idea/day; ~2 watermarked thumbs/day;
  ~50 img/mo paid; unlimited paid text (§6)
- **Context freshness** → on-demand + scheduled refresh (scheduled gated to active/paid)
- **Feedback** → like/dislike OUT of v1; capture implicit signal (selects/downloads/
  regens) from day 1
- **Video format** → per-user `format` field (`talking_head` | `faceless`), default
  talking-head (matches ICP §2); script + thumbnail prompts adapt to it (2026-07-08,
  implemented in backend phase 1C — was hardcoded faceless)

### 🟥 Still open (product) — ONE item

- **Growth / distribution mechanic** — how growth-stage business/finance creators find
  us (watermark-as-ad dropped). Needs a dedicated GTM session (§7).

### Out of scope here

- **Frontend / UI** — React app exists; visual/UI is design's call.
- **Context-object schema** reconciliation (draft vs Firestore) — engineering task.
