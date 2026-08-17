jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn() },
    FieldPath: { documentId: jest.fn() },
    Timestamp: { now: jest.fn() },
  }),
  auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
}));

jest.mock("../../src/config/firebase", () => ({
  db: {},
  auth: { verifyIdToken: jest.fn() },
  firebase: {
    firestore: {
      FieldValue: { serverTimestamp: jest.fn() },
      FieldPath: { documentId: jest.fn() },
    },
  },
}));

jest.mock("../../src/config/ai", () => ({
  __esModule: true,
  default: jest.fn(),
  embeddingModel: { embedContent: jest.fn() },
}));

import request from "supertest";
import app from "../../src/app";

/**
 * Responses are authenticated and scoped to a single user, so none may be stored.
 *
 * Express ETags every JSON body by default. An endpoint whose body doesn't change
 * between calls — an empty competitor list, for instance — therefore answered 304
 * Not Modified on revalidation, and the body was sitting in the browser cache (and
 * potentially an intermediary's) with nothing marking it private.
 */
describe("cache headers", () => {
  it("sends Cache-Control: no-store on API responses", async () => {
    const res = await request(app).get("/");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("sends no ETag, so a repeated identical body can't answer 304", async () => {
    const res = await request(app).get("/");
    expect(res.headers.etag).toBeUndefined();
  });

  it("keeps the headers on error responses too", async () => {
    // Unauthenticated /v1 route → 4xx from authMiddleware, still uncacheable.
    const res = await request(app).get("/v1/research/competitors");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers.etag).toBeUndefined();
  });

  it("does not answer 304 when the client revalidates with a stale validator", async () => {
    const res = await request(app).get("/").set("If-None-Match", 'W/"anything"');
    expect(res.status).toBe(200);
  });
});
