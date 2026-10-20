// Behaviour-driven integration tests for /v1/ideas (routes + controller).
//
// Contract derived FIRST from .claude/rules/api-design.md (response envelope,
// status codes, userId-from-middleware, owning-id rules) and then checked
// against src/controller/idea.controller.ts + src/routes/v1/ideas.route.ts.
// ContentService is mocked at the module boundary (src/container.ts wires the
// real class into ideaController) — no Firestore/Gemini call happens for real,
// except formatGeneratedIdea, which is also mocked below because it calls the
// real embedding model.

// Route suites mock Firestore away, so the real account middleware (which reads
// the account document to verify membership) cannot run. Membership behaviour is
// tested in tests/integration/account-middleware.behaviour.test.ts; that each
// router still MOUNTS it is pinned by tests/unit/auth-coverage.test.ts.
jest.mock("../../src/middleware/account", () =>
  require("../helpers/account").passthroughAccountMiddleware()
);

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
import { testOwner, TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID } from "../helpers/account";
import { AccountForbidden, InsufficientCredits, NotFound, WrongAccount } from "../../src/utlils/errors";

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

/**
 * The page envelope `ContentService.getPaginatedUsersIdeas` actually returns
 * (src/service/content.service.ts) — `{ meta: { nextCursor, hasNextPage }, lists }`.
 *
 * The fixtures here used to be `{ ideas: [], hasMore: false }`, a shape
 * no code path can produce. Paired with `data: expect.any(Object)` — which
 * `{}` satisfies — the list endpoint's entire public contract was unasserted:
 * a controller that dropped `meta`, renamed `lists`, or returned the cursor of
 * the wrong page would have passed. `nextCursor` is the whole of "Load more":
 * lose it and the list silently stops at page one.
 */
const savedIdea = (id: string, title: string) => ({
  id,
  title,
  concept: "a concept",
  ideaType: "long",
  evidence: null,
  isScriptGenerated: false,
  videoProjectId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: undefined,
});

