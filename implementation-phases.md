# MomentumX — v1 Implementation Phases

> Companion to `product-doc-gap-analysis.md` (v2, verified) and `creator-saas-product-doc.md`.
> Converts the gap analysis into an ordered, bug-resistant build plan. Created 2026-07-08 (v2 — recategorized).
>
> **Ordering principle:** every phase ends with the system deployable and tested.
> A phase never depends on code that lands in a later phase, and risky work
> (prompt rewrites, new infra) is isolated behind its own test gate before
> anything builds on top of it.

---

## Phase overview

| Phase | Theme | Risk | FE contract impact | Owners |
|-------|-------|:----:|--------------------|--------|
| 0A | Live-exposure security fixes | low | 403→401 status change, CORS origins | DEV |
| 0B | Build hygiene (strict mode, dead code) | low | none | DEV |
| 1 | Context assembler + best-available context | **high** | packaging inputs loosened | DEV + AI‑ENG |
| 2 | Research grounding + title-intelligence placement | med | title-intel routes retired; ideas gain `titleType` + evidence meta | DEV + AI‑ENG |
| 3 | Onboarding value-first | med | required fields loosened; new prefill/refresh endpoints | DEV + AI‑ENG |
| 4 | Thumbnail image generation | **high** | thumbnail response gains image URLs | DEV + AI‑ENG + OPS |
| 5 | Billing, metering, enforcement | **high** | new 402-style quota errors; upgrade flow | DEV + OPS |
| 6A | Launch-required workflow changes (signals, feedback removal, stateless kill, CTAs, relabel) | med | feedback routes removed; response copy changes | DEV |
| 6B | Trailing cleanup (docs sync, test debt) | low | none | DEV |

**Owner key:** DEV = Developer (endpoints, services, repos) · AI‑ENG = AI Engineer (`prompt.ts`, `firebase.ts` configs, model factories — sole owner of those files) · OPS = deploy/infra (Vercel, Firebase Functions, Storage, payment provider).

### Dependency map

```
P0A ─► P0B ─► P1 (context assembler) ─► P2 (research + title-intel)
                   │                         │
                   ├──► P3 (onboarding)      │        [P2 ∥ P3 — parallel-safe]
                   │                         │
                   └──► P4 (thumbnails) ◄────┘        [4-spike starts during P1]
                                │
                                ▼
                        P5 (billing + metering)
                                │
                                ▼
                        P6A (launch-required) ─► LAUNCH ─► P6B (can trail)
```

- P3 can run in parallel with P2 (different subsystems; the only shared file is `prompt.ts` — AI‑ENG coordinates merges).
- The P4 image-quality/cost **spike** starts during P1; the P4 build starts after P1 merges.
- Task 2.4 (structured idea output) and all of P6A are dependency-light — pull them earlier if the schedule allows; they are placed where merge conflicts are cheapest, not where they become possible.

### Working rules (apply to every phase)

- **One phase = one branch** (`feature/phase-N-<slug>`); sub-phases marked *(separate PR)* merge independently, each behind its own exit criteria.
- **Regression gate on every PR:** `npm run build` clean + full Jest suite green + the phase's new tests. Commit `dist/` with the source per repo convention.
- **Prompt/config changes** land as a pair (prompt + matching generation config) — a JSON prompt with a text config is the known malformed-output failure mode. New JSON configs must define a `responseSchema` (repo rule; `GENERATION_CONFIG_SCORED_TITLES` is the pattern).
- **New middleware** follows the existing snake_case style of `src/middleware/`; new services/repos follow `{resource}.{layer}.ts`.
- **`[DECIDE]` markers** need a product call before that phase starts — none block an earlier phase.
- Gap-analysis references are `GA §n`.

---

## Phase 0A — Live-exposure security fixes *(ship first, smallest possible PR)*

**Goal:** close the holes that are exploitable **today**. Nothing here waits on anything else — if only one PR merges this week, it's this one.

