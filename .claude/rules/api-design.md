---
name: api-design
description: REST conventions and response standards for the MomentumX API — URL structure, HTTP methods, auth pattern, and response shape.
---

# API Design

REST conventions and response standards for the MomentumX API. All endpoints — existing and new — must follow the same shape, auth pattern, and URL structure.

---

## URL Structure

- Base: `/v1`
- Kebab-case paths: `/generate-title` not `/generateTitle`
- Plural nouns for collections: `/topics` not `/topic`
- No trailing slashes

```
✅ /v1/ideas
✅ /v1/scripts/stream/:projectId
✅ /v1/packaging/generate-title
✅ /v1/user/profile

❌ /v1/content/ideas
❌ /v1/packaging/generateTitle
❌ /v1/user/profile/
```

---

## HTTP Methods

```
GET    — read only, no side effects
POST   — create new resource or trigger generation
PATCH  — partial update (not PUT)
DELETE — remove (soft delete via isDeleted flag)
```

---

## Auth

All routes protected with `authMiddleware` at router level:

```typescript
// ✅ Every new router
const router = express.Router();
router.use(authMiddleware);      // identity  → req.userId
router.use(accountMiddleware);   // tenancy   → req.accountId, req.role
router.get('/ideas', controller.getIdeas);
```

Order matters: `accountMiddleware` reads `req.userId`, so mounted first it would resolve the
account for `undefined` on every request. Both mounts, and their order, are pinned by
`tests/unit/auth-coverage.test.ts`.

**Account-context exception:** `GET /v1/accounts` and `POST /v1/accounts` mount
`authMiddleware` but NOT `accountMiddleware`. You cannot present an `X-Account-Id` for a
channel you do not have yet, and a brand-new user's first list call has no channel at all —
with the middleware in front, that request falls into the header-less fallback, which mints
a channel as a side effect of *reading the list*, and once Phase 07 flips
`FALLBACK_ALLOWS_WRITES` to `false` it rejects `POST /v1/accounts` outright: the one call
whose purpose is producing the id the header needs.

The exemption covers those two COLLECTION routes only. Everything under `/:id` sits below
the mount and is account-checked like every other route. Both are still authenticated, and
both scope to `req.userId`. `tests/unit/auth-coverage.test.ts` names them in a shrink-only
allowlist, so a third cannot be added without an explicit edit and a written reason.

**SSE exception:** `GET /v1/scripts/stream/:projectId` uses `?token=` query param.
Reason: browser EventSource API cannot send Authorization headers.
The token is verified by `sseAuthMiddleware` (from `src/middleware/auth.ts`), applied per-route before the controller:

```typescript
router.get(
  "/stream/:projectId",
  sseAuthMiddleware,          // ?token= → req.userId
  resolveAccountFromProject,  // the PROJECT → req.accountId, req.role
  scriptController.generateScript
);
```

No router ships without auth. A router left unprotected "temporarily for testing" is a Critical review finding.

---

## Standard Response Shape — Always

```typescript
// Success
{ success: true, data: unknown, message?: string, meta?: object }

// Error
{ success: false, message: string, code?: ErrorCode, detail?: unknown }
```

Achieved via response helpers — never construct this shape manually:
```typescript
res.sendSuccess({ data, message?, statusCode?, meta? })
res.sendError({ message, statusCode?, code?, detail? })
```

### `code` — the machine-readable reason (Phase 05)

`statusCode` is the HTTP status. `code` is a **separate body field** that says *which*
failure this is, because **403 cannot mean one thing**:

| `code` | Meaning | What the client does |
|---|---|---|
| `account_forbidden` | Not a member of this channel at all | Clear the active account, go to the channel list |
| `wrong_account` | Member of the resource's channel, but acting in a different one | Offer a one-click switch — `detail` carries `{ accountId, displayName }` |
| `role_forbidden` | Member, but the role doesn't allow it | Inline message, stay put |
| `insufficient_credits` | Phase 08 | Show the balance and the reset date |

