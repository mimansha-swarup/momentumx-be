// Behaviour-driven integration tests for /v1/ideas (routes + controller).
//
// Contract derived FIRST from .claude/rules/api-design.md (response envelope,
// status codes, userId-from-middleware, owning-id rules) and then checked
// against src/controller/idea.controller.ts + src/routes/v1/ideas.route.ts.
// ContentService is mocked at the module boundary (src/container.ts wires the
// real class into ideaController) — no Firestore/Gemini call happens for real,
// except formatGeneratedIdea, which is also mocked below because it calls the
// real embedding model.

jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn().mockReturnValue({ _sentinel: "ts" }) },
    FieldPath: { documentId: jest.fn() },
  }),
  auth: jest.fn().mockReturnValue({ verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) }),
}));

const mockVerifyIdToken = jest.fn();

jest.mock("../../src/config/firebase", () => ({
  db: {},
  auth: { verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) },
  firebase: {
    firestore: {
      FieldValue: { serverTimestamp: jest.fn().mockReturnValue({ _sentinel: "ts" }) },
      FieldPath: { documentId: jest.fn() },
    },
    auth: jest.fn().mockReturnValue({ verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) }),
  },
}));

// ContentService is used for BOTH idea and script controllers; only the idea
// controller is exercised by this file's routes.
const mockContentService = {
  // Phase 03: the controller assembles the idea write shape itself (a layering
  // violation that predates the phase), so it asks the service for the owner
  // stamp rather than taking a second dependency.
  resolveOwner: jest.fn(),
  getPaginatedUsersIdeas: jest.fn(),
  generateIdeas: jest.fn(),
  saveBatchIdeas: jest.fn(),
  editIdeas: jest.fn(),
  regenerateAll: jest.fn(),
  regenerateOne: jest.fn(),
  exportIdeas: jest.fn(),
};

jest.mock("../../src/service/content.service", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => mockContentService),
}));

// formatGeneratedIdea calls the real Gemini embedding model — mocked here so
// the controller's own post-generation logic (Promise.allSettled / the 503
// guard) runs for real without a network call. Every other export of this
// module stays real.
const mockFormatGeneratedIdea = jest.fn();
jest.mock("../../src/utlils/content", () => ({
  ...jest.requireActual("../../src/utlils/content"),
  formatGeneratedIdea: (...args: unknown[]) => mockFormatGeneratedIdea(...args),
}));

import request from "supertest";
import app from "../../src/app";
import { useSharedServer } from "./shared-server";
import { TEST_ACCOUNT_ID } from "../helpers/account";

// One HTTP server for the whole file. `request(app)` starts and tears down a
// FRESH ephemeral server per call; across ~113 requests that intermittently
// produced connection-level failures (a 501 from Node with an empty body, once a
// socket hang up) on an arbitrary test, never reproducible in isolation.
const server = useSharedServer(app);

function makeServiceError(message: string, statusCode: number) {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

const AUTH_HEADER = ["Authorization", "Bearer valid-token"] as const;

beforeEach(() => {
  mockVerifyIdToken.mockReset();
  mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });

  // Drain any queued `mockResolvedValueOnce`. `clearMocks: true` calls
  // mockClear(), which resets call history but LEAVES the once-queue intact — so
  // a test whose request short-circuits before reaching the service (a 400 from
  // validation, a 404 thrown upstream) leaves its queued value for whichever
  // test calls that mock next. That produced intermittent, order-dependent
  // failures on a different test each run. mockReset() drains the queue.
  Object.values(mockContentService).forEach((fn) => (fn as jest.Mock).mockReset());
  mockContentService.resolveOwner.mockResolvedValue({
    userId: "user-1",
    accountId: TEST_ACCOUNT_ID,
  });

  mockFormatGeneratedIdea.mockReset();
  // The 2nd argument is a RecordOwner OBJECT, not a uid — mirrored honestly here
  // so this stays a test of the route's wiring. The stamp itself is asserted
  // against the real formatter in tests/unit/utils/record-owner.behaviour.test.ts;
  // this suite mocks the formatter and so proves nothing about it.
  mockFormatGeneratedIdea.mockImplementation(
    async (
      idea: { workingTitle: string },
      owner: { userId: string; accountId: string },
      batchId: string
    ) => ({
      id: "idea-formatted",
      title: idea.workingTitle,
      createdBy: owner.userId,
      accountId: owner.accountId,
      batchId,
    })
  );
});

