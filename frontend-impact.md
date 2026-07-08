# Frontend Impact Log — Backend Phase Rollout

> Running log of frontend changes required by each backend phase
> (see `implementation-phases.md`). Updated as each phase merges.
> Items marked **required** break or degrade the FE if ignored; **check** items
> need verification but may already be handled.

---

## Phase 0A — Security hardening (branch: `feature/phase-0a-security-hardening`)

### 1. Auth failures now return `401` (previously `403`) — **check, likely required**

- Invalid/expired Firebase tokens on **every** protected route (and the SSE `?token=` route) now return **`401`** with `{ success: false, message: "Unable to authenticate" }`. Previously this was `403`.
- `403` is now reserved for **ownership** failures (accessing someone else's resource).
- **FE action:** any interceptor/handler that triggers token-refresh or logout on `403` must trigger on `401` instead. If the FE already treats both as "re-authenticate," no change.

### 2. CORS is now origin-locked — **required (deploy config, not code)**

- The API no longer reflects any origin. Allowed origins come from the backend `ALLOWED_ORIGINS` env var; when unset, only `localhost:*` works (dev fallback).
- **FE action:** supply the exact production origin(s) — and note that **Vercel preview URLs** (`*-git-*.vercel.app`) will be blocked unless explicitly added or a wildcard strategy is agreed. Local dev on `localhost` keeps working with no config.

### 3. Title-intelligence endpoints — superseded by Phase 2

- The P0A auth-hardening of `POST /v1/title-intelligence/*` is moot: Phase 2 **removed** these routes entirely (see Phase 2 §2). No FE action from this item.

### 4. Title-intelligence error responses changed shape/status — **check**

- The `detail` field no longer carries a raw error object (it carried internal error data before; nothing useful was in it for users).
- Service-level validation errors now surface with their real status (e.g. `400`) instead of everything collapsing into a generic failure. Unexpected errors return `500` with a generic message.
- **FE action:** none if the FE only reads `message`; remove any debugging reliance on `detail`.

### 5. Helmet security headers — no action

- Standard security headers added to all responses. No effect on JSON API consumption.

---

## Phase 1 — Best-available context (branch: `feature/phase-1-context-assembler`)

All changes are **backward-compatible** — every existing call keeps working. New, looser input shapes are now accepted:

| Endpoint | Before | Now |
|----------|--------|-----|
| `POST /packaging/generate-title` | `script` required | `script` **or** `videoProjectId` (stored script resolved server-side) |
| `POST /packaging/generate-description` | `script` + `title` required | `title` only; `script` optional (resolved from project if linked) |
| `POST /packaging/generate-thumbnail` | `script` + `title` required | `title` only — **works as a standalone door** |
| `POST /packaging/generate-shorts` | `script` + `duration` | unchanged |
| `POST /packaging/:id/regenerate/:item` | `script` required always | `script` optional — resolved from the stored project; per-item rules apply (title/shorts still need a script to exist somewhere) |
| `POST /hooks/generate` | `videoProjectId` + `script` | `videoProjectId` only; `script` optional |
| `POST /hooks/:id/regenerate` | `script` required | `script` optional |
| `PATCH /user/onboarding` | — | new optional `format` field: `"talking_head"` (default) or `"faceless"`; other values → 400 |

Notes for FE:
- Passing `script` in a body still works and **wins** over the stored one (supports edited-but-unsaved scripts).
- Generation output now reflects channel context (niche/audience/brand/top titles) — expect more personalized results, same JSON shapes.
- New 400 message on generate-title when neither script nor videoProjectId is sent: `"Provide a script or a videoProjectId with a generated script"`.
- A "format" toggle (talking-head vs faceless) can now be added to onboarding/profile UI.

---

## Phase 2 — Idea generation (branch: `feature/phase-2-idea-generation`)

**Step 1 is now IDEA generation, not title generation.** The pipeline is Idea → Script → Title: step 1 produces researched video *concepts*; optimized headlines come post-script at the Title step.

### 1. Idea objects have new fields — **required to display**

`POST /v1/topics/generate`, `/regenerate-all`, `/:topicId/regenerate` and `GET /v1/topics` docs now carry:

```json
{
  "title": "working title (plain-language handle — NOT an optimized headline)",
  "concept": "1-3 sentence description of the video angle",
  "ideaType": "long" | "short",
  "evidence": "research grounding, e.g. 'competitor videos on X pulling 500K+ views'" | null
}
```

- `title` keeps its old meaning as the display/working title, so nothing breaks — but the FE should now surface `concept` (the idea itself), the long/Shorts split via `ideaType`, and `evidence` as the "why this, why now" grounding chip.
- **Legacy saved topics don't have the new fields** — treat all three as optional.
- Ideas are grounded in live trending + search signals for the user's niche; if YouTube is unavailable, generation still works (evidence will be empty).

### 2. `/v1/title-intelligence/*` routes are REMOVED — **required if used**

`POST /v1/title-intelligence/generate` and `/deep-generate` no longer exist (404). Their scoring engine is being folded into the post-script Title step (packaging). Remove any FE calls.

### 3. Copy changes — cosmetic

Response messages now say "ideas" ("successfully generated ideas", "Ideas regenerated successfully"); the export is titled "Video Ideas" and includes concepts + [Shorts] tags. Route paths (`/v1/topics/...`) are unchanged.

---

### 4. Title step is research-grounded and scored (P2‑C) — **display recommended**

`POST /v1/packaging/generate-title` (and title regeneration) now returns scored variations:

```json
{ "titles": [ { "title": "...", "characterCount": 62, "score": 8, "reason": "contrarian, strong curiosity gap" } ] }
```

- `score` (1-10 CTR potential vs live competition) and `reason` are new — show them as a quality badge/tooltip. `title`/`characterCount` unchanged, so existing rendering keeps working.
- Titles are grounded in live competitive research for the video's topic; on YouTube outage generation still works (context-only).
- Previously saved packaging docs have unscored titles — treat `score`/`reason` as optional.

---

## Heads-up: contract changes coming in later phases (plan, don't build yet)

| Phase | Expected FE impact |
|-------|--------------------|
| P3 | Onboarding: new `POST /v1/user/onboarding/prefill` (URL → suggested niche/audience/brand); required fields drop to URL-only or niche+audience; profile gains a completeness score; new `POST /v1/user/refresh-context`. Real 400 validation errors on malformed input |
| P4 | Thumbnail responses gain image URLs (`thumbnailImages[]`) alongside text briefs; free-tier images are watermarked |
| P5 | Quota errors: generation/project-create endpoints return machine-readable quota errors (e.g. `{ code: "free_project_limit" }`) that the FE must render as the upgrade wall; billing/upgrade flow UI |
| P6A | The 4 like/dislike feedback endpoints are **removed** (buttons must go in the same release); responses gain `recommendedNextStep` for guided CTAs; "topic" copy becomes "idea" |

*(This table mirrors `implementation-phases.md` — details will be filled in per phase as each merges.)*