Without the discriminator a viewer clicking a button the UI failed to disable gets
**ejected from the channel**, and a bookmarked project living in the user's other channel
renders as *"Project not found. It may have been deleted."* — when it is one switch away.

Use the named factories in `utlils/errors.ts` (`AccountForbidden()`, `WrongAccount()`,
`RoleForbidden()`), never a `code` argument on `Forbidden()`: `message`, `detail` and `code`
would be three loosely-typed trailing parameters in a row, which is the positional trap that
put a `batchId` in an `accountId` slot during Phase 03.

`code` and `detail` are forwarded **only for 4xx `HttpError`s**. An unexpected throw gets
neither, so nothing internal leaks and no caller can forge a `code` that drives the client's
branch.

---

## Account Context — `X-Account-Id` (Phase 05)

Every protected router mounts `accountMiddleware` immediately after `authMiddleware`:

```typescript
router.use(authMiddleware);      // who are you        → req.userId
router.use(accountMiddleware);   // which channel      → req.accountId, req.role
```

The header is client-supplied and therefore **forgeable** — all of the safety is the
unconditional membership check inside that one middleware. Never read an account id from
`req.headers`, `req.body`, `req.query` or `req.params` anywhere else; doing so bypasses the
check, which is precisely how one user reads another's channel. Pinned by
`tests/unit/dual-write-coverage.test.ts`.

A missing header falls back to the caller's own channel rather than 400ing, so
already-loaded browser tabs keep working across the deploy. **Phase 07 flips
`FALLBACK_ALLOWS_WRITES` to `false`** in the same commit that makes the frontend send the
header, at which point the fallback becomes read-only.

**SSE exception.** `GET /v1/scripts/stream/:projectId` cannot send headers (`EventSource`),
so it mounts `resolveAccountFromProject` instead, which derives the account from the
**project** and takes nothing account-related from the query string. It sets `req.role` too —
Phase 09 gates exactly this route on it.

**CORS:** `X-Account-Id` must stay in `allowedHeaders` in `app.ts`. Drop it and the browser
strips the header on every preflighted request while the entire test suite still passes.

---

## SSE Response Format — Always

Each content chunk is a **JSON-encoded** string; the terminator is sent raw. The client `JSON.parse`s every `data:` line and stops on the literal `[DONE]`.

```
data: "<JSON-encoded text chunk>"\n\n     ← e.g. data: "Hello, "  then  data: "world"
data: [DONE]\n\n                          ← always end with this (raw, not JSON)
```

JSON-encoding the chunk keeps embedded newlines in multi-line content (scripts) from being interpreted as SSE event boundaries.

---

## Standard HTTP Status Codes

| Situation | Status |
|---|---|
| Successful read | 200 |
| Successful create | 201 |
| Bad request / missing fields | 400 |
| Not authenticated — missing, malformed or invalid token | **401** |
| Authenticated, but not allowed to touch this resource | **403** |
| Resource not found | 404 |
| Channel tombstoned (existed, now deleted) | **410** |
| Server error / service failure | 500 |
| Upstream (Gemini / YouTube) produced nothing usable | 503 |

**401 and 403 are not interchangeable, and this table used to say otherwise** — it
listed "Unauthorized / invalid token → 403". The code was always right:
`authMiddleware` and `sseAuthMiddleware` return **401** for a missing, malformed or
invalid token, which is correct HTTP semantics — *who are you?* — while **403** means
*I know who you are, and no*.

Keeping them distinct is load-bearing, not pedantry:

- `Forbidden()` (`utlils/errors.ts`) is 403 and is what every ownership check throws.
- The multi-account plan builds its whole client contract on 403 meaning permission:
  `account_forbidden`, `wrong_account` and `role_forbidden` are all 403 with different
  `code` values, and the frontend branches on them (eject to the channel list vs. offer
  a switch vs. show an inline message). A 401 in that set would mean "log in again" and
  send the user somewhere completely different.
