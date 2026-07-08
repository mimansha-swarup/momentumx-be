# MomentumX — Product Doc vs Backend: Gap Analysis

> Generated 2026-07-07 from a full read of `src/` against `creator-saas-product-doc.md`.
> **v2 — verified.** A second pass adversarially fact-checked every claim against the code
> and swept previously uncovered areas (`functions/`, `docs/`, tests, middleware, types,
> repositories, deploy configs). Corrections and new findings are folded in; §17 logs what changed.
>
> Each item maps a product decision to the current implementation state with
> `file:line` evidence, and states the concrete change required.
>
> **Legend:** ✅ already aligned · 🟡 partial — needs targeted change · 🔴 missing — net-new build · ⚠️ conflict / undocumented

---

## Scorecard (v1 checklist §4.1 → backend reality)

| #   | §4.1 Item                       | State | Verdict                                                                       |
| --- | ------------------------------- | :---: | ----------------------------------------------------------------------------- |
| 1   | Thumbnail image generation      |  🔴   | Text brief only; zero image/storage/watermark infra                           |
| 2   | Lazy project creation           |  🟡   | Creation is already explicit + BYO-idea works; door→continue flow needs shape |
| 3   | Best-available context          |  🔴   | Every packaging tool hard-requires `script`; no channel context in packaging  |
| 4   | Kill legacy stateless endpoints |  🟡   | Scripts/hooks are project-scoped; packaging generation + title-intelligence are stateless |
| 5   | "Continue workflow" CTAs        |  🟡   | Pipeline state exists; no explicit next-step hint in responses (mostly FE)    |
| 6   | Onboarding value-first + validation |  🔴   | Manual 4-required-field form; no AI prefill, no validation beyond presence, no completeness meter |
| 7   | Relabel Idea vs Title           |  🟡   | Code says "topics"/"titles" interchangeably; naming/copy decision needed      |
| 8   | Research embedded at point-of-action |  🔴   | Idea generation uses NO live research; keywords not in packaging prompts      |
| 9   | Context refresh                 |  🟡   | On-demand exists implicitly (re-submit profile); no dedicated endpoint, no cron, no gating |
| 10  | Implicit signal capture         |  🔴   | Opposite state: explicit like/dislike endpoints everywhere, no implicit event capture |
| 11  | Billing + metering              |  🔴   | Nothing exists — no plan fields, no quotas, no enforcement; counters are lifetime tallies |
| 12  | Gentle stale-state UX           |  ✅   | BE already exposes `isStale`/`staleReason`/`staleSince` + recovery; copy is FE's job |

Findings outside the checklist: **§13 title-intelligence (undocumented + auth disabled)**,
**§14 cross-cutting inconsistencies**, **§15 security & deployment findings**,
**§16 internal `docs/` drift**.

---

## 1. Thumbnail image generation — 🔴 net-new, critical path (§4.1‑1, §8)

**Doc:** real images, 3 concepts, watermarked on free, ~50/mo metered on paid, quality-gated before ship.

**Current state:**

- `POST /v1/packaging/generate-thumbnail` produces a **text brief** — 3 textual "thumbnail creation instructions" (`src/constants/prompt.ts:250-278`), stored as `thumbnail: string[]` (`src/service/packaging.service.ts:137-140`), exported under the literal heading "THUMBNAIL BRIEF" (`packaging.service.ts:452`).
- Only two Gemini models exist: `gemini-3.5-flash` (text) and `gemini-embedding-001` (`src/config/ai.ts:6,11`). No image model, no `responseModalities`.
- Firebase config initializes **Firestore + Auth only — no Storage bucket** (`src/config/firebase.ts`). No upload handling (`multer` absent), no signed URLs, no watermarking code anywhere.

**Changes required:**

1. Integrate an image model (Gemini image generation / Imagen) via a new factory in `src/config/ai.ts`.
2. Add Firebase Storage (or equivalent) init + a storage layer for generated images; packaging doc stores image URLs alongside (or replacing) the brief.
3. Watermark pipeline for free-tier renders (server-side compositing) — no infra for this exists.
4. Per-image metering hooks (feeds §11).
5. ⚠️ **Prompt conflict — bigger than the thumbnail.** `GENERATE_THUMBNAIL_PROMPT` forbids faces — *"Do not suggest faces, people, or facial expressions — these are faceless videos"* (`prompt.ts:259`) — **and the script system prompt has the same baked-in assumption**: *"professional YouTube scriptwriter specializing in faceless, documentary-style videos"* (`prompt.ts:128`). The ICP (§2) is **talking-head** creators. Both prompts (thumbnail + script) need rework for the ICP, not just the thumbnail one.
6. Doc requires thumbnail to work as a **door** from title + channel context only — today it hard-requires `script` + `title` (`src/controller/packaging.controller.ts:40-53`). See §3.

