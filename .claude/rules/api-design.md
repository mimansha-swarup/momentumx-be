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
✅ /v1/scripts/stream/:scriptId
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

**SSE exception:** `GET /v1/scripts/stream/:scriptId` uses `?token=` query param.
Reason: browser EventSource API cannot send Authorization headers.
Token is verified manually in the controller before the stream starts.

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

```
data: <text chunk>\n\n
data: [DONE]\n\n         ← always end with this
```

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

## Collection Names — Never Hardcode Strings

```typescript
// ✅ Always use enum
db.collection(Collection.TOPICS)

// ❌ Never hardcode
db.collection('topics')
```

All collection names live in `src/constants/collection.ts`. Add new names there — never inline strings.

---

## Existing Route Structure

```
/v1/user
  PATCH /onboarding            — complete brand setup
  GET   /profile               — get user profile
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
  GET   /stream/:scriptId      — SSE: generate + stream script (?token= auth)
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
```