const pageOf = (
  lists: ReturnType<typeof savedIdea>[],
  nextCursor: { createdAt: string; docId: string } | { title: string; docId: string } | null = null
) => ({ meta: { nextCursor, hasNextPage: nextCursor !== null }, lists });

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
  it("returns the SAVED ideas — with their ids — not the raw generation", async () => {
    // `generateIdeas` saves and returns the persisted docs (content.service.ts →
    // steps.run → saveBatchIdeas), so the response carries ids. `expect.any(Array)`
    // could not tell that from the model's raw `{ concept, workingTitle, type }`,
    // which has no id at all — and the client keys every idea card on the id.
    mockContentService.generateIdeas.mockResolvedValueOnce([
      savedIdea("idea-1", "Title 1"),
      savedIdea("idea-2", "Title 2"),
    ]);

    const res = await request(server()).post("/v1/ideas/generate").set(...AUTH_HEADER).send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([
      expect.objectContaining({ id: "idea-1", title: "Title 1" }),
      expect.objectContaining({ id: "idea-2", title: "Title 2" }),
    ]);
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

    expect(mockContentService.generateIdeas).toHaveBeenCalledWith(
      testOwner("user-1"), true, undefined, undefined);
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
  it("returns an uncharged embedding failure from the service as 503", async () => {
    const { ServiceUnavailable } = await import("../../src/utlils/errors");
    mockContentService.generateIdeas.mockRejectedValueOnce(ServiceUnavailable("Couldn't generate ideas", { charged: false }));
    const res = await request(server()).post("/v1/ideas/generate").set(...AUTH_HEADER).send({});
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, detail: { charged: false } });
  });

  // The fourth entry in the api-design.md `code` table, and the only one no test
  // anywhere asserted at the HTTP boundary: the repository's own suite pins the
  // THROWN error, and error-code-contract covers the three 403s and the 410, so
  // whether a 402 survives to the response body was proved by nothing.
  it("answers 402 with insufficient_credits AND the reset date when the allowance is spent", async () => {
    // HARM PREVENTED: the client is documented to "show the balance and the reset
    // date" from `detail`. Dropped, the paywall says "out of credits" with no way
    // to know whether that means minutes or three weeks — and a 402 without the
    // code is indistinguishable from any other refusal.
    mockContentService.generateIdeas.mockRejectedValueOnce(
      InsufficientCredits("Monthly generation allowance used up", {
        remaining: 0,
        resetsAt: "2026-10-01T00:00:00.000Z",
      })
    );

    const res = await request(server()).post("/v1/ideas/generate").set(...AUTH_HEADER).send({});

    expect(res.status).toBe(402);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("insufficient_credits");
    expect(res.body.detail).toMatchObject({ remaining: 0, resetsAt: "2026-10-01T00:00:00.000Z" });
    // The creator-facing message is author-written, so it reaches them verbatim.
    expect(res.body.message).toMatch(/allowance/i);
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
  it("returns the ideas AND the cursor the client needs to ask for the next page", async () => {
    const cursor = { createdAt: "2026-01-01T00:00:00.000Z", docId: "idea-1" };
    mockContentService.getPaginatedUsersIdeas.mockResolvedValueOnce(
      pageOf([savedIdea("idea-1", "First idea")], cursor)
    );

    const res = await request(server()).get("/v1/ideas").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The whole envelope, not "an object": `lists` is what the grid renders and
    // `meta.nextCursor` is the only thing that makes "Load more" work. The client
    // echoes the cursor back verbatim, so its SHAPE is part of the contract.
    expect(res.body.data).toEqual({
      meta: { nextCursor: cursor, hasNextPage: true },
      lists: [expect.objectContaining({ id: "idea-1", title: "First idea", concept: "a concept" })],
    });
  });

  it("says there is no next page, with a null cursor, on the last page", async () => {
    // `hasNextPage` guessed from `limit === docs.length` claimed another page on a
    // full final page, and the "Load more" it rendered came back empty.
    mockContentService.getPaginatedUsersIdeas.mockResolvedValueOnce(pageOf([savedIdea("idea-1", "Only")]));

    const res = await request(server()).get("/v1/ideas").set(...AUTH_HEADER);

    expect(res.body.data.meta).toEqual({ nextCursor: null, hasNextPage: false });
    expect(res.body.data.lists).toHaveLength(1);
  });

  it("scopes the query to the request's account, not any query-string override", async () => {
    mockContentService.getPaginatedUsersIdeas.mockResolvedValueOnce(pageOf([]));

    await request(server()).get("/v1/ideas?userId=someone-else").set(...AUTH_HEADER);

    expect(mockContentService.getPaginatedUsersIdeas).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: TEST_ACCOUNT_ID })
    );
  });

  // The client picks the page size, so the client could pick a page size that
  // times the function out. It reached `query.limit()` unclamped, and `?limit=abc`
  // reached it as NaN.
  it("caps the page size a client can ask for, and ignores a nonsense one", async () => {
    mockContentService.getPaginatedUsersIdeas.mockResolvedValue(pageOf([]));

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
    mockContentService.getPaginatedUsersIdeas.mockResolvedValue(pageOf([]));

    const res = await request(server())
      .get("/v1/ideas?searchText=first&searchText=second")
      .set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    const { filters } = mockContentService.getPaginatedUsersIdeas.mock.calls.at(-1)![0];
    expect(typeof filters.searchText).toBe("string");
    expect(filters.searchText).toBe("second");
  });

  it("does not let a nested param smuggle an object into the filters", async () => {
    mockContentService.getPaginatedUsersIdeas.mockResolvedValue(pageOf([]));

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
    mockContentService.getPaginatedUsersIdeas.mockResolvedValue(pageOf([]));

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
    // `exportIdeas` returns `{ text, count }` — the fixture omitted `count`, which
    // is what the export panel reports ("10 ideas copied").
    mockContentService.exportIdeas.mockResolvedValueOnce({
      text: "Video Ideas\n1. First idea\n2. Second idea",
      count: 2,
    });

    const res = await request(server()).get("/v1/ideas/export").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ text: expect.stringContaining("First idea"), count: 2 });
  });
});

// ---------------------------------------------------------------------------
// POST /v1/ideas/regenerate-all
// ---------------------------------------------------------------------------