- `error_handler.ts`'s `STRING_SENTINELS` map is a legacy fallback for bare
  `throw new Error("...")` calls. It does **not** fire for auth failures — `auth.ts`
  calls `res.sendError` directly rather than throwing — and an `HttpError` always wins
  over it, so the `Unauthorized()` factory's 401 is what reaches the client.

---

## userId — Never From Request Body

```typescript
// ✅ Always from middleware
const userId = req.userId;

// ❌ Never trust client for identity
const userId = req.body.userId;
const userId = req.query.userId as string;
```

---

## Query Params — Always a String by the Time You Read Them

`req.query.x as string` is a lie Express is happy to tell: `?q=a&q=b` parses to an
array and `?q[x]=1` to an object. `queryNormalizer` (`src/middleware/query_normalizer.ts`,
mounted in `app.ts` before the routes) collapses both to a single string — last
occurrence wins — so the casts in the controllers are true at runtime.

Before it existed, `GET /v1/research/keywords?query=a&query=b` reached
`query.trim()` as an array and returned **500 "Something went wrong"** for what is
a client-side mistake. If a route ever needs a genuine array or a typed query,
give that route a zod schema — do not widen the normalizer.

---

## Owning IDs — Derive From the Stored Doc, Not the Body

For an operation on an **existing** document, resolve its owning/related resource IDs from the stored document — never from the request body. Accepting such IDs from the client lets a caller bind one resource to the wrong related resource.

```typescript
// ✅ Operation on an existing hooks batch: resolve the project from the stored doc
const batch = await repo.findById(hooksId);
const videoProjectId = batch.videoProjectId;        // stored, server-trusted

// ❌ Trusting a client-supplied owning id on an existing doc
const { videoProjectId } = req.body;                // can point at the wrong project
```

Only accept these IDs in the body for **create/generate** operations, where the document does not yet exist (e.g. `POST /v1/hooks/generate`, `POST /v1/packaging/generate-*`). For `select`/`regenerate`/edit on an existing doc, derive them. (Same spirit as the `userId` rule above, extended to relational ownership.)

---

## Collection Names — Never Hardcode Strings

```typescript
// ✅ Always use enum
db.collection(COLLECTIONS.IDEAS)

// ❌ Never hardcode
db.collection('ideas')
```

All collection names live in `src/constants/collection.ts`. Add new names there — never inline strings.

---

## Existing Route Structure

Snapshot of the API surface. When exact behavior matters, verify against `src/routes/v1/` — the route files are the source of truth. When you add or change an endpoint, update this list in the same change.

