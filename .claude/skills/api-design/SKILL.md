---
name: api-design
description: Reference for MomentumX REST API conventions, endpoint patterns, and response shapes. Use when designing or building new endpoints.
---

# API Design Reference

## Base URL and Path Conventions

- Base: `/v1`
- Kebab-case: `/generate-title`, not `/generateTitle`
- Plural nouns: `/topics`, not `/topic`
- No trailing slashes

## Auth Pattern

Every router applies `authMiddleware`:

```typescript
import { authMiddleware } from '../../middleware/auth.middleware';

const router = express.Router();
router.use(authMiddleware); // apply once at router level
router.get('/topics', controller.getTopics.bind(controller));
```

**SSE exception:** `GET /stream/scripts/:scriptId` uses `?token=` query param because EventSource API cannot send Authorization headers. Token is verified manually:

```typescript
async streamScript(req: Request, res: Response) {
  const token = req.query.token as string;
  if (!token) {
    res.sendError({ message: 'Missing token', statusCode: 403 });
    return;
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const userId = decoded.uid;
    // proceed with stream
  } catch {
    res.sendError({ message: 'Invalid token', statusCode: 403 });
  }
}
```

## Response Helpers

Never use `res.json()` directly. Always use:

```typescript
// Success
res.sendSuccess({ data: result })
res.sendSuccess({ data: result, message: 'Topics generated' })
res.sendSuccess({ data: result, statusCode: 201 })
res.sendSuccess({ data: items, meta: { total: items.length } })

// Error
res.sendError({ message: 'Failed to get topics' })
res.sendError({ message: 'Topic not found', statusCode: 404 })
res.sendError({ message: 'Generation failed', detail: error })
```

## Controller Pattern

Thin controller — validate, delegate, respond:

```typescript
export class ContentController {
  constructor(private contentService: ContentService) {}

  async getTopics(req: Request, res: Response) {
    try {
      const topics = await this.contentService.getTopicsByUser(req.userId);
      res.sendSuccess({ data: topics });
    } catch (error) {
      res.sendError({ message: 'Failed to get topics', detail: error });
    }
  }

  async updateTopic(req: Request, res: Response) {
    try {
      const { title } = req.body as { title: string };
      const updated = await this.contentService.updateTopic(
        req.params.topicId,
        req.userId,
        title
      );
      res.sendSuccess({ data: updated, message: 'Topic updated' });
    } catch (error) {
      res.sendError({ message: 'Failed to update topic', detail: error });
    }
  }
}
```

## HTTP Status Codes

| Status | When |
|---|---|
| 200 | Successful read or update |
| 201 | Successful create |
| 400 | Missing/invalid request fields |
| 403 | Missing or invalid auth token |
| 404 | Resource not found |
| 500 | Unexpected server error |

## Route File Structure

```typescript
// src/routes/v1/{feature}.route.ts
import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';
import { FeatureController } from '../../controller/feature.controller';
import { FeatureService } from '../../service/feature.service';
import { FeatureRepository } from '../../repository/feature.repository';

const router = Router();

const repo = new FeatureRepository();
const service = new FeatureService(repo);
const controller = new FeatureController(service);

router.use(authMiddleware);

router.get('/', controller.list.bind(controller));
router.get('/:id', controller.getById.bind(controller));
router.post('/', controller.create.bind(controller));
router.patch('/:id', controller.update.bind(controller));

export default router;
```

## Registering a New Route

In `src/app.ts`:

```typescript
import featureRouter from './routes/v1/feature.route';
app.use('/v1/feature', featureRouter);
```

## SSE Endpoint Pattern

```typescript
router.get('/stream/something', controller.streamSomething.bind(controller));

// Controller method
async streamSomething(req: Request, res: Response) {
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const stream = await this.service.generateStreaming(req.userId);
    for await (const chunk of stream) {
      if (chunk) res.write('data: ' + chunk + '\n\n');
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    // Can't sendError after flushHeaders — stream is already open
    res.write('data: [ERROR]\n\n');
    res.end();
  }
}
```

## Existing Endpoints Quick Reference

```
GET    /v1/user/profile
PATCH  /v1/user/profile
PATCH  /v1/user/onboarding

POST   /v1/topics/generate
GET    /v1/topics
GET    /v1/topics/export
POST   /v1/topics/regenerate-all
PATCH  /v1/topics/edit/:topicId
POST   /v1/topics/:topicId/regenerate
PATCH  /v1/topics/:topicId/feedback

GET    /v1/scripts/stream/:scriptId    (SSE, ?token= auth)
GET    /v1/scripts
GET    /v1/scripts/:scriptId
PATCH  /v1/scripts/edit/:scriptId
POST   /v1/scripts/:scriptId/regenerate
PATCH  /v1/scripts/:scriptId/feedback
GET    /v1/scripts/:scriptId/export

POST   /v1/hooks/generate
POST   /v1/hooks/:hooksId/select
POST   /v1/hooks/:hooksId/regenerate
PATCH  /v1/hooks/:hooksId/feedback
GET    /v1/hooks/:hooksId/export

POST   /v1/packaging/generate-title
POST   /v1/packaging/generate-description
POST   /v1/packaging/generate-thumbnail
POST   /v1/packaging/generate-shorts
POST   /v1/packaging/save
GET    /v1/packaging/list
GET    /v1/packaging/:packagingId
POST   /v1/packaging/:packagingId/regenerate/:item
PATCH  /v1/packaging/:packagingId/feedback
GET    /v1/packaging/:packagingId/export

GET    /v1/research/trending
GET    /v1/research/competitors
GET    /v1/research/keywords

POST   /v1/video-projects
GET    /v1/video-projects
GET    /v1/video-projects/:projectId
PATCH  /v1/video-projects/:projectId
DELETE /v1/video-projects/:projectId
```