| # | Task | Where | GA ref |
|---|------|-------|--------|
| 0A.1 | Re-enable auth on title-intelligence — uncomment import + `router.use(authMiddleware)` | `title-intelligence.route.ts:2,12` | §13.1 |
| 0A.2 | **Auth-coverage test**: assert every `/v1` router mounts auth middleware (allowlist: `/health`; SSE uses per-route `sseAuthMiddleware`). Codifies the "no router ships unprotected" rule | new `tests/unit/auth-coverage.test.ts` | §15.1 |
| 0A.3 | Lock CORS to the real FE origin(s) via env var; drop `origin: true` | `app.ts:13-18` | §15.2 |
| 0A.4 | Stop passing raw `error` objects as `detail` in `res.sendError` (safe message only; keep server-side structured logging) | `title-intelligence.controller.ts:22,40` + grep all controllers | §15.3 |
| 0A.5 | Redact query params (at minimum `token`) in `loggerMiddleware` | `middleware/logger_middleware.ts` | §15.5 |
| 0A.6 | Wire `helmet()` (already a dependency) | `app.ts` | §14.4 |
| 0A.7 | Return `401` (not `403`) for invalid/expired tokens; keep `403` for ownership failures | `middleware/auth.ts` | §15.6 |

**Bug-safety notes:** 0A.7 changes an HTTP status the FE may match on — grep the FE for `403` handling before merging. 0A.3 needs the real FE origin list from whoever owns the frontend deploy.

**Exit criteria:** unauthenticated calls to every `/v1` route (except health) return 401; auth-coverage test green; no raw error objects in any error response body; existing 80+ unit tests green.

## Phase 0B — Build hygiene *(separate PR; must not delay 0A)*

**Goal:** make the toolchain honest before the big phases build on it. Split from 0A because the strict-mode fix-up has unknown size and zero user-facing urgency.