```
/v1/health                     — unauthenticated health check (registered in index.ts)

/v1/accounts                   — channels (Phase 06a)
  GET   /                      — the switcher's list + activeAccountId.
                                 EXEMPT FROM accountMiddleware (see below)
  POST  /                      — create a channel. EMPTY BODY, deliberately —
                                 onboarding runs against the new id afterwards.
                                 EXEMPT FROM accountMiddleware (see below)
  GET   /:id                   — one channel in full (settings screen)
  PATCH /:id                   — rename (owner only)
  POST  /:id/activate          — set lastActiveAccountId. 204.
  DELETE /:id                  — owner only; 400s on the user's LAST channel

/v1/user
  POST  /onboarding/prefill    — infer {niche, targetAudience, brandName} from a channel URL (suggestions, not persisted)
  PATCH /onboarding            — complete brand setup (required minimum: channel URL, OR niche + targetAudience)
  POST  /refresh-context       — re-pull channel/website enrichment from stored inputs (no body)
  GET   /profile               — get user profile (+ completeness score)
  PATCH /profile               — update profile

/v1/ideas
  POST  /generate              — ADD 10 ideas to the active list ("Generate More").
                                 ADDITIVE BY DESIGN: it does NOT archive what's already
                                 there. Only /regenerate-all archives. The missing
                                 archiveUserIdeas call is intentional — do not "fix" it.
  GET   /                      — list saved ideas
  GET   /export                — export active batch as text
  POST  /regenerate-all        — archive + regenerate full batch
  PATCH /edit/:ideaId          — update idea working title
  POST  /:ideaId/regenerate    — regenerate single idea slot

/v1/scripts
  GET   /stream/:projectId     — SSE: generate + stream script (?token= auth)
  GET   /                      — list saved scripts
  GET   /:scriptId             — get single script
  PATCH /edit/:scriptId        — update script content
  POST  /:scriptId/regenerate  — regenerate script (non-SSE)
  GET   /:scriptId/export      — export script as plain text

/v1/hooks
  POST  /generate              — generate 5-hook batch tied to video project
  POST  /:hooksId/select       — select a hook, completes hooks step
  POST  /:hooksId/regenerate   — regenerate hooks, cascades stale to packaging
  GET   /:hooksId/export       — export hooks as plain text

/v1/packaging
  # generate-* PERSIST server-side: each writes its item straight into the project's
  # packaging doc (created on the first generation), sets that item's status, and
  # returns the content + packagingId. The step is in_progress until all four items
  # exist, then auto-completes. Clients never round-trip generated content back to
  # /save. Without a videoProjectId these are stateless previews (no persist).
  POST  /generate-title        — generate 3 title variations (persists → { titles, packagingId })
  POST  /generate-description  — generate SEO description (persists → { description, packagingId })
  POST  /generate-thumbnail    — generate thumbnail brief (persists → { descriptions, packagingId })
  POST  /generate-shorts       — generate Shorts script (persists → { segments, totalDuration, packagingId })
  POST  /save                  — persist USER EDITS only (edited title/description text,
                                  thumbnail selection). Generated content is already saved by
                                  the generate-* endpoints. script/hooks are NOT accepted in the
                                  body — server-resolved. A door save without videoProjectId
                                  creates ONE project and returns it on the saved doc; the client
                                  must adopt that id or repeat saves mint duplicates)
  GET   /list                  — list user's packaging
  GET   /:packagingId          — get single packaging
  POST  /:packagingId/regenerate/:item — regenerate one packaging item
  POST  /:packagingId/select-title — finalize a title → updates the project's display title
  GET   /:packagingId/export   — export full package as text

/v1/research
  GET   /trending              — trending videos in user's niche (YouTube API)
  GET   /competitors           — top videos from competitor channels (YouTube API)
  GET   /keywords              — keyword signals for a query (YouTube API)

/v1/video-projects
  POST  /                      — create a new video project
  GET   /                      — list all video projects
  GET   /:projectId            — get single project
  PATCH /:projectId            — update project
  DELETE /:projectId           — soft delete project
  PATCH /:projectId/step/:stepName/complete — mark a pipeline step complete
                                              (stepName ∈ script|hooks|title|packaging;
                                               no /start route: generation endpoints
                                               set in_progress server-side)
  PATCH /:projectId/link/:resourceType      — link a resource (script/hooks/packaging) to the project
```

Pipeline steps (state machine): **research → script → hooks → title → packaging**.
The Title step is post-script: `POST /packaging/generate-title` starts it (in_progress);
`POST /packaging/:id/select-title` completes it (and renames the project). The Packaging
step then covers description + thumbnail + shorts, and auto-completes once those three
exist. Legacy projects created before the title step default `pipeline.title` on read.

Note: `/v1/ideas` generates **ideas** (video concepts with `concept`/`workingTitle`/`ideaType`/`evidence`), grounded in live trending + keyword research. (The legacy `/v1/topics` path + all "topic" naming were renamed to "idea" in P6A — step 1 is **Idea**; **Title** is now its own post-script pipeline step, distinct from **Packaging** (description/thumbnail/shorts); "topic" is retired.) The former `/v1/title-intelligence` routes were retired in phase 2 — `title-intelligence.service.ts` remains as the engine reserved for the post-script Title step; the research half lives in `research-context.service.ts`.
