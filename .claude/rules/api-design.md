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
✅ /v1/content/topics
✅ /v1/packaging/generate-title
✅ /v1/user/profile

❌ /v1/content/topic
❌ /v1/packaging/generateTitle
❌ /v1/user/profile/
```

---

## HTTP Methods

```
GET    — read only, no side effects
POST   — create new resource or trigger generation
PATCH  — partial update (not PUT)
DELETE — remove (not yet used — follow this when added)
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

**SSE exception:** `GET /v1/content/stream/scripts/:scriptId` uses `?token=` query param.
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

/v1/content
  GET   /stream/topics         — SSE: generate + stream 10 topic ideas
  GET   /stream/scripts/:id    — SSE: generate + stream script (?token= auth)
  GET   /topics                — list saved topics
  GET   /scripts               — list saved scripts
  GET   /script/:scriptId      — get single script
  PATCH /topics/edit/:topicId  — update topic
  PATCH /script/edit/:scriptId — update script

/v1/packaging
  POST /generate-title         — generate 3 title variations
  POST /generate-description   — generate SEO description
  POST /generate-thumbnail     — generate thumbnail brief
  POST /generate-hooks         — generate 5 hook variations
  POST /generate-shorts        — generate Shorts script
  POST /save                   — save packaging to Firestore
  GET  /list                   — list user's packaging
  GET  /:packagingId           — get single packaging
```
