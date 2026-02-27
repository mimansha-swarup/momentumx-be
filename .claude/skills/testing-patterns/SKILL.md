---
name: testing-patterns
description: Reference for Jest unit tests and Supertest integration tests in MomentumX. Use when writing tests for services, controllers, or utilities.
---

# Testing Patterns Reference

## Stack

- **Unit tests:** Jest
- **Integration tests:** Jest + Supertest
- **Mock targets:** `firebase-admin`, `@google/generative-ai`, `googleapis`

## File Structure

```
src/
└── __tests__/
    ├── services/
    │   ├── content.service.test.ts
    │   └── packaging.service.test.ts
    ├── controllers/
    │   ├── content.controller.test.ts
    │   └── packaging.controller.test.ts
    └── utils/
        └── content.utils.test.ts
```

## Mock Setup

### firebase-admin

```typescript
const mockCollection = jest.fn();
const mockDoc = jest.fn();
const mockGet = jest.fn();
const mockSet = jest.fn();
const mockUpdate = jest.fn();
const mockAdd = jest.fn();
const mockWhere = jest.fn();
const mockOrderBy = jest.fn();
const mockLimit = jest.fn();
const mockBatchSet = jest.fn();
const mockBatchCommit = jest.fn().mockResolvedValue(undefined);

jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  firestore: () => ({
    collection: mockCollection.mockReturnValue({
      doc: mockDoc.mockReturnValue({
        get: mockGet,
        set: mockSet,
        update: mockUpdate,
      }),
      add: mockAdd,
      where: mockWhere.mockReturnThis(),
      orderBy: mockOrderBy.mockReturnThis(),
      limit: mockLimit.mockReturnThis(),
      get: mockGet,
    }),
    batch: jest.fn().mockReturnValue({
      set: mockBatchSet,
      commit: mockBatchCommit,
    }),
  }),
  auth: () => ({
    verifyIdToken: mockVerifyIdToken,
  }),
}));
```

### @google/generative-ai

```typescript
const mockGenerateContent = jest.fn();
const mockGenerateContentStream = jest.fn();
const mockEmbedContent = jest.fn();

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: mockGenerateContent,
      generateContentStream: mockGenerateContentStream,
      embedContent: mockEmbedContent,
    }),
  })),
}));
```

### googleapis

```typescript
const mockSearchList = jest.fn();
const mockChannelsList = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    youtube: jest.fn().mockReturnValue({
      search: { list: mockSearchList },
      channels: { list: mockChannelsList },
    }),
  },
}));
```

## Service Unit Test Pattern

```typescript
import { ContentService } from '../../service/content.service';
import { ContentRepository } from '../../repository/content.repository';

describe('ContentService', () => {
  let service: ContentService;
  let mockRepo: jest.Mocked<ContentRepository>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockRepo = {
      saveTopics: jest.fn(),
      getTopicsByUserId: jest.fn(),
      getTopicById: jest.fn(),
      updateTopic: jest.fn(),
    } as unknown as jest.Mocked<ContentRepository>;

    service = new ContentService(mockRepo);
  });

  describe('getTopics', () => {
    it('returns user topics', async () => {
      mockRepo.getTopicsByUserId.mockResolvedValue([
        { id: 'topic-1', title: 'Test Title', createdBy: 'user-1' }
      ]);

      const result = await service.getTopics('user-1');

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Test Title');
      expect(mockRepo.getTopicsByUserId).toHaveBeenCalledWith('user-1');
    });

    it('throws if repository fails', async () => {
      mockRepo.getTopicsByUserId.mockRejectedValue(new Error('DB error'));

      await expect(service.getTopics('user-1')).rejects.toThrow('DB error');
    });
  });
});
```

## Controller Integration Test Pattern

```typescript
import request from 'supertest';
import app from '../../app';

const mockVerifyIdToken = jest.fn();

jest.mock('firebase-admin', () => ({
  auth: () => ({ verifyIdToken: mockVerifyIdToken }),
  // ... rest of mock
}));

describe('GET /v1/content/topics', () => {
  it('returns 403 with no token', async () => {
    const res = await request(app).get('/v1/content/topics');
    expect(res.status).toBe(403);
  });

  it('returns 403 with invalid token', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('Invalid token'));
    const res = await request(app)
      .get('/v1/content/topics')
      .set('Authorization', 'Bearer bad-token');
    expect(res.status).toBe(403);
  });

  it('returns 200 with valid token', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'user-123' });
    // mock service/repo...
    const res = await request(app)
      .get('/v1/content/topics')
      .set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: expect.any(Array) });
  });
});
```

## Response Shape Assertions

```typescript
// Success
expect(res.body).toMatchObject({
  success: true,
  data: expect.any(Object),
});

// Success with meta
expect(res.body).toMatchObject({
  success: true,
  data: expect.any(Array),
  meta: { total: expect.any(Number) },
});

// Error
expect(res.body).toMatchObject({
  success: false,
  message: expect.any(String),
});
```

## Priority Test Cases (Every Endpoint)

1. Happy path — 200/201 with correct response shape
2. Missing required body fields — 400
3. No auth token — 403
4. Invalid auth token — 403
5. Resource not found — 404
6. Service throws → controller catches → `sendError` called (not unhandled rejection)

## SSE Stream Testing

```typescript
it('streams content and ends with [DONE]', (done) => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'user-123' });
  const chunks: string[] = [];

  request(app)
    .get('/v1/content/stream/topics')
    .set('Authorization', 'Bearer valid-token')
    .buffer(false)
    .parse((res, callback) => {
      res.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
      res.on('end', () => callback(null, chunks.join('')));
    })
    .then((res) => {
      expect(res.text).toContain('data: ');
      expect(res.text).toContain('[DONE]');
      done();
    });
});
```

## Utility Function Tests (No Mocks Needed)

```typescript
import { formatGeneratedTitle, getClusteredTitles } from '../../utlils/content';

describe('formatGeneratedTitle', () => {
  it('strips leading/trailing whitespace', () => {
    expect(formatGeneratedTitle('  My Title  ')).toBe('My Title');
  });
});

describe('getClusteredTitles', () => {
  it('returns all titles in one cluster when count <= k', () => {
    const topics = [{ title: 'A', embedding: [0.1, 0.2] }];
    const result = getClusteredTitles(topics as any);
    expect(result).toHaveLength(1);
  });
});
```

## Running Tests

```bash
npm test                    # all tests
npm test -- --watch         # watch mode
npm test -- --coverage      # coverage report
npm test -- content.service # filter by name
```
