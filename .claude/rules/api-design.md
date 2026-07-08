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
✅ /v1/topics
✅ /v1/scripts/stream/:projectId
✅ /v1/packaging/generate-title
✅ /v1/user/profile

❌ /v1/content/topics
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
router.use(authMiddleware);
router.get('/topics', controller.getTopics);
```

**SSE exception:** `GET /v1/scripts/stream/:projectId` uses `?token=` query param.
Reason: browser EventSource API cannot send Authorization headers.
The token is verified by `sseAuthMiddleware` (from `src/middleware/auth.ts`), applied per-route before the controller:

```typescript
router.get("/stream/:projectId", sseAuthMiddleware, scriptController.generateScript);
```

No router ships without auth. A router left unprotected "temporarily for testing" is a Critical review finding.

---

## Standard Response Shape — Always

```typescript
// Success
{ success: true, data: unknown, message?: string, meta?: object }

// Error
{ success: false, message: string, detail?: unknown }
```

Achieved via response helpers — never construct this shape manually:
```typescript
res.sendSuccess({ data, message?, statusCode?, meta? })
res.sendError({ message, statusCode?, detail? })
```

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
| Unauthorized / invalid token | 403 |
| Resource not found | 404 |
| Server error / service failure | 500 |

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
db.collection(COLLECTIONS.TOPICS)

// ❌ Never hardcode
db.collection('topics')
```

All collection names live in `src/constants/collection.ts`. Add new names there — never inline strings.

---

## Existing Route Structure

Snapshot of the API surface. When exact behavior matters, verify against `src/routes/v1/` — the route files are the source of truth. When you add or change an endpoint, update this list in the same change.

```
/v1/health                     — unauthenticated health check (registered in index.ts)

/v1/user
  POST  /onboarding/prefill    — infer {niche, targetAudience, brandName} from a channel URL (suggestions, not persisted)
  PATCH /onboarding            — complete brand setup (required minimum: channel URL, OR niche + targetAudience)
  POST  /refresh-context       — re-pull channel/website enrichment from stored inputs (no body)
  GET   /profile               — get user profile (+ completeness score)
  PATCH /profile               — update profile

/v1/topics
  POST  /generate              — generate 10 topic ideas
  GET   /                      — list saved topics
  GET   /export                — export active batch as text
  POST  /regenerate-all        — archive + regenerate full batch
  PATCH /edit/:topicId         — update topic title
  POST  /:topicId/regenerate   — regenerate single topic slot
  PATCH /:topicId/feedback     — like/dislike on a topic

/v1/scripts
  GET   /stream/:projectId     — SSE: generate + stream script (?token= auth)
  GET   /                      — list saved scripts
  GET   /:scriptId             — get single script
  PATCH /edit/:scriptId        — update script content
  POST  /:scriptId/regenerate  — regenerate script (non-SSE)
  PATCH /:scriptId/feedback    — like/dislike on a script
  GET   /:scriptId/export      — export script as plain text

/v1/hooks
  POST  /generate              — generate 5-hook batch tied to video project
  POST  /:hooksId/select       — select a hook, completes hooks step
  POST  /:hooksId/regenerate   — regenerate hooks, cascades stale to packaging
  PATCH /:hooksId/feedback     — per-hook like/dislike
  GET   /:hooksId/export       — export hooks as plain text

/v1/packaging
  POST  /generate-title        — generate 3 title variations
  POST  /generate-description  — generate SEO description
  POST  /generate-thumbnail    — generate thumbnail brief
  POST  /generate-shorts       — generate Shorts script
  POST  /save                  — save packaging to Firestore
  GET   /list                  — list user's packaging
  GET   /:packagingId          — get single packaging
  POST  /:packagingId/regenerate/:item — regenerate one packaging item
  PATCH /:packagingId/feedback — per-item like/dislike
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
  PATCH /:projectId/step/:stepName/start    — mark a pipeline step in progress
  PATCH /:projectId/step/:stepName/complete — mark a pipeline step complete
  PATCH /:projectId/link/:resourceType      — link a resource (topic/script/hooks/packaging) to the project
```

Note: `/v1/topics` generates **ideas** (video concepts with `concept`/`workingTitle`/`ideaType`/`evidence`), grounded in live trending + keyword research. The route path keeps the legacy "topics" name for FE compatibility (rename decision tracked for P6A). The former `/v1/title-intelligence` routes were retired in phase 2 — `title-intelligence.service.ts` remains as the engine reserved for the post-script Title step; the research half lives in `research-context.service.ts`.