// ---------------------------------------------------------------------------
// POST /v1/ideas/generate
// ---------------------------------------------------------------------------

describe("POST /v1/ideas/generate", () => {
  it("returns 200 with the standard success envelope", async () => {
    mockContentService.generateIdeas.mockResolvedValueOnce([
      { concept: "c1", workingTitle: "Title 1", type: "long", evidence: "e1" },
    ]);
    mockContentService.saveBatchIdeas.mockResolvedValueOnce([{ id: "idea-1", title: "Title 1" }]);

    const res = await request(server()).post("/v1/ideas/generate").set(...AUTH_HEADER).send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: expect.any(Array) });
  });

  it("ignores a client-supplied userId and generates for the authenticated uid", async () => {
    mockContentService.generateIdeas.mockResolvedValueOnce([
      { concept: "c1", workingTitle: "Title 1", type: "long", evidence: "" },
    ]);
    mockContentService.saveBatchIdeas.mockResolvedValueOnce([{ id: "idea-1" }]);

    await request(server())
      .post("/v1/ideas/generate")
      .set(...AUTH_HEADER)
      .send({ userId: "someone-elses-uid" });

    expect(mockContentService.generateIdeas).toHaveBeenCalledWith("user-1", true, undefined);
  });

  it("returns 400 with a field-prefixed message for an oversized context.niche", async () => {
    const res = await request(server())
      .post("/v1/ideas/generate")
      .set(...AUTH_HEADER)
      .send({ context: { niche: "x".repeat(250) } });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, message: expect.any(String) });
    expect(res.body.message).toMatch(/context\.niche/);
    expect(mockContentService.generateIdeas).not.toHaveBeenCalled();
  });

  // Intricate controller logic (not boilerplate): every generated idea failing
  // to format (e.g. every embedding call fails) must surface as a retryable
  // 503, not a silent empty save.
  it("returns 503 when every generated idea fails to format", async () => {
    mockContentService.generateIdeas.mockResolvedValueOnce([
      { concept: "c1", workingTitle: "Title 1", type: "long", evidence: "" },
    ]);
    mockFormatGeneratedIdea.mockRejectedValue(new Error("embedding timed out"));

    const res = await request(server()).post("/v1/ideas/generate").set(...AUTH_HEADER).send({});

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(mockContentService.saveBatchIdeas).not.toHaveBeenCalled();
  });

  it("propagates a service failure as a masked 500, not an unhandled rejection", async () => {
    mockContentService.generateIdeas.mockRejectedValueOnce(new Error("boom"));

    const res = await request(server()).post("/v1/ideas/generate").set(...AUTH_HEADER).send({});

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, message: expect.any(String) });
  });
});

// ---------------------------------------------------------------------------
// GET /v1/ideas
// ---------------------------------------------------------------------------