| # | Task | Where | GA ref |
|---|------|-------|--------|
| 0B.1 | Point `npm run build` at `tsconfig.build.json` (strict); fix surfaced type errors — fix, don't suppress | `package.json`, `tsconfig.build.json` | §15.7 |
| 0B.2 | Delete dead empty file `src/utlils/firebase.ts` (`utlils/regex.ts` turned out NOT to be dead — it's imported by `extract.service.ts`; keep it) | — | §14.10 |
| 0B.3 | Sync the Functions `COLLECTIONS` enum with the main 6-value enum | `functions/src/util/index.ts:13-17` | §14.9 |

**Exit criteria:** strict build green; suite green; `dist/` rebuilt and committed.

---

## Phase 1 — Context assembler & best-available context

**Goal:** the single biggest architectural change (GA §3). Every generation tool draws from one context object: channel context always, plus whatever upstream outputs exist, resolved **server-side**. Everything downstream (P2 research injection, P3 prefill overrides, P4 doors) consumes this — which is why it goes first and why its test matrix is the most important artifact of the whole plan.

Internally ordered by risk: **additive first (1A, 1B — separate PR, zero behavior change), then behavioral (1C, 1D, 1E — one PR, prompts before validation).**

### 1A — Context assembler *(additive; separate PR with 1B)* — DEV

- New `src/service/context.service.ts`:
  `assemble(userId, { videoProjectId?, overrides? }) → { channelContext, sessionContext }`
  - `channelContext`: niche, targetAudience, brandName, userTitle (top titles), competitor titles, websiteContent — from the user doc.
  - `sessionContext`: working title (topic), script (resolved from `project.scriptId`), selected hook (existing `resolveSelectedHook` logic in `packaging.service.ts:27-37` moves here), packaging so far.
  - Missing pieces come back `null` — the assembler never throws for absent upstream content, only for missing user.
  - `overrides` lets P3 pass a just-pulled, not-yet-persisted channel context (instant-first-idea).
- **Unit-test the degradation matrix first** (project with script+hook / script only / title only / no project) — this matrix is the contract every later phase relies on.

### 1B — Type the packaging document *(additive; same PR as 1A)* — DEV

- Add `IPackaging`; replace `Record<string, unknown>` in `packaging.repository.ts`. GA §14.8. Done now because P4/P5 extend this document (image URLs, quota fields) and untyped extension is how field-name bugs happen.

### 1C — Prompt rewrites *(behavioral PR, lands before 1D within it)* — AI‑ENG

- Add optional channel-context + keyword blocks to `GENERATE_TITLE/DESCRIPTION/THUMBNAIL/SHORTS_PROMPT` (`prompt.ts:201-332`). Conditional block assembly happens **before** `.replace()` — no unreplaced placeholders (repo rule).
- Rework the faceless assumption for the talking-head ICP: `SCRIPT_SYSTEM_PROMPT` (`prompt.ts:128`) and `GENERATE_THUMBNAIL_PROMPT` (`prompt.ts:259`). GA §1.5. `[DECIDE]` whether format (talking-head vs faceless) becomes a per-user field (pairs with GA §14.2's missing `tone`/`brandVoice`/`thumbnailStyle`/`language` fields — add the fields now even if onboarding fills them in P3).
- Each rewritten prompt ships with its verified generation config and a parse test.

### 1D — Relax packaging hard deps + server-side resolution *(same PR, after 1C)* — DEV

- Thumbnail: require `title` only. Description: require `title` (or idea). Title/hooks/shorts keep requiring script (pipeline-native). `packaging.controller.ts:13-68`. GA §3. **Sequencing rule: validation relaxes only after the matching prompt handles the absent script (1C).**
- Hooks generate/regenerate and packaging regenerate-item stop requiring client-POSTed `script`; resolve from `project.scriptId` via the assembler (`hooks.controller.ts:10-17,30-38`, `packaging.service.ts:286-288`). GA §14.1.
- **FE contract change:** `script` in these bodies becomes optional → ignored. Accept-but-ignore for one release; never trust it again.

**Bug-safety notes:** 1D is the regression hotspot — existing FE calls that always pass script must keep working identically (degradation only *adds* accepted input shapes). Snapshot-test the assembled prompts for the full-context case against pre-change output.

**Exit criteria:** degradation-matrix unit tests green; thumbnail generates from title-only; description from title-only; full-context outputs unchanged in structure (JSON parses, same fields); existing packaging/hooks iteration tests (39 + 21) green.

---

## Phase 2 — Research grounding & title-intelligence placement

**Goal:** make generation research-grounded at point-of-action (GA §8) and resolve the undocumented title-intelligence module (GA §13) in the same motion, since they share the same code.

`[DECIDE] before starting:` title-intelligence placement — recommended: it becomes the *engine* behind Idea (and the packaging Title upgrade), standalone routes retired. Log the decision in the product doc's §9 decision log.

### 2A — Shared research engine *(additive; separate PR)* — DEV

- Extract `cleanVideos`, view-stats annotation, `formatTitleLines` (`title-intelligence.service.ts:73-119`) → `src/service/research-context.service.ts`. Unit-test the cleaning rules (dedupe, ≤2/channel, Shorts/livestream filter) in isolation first — they're pure functions, cheapest tests in the plan.

### 2B — Inject research into generation *(behavioral)* — DEV + AI‑ENG

- Trending + competitor signals into `generateTopics` (`content.service.ts:105-151`). Wrap the fetch in try/catch: **research failure degrades to current behavior, never blocks generation** (YouTube API quota is a real failure mode). Return evidence in response `meta` for FE grounding chips.
- Keyword signals into packaging Title + Description prompts (uses the optional keyword block added in 1C).
- YouTube quota watch: topic generation now costs API calls per invocation; add per-call result caching if quota pressure appears (constants already cap results — `research.repository.ts:1-3`).

### 2C — Structured idea output: 5 long / 5 Shorts *(independent — can land any time after P0; parked here only because it touches the same prompt/config files as 2B)* — AI‑ENG + DEV

- Change `GENERATION_CONFIG_TITLES` responseSchema to `[{title, type: "long"|"short"}]`, add `titleType` to `ITopic` (`types/routes/content.ts`), persist it. GA §14.7.
- **Old topic docs lack the field — every reader must tolerate `titleType: undefined`; no backfill.** Verify `getClusteredTitles`/KMeans is type-agnostic.

### 2D — Retire the standalone module *(behavioral; after 2A/2B prove the engine)* — DEV

- Fold title-intelligence per the decision: keep the service as the engine; remove or auth-gate+deprecate `/v1/title-intelligence/*` routes. Update the api-design route table in the same change (repo rule).

**Bug-safety notes:** 2B's degrade-gracefully wrapper is the critical guard — a YouTube outage must not take down the Idea door. 2C changes a Gemini response schema: config and prompt must change together (known malformed-JSON failure mode).

**Exit criteria:** generateTopics returns 10 typed ideas with evidence meta; kill-switch test (YouTube mock throwing) still yields 10 ideas; legacy topics without `titleType` list/export/regenerate cleanly; no unauthenticated title-intelligence surface remains.

---

## Phase 3 — Onboarding: value-first, hybrid entry *(parallel-safe with P2)*

**Goal:** GA §6 — URL does the heavy lifting, aha before the form, validation + completeness. Ordered inside the phase as: validation foundation → new capabilities → contract loosening (the loosening ships last because it depends on everything else tolerating absent fields).

| # | Task | Owner | Detail |
|---|------|-------|--------|
| 3.1 | Schema validation layer | DEV | Introduce Zod (new dependency) for onboarding/profile bodies: URL formats, competitor array shape, length caps, whitespace-trim. First real validation in the codebase — establish the pattern here, reuse everywhere after |
| 3.2 | Prefill endpoint | DEV + AI‑ENG | `POST /v1/user/onboarding/prefill` `{channelUrl}` → existing `ExtractService` pull (channel id, description, top titles) → **new prefill prompt + responseSchema config** infers `{niche, targetAudience, brandName}` → returned as suggestions, **not persisted** |
| 3.3 | Instant first Idea | DEV | `generateTopics` accepts the P1 assembler's `overrides` to run on just-pulled channel context before onboarding is saved. Flow: prefill → generate → user confirms context after the aha |
| 3.4 | Completeness score | DEV | Computed field (weighted required/enrichment fields) returned on `GET /profile`; drives the FE meter + nudges. Read-time computation — do not persist |
| 3.5 | Fix `description` silent overwrite | DEV | Keep user-submitted description; store the YouTube channel description as its own field (`channelDescription`). Migration-free: new field, old reads unaffected |
| 3.6 | `stats` tolerance/backfill | DEV + OPS | Auth-trigger users lack `stats` (GA §6/§11): initialize `stats` in `onCreateUser` (`functions/src/index.ts`) AND make all `stats` readers tolerate absence. Both, not either — existing users predate the fix |
| 3.7 | On-demand refresh endpoint | DEV | `POST /v1/user/refresh-context` — thin wrapper re-running the pull without form fields. (Scheduled refresh waits for P5 — it's plan-gated) |
| 3.8 | Split the required minimum *(last)* | DEV | Channel path: URL only. No-channel path: `niche` + `targetAudience`. Drop `brandName`/`userName` from the required set (`user.controller.ts:14-24`). **FE contract change — coordinate** |

**Bug-safety notes:** 3.8 loosens required fields — every downstream consumer of `brandName`/`userName` must handle absence (they flow into prompts as `{userName}`; the 1C conditional blocks cover this, which is why P3 depends on P1). 3.6's dual fix avoids the classic "new users fine, old users crash" split.

**Exit criteria:** prefill returns sensible suggestions for a real channel URL; onboarding succeeds via both paths (URL-only, niche+audience-only); invalid URLs rejected with 400 + clear message; instant-first-idea works pre-persist; users without `stats` can generate without errors.

---

## Phase 4 — Thumbnail image generation *(critical path; spike starts during P1)*

**Goal:** GA §1 — the one genuinely net-new build, quality-gated per the product doc.

### 4-spike *(parallel with P1/P2 — no merge dependency)* — AI‑ENG + OPS

- Validate image model output quality on real briefs + measure per-image cost. This is the doc's committed quality gate: **do not start 4B until the spike passes** (looks-good-enough-for-growth-stage-creators bar + unit cost known for §6 pricing).
- Test the talking-head style requirement explicitly (post-1C prompt direction).
- Measure against Vercel serverless limits (execution time, response size) — a hard constraint on the 4B design.

### 4A — Infrastructure *(separate PR)* — OPS + AI‑ENG

- Image model factory in `src/config/ai.ts` (new model + config; AI‑ENG owns the file).
- Firebase Storage init in `src/config/firebase.ts` + a storage repository (upload, signed/public URL). Repository-layer only, per architecture rules.
- Watermark compositing for free-tier renders (server-side; library choice inside the phase). Watermarked and clean variants stored separately — **never strip a watermark client-side**.

### 4B — Feature integration — DEV

- `generate-thumbnail` flow: brief generation (existing text pipeline, context-enriched from P1) → image generation per concept → store → return URLs + briefs. Works from title-only (P1 door behavior).
- Packaging doc extension (typed via 1B's `IPackaging`): `thumbnailImages: [{url, watermarkedUrl, brief, status}]`. `itemStatuses.thumbnail`, stale cascade, and per-item regenerate keep working — extend `normalizeField` + `buildItemStatuses` (`packaging.service.ts:124-169`).
- `thumbnailHint` on projects (`video-project.service.ts:65`) points at the first image URL going forward; readers must tolerate legacy string briefs.
- Image generation is slow: generate the 3 concepts concurrently (`Promise.allSettled`), tolerate partial success (2/3 images = success + warning, matching the onboarding partial-failure pattern).

**Bug-safety notes:** this is the phase most likely to break existing behavior via the shared packaging document — the 1B types + the existing 39 packaging iteration tests are the safety net. Run the full stale-cascade suite against docs containing image fields.

**Exit criteria:** spike sign-off recorded (quality + cost); thumbnail endpoint returns 3 image URLs from title-only input; watermarked variant for free tier (flag hardcoded until P5); stale cascade + per-item regenerate green on image-bearing docs; legacy brief-only packaging docs still render/export.

---

## Phase 5 — Billing, metering & enforcement

**Goal:** GA §11 — greenfield monetization. Last of the big builds because every quota it enforces (ideas/day, images/mo, free-project wall) needs the features from P1–P4 to exist and be stable.

### 5A — Plan model + payments — DEV + OPS

- User doc: `plan` (`free` | `paid`), subscription status/period, provider customer id. Default everyone to `free`; readers tolerate absence (same discipline as 3.6).
- `[DECIDE]` payment provider (doc says $9/mo single tier; Stripe is the default assumption).
- Webhook route: **must bypass `authMiddleware`** (add to the 0A.2 allowlist explicitly), verify provider signatures, and needs the **raw body** — `express.json()` is global (`app.ts:22`), so mount the webhook with a raw-body parser before it. Known integration trap; test with provider CLI fixtures.

### 5B — Usage counters (windowed) — DEV

- New `usage` map on the user doc (or subcollection): `usage.daily.{YYYY-MM-DD}.ideas`, `usage.daily.{...}.thumbnails`, `usage.monthly.{YYYY-MM}.images`. `FieldValue.increment` writes, same as existing stats. Lifetime `stats.*` stays untouched (analytics).
- Increment at the same points that already increment `stats` (`content.service.ts:141,271,370`) + thumbnail generation.

### 5C — Enforcement — DEV

- `QuotaService.checkAndConsume(userId, meter)` called at the top of: topic generate/regenerate (~5 ideas/day free), thumbnail generate (~2/day free watermarked; ~50/mo paid clean), project create (**free-project wall**: count non-`isDeleted` projects — no counter needed, the indexed query exists). Limits in config/env, not hardcoded — the doc says tune with data.
- Quota-exceeded responses carry a machine-readable reason (`{code: "free_project_limit"}`) so the FE can render the upgrade wall.
- **Check-then-consume race:** acceptable for launch-scale limits (worst case: one extra free generation); note it, don't over-engineer with transactions yet.
- Watermark selection in the P4 pipeline switches from hardcoded flag → `plan`.

### 5D — Infra that becomes load-bearing now — OPS

- Replace the in-memory rate limiter with per-user, Firestore-or-Redis-backed limits (GA §15.4) — quota enforcement can't rest on a limiter that resets per serverless instance.
- Scheduled context refresh (GA §9): `onSchedule` function in the existing `functions/` codebase, gated to active/paid users (`plan` field now exists). *(Categorized here, not P3, only because the gate needs the plan field.)*

**Bug-safety notes:** enforcement must **fail open on infrastructure errors** (quota read fails → allow + log loudly) — a Firestore blip must not lock every user out of generation. Webhook signature verification and raw-body handling are the two classic payment bugs; integration-test both.

**Exit criteria:** free user hits idea/thumbnail/project walls with correct machine-readable errors; paid flag flips via webhook in a provider-CLI test; quotas reset across day/month boundaries (unit-test the window-key derivation); quota-service outage does not block generation; scheduled refresh runs in the Functions emulator.

---

## Phase 6A — Launch-required workflow changes *(must merge before launch)*

**Goal:** the remaining **product decisions from the doc** — decided behavior the launch can't ship without. Kept out of earlier phases only to avoid merge noise; every item is dependency-light, so pull any of them forward if a slot opens.

| # | Task | Owner | Detail | GA ref |
|---|------|-------|--------|--------|
| 6A.1 | Implicit signal capture | DEV | New `events` collection (add to `COLLECTIONS` enum) + fire-and-forget writes (existing best-effort try/catch pattern) at: project create (idea selected), `setSelectedHook`, every `export*`, every `regenerate*`, thumbnail download. Doc requires signal **from day 1** — this is the first 6A item to land, and the strongest candidate to pull forward into any earlier phase | §10 |
| 6A.2 | Remove like/dislike routes | DEV | Delete the 4 feedback routes (doc: no dead buttons). Keep stored `userFeedback`/`hookFeedback` fields — harmless data, no migration. **FE coordination:** buttons must disappear in the same release | §10 |
| 6A.3 | Kill remaining stateless paths | DEV | Packaging `save` without project → create shallow project instead of standalone doc (`packaging.service.ts:219-225`); Shorts accepts optional `videoProjectId`. `[DECIDE]` whether packaging generate itself stays project-optional (door) — recommended yes, with save-time project creation | §2, §4, §14.6 |
| 6A.4 | `recommendedNextStep` in generation/save responses | DEV | Server-side `NEXT_STEP` map already exists (`video-project.service.ts:16-27`) — expose it so the FE renders guided CTAs without re-deriving | §5 |
| 6A.5 | Idea/Title relabel sweep | DEV | Response `message` strings + export headers say "idea" (surface 1) / "title" (surface 2). `[DECIDE]` route rename (`/v1/ideas` alias) vs copy-only — copy-only recommended for v1; Firestore collection name unchanged either way | §7 |
| 6A.6 | Project title continuity | DEV | `[DECIDE]` whether selecting a packaging title updates the project's display title | §7.3 |

**Exit criteria:** events land for every implicit action; no feedback routes respond; no standalone packaging docs can be created; FE receives `recommendedNextStep`; copy consistent across surfaces.

## Phase 6B — Trailing cleanup *(may trail launch; do not let it slip forever)*

| # | Task | Owner | Detail | GA ref |
|---|------|-------|--------|--------|
| 6B.1 | Internal `docs/` sync | DEV | Fix research states, stale-boolean language, hook styles, onboarding stale gap, description word target; document title-intelligence's final placement and the new P1–P5 surfaces; update the api-design route table | §16 |
| 6B.2 | Test debt on now-load-bearing areas | DEV | Coverage for: context assembler edge cases beyond the matrix, onboarding/prefill, quota service, research-grounding helpers — the areas GA §16.7 flags as untested and P1–P5 made critical | §16.7 |

---

## Launch readiness checklist (after P6A)

- [ ] All §4.1 checklist items traceable to a merged phase (GA scorecard all ✅)
- [ ] Auth-coverage test green; CORS locked; no `detail: error` leaks (P0A invariants still hold)
- [ ] Thumbnail spike quality/cost sign-off documented (product-doc §8 commitment)
- [ ] Free→paid conversion path manually walked end-to-end: signup → prefill → instant idea → project → pipeline → wall → upgrade → clean thumbnail
- [ ] Quota limits configured to doc defaults (5 ideas/day, 2 thumbs/day, 1 project, 50 img/mo) and adjustable without deploy
- [ ] `dist/` committed in sync with final source (Vercel serves committed dist)
- [ ] Product doc §9 decision log updated with all `[DECIDE]` outcomes: title-intelligence placement (P2), talking-head format field (P1), payment provider (P5), packaging-generate door semantics (P6A), relabel approach (P6A), title continuity (P6A)

## Deferred (post-launch, per product doc — do NOT build now)

Content calendar · asset/brand library · analytics feedback loop (OAuth) · explicit feedback→regeneration · trending-as-door · cross-platform repurposing · teams · 3-tier pricing · idea inbox UI.
