---
name: testing-patterns
description: Reference for Jest unit tests and Supertest integration tests in MomentumX — mock setups, response assertions, auth and SSE testing. Use when writing tests for services, controllers, or utilities.
---

# Testing Patterns Reference

## Stack

- **Runner:** Jest via `jest.config.cjs` (`npm test`), ts-jest for TypeScript
- **Integration:** Jest + Supertest (`src/app.ts` default-exports the Express app)
- **Must mock:** Firebase (via the config module), Gemini (`@google/generative-ai`), and YouTube (**`global.fetch`** — see below)

`src/__tests__/` does not exist yet — create it on first use:

```
src/__tests__/
├── services/       content.service.test.ts, packaging.service.test.ts, ...
├── controllers/    topic.controller.test.ts, ...
└── utils/          content.utils.test.ts
```

## Mocking Firebase — Mock the Config Module, Not firebase-admin

All Firestore access goes through `src/config/firebase.ts` (`export { db, firebase, auth }`), so mock that one module instead of reconstructing the whole `firebase-admin` surface:

```typescript
const mockGet = jest.fn();
const mockSet = jest.fn();
const mockUpdate = jest.fn();
const mockBatchCommit = jest.fn().mockResolvedValue(undefined);
const mockVerifyIdToken = jest.fn();

jest.mock("../../config/firebase.js", () => ({
  db: {
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({ get: mockGet, set: mockSet, update: mockUpdate }),
      add: jest.fn(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: mockGet,
    }),
    batch: jest.fn().mockReturnValue({ set: jest.fn(), commit: mockBatchCommit }),
  },
  firebase: {
    firestore: { FieldValue: { serverTimestamp: jest.fn().mockReturnValue("SERVER_TS") } },
  },
  auth: { verifyIdToken: mockVerifyIdToken },
}));
```

This also short-circuits the real module's `initializeApp` + service-account parsing, which would otherwise run (and fail) at import time in tests.

## Mocking Gemini

```typescript
const mockGenerateContentStream = jest.fn();
const mockEmbedContent = jest.fn();

jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContentStream: mockGenerateContentStream,
      embedContent: mockEmbedContent,
    }),
  })),
  SchemaType: { ARRAY: "array", OBJECT: "object", STRING: "string", NUMBER: "number" },
}));

// Fake a stream result:
mockGenerateContentStream.mockResolvedValue({
  stream: (async function* () {
    yield { text: () => '["Title one","Title two"]' };
  })(),
});
```

Or, simpler for service tests: mock `src/utlils/ai.ts` (`generateStreamingContent` / `generateContent`) directly.

## Mocking YouTube — It's `fetch`, Not `googleapis`

`extract.repository.ts` and `research.repository.ts` call the YouTube REST API with raw `fetch` (the `googleapis` npm package is installed but never imported — mocking it does nothing):

```typescript
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

mockFetch.mockResolvedValue({
  ok: true,
  json: async () => ({
    items: [{ snippet: { title: "Top video" }, id: { videoId: "abc" } }],
  }),
} as Response);
```

## Service Unit Test Pattern

```typescript
describe("ContentService", () => {
  let service: ContentService;
  let mockRepo: jest.Mocked<ContentRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRepo = {
      saveTopics: jest.fn(),
      getTopicsByUserId: jest.fn(),
      getTopicById: jest.fn(),
    } as unknown as jest.Mocked<ContentRepository>;
    service = new ContentService(mockRepo);
  });

  it("throws if user not found", async () => {
    mockRepo.getUserById.mockResolvedValue(null);
    await expect(service.generateTopics("user-1")).rejects.toThrow("User not found");
  });
});
```

## Controller Integration Tests

```typescript
import request from "supertest";
import app from "../../app";

it("returns 403 with no token", async () => {
  const res = await request(app).get("/v1/topics");
  expect(res.status).toBe(403);
});

it("returns 200 with valid token", async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: "user-123" });
  const res = await request(app)
    .get("/v1/topics")
    .set("Authorization", "Bearer valid-token");
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ success: true, data: expect.any(Array) });
});
```

**Ownership test — highest-value case in this codebase:** authenticate as user B, request user A's resource, expect 404 (never A's data).

## Response Shape Assertions

```typescript
expect(res.body).toMatchObject({ success: true, data: expect.any(Object) });          // success
expect(res.body).toMatchObject({ success: false, message: expect.any(String) });      // error
```

## What Every Endpoint's Tests Cover

1. Happy path — 200/201, standard shape
2. Missing/invalid body fields — 400
3. No token / invalid token — 403
4. Cross-user access — 404 (ownership)
5. Nonexistent ID — 404
6. Service throws → controller catches → `sendError` (no unhandled rejection)

## SSE Stream Testing

Chunks are JSON-encoded; the terminator is the raw literal `[DONE]` (uppercase). Assert shape, not exact content:

```typescript
it("streams script and terminates with [DONE]", async () => {
  const res = await request(app)
    .get(`/v1/scripts/stream/${projectId}?token=valid-token`) // ?token= — no Authorization header
    .buffer(true)
    .parse((res, callback) => {
      let raw = "";
      res.on("data", (c: Buffer) => (raw += c.toString()));
      res.on("end", () => callback(null, raw));
    });
  expect(res.body).toContain("data: ");
  expect(res.body).toContain("data: [DONE]");
});
```

Keep SSE integration tests at this level — test generation logic at the service layer instead.

## Utility Tests (No Mocks)

```typescript
import { getClusteredTitles } from "../../utlils/content";

it("returns all titles in one cluster when count <= k", () => {
  const topics = [{ title: "A", embedding: [0.1, 0.2] }];
  expect(getClusteredTitles(topics as ITopic[])).toHaveLength(1);
});
```

## Running

```bash
npm test                     # all tests
npm test -- --watch          # watch mode
npm test -- --coverage       # coverage report
npm test -- content.service  # filter by name
```