describe("POST /v1/ideas/regenerate-all", () => {
  it("returns the NEW batch, ids included — the list replaces itself from this", async () => {
    mockContentService.regenerateAll.mockResolvedValueOnce([
      savedIdea("idea-9", "Regenerated one"),
      savedIdea("idea-10", "Regenerated two"),
    ]);

    const res = await request(server()).post("/v1/ideas/regenerate-all").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    // `expect.any(Array)` passed on `[]`, which is what a regenerate that archived
    // the old batch and saved nothing returns — an emptied list reported as success.
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((idea: { id: string }) => idea.id)).toEqual(["idea-9", "idea-10"]);
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
    // The controller merges the path id onto the service's `{ title }`, because the
    // client patches its store by id. Both halves matter.
    expect(res.body.data).toMatchObject({ id: "idea-1", title: "New title" });
  });

  it("uses the authenticated uid for ownership, ignoring a body-supplied userId", async () => {
    mockContentService.editIdeas.mockResolvedValueOnce({ title: "New title" });

    await request(server())
      .patch("/v1/ideas/edit/idea-1")
      .set(...AUTH_HEADER)
      .send({ title: "New title", userId: "someone-elses-uid" });

    expect(mockContentService.editIdeas).toHaveBeenCalledWith("idea-1", testOwner("user-1"), expect.anything());
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

  it("returns 404 for an idea that does not exist", async () => {
    mockContentService.editIdeas.mockRejectedValueOnce(NotFound("Idea not found"));

    const res = await request(server())
      .patch("/v1/ideas/edit/no-such-idea")
      .set(...AUTH_HEADER)
      .send({ title: "Hijack" });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  // An idea in ANOTHER CHANNEL is not a 404 — this block used to assert one,
  // titled "another user's idea". `editIdeas` reads the doc unscoped and then
  // calls `forbidCrossAccount`, which answers 403 with the reason. Which reason
  // is the whole contract (.claude/rules/api-design.md → `code`):
  it("offers a switch — not an eject — for an idea in the caller's OTHER channel", async () => {
    // HARM PREVENTED: without `wrong_account` + `detail`, the client treats this
    // as "you are not in this channel", clears the active channel and ejects a
    // member from a channel their own idea lives one click away in.
    mockContentService.editIdeas.mockRejectedValueOnce(
      WrongAccount({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" })
    );

    const res = await request(server())
      .patch("/v1/ideas/edit/idea-in-my-other-channel")
      .set(...AUTH_HEADER)
      .send({ title: "Rename" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_account");
    // The client names the destination channel from `detail`; an id the user has
    // never seen is not a button they can be asked to press.
    expect(res.body.detail).toMatchObject({
      accountId: OTHER_ACCOUNT_ID,
      displayName: "Finance Channel",
    });
  });

  it("ejects — and names no channel — for an idea in a channel the caller is not in", async () => {
    // HARM PREVENTED: the mirror. A `wrong_account` here would offer a switch to
    // a channel the caller has no membership in, and leak its display name.
    mockContentService.editIdeas.mockRejectedValueOnce(AccountForbidden());

    const res = await request(server())
      .patch("/v1/ideas/edit/a-strangers-idea")
      .set(...AUTH_HEADER)
      .send({ title: "Hijack" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("account_forbidden");
    expect(res.body.detail).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/ideas/:ideaId/regenerate
// ---------------------------------------------------------------------------

describe("POST /v1/ideas/:ideaId/regenerate", () => {
  it("returns the regenerated idea in the SAME slot id, under `title`", async () => {
    // The fixture said `workingTitle`. `regenerateOne` returns `{ ...formatted,
    // id: ideaId }` and `formatGeneratedIdea` stores the headline as `title` —
    // `workingTitle` is the model's raw field and never reaches a response. With
    // `data: expect.any(Object)` the mismatch was invisible, and the card that
    // reads `data.title` would render blank.
    mockContentService.regenerateOne.mockResolvedValueOnce(savedIdea("idea-1", "A fresher idea"));

    const res = await request(server()).post("/v1/ideas/idea-1/regenerate").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: "idea-1", title: "A fresher idea" });
    // Regenerating a slot must not report itself as already scripted, or the card
    // offers "View script" for a script that describes the previous idea.
    expect(res.body.data.isScriptGenerated).toBe(false);
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

  // This was a `test.failing` asserting 403, against an older revision of
  // .claude/rules/api-design.md whose status table read "Unauthorized / invalid
  // token → 403". That row has since been corrected, and it now says so
  // explicitly: "401 and 403 are not interchangeable, and this table used to say
  // otherwise… The code was always right." So the documented contract and the
  // implementation now AGREE on 401, and a `test.failing` demanding 403 encoded
  // the retracted contract — it passed only for as long as production stayed
  // correct, and would have gone red the moment someone "fixed" it.
  //
  // Asserted as an ordinary test, because it is ordinary behaviour now.
  it("answers 401, not 403, for a missing or unusable token", async () => {
    // HARM PREVENTED: 401 means "log in again"; 403 means "you are known, and
    // no". The whole multi-account client contract hangs on 403 meaning
    // permission (account_forbidden / wrong_account / role_forbidden), so a 401
    // in that set would send the user to the sign-in screen instead of the
    // channel switcher.
    const missing = await request(server()).get("/v1/ideas");
    expect(missing.status).toBe(401);
    expect(missing.body).toMatchObject({ success: false, message: expect.any(String) });
    // And no `code`: this is not one of the three 403 discriminations.
    expect(missing.body.code).toBeUndefined();

    mockVerifyIdToken.mockRejectedValueOnce(new Error("token expired"));
    const invalid = await request(server()).get("/v1/ideas").set("Authorization", "Bearer bad");
    expect(invalid.status).toBe(401);

    const malformed = await request(server()).get("/v1/ideas").set("Authorization", "not-a-bearer-token");
    expect(malformed.status).toBe(401);
  });
});