describe("GET /v1/ideas", () => {
  it("returns 200 with the saved ideas", async () => {
    mockContentService.getPaginatedUsersIdeas.mockResolvedValueOnce({ ideas: [], hasMore: false });

    const res = await request(server()).get("/v1/ideas").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: expect.any(Object) });
  });

  it("scopes the query to the authenticated uid, not any query-string override", async () => {
    mockContentService.getPaginatedUsersIdeas.mockResolvedValueOnce({ ideas: [], hasMore: false });

    await request(server()).get("/v1/ideas?userId=someone-else").set(...AUTH_HEADER);

    expect(mockContentService.getPaginatedUsersIdeas).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" })
    );
  });

  // The client picks the page size, so the client could pick a page size that
  // times the function out. It reached `query.limit()` unclamped, and `?limit=abc`
  // reached it as NaN.
  it("caps the page size a client can ask for, and ignores a nonsense one", async () => {
    mockContentService.getPaginatedUsersIdeas.mockResolvedValue({ ideas: [], hasMore: false });

    await request(server()).get("/v1/ideas?limit=1000000").set(...AUTH_HEADER);
    expect(mockContentService.getPaginatedUsersIdeas).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 50 })
    );

    await request(server()).get("/v1/ideas?limit=abc").set(...AUTH_HEADER);
    expect(mockContentService.getPaginatedUsersIdeas).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 9 })
    );

    await request(server()).get("/v1/ideas?limit=12").set(...AUTH_HEADER);
    expect(mockContentService.getPaginatedUsersIdeas).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 12 })
    );
  });

  // `query_normalizer` claims to cover this route; until now only /v1/research
  // proved it. A repeated param parses to an array, and `searchText as string`
  // would hand an array to the search branch.
  it("collapses a repeated searchText to a single string", async () => {
    mockContentService.getPaginatedUsersIdeas.mockResolvedValue({ ideas: [], hasMore: false });

    const res = await request(server())
      .get("/v1/ideas?searchText=first&searchText=second")
      .set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    const { filters } = mockContentService.getPaginatedUsersIdeas.mock.calls.at(-1)![0];
    expect(typeof filters.searchText).toBe("string");
    expect(filters.searchText).toBe("second");
  });

  it("does not let a nested param smuggle an object into the filters", async () => {
    mockContentService.getPaginatedUsersIdeas.mockResolvedValue({ ideas: [], hasMore: false });

    const res = await request(server())
      .get("/v1/ideas?searchText[$ne]=x")
      .set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    const call = mockContentService.getPaginatedUsersIdeas.mock.calls.at(-1)![0];
    // `?searchText[$ne]=x` parses to an OBJECT. Reaching the search branch it
    // would be compared and concatenated as one; there is no sensible string for
    // it, so it becomes empty and the search simply doesn't filter.
    expect(call.filters.searchText).toBe("");
  });

  it("treats the array form of a flag exactly like the plain form", async () => {
    mockContentService.getPaginatedUsersIdeas.mockResolvedValue({ ideas: [], hasMore: false });

    await request(server()).get("/v1/ideas?isScriptGenerated[]=true").set(...AUTH_HEADER);
    const bracketed = mockContentService.getPaginatedUsersIdeas.mock.calls.at(-1)![0];

    await request(server()).get("/v1/ideas?isScriptGenerated=true").set(...AUTH_HEADER);
    const plain = mockContentService.getPaginatedUsersIdeas.mock.calls.at(-1)![0];

    // `["true"]` collapses to `"true"` — last-occurrence-wins applied to a
    // one-element array. The three-state parse then sees a string either way, so
    // a client that writes the bracket form gets the filter it meant rather than
    // silently getting the opposite set.
    expect(bracketed.filters.isScriptGenerated).toBe(true);
    expect(bracketed.filters).toEqual(plain.filters);
  });

  it("propagates a service failure as an error response", async () => {
    mockContentService.getPaginatedUsersIdeas.mockRejectedValueOnce(new Error("db down"));

    const res = await request(server()).get("/v1/ideas").set(...AUTH_HEADER);

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/ideas/export
// ---------------------------------------------------------------------------

describe("GET /v1/ideas/export", () => {
  it("returns 200 with exported text", async () => {
    mockContentService.exportIdeas.mockResolvedValueOnce({ text: "ideas..." });

    const res = await request(server()).get("/v1/ideas/export").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { text: "ideas..." } });
  });
});

// ---------------------------------------------------------------------------
// POST /v1/ideas/regenerate-all
// ---------------------------------------------------------------------------

