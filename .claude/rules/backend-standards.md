---
name: backend-standards
description: Non-negotiable conventions for MomentumX backend — 4-layer architecture, file naming, TypeScript, and error handling.
---

# Backend Standards

Non-negotiable conventions for the MomentumX backend. Every agent building or reviewing code must follow these. Covers architecture, file naming, TypeScript, and error handling.

---

## 4-Layer Architecture (Strictly Enforced)

```
Routes → Controllers → Services → Repositories
```

- No Firestore access outside repositories
- No business logic in controllers — delegate to services
- No service calls in routes — delegate to controllers
- Controllers are thin: validate input, call service, send response

**Violation examples to catch and reject:**
```typescript
// ❌ Firestore in a service
async getTopics(userId: string) {
  const snap = await db.collection('topics').where('userId', '==', userId).get(); // WRONG
}

// ❌ Business logic in a controller
async generateTopics(req: Request, res: Response) {
  const user = await this.repo.getUser(req.userId);
  const clusters = kmeans(user.embeddings, 8); // WRONG — belongs in service
  res.sendSuccess({ data: clusters });
}
```

---

## File Naming — `{resource}.{layer}.ts`

Folder names are **singular**: `src/controller/`, `src/service/`, `src/repository/` (NOT `controllers/`, `services/`, `repositories/`).

```
✅ user.controller.ts       ✅ content.service.ts
✅ packaging.repository.ts  ✅ extract.service.ts

❌ userController.ts        ❌ ContentService.ts
❌ packaging_repository.ts
```

---

## Legacy Typo — DO NOT Fix

`src/utlils/` — folder name is a typo for `utils`. Do NOT rename. Renaming breaks all existing imports. Work with it as-is.

---

## TypeScript — Always

- No `any` type — use proper interfaces
- No untyped `req.body` — type request bodies explicitly
- `req.userId: string` — set by authMiddleware, always available on protected routes
- Strict mode on — do not disable

```typescript
// ✅ Typed request body
interface GenerateTopicsBody {
  // no body required for this endpoint
}

// ✅ Typed repository return
async getUser(userId: string): Promise<User | null> {
  const doc = await db.collection(Collection.USERS).doc(userId).get();
  if (!doc.exists) return null;
  return doc.data() as User;
}

// ❌ any kills type safety
const user: any = doc.data();
```

---

## Response Helpers — Always Use, Never Raw res.json

```typescript
// ✅ Success
res.sendSuccess({ data, message?, statusCode?, meta? })

// ✅ Error
res.sendError({ message, statusCode?, detail? })

// ❌ Never
res.json({ success: true, data })
res.status(500).json({ error: 'something failed' })
```

---

## Error Handling — Non-Negotiable

```typescript
// ✅ Services throw — errors propagate up
async getUser(userId: string) {
  const user = await this.userRepo.get(userId);
  if (!user) throw new Error('User not found');
  return user;
}

// ✅ Controllers catch — send error response
async getProfile(req: Request, res: Response) {
  try {
    const user = await this.userService.getUser(req.userId);
    res.sendSuccess({ data: user });
  } catch (error) {
    res.sendError({ message: 'Failed to get profile', detail: error });
  }
}

// ❌ Never do these
catch (error) {
  console.log("error", error); // silent failure
  return {};
}

catch (error) {
  // swallowed silently — bugs become invisible
}
```

---

## Auth — Always Per-Router, Never Global

```typescript
// ✅ Correct — applied at router level
router.use(authMiddleware);
router.get('/profile', controller.getProfile);

// ❌ Wrong — applied globally in app.ts
app.use(authMiddleware);
```

---

## Service Instantiation Pattern

```typescript
const repo = new UserRepository();
const service = new UserService(repo);
const controller = new UserController(service);
```

---

## userId — Always From Middleware

```typescript
// ✅ From authMiddleware
const userId = req.userId;

// ❌ Never trust client for identity
const userId = req.body.userId;
```