---

## 2. Lazy project creation — 🟡 mostly aligned, flow needs a decision (§0, §4.1‑2)

**Doc:** project spun up only when the user takes the 2nd step; door use alone creates nothing.

**Current state — closer to the target than expected:**

- Projects are **only** created via explicit `POST /v1/video-projects` with exactly one of `{topicId, title}` (`src/controller/video-project.controller.ts:11-17`). Topic generation never creates projects (`formatGeneratedTitle` sets `videoProjectId: null`, `src/utlils/content.ts:28`).
- **Bring-your-own-idea already works:** `createFromTitle` materializes a raw title into a topic doc, then creates the project (`src/service/video-project.service.ts:89-96`).
- `research` step is seeded `completed` at creation, `currentStep: "research"` (`video-project.service.ts:67,77`) — matches "research auto-completes at creation."

**Gaps:**

1. The doc's Flow B (door → generate with no project → **Continue** spins up a shallow project) has no single "continue" affordance. Today the FE would have to orchestrate: `POST /video-projects {title}` → then call the next tool. Workable, but consider one endpoint that atomically creates a shallow project **from a door output** (e.g. from an unsaved thumbnail/title generation) so door state isn't lost.
2. Packaging `save` without `videoProjectId` creates a **standalone packaging doc** (`src/service/packaging.service.ts:219-225`) — this is exactly the "project-less artifact" the lazy model is meant to avoid. Once lazy-create lands, standalone saves should instead trigger shallow-project creation (or be removed — see §4).

---

## 3. Best-available context — 🔴 the key engineering change (§0‑2, §4.1‑3)

**Doc:** every tool uses channel context + whatever upstream outputs exist; degrades gracefully. Thumbnail must work from just a title.

**Current state — hard dependencies everywhere, and packaging ignores channel context entirely:**