describe("POST /v1/ideas/regenerate-all", () => {
  it("returns 200 with the regenerated batch", async () => {
    mockContentService.regenerateAll.mockResolvedValueOnce([{ id: "idea-1" }]);

    const res = await request(server()).post("/v1/ideas/regenerate-all").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: expect.any(Array) });
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/ideas/edit/:ideaId
// ---------------------------------------------------------------------------

describe("PATCH /v1/ideas/edit/:ideaId", () => {
  it("returns 200 with the updated idea", async () => {
    mockContentService.editIdeas.mockResolvedValueOnce({ title: "New title" });

    const res = await request(server())
      .patch("/v1/ideas/edit/idea-1")
      .set(...AUTH_HEADER)
      .send({ title: "New title" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { id: "idea-1" } });
  });

  it("uses the authenticated uid for ownership, ignoring a body-supplied userId", async () => {
    mockContentService.editIdeas.mockResolvedValueOnce({ title: "New title" });

    await request(server())
      .patch("/v1/ideas/edit/idea-1")
      .set(...AUTH_HEADER)
      .send({ title: "New title", userId: "someone-elses-uid" });

    expect(mockContentService.editIdeas).toHaveBeenCalledWith("idea-1", "user-1", expect.anything());
  });

  // The editable field is `title`, not `workingTitle`. These tests originally sent
  // `workingTitle` and passed, because the mocked service never applied the real
  // whitelist — the schema is what surfaced the mismatch. The frontend sends
  // `{ title }` (ideas.thunk.ts), which is what the service accepts.
  it("rejects an unknown field name with 400 and never reaches the service", async () => {
    const res = await request(server())
      .patch("/v1/ideas/edit/idea-1")
      .set(...AUTH_HEADER)
      .send({ workingTitle: "New title" });

    expect(res.status).toBe(400);
    expect(mockContentService.editIdeas).not.toHaveBeenCalled();
  });

  it("rejects an empty title rather than blanking the idea", async () => {
    const res = await request(server())
      .patch("/v1/ideas/edit/idea-1")
      .set(...AUTH_HEADER)
      .send({ title: "   " });

    expect(res.status).toBe(400);
    expect(mockContentService.editIdeas).not.toHaveBeenCalled();
  });

  // Ownership / not-found: another user's idea (or a nonexistent one) must
  // never come back as a 200 — the service's NotFound propagates untouched.
  it("returns 404 for another user's idea (never that user's data)", async () => {
    mockContentService.editIdeas.mockRejectedValueOnce(makeServiceError("Idea not found", 404));

    const res = await request(server())
      .patch("/v1/ideas/edit/someone-elses-idea")
      .set(...AUTH_HEADER)
      .send({ title: "Hijack" });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/ideas/:ideaId/regenerate
// ---------------------------------------------------------------------------

describe("POST /v1/ideas/:ideaId/regenerate", () => {
  it("returns 200 with the regenerated idea", async () => {
    mockContentService.regenerateOne.mockResolvedValueOnce({ id: "idea-1", workingTitle: "New" });

    const res = await request(server()).post("/v1/ideas/idea-1/regenerate").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: expect.any(Object) });
  });

  it("returns 404 for a nonexistent idea", async () => {
    mockContentService.regenerateOne.mockRejectedValueOnce(makeServiceError("Idea not found", 404));

    const res = await request(server()).post("/v1/ideas/missing/regenerate").set(...AUTH_HEADER);

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Auth — every route sits behind router.use(authMiddleware); exercised once
// via a representative route since the middleware is router-wide, not
// per-route.
// ---------------------------------------------------------------------------

describe("Auth", () => {
  it("rejects a request with no Authorization header without reaching the service", async () => {
    const res = await request(server()).get("/v1/ideas");

    expect(res.status).not.toBe(200);
    expect(res.body.success).toBe(false);
    expect(mockContentService.getPaginatedUsersIdeas).not.toHaveBeenCalled();
  });

  it("rejects a request with an invalid token without reaching the service", async () => {
    mockVerifyIdToken.mockRejectedValueOnce(new Error("invalid token"));

    const res = await request(server()).get("/v1/ideas").set("Authorization", "Bearer bad-token");

    expect(res.status).not.toBe(200);
    expect(res.body.success).toBe(false);
    expect(mockContentService.getPaginatedUsersIdeas).not.toHaveBeenCalled();
  });

  // CONTRACT (.claude/rules/api-design.md → Standard HTTP Status Codes table):
  // "Unauthorized / invalid token" → 403.
  // ACTUAL (src/middleware/auth.ts): authMiddleware always calls
  // res.sendError({ statusCode: 401 }) for a missing/invalid/empty-uid token —
  // never 403. error_handler.ts's STRING_SENTINELS maps "Unauthorized" → 403,
  // but auth.ts never throws through that handler (it calls res.sendError
  // directly), so that mapping never applies to an auth failure. This is a
  // genuine, repo-wide contract/implementation mismatch, not a test bug.
  //
  // Written with `test.failing` (Jest 30) so this discrepancy is visible in
  // `npm test` output without turning the suite red: it is reported as PASSING
  // as long as the real behaviour (401) keeps contradicting the documented
  // contract (403). If auth.ts is ever changed to emit 403, this test starts
  // failing loudly — the signal to delete `.failing` and promote it.
  test.failing(
    "CONTRACT: a missing token should be rejected with 403, per api-design.md (currently 401)",
    async () => {
      const res = await request(server()).get("/v1/ideas");
      expect(res.status).toBe(403);
    }
  );
});
