---
name: api-design
description: Implementation recipes for MomentumX endpoints — route file structure, controller pattern, auth wiring, and SSE controller. Use when building new endpoints.
---

# API Endpoint Implementation Reference

The conventions themselves (URL structure, methods, status codes, response shape, identity rules) and the full route inventory are enforced in `.claude/rules/api-design.md` — read that first. This file is the code-level recipe.

## Route File Structure

```typescript
// src/routes/v1/{feature}.route.ts
import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import FeatureRepository from "../../repository/feature.repository.js";
import FeatureService from "../../service/feature.service.js";
import FeatureController from "../../controller/feature.controller.js";

const router = Router();

// Instantiation happens in the route file
const repo = new FeatureRepository();
const service = new FeatureService(repo);
const controller = new FeatureController(service);

router.use(authMiddleware); // every router — no exceptions

router.get("/", controller.list.bind(controller));
router.get("/:id", controller.getById.bind(controller));
router.post("/", controller.create.bind(controller));
router.patch("/:id", controller.update.bind(controller));

export default router;
```

Note the `.js` extensions on relative imports (ESM output) and the `.bind(controller)` on every handler.

## Registering the Router

Routers register in `src/routes/v1/index.ts` — NOT in `app.ts`:

```typescript
import featureRouter from "./feature.route.js";
router.use("/feature", featureRouter);
```

## Auth Wiring

- Standard routes: `router.use(authMiddleware)` at router level; `authMiddleware` sets `req.userId` from the Firebase JWT.
- SSE routes: apply `sseAuthMiddleware` per-route (it reads `?token=` because EventSource can't send headers):

```typescript
import { authMiddleware, sseAuthMiddleware } from "../../middleware/auth.js";

router.get("/stream/:projectId", sseAuthMiddleware, scriptController.generateScript);
router.use(authMiddleware); // everything below is header-auth
```

Do NOT hand-verify tokens in controllers — both middlewares live in `src/middleware/auth.ts`.

## Controller Pattern

Thin: validate, delegate, respond via helpers.

```typescript
export default class ContentController {
  constructor(private contentService: ContentService) {}

  async updateTopic(req: Request, res: Response) {
    try {
      const { title } = req.body as { title: string };
      if (!title) {
        res.sendError({ message: "title is required", statusCode: 400 });
        return;
      }
      const updated = await this.contentService.updateTopic(
        req.params.topicId,
        req.userId,   // identity ALWAYS from middleware, never the body
        title
      );
      res.sendSuccess({ data: updated, message: "Topic updated" });
    } catch (error) {
      res.sendError({ message: "Failed to update topic", detail: error });
    }
  }
}
```

Response helpers (`res.sendSuccess` / `res.sendError`) are attached by `src/middleware/response_formatter.ts`. Never use raw `res.json()`.

## SSE Controller

Once `res.flushHeaders()` fires you can no longer `sendError` — the stream is open. Termination is guaranteed by `finally`, and the terminator is always `[DONE]` (there is no `[ERROR]` sentinel in this codebase):

```typescript
res.setHeader("Content-Type", "text/event-stream");
res.setHeader("Cache-Control", "no-cache");
res.setHeader("Connection", "keep-alive");
res.flushHeaders();

try {
  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) res.write(`data: ${JSON.stringify(text)}\n\n`); // JSON-encode every chunk
  }
} catch (streamError) {
  console.error("SSE stream error", streamError);
} finally {
  res.write("data: [DONE]\n\n");
  res.end();
}

// Post-stream persistence in its OWN try/catch — must not affect the finished stream
try {
  await saveScript(...);
} catch (saveError) {
  console.error("Post-stream save error", saveError);
}
```

Validate everything you can (auth, project exists, ownership) BEFORE `flushHeaders()` — that's your last chance to return a proper error response.

## Errors That Belong to Each Layer

- Controller: input validation → 400; catch-all → `sendError` with sensible message
- Service: throws (`throw new Error('Topic not found')`) — never returns error objects
- Repository: returns `null` for missing/not-owned docs; propagates Firestore errors naturally