| Tool        | Hard-required today                                             | Doc target                                  |
| ----------- | --------------------------------------------------------------- | ------------------------------------------- |
| Idea/topics | user profile only                                               | ✅ + trending/competitor grounding (§8)     |
| Script      | project + topic (`content.service.ts:189-203`)                  | ✅ ok (pipeline-native; 1-line idea = BYO title path) |
| Hooks       | `videoProjectId` + `script` in body; script step must be `completed` (`hooks.controller.ts:10-17`, `hooks.service.ts:24-27`) | ✅ ok (pipeline-native) |
| Title       | `script` required → 400 (`packaging.controller.ts:15`)          | ok (pipeline-native)                        |
| Description | `script` **and** `title` required (`packaging.controller.ts:29-30`) | 🔴 should degrade to idea/title-only ("soft door") |
| Thumbnail   | `script` **and** `title` required (`packaging.controller.ts:42,45`) | 🔴 must work from title + channel context (it's a DOOR) |
| Shorts      | `script` + `duration` (`packaging.controller.ts:56-57`)         | ✅ ok (pipeline-native)                     |

**Deeper problem — packaging prompts contain zero channel context.** `GENERATE_TITLE_PROMPT`, `GENERATE_DESCRIPTION_PROMPT`, `GENERATE_THUMBNAIL_PROMPT`, `GENERATE_SHORTS_PROMPT` take only `{script}`/`{title}`/`{selectedHook}`/`{duration}` (`prompt.ts:201-332`) — no `{niche}`, `{targetAudience}`, `{brandName}`. The doc's context object (§5.3: `everyTool(channelContext + sessionContext)`) is only honored by topic + script generation (`content.service.ts:53-62,110-116`). Packaging output cannot "sound like their channel" today.

**Changes required:**

1. Build a **context assembler**: given `userId` (+ optional `videoProjectId`), returns `channelContext` (niche, audience, brand, top titles, competitor titles, websiteContent) + `sessionContext` (idea/title, script?, selectedHook?) with whatever exists. Server-side — resolve script/hook from the stored project rather than trusting the body (see §14.1).
2. Rewrite packaging prompts (AI Engineer) with optional context blocks — conditional assembly before `.replace()`, honoring the "handle optional vars before replace" rule.
3. Relax controller validation: thumbnail needs `title` only; description needs `title` or idea; keep script requirements for hooks/shorts/title.
4. Doc's draft context object lists `tone`, `brandVoice`, `thumbnailStyle`, `language` — **none of these fields exist** on the user doc (no such fields anywhere in `src/types/routes/user.ts` / `formatUserData`, `utlils/content.ts:104-178`). Schema reconciliation is flagged in the doc as an engineering task (§9 "out of scope") — this is where it lands.

---

## 4. Kill legacy stateless endpoints — 🟡 inconsistent today (§0‑3, §4.1‑4)

**Doc:** one model — everything project-scoped; projects can be shallow; no dual path.

**Current state, per subsystem:**

- **Scripts:** ✅ already strict — project mandatory (comment "Project is mandatory now", `content.service.ts:189`), topic mandatory via `project.topicId` (`content.service.ts:196-203`).
- **Hooks:** ✅ strictly project-scoped (`hooks.controller.ts:10-17`); select/regenerate resolve `videoProjectId` from the stored batch, never the client (`hooks.service.ts:81-84`).
- **Packaging:** 🔴 all four `generate-*` endpoints run with **no project at all** (`videoProjectId` optional on title/description/thumbnail, absent on shorts — `packaging.controller.ts:13-68`); `save` without a project creates standalone docs (`packaging.service.ts:219-225`); `list` is user-scoped, not project-scoped (`packaging.repository.ts:48-67`).
- **Topics:** entire subsystem is project-agnostic (`topics.route.ts`) — **this is correct** per the doc: Idea is the pre-project free door.
- **Title-intelligence:** fully stateless, no persistence, and **no auth** (`title-intelligence.route.ts:2,12` — middleware commented out). See §13.

**Changes required:**

1. Reconcile packaging generation with the lazy-project model: either (a) generation stays callable pre-project for door use but **save always requires/creates a project** (shallow if needed), or (b) generation itself auto-creates the shallow project. (a) matches the doc's "lazy — create on 2nd step" more closely. Decision needed, then remove the standalone-save branch.
2. Decide title-intelligence's fate (fold in, gate, or remove — §13). Whatever the outcome, it cannot ship as an unauthenticated stateless door.

---

## 5. "Continue workflow" CTAs — 🟡 mostly FE, small BE assist (§0‑4, §4.1‑5)

The pipeline state machine already supports this: `NEXT_STEP` map exists server-side (`video-project.service.ts:16-27`), `completeStep` auto-advances `currentStep`, and `reconcileView` presents resource-linked steps as completed on `GET /:projectId` (`video-project.service.ts:147-161`).

**Optional BE change:** include an explicit `recommendedNextStep` (and door-context, e.g. "no project yet → continue creates one") in generation/save responses so the FE doesn't re-derive the guided path. Low effort, do alongside §3's context assembler.

---

## 6. Onboarding — 🔴 value-first model not built (§5.1, §4.1‑6)

**Doc:** URL-primary hybrid entry, AI pre-fill from channel, instant first Idea before any form, tiny soft-mandatory minimum, validation + completeness meter.

**Current state (`PATCH /v1/user/onboarding`):**

- **The user doc is born before onboarding:** a Firebase Auth `onCreate` trigger (deployed as a Cloud Function, `functions/src/index.ts:8-20`) writes the base `users/{uid}` doc (`uid, name, email, photoURL, createdAt`); onboarding later merges in profile + `stats`. A user who signs up but never onboards has a user doc **without a `stats` object** — matters for §11's metering plan.
- **Hard gate up front:** 4 required fields — `brandName`, `niche`, `targetAudience`, `userName` — presence-checked only (`src/controller/user.controller.ts:14-24`). This is the "8-field wall" the doc kills. Notably `userName` (channel URL) is **required**, which breaks the doc's no-channel fallback path (niche + audience only).
- **No AI pre-fill.** The pipeline is pure HTTP: website scrape + YouTube channel lookup + top-10 titles for self and competitors (`src/utlils/content.ts:104-178`, `src/service/extract.service.ts`). Niche/audience/brand are taken verbatim from the form. The raw material for prefill (channel description + top titles) is already being fetched — the LLM prefill step is the only missing piece.
- **No validation** beyond falsy checks: no URL format checks, no schema (Zod/Joi), whitespace passes (`user.controller.ts:16-24`).
- **No completeness meter** — nothing computes profile completeness anywhere.
- ✅ Partial-failure isolation exists (`Promise.allSettled`, `content.ts:127,143`) with a soft warning for failed website parse (`user.controller.ts:30-33`).
- ✅ Re-submittable/idempotent: `set(..., {merge: true})` (`src/repository/user.repository.ts:21-28`) + `PATCH /profile` re-runs the full pull.
- ⚠️ Submitted `description` is silently **overwritten** by the YouTube channel description (`content.ts:145-176`) — fine for prefill, surprising for a form field.

**Changes required:**

1. New **prefill endpoint**: URL in → channel pull → LLM infers `{niche, audience, brand}` → returned as suggestions for confirm/edit. (Reuses `ExtractService` + one new prompt.)
2. Split the minimum: channel path = URL only; fallback path = `niche` + `targetAudience`. Drop `brandName`/`userName` from the required set accordingly.
3. Support the **instant-first-Idea** flow: topic generation must run off a just-pulled URL context before full onboarding is saved (today `generateTopics` reads the persisted user doc — `content.service.ts:109`).
4. Add real input validation (schema + URL formats) and a computed completeness score (field to drive the meter + enrichment nudges).
5. Backfill/initialize `stats` for auth-created users who haven't onboarded (or make the metering layer tolerate a missing `stats` map).

---

## 7. Idea vs Title relabel — 🟡 naming decision (§5.2, §4.1‑7)

**Current terminology is exactly the confusion the doc describes:**

- Routes/collection say **topic** (`/v1/topics`, `COLLECTIONS.TOPICS`), the stored primitive is `title`, generation prompts say "video titles" (`TOPIC_USER_PROMPT`), and responses mix both — `editTopic` → "Title updated successfully" (`topic.controller.ts:71`), export header "Research Topics" (`content.service.ts:486`). "Idea" appears nowhere in code.
- Packaging's title generator is a second "title" surface (`/v1/packaging/generate-title`).

**Changes required:**

1. Decide: rename routes (`/v1/ideas`) vs keep paths and relabel only response copy + FE. Renaming touches the FE contract — an alias period or v1-freeze is the pragmatic option. Firestore collection name should **not** change (data migration for a label isn't worth it).
2. Sweep response `message` strings so surface 1 consistently says "idea" and surface 2 "title."
3. The doc's continuity rule (chosen Idea = project working title until packaging Title lands) already holds structurally — project title comes from the topic (`video-project.service.ts:47-87`); nothing updates it when a packaging title is chosen. If "publish with the Title" should reflect on the project, add that link (e.g. selected packaging title → project display title). Product-level nicety, flag for decision.

---

## 8. Research intelligence at point-of-action — 🔴 not wired (§5.3, §4.1‑8)

**Doc:** trending + competitors ground the Idea step; keywords surface in Packaging/Title. No standalone dashboard.

**Current state:**

- **Idea generation uses zero live research.** `generateTopics` builds its prompt from the persisted user profile + KMeans-clustered prior titles only (`content.service.ts:105-151`); the prompt *asks* for trend-awareness but no trending/competitor API call happens at generation time. Competitor titles are even commented out of `formatCreatorsData` (`utlils/content.ts:57`).
- **Keywords are absent from packaging** — description/title prompts have no keyword inputs (`prompt.ts:201-249`).
- The three `/v1/research/*` endpoints exist and work (trending by niche, competitor top-10s, keyword search — `src/service/research.service.ts`) but are **standalone**: their output goes only to the API caller, never into a prompt.
- **However:** the title-intelligence service already implements exactly the doc's pattern — it fetches trending + keyword videos, cleans them (dedupe, ≤2/channel, no Shorts/livestream junk — `title-intelligence.service.ts:73-99`), weights by real view counts (`:103-119`), and feeds them into generation (pipelines at `:203-285`). The plumbing the doc asks for exists — in the wrong (undocumented, unauthenticated) module.

**Changes required:**

1. Inject trending + competitor signals into `generateTopics` (reuse `ResearchRepository` + the title-intelligence cleaning/view-weighting helpers). Return the evidence ("trending in your niche", view counts) in the response `meta` so the FE can show grounding.
2. Inject keyword signals into the packaging Title + Description prompts.
3. Decide whether `/v1/research/*` remain as FE data endpoints (for showing evidence chips) or get absorbed; the doc's "no standalone dashboard" argues against expanding them.

---

## 9. Context refresh — 🟡 half-exists (§4.1‑9, §9)

- **On-demand:** effectively exists — `PATCH /v1/user/profile` re-runs the full scrape/pull pipeline (`user.service.ts`, `formatUserData`). A dedicated `POST /v1/user/refresh-context` that re-pulls without requiring the form body would be a thin wrapper.
- **Scheduled:** 🔴 nothing — no cron/scheduler anywhere in `src/`, `functions/src/`, or `package.json`. Two viable hosts exist:
  - **Firebase Scheduled Functions** — a Functions codebase is already deployed (`firebase.json`, `functions/`), currently holding only the `onCreateUser` auth trigger. Adding an `onSchedule` refresh function is the lowest-friction path.
  - **Vercel Cron** hitting a protected refresh route on the Express app.
- **Gating (scheduled refresh only for active/paid users):** depends on §11's plan field — doesn't exist yet.

---

## 10. Feedback: explicit OUT, implicit IN — 🔴 currently inverted (§4.1‑10, §9)

**Doc:** like/dislike cut from v1 (no dead buttons); capture implicit signal (selects / downloads / regens) from day 1.

**Current state — four explicit feedback endpoints (verified complete; no 5th surface), zero implicit capture:**

| Endpoint | Storage |
| --- | --- |
| `PATCH /v1/topics/:topicId/feedback` | `userFeedback` on topic (`content.service.ts:376-396`) |
| `PATCH /v1/scripts/:scriptId/feedback` | `userFeedback` on script (`content.service.ts:398-416`) |
| `PATCH /v1/hooks/:hooksId/feedback` | per-index `hookFeedback` map (`hooks.service.ts:137-160`) |
| `PATCH /v1/packaging/:packagingId/feedback` | per-item `feedback` map (`packaging.service.ts:373-397`) |

Implicit events (topic→project select, hook select, exports, per-item regens) all happen but are **not recorded as signals** — the only tallies are lifetime `stats.topics`/`stats.scripts` increments (`content.service.ts:141,271,370`).

**Changes required:**

1. Deprecate (don't delete — data shape is harmless) the four feedback endpoints from the FE contract; or remove routes outright per "no dead buttons."
2. Add a lightweight **event log** (new collection, e.g. `events`: `{userId, type, resourceId, projectId?, ts}`) written fire-and-forget from the existing hot spots: `VideoProjectService.create` (idea selected), `setSelectedHook`, every `export*`, every `regenerate*`, thumbnail download (once images exist). The best-effort try/catch logging pattern already used for cross-service sync (`packaging.service.ts:231-233`) is the right template.

---

## 11. Billing + metering — 🔴 greenfield (§4.1‑11, §6)

**Doc:** freemium + $9/mo single tier. Free = 1 full project + ~5 ideas/day + ~2 watermarked thumbs/day. Paid = unlimited text + ~50 images/mo. Build on existing stats counters.

**Current state — nothing enforces anything:**

- No subscription/plan/billing fields on the user doc; no Stripe/payment dependency; no webhook route (confirmed absent across `src/`, `functions/`, `package.json`).
- `stats: {topics, scripts, credits}` initialized at onboarding (`user.service.ts:17-19`); `credits` is **dormant — never read or written again** anywhere. Users who authenticated but never onboarded have **no `stats` object at all** (the auth-trigger doc doesn't include it — see §6).
- `stats.topics`/`stats.scripts` are **lifetime** tallies via `FieldValue.increment` — no daily/monthly windows, and **nothing reads them** to gate generation.
- Only throttle in the app: global IP rate limit, 100 req/15 min (`src/middleware/rate_limit.ts`, `app.ts:23`) — not per-user, not per-feature, **and it uses an in-memory store, which is per-instance and largely ineffective on Vercel serverless** (see §15.4).

**Changes required:**

1. User doc: `plan` (`free`/`paid`), subscription status/period fields, provider customer ID.
2. Payment provider integration + webhook route (webhook must bypass `authMiddleware` and JSON-verify signatures — new pattern for this codebase).
3. **Windowed counters** — the doc says "build on `stats.topics`/`stats.scripts`," but daily refills (~5 ideas/day) and monthly quotas (~50 images/mo) need period-keyed counters (e.g. `usage.{YYYY-MM-DD}.ideas`, `usage.{YYYY-MM}.images`), not lifetime totals. Extend rather than replace; tolerate missing `stats` (see §6.5).
4. **Enforcement middleware/service** consulted by: topic generate/regenerate (daily idea refill), thumbnail generate (daily free cap / monthly paid quota), project create (**free-project wall** — count non-deleted projects for free users; `isDeleted` filter already exists on the list path).
5. Free-tier watermarking hook into the §1 image pipeline.
6. Decide fate of the dormant `stats.credits` field — repurpose for image quota or drop.

---

## 12. Gentle stale-state UX — ✅ backend done (§4.1‑12)

Backend already provides everything the FE needs: per-step `stale` statuses with `STALE_CASCADE` fan-out across **all projects on a topic** (`content.service.ts:310-316`), doc-level `isStale`/`staleReason`/`staleSince` on packaging (`packaging.repository.ts:98-121`), selective un-stale on per-item regenerate with `refreshPackagingStep` recovery (`packaging.service.ts:335-357`), and re-save deliberately not clearing stale flags (`packaging.service.ts:195-201`). "Refresh recommended" phrasing is FE copy. No BE change required.

---

## 13. ⚠️ Title-Intelligence module — undocumented, unauthenticated, unplaced

The newest module (`/v1/title-intelligence`, recent commits `7b96efa`, `0c0535d`, `183a606`, `752cdd5`) **does not exist in the product doc** (nor in `docs/features/`) and needs a product decision.

**What it is:** stateless title generation from free-form `{idea?, script?}` with two pipelines — `/generate` (1 merged LLM call: analyze + decode niche angle + 20 candidates + harsh scoring → top 10, with live trending/keyword YouTube data cleaned and **weighted by real view counts** — cleaning/weighting helpers at `title-intelligence.service.ts:73-119`, pipelines at `:203-285`) and `/deep-generate` (4 sequential LLM calls: analyze → patterns → 20 enriched titles → score). No persistence, no project linkage. Fully typed (`types/routes/title-intelligence.ts`) with per-stage latency instrumentation.

**Issues:**

1. 🔴 **Auth is disabled** — both the `authMiddleware` import and `router.use(authMiddleware)` are commented out (`title-intelligence.route.ts:2,12`). Public endpoints that burn Gemini + YouTube API quota, protected only by the (ineffective, §15.4) IP rate limiter. Must be fixed regardless of product direction. Note this is a symptom of a structural risk: auth is per-router, and the global `authMiddleware` in `app.ts` is commented out (`app.ts:3,12`) — any new route file that forgets `router.use(authMiddleware)` ships public (§15.1).
2. **Product placement is undefined.** It overlaps both doc surfaces: it accepts an `idea` (Surface 1 territory) and a `script` (Surface 2 territory), and it — not the packaging title generator — implements the doc's research-grounded generation (§5.3). Plausible resolutions:
   - power the **Idea door** with it (research-grounded, view-weighted — exactly §5.3's target for the Idea step), and/or
   - replace/upgrade packaging `/generate-title` with the scored pipeline (script in, top titles out),
   - then retire the standalone route (it's a "legacy stateless endpoint" under §0‑3).
3. It violates house conventions meanwhile: stateless, unauthenticated, results not persisted, not project-scoped, and its controller leaks raw errors via `detail: error` (§15.3).

**Recommendation to log in the product doc:** treat title-intelligence as the *engine* behind Idea (and optionally Title), not as a separate user-facing tool; decide before more work builds on the standalone route.

---

## 14. Cross-cutting inconsistencies found during review

1. **Client-supplied `script` on existing-doc operations.** Hooks generate/regenerate and packaging regenerate-item all require the client to POST the script text (`hooks.controller.ts:10-17,30-38`; `packaging.controller.ts:102-103`, `packaging.service.ts:286-288`) even though the project already links a stored `scriptId`. This clashes with the repo's own "derive owning IDs/content from the stored doc" rule and with best-available context (§3). Fix alongside the context assembler: resolve script server-side from `project.scriptId`.
2. **Missing channelContext fields.** `tone`, `brandVoice`, `thumbnailStyle`, `language` from the doc's context draft (§5.3) don't exist on the user doc. Needed at latest for the thumbnail image pipeline (style) — fold into the §6 onboarding/enrichment changes.
3. **`stats.credits` dormant** since onboarding init (`user.service.ts:17-19`) — see §11.6.
4. **`helmet` is a dependency but never wired** into `app.ts`. One-liner hardening while touching app wiring for billing webhooks.
5. **No `stats.projects` counter** — the free-project wall (§11.4) needs either a counter or a count query on project create.
6. **Shorts generation is fully project-blind** — takes no `videoProjectId` at all (`packaging.controller.ts:56`), so a Shorts result can't even opportunistically enrich or link to a project.
7. **Idea output split (5 long / 5 Shorts) — half-built.** The doc (§3, Flow A) describes 10 ideas as 5 long-form + 5 Shorts and marks it built. The **prompt does instruct the split** — `TOPIC_SYSTEM_PROMPT` demands "5 Long-Form Titles (60-65 chars)" and "5 Shorts Titles (<50 chars)" (`prompt.ts:41-42,79-82`) — but the output schema is a **flat array of 10 strings** (`prompt.ts:108-109`), parsed as `string[]` (`content.service.ts:137`), and `ITopic` has no type/format field (`types/routes/content.ts:6-18`). Which titles are long vs Shorts is never labeled, persisted, or queryable — the FE can't badge or filter them. Fix is a **structured-output change** (schema + `titleType` field + storage), not a prompt change.
8. **No `IPackaging` type exists.** Packaging documents are `Record<string, unknown>` throughout `packaging.repository.ts`; only `IPackagingItemStatuses` is typed (`types/routes/video-project.ts:16-21`). The only entity without a document type — violates the repo's own no-`any`/typed-return standard and will bite the §1/§11 work that extends this doc.
9. **Duplicate drifted `COLLECTIONS` enum in Functions.** `functions/src/util/index.ts:13-17` has its own 3-value enum (`USERS/SCRIPTS/TOPICS`), out of sync with the main 6-value enum (`src/constants/collection.ts:1-8`).
10. **Dead placeholder file:** `src/utlils/firebase.ts` is empty (the real Firebase init lives in `src/config/firebase.ts`). *(Correction during P0B: an earlier draft also listed `utlils/regex.ts` as dead — it is not; it holds `extractChannelInfo`/`extractTextFromHTML` and is imported by `extract.service.ts`.)*

---

## 15. Security & deployment findings (second pass — not in the product doc, but launch-blocking adjacent)

1. **Auth is opt-in per router** — per-router auth is the codified convention (global auth in `app.ts` is explicitly disallowed by backend-standards), but title-intelligence (§13.1) proves the failure mode is real. Mitigation: a route-registration assertion or test that every `/v1` router mounts an auth middleware (allowlist: `/health`, SSE per-route `sseAuthMiddleware`).
2. **CORS reflects any origin with credentials** — `cors({ origin: true, credentials: true })` (`app.ts:13-18`). Any website can make credentialed calls. Lock to the real FE origin(s) before launch.
3. **Raw error objects leak to clients** where controllers pass `detail: error` into `res.sendError` (e.g. `title-intelligence.controller.ts:22,40`; the same pattern exists in other controllers per the backend-standards example). The central `error_handler` carefully hides ≥500 internals (`middleware/error_handler.ts:54-72`) but `sendError({detail: error})` bypasses it (`response_formatter.ts:25-32`). Sweep controllers to stop serializing raw errors into `detail`.
4. **Rate limiter is ineffective in production** — `express-rate-limit` with the default in-memory store (`rate_limit.ts`) is per-serverless-instance on Vercel; limits reset on cold start and don't share across concurrent instances. Real quota enforcement (§11) must be Firestore/Redis-backed, per-user.
5. **Firebase ID tokens leak into logs** — `loggerMiddleware` logs `req.originalUrl`, and the SSE endpoint authenticates via `?token=<idToken>` (`middleware/auth.ts:33-38`). Redact query params (at minimum `token`) in the logger.
6. **`403` returned for invalid/expired tokens** (`auth.ts`) where `401` is conventional; and `verifyIdToken` is called without the revocation check. Minor, but worth fixing while touching auth.
7. **Strict mode is not actually enforced.** `tsconfig.json` has `strict: false`; the strict `tsconfig.build.json` exists but `npm run build` runs plain `tsc` against `tsconfig.json`, so it's never used. The backend-standards rule "strict mode on" is currently aspirational. Point the build at `tsconfig.build.json` (expect a fix-up pass).
8. **Deploy topology (context for the above):** the Express API deploys to Vercel from the **committed `dist/`** (`vercel.json`, `.vercelignore` excludes `src`; `vercel-build` is a no-op) — currently in sync. Firebase Functions (`functions/`) is a second deploy target holding only the `onCreateUser` auth trigger. Single Firebase project (`video-topic-5bace`) — no staging/prod separation.

---

## 16. Internal `docs/` drift (docs claim "implemented/final" but diverge from code)

The repo's `docs/product/` + `docs/features/` specs need a sync pass alongside the product-doc changes — several will mislead anyone implementing §1–§11:

1. **Research states are fictional:** `docs/features/research/spec.md:54-74` documents `not_started → generating → in_review → completed`; actual `StepStatus` is `not_started | in_progress | completed | stale` (`types/routes/video-project.ts:3`). `video-project/spec.md:44` itself flags the conflict.
2. **Stale modeled as boolean vs status value:** feature specs describe `stale: true` booleans; code (and `pipeline-spec.md`) use `status = "stale"`. Also code's `StaleReason` includes `research_regenerated`, which the pipeline-spec enum omits.
3. **Hook styles wrong in spec:** `hooks/spec.md:63-68` says Question/Shock/Story/Challenge/Promise; actual prompt uses question / bold statement / story teaser / contrarian / revelation (`prompt.ts:184-199,280-302`). The product doc (§3, §5) repeats the spec's stale list.
4. **Onboarding spec's "known gap" is stale:** claims website scraping lives in `UserRepository.getWebsiteContent` as an architecture violation — that method doesn't exist; scraping moved to `ExtractService` (already fixed).
5. **"Publish" stage documented as planned pipeline tail** (`docs/product/overview.md:40,152`) — no code exists; consistent with the product doc's "(→ Publish, future)" but the specs read as nearer-term.
6. **Description length mismatch:** spec says 200–400 words; prompt says 200–500 (`prompt.ts:237`). Product doc says 200–400 (§5 table). Pick one.
7. **Test coverage note:** contrary to older assumptions, `tests/` has substantial unit coverage (video-project service, script/hooks/packaging iteration flows, error handler) + a mocked route integration test. Gaps: no tests for onboarding/user, research, title-intelligence, topic generation/KMeans, repositories, or auth middleware — exactly the areas §1–§11 will touch.

---

## 17. Verification log (what the second pass changed)

- **Corrected:** §14.7 — the 5-long/5-Shorts split IS instructed in `TOPIC_SYSTEM_PROMPT` (first pass missed it by only reading `TOPIC_USER_PROMPT`); the gap is structured output/storage, not the prompt.
- **Corrected:** line citations — packaging regenerate script check (`packaging.service.ts:286-288`, not `:289-294`); title-intelligence cleaning/weighting (`:73-119`, not the pipeline wrappers); per-endpoint packaging validation lines in §3's table.
- **Corrected:** §9 — Firebase Scheduled Functions is an available cron host (the `functions/` codebase was missed in round 1); Vercel Cron is not the only option.
- **Added:** §6/§11 — the `onCreateUser` auth trigger creates user docs without `stats`; §1.5 — the script system prompt is also faceless-documentary (ICP conflict beyond thumbnails); §14.8–14.10; §15 (security/deploy); §16 (docs drift).
- **Verified correct (adversarial pass):** all packaging hard-deps and zero-channel-context claims, no-live-research-at-generation, lifetime-only counters with zero enforcement reads, onboarding validation state, lazy-creation semantics, reconcileView behavior, the 4-endpoint feedback inventory (complete), title-intelligence auth state, absence of image/storage/watermark/billing/cron infra in `src/`.
- **Discarded:** a sweep-agent claim that `gemini-3.5-flash` is an invalid model name — the agent's model knowledge is stale; the app runs on it.

---

## Suggested build order (dependency-driven, not priority-voted)

1. **§13.1 + §15.1–15.3** — re-enable auth on title-intelligence (uncomment `title-intelligence.route.ts:2,12`), lock CORS, stop leaking `detail: error`. Small, live-exposure fixes.
2. **§3 context assembler + prompt rewrites** — unblocks doors, §1, §8, and fixes §14.1. Include the faceless→talking-head prompt rework (§1.5).
3. **§8 research injection** into Idea + packaging (reuses title-intelligence internals; forces the §13.2 placement decision).
4. **§6 onboarding prefill + validation + instant-first-Idea** (depends on §3's assembler working pre-persist).
5. **§1 thumbnail image pipeline** (storage + model + watermark; highest risk — start the quality/cost validation spike early in parallel).
6. **§11 billing + windowed metering** (needs plan fields before §9's gated cron and §1's quotas go live; rate limiting must move off in-memory, §15.4).
7. **§10 feedback flip + §2 lazy-flow polish + §7 relabel sweep + §16 docs sync** — lighter, can trail.
