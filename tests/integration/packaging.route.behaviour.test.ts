// Behaviour-driven integration tests for /v1/packaging (routes + controller).
//
// Contract derived FIRST from .claude/rules/api-design.md (response envelope,
// "Owning IDs" rule, packagingSaveSchema key-allowlisting) and
// docs/features/packaging/api.md, then checked against
// src/controller/packaging.controller.ts + src/routes/v1/packaging.route.ts.
// PackagingService is mocked at the module boundary; src/container.ts wires
// the real class into packagingController.

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

const mockPackagingService = {
  generateTitle: jest.fn(),
  generateDescription: jest.fn(),
  generateThumbnail: jest.fn(),
  generateShorts: jest.fn(),
  savePackaging: jest.fn(),
  getPackaging: jest.fn(),
  getPackagingByAccount: jest.fn(),
  regenerateItem: jest.fn(),
  selectTitle: jest.fn(),
  exportPackaging: jest.fn(),
};

jest.mock("../../src/service/packaging.service", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => mockPackagingService),
}));

import request from "supertest";
import app from "../../src/app";
import { Forbidden, NotFound } from "../../src/utlils/errors";
import { useSharedServer } from "./shared-server";
import { testOwner, OTHER_ACCOUNT_ID, TEST_ACCOUNT_ID } from "../helpers/account";

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
  Object.values(mockPackagingService).forEach((fn) => (fn as jest.Mock).mockReset());
});

// ---------------------------------------------------------------------------
// POST /v1/packaging/generate-title
// ---------------------------------------------------------------------------

describe("POST /v1/packaging/generate-title", () => {
  it("returns 200 with generated titles", async () => {
    mockPackagingService.generateTitle.mockResolvedValueOnce({ titles: [{ title: "T1", characterCount: 2 }] });

    const res = await request(server())
      .post("/v1/packaging/generate-title")
      .set(...AUTH_HEADER)
      .send({ script: "the script" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { titles: expect.any(Array) } });
  });

  it("returns 400 when neither script nor videoProjectId is provided", async () => {
    const res = await request(server()).post("/v1/packaging/generate-title").set(...AUTH_HEADER).send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockPackagingService.generateTitle).not.toHaveBeenCalled();
  });

  it("accepts a videoProjectId alone (script resolved server-side)", async () => {
    mockPackagingService.generateTitle.mockResolvedValueOnce({ titles: [] });

    const res = await request(server())
      .post("/v1/packaging/generate-title")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "proj-1" });

    expect(res.status).toBe(200);
    expect(mockPackagingService.generateTitle).toHaveBeenCalledWith(
      testOwner("user-1"), undefined, "proj-1");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/packaging/generate-description | generate-thumbnail — both
// require `title`, both degrade to a 400 on the same shape.
// ---------------------------------------------------------------------------

describe.each([
  ["generate-description", "generateDescription", { description: "d" }],
  ["generate-thumbnail", "generateThumbnail", { descriptions: ["d1"] }],
] as const)("POST /v1/packaging/%s", (path, serviceMethod, successPayload) => {
  it("returns 200 when title is present", async () => {
    (mockPackagingService[serviceMethod] as jest.Mock).mockResolvedValueOnce(successPayload);

    const res = await request(server())
      .post(`/v1/packaging/${path}`)
      .set(...AUTH_HEADER)
      .send({ script: "s", title: "My Title" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 when title is missing", async () => {
    const res = await request(server())
      .post(`/v1/packaging/${path}`)
      .set(...AUTH_HEADER)
      .send({ script: "s" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockPackagingService[serviceMethod]).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/packaging/generate-shorts
// ---------------------------------------------------------------------------

describe("POST /v1/packaging/generate-shorts", () => {
  it("returns 200 when duration is present", async () => {
    mockPackagingService.generateShorts.mockResolvedValueOnce({ segments: [], totalDuration: "1:00" });

    const res = await request(server())
      .post("/v1/packaging/generate-shorts")
      .set(...AUTH_HEADER)
      .send({ script: "s", duration: 60 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 when duration is missing", async () => {
    const res = await request(server())
      .post("/v1/packaging/generate-shorts")
      .set(...AUTH_HEADER)
      .send({ script: "s" });

    expect(res.status).toBe(400);
    expect(mockPackagingService.generateShorts).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/packaging/save — packagingSaveSchema key-allowlisting.
// ---------------------------------------------------------------------------

describe("POST /v1/packaging/save", () => {
  it("returns 200 with the saved doc id", async () => {
    mockPackagingService.savePackaging.mockResolvedValueOnce({ id: "pkg-1" });

    const res = await request(server())
      .post("/v1/packaging/save")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "proj-1", titles: [{ title: "T", characterCount: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { id: "pkg-1" } });
  });

  // The highest-value case for this route: packagingSaveSchema must strip
  // isStale/itemStatuses/createdBy/accountId/script/hooks before the
  // service is ever called, so a client can never defeat the stale cascade
  // or rewrite ownership/generation-derived fields through an "edit" call.
  it("strips isStale, itemStatuses, createdBy, accountId, script and hooks from the body", async () => {
    mockPackagingService.savePackaging.mockResolvedValueOnce({ id: "pkg-1" });

    await request(server())
      .post("/v1/packaging/save")
      .set(...AUTH_HEADER)
      .send({
        videoProjectId: "proj-1",
        titles: [{ title: "T", characterCount: 1 }],
        isStale: true,
        staleReason: "manual",
        itemStatuses: { title: "completed" },
        createdBy: "attacker-uid",
        accountId: "acct-x",
        script: "sneaky full script",
        hooks: ["sneaky hook"],
      });

    expect(mockPackagingService.savePackaging).toHaveBeenCalledTimes(1);
    const [userIdArg, restArg, videoProjectIdArg] = mockPackagingService.savePackaging.mock.calls[0];
    expect(userIdArg).toEqual(testOwner("user-1"));
    expect(videoProjectIdArg).toBe("proj-1");
    expect(restArg).toHaveProperty("titles");
    for (const forbidden of ["isStale", "staleReason", "itemStatuses", "createdBy", "accountId", "script", "hooks"]) {
      expect(restArg).not.toHaveProperty(forbidden);
    }
  });

  it("uses the authenticated uid, ignoring a client-supplied createdBy/userId", async () => {
    mockPackagingService.savePackaging.mockResolvedValueOnce({ id: "pkg-1" });

    await request(server())
      .post("/v1/packaging/save")
      .set(...AUTH_HEADER)
      .send({ description: "d", createdBy: "attacker-uid", accountId: OTHER_ACCOUNT_ID });

    expect(mockPackagingService.savePackaging).toHaveBeenCalledWith(
      testOwner("user-1"), expect.anything(), undefined);
  });

  it("returns 404 when videoProjectId is provided but the project does not exist", async () => {
    mockPackagingService.savePackaging.mockRejectedValueOnce(makeServiceError("Not found", 404));

    const res = await request(server())
      .post("/v1/packaging/save")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "missing", description: "d" });

    expect(res.status).toBe(404);
  });

  it("returns 403 when videoProjectId is provided but not owned by the requester", async () => {
    mockPackagingService.savePackaging.mockRejectedValueOnce(makeServiceError("Forbidden", 403));

    const res = await request(server())
      .post("/v1/packaging/save")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "someone-elses-project", description: "d" });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/packaging/list
// ---------------------------------------------------------------------------

describe("GET /v1/packaging/list", () => {
  it("returns 200 with the user's packaging list", async () => {
    mockPackagingService.getPackagingByAccount.mockResolvedValueOnce([{ id: "pkg-1" }]);

    const res = await request(server()).get("/v1/packaging/list").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: expect.any(Array) });
    expect(mockPackagingService.getPackagingByAccount).toHaveBeenCalledWith(
      testOwner("user-1"));
  });
});

// ---------------------------------------------------------------------------
// GET /v1/packaging/:packagingId
// ---------------------------------------------------------------------------

describe("GET /v1/packaging/:packagingId", () => {
  it("returns 200 with the packaging doc", async () => {
    mockPackagingService.getPackaging.mockResolvedValueOnce({ id: "pkg-1", createdBy: "user-1", accountId: TEST_ACCOUNT_ID });

    const res = await request(server()).get("/v1/packaging/pkg-1").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: expect.any(Object) });
  });

  // 404 and 403 are DIFFERENT cases here, and this block used to conflate them:
  // it asserted 404 under the title "another user's document", with a comment
  // claiming the service resolves null for both. It does not —
  // `PackagingService.getPackaging` returns null only when the doc is missing and
  // throws Forbidden() when it belongs to someone else. Because the service is
  // mocked here, the test happily proved the controller forwards whatever the
  // mock was told to produce, and the mock had been told the wrong thing.
  it("returns 404 when the document does not exist", async () => {
    mockPackagingService.getPackaging.mockResolvedValueOnce(null);

    const res = await request(server()).get("/v1/packaging/missing-pkg").set(...AUTH_HEADER);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("returns 403, not 404, for a document owned by someone else", async () => {
    // The real factory, so the status is production's and not a number invented
    // by this test.
    mockPackagingService.getPackaging.mockRejectedValueOnce(Forbidden());

    const res = await request(server()).get("/v1/packaging/someone-elses-pkg").set(...AUTH_HEADER);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/packaging/:packagingId/regenerate/:item
// ---------------------------------------------------------------------------

describe("POST /v1/packaging/:packagingId/regenerate/:item", () => {
  it("returns 200 with the regenerated item", async () => {
    mockPackagingService.regenerateItem.mockResolvedValueOnce({
      id: "pkg-1",
      item: "title",
      data: [{ title: "T", characterCount: 1 }],
    });

    const res = await request(server())
      .post("/v1/packaging/pkg-1/regenerate/title")
      .set(...AUTH_HEADER)
      .send({ script: "s" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { item: "title" } });
  });

  // Owning-ID rule: regenerate operates on an EXISTING packagingId; the
  // stored document's videoProjectId is used server-side, so a body-supplied
  // one must never reach the service call.
  it("ignores a body-supplied videoProjectId on regenerate", async () => {
    mockPackagingService.regenerateItem.mockResolvedValueOnce({ id: "pkg-1", item: "title", data: [] });

    await request(server())
      .post("/v1/packaging/pkg-1/regenerate/title")
      .set(...AUTH_HEADER)
      .send({ script: "s", videoProjectId: "attacker-chosen-project" });

    expect(mockPackagingService.regenerateItem).toHaveBeenCalledWith(
      testOwner("user-1"),
      "pkg-1",
      "title",
      "s",
      undefined,
      undefined
    );
  });

  it("returns 404 when the packaging document does not exist", async () => {
    mockPackagingService.regenerateItem.mockRejectedValueOnce(NotFound("Packaging not found"));

    const res = await request(server())
      .post("/v1/packaging/missing-pkg/regenerate/title")
      .set(...AUTH_HEADER)
      .send({ script: "s" });

    expect(res.status).toBe(404);
  });

  it("returns 403 for another user's packaging document", async () => {
    mockPackagingService.regenerateItem.mockRejectedValueOnce(Forbidden());

    const res = await request(server())
      .post("/v1/packaging/someone-elses-pkg/regenerate/title")
      .set(...AUTH_HEADER)
      .send({ script: "s" });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/packaging/:packagingId/select-title
// ---------------------------------------------------------------------------

describe("POST /v1/packaging/:packagingId/select-title", () => {
  it("returns 200 on success", async () => {
    mockPackagingService.selectTitle.mockResolvedValueOnce({ id: "pkg-1", selectedTitleIndex: 1 });

    const res = await request(server())
      .post("/v1/packaging/pkg-1/select-title")
      .set(...AUTH_HEADER)
      .send({ index: 1 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: expect.any(Object) });
  });

  it("returns 400 when index is missing", async () => {
    const res = await request(server()).post("/v1/packaging/pkg-1/select-title").set(...AUTH_HEADER).send({});

    expect(res.status).toBe(400);
    expect(mockPackagingService.selectTitle).not.toHaveBeenCalled();
  });

  it("returns 400 when index is not a number", async () => {
    const res = await request(server())
      .post("/v1/packaging/pkg-1/select-title")
      .set(...AUTH_HEADER)
      .send({ index: "1" });

    expect(res.status).toBe(400);
    expect(mockPackagingService.selectTitle).not.toHaveBeenCalled();
  });

  it("returns 404 when the packaging document does not exist", async () => {
    mockPackagingService.selectTitle.mockRejectedValueOnce(NotFound("Packaging not found"));

    const res = await request(server())
      .post("/v1/packaging/missing-pkg/select-title")
      .set(...AUTH_HEADER)
      .send({ index: 0 });

    expect(res.status).toBe(404);
  });

  it("returns 403 for another user's packaging document", async () => {
    mockPackagingService.selectTitle.mockRejectedValueOnce(Forbidden());

    const res = await request(server())
      .post("/v1/packaging/someone-elses-pkg/select-title")
      .set(...AUTH_HEADER)
      .send({ index: 0 });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/packaging/:packagingId/export
// ---------------------------------------------------------------------------

describe("GET /v1/packaging/:packagingId/export", () => {
  it("returns 200 with exported text", async () => {
    mockPackagingService.exportPackaging.mockResolvedValueOnce({ text: "Video Package..." });

    const res = await request(server()).get("/v1/packaging/pkg-1/export").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { text: expect.any(String) } });
  });

  it("returns 404 when the packaging document does not exist", async () => {
    mockPackagingService.exportPackaging.mockRejectedValueOnce(NotFound("Packaging not found"));

    const res = await request(server()).get("/v1/packaging/missing-pkg/export").set(...AUTH_HEADER);

    expect(res.status).toBe(404);
  });

  it("returns 403 for another user's packaging document", async () => {
    mockPackagingService.exportPackaging.mockRejectedValueOnce(Forbidden());

    const res = await request(server()).get("/v1/packaging/someone-elses-pkg/export").set(...AUTH_HEADER);

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Auth — router-wide via router.use(authMiddleware). The documented-403-vs-
// actual-401 status code mismatch is flagged once (with a `test.failing`) in
// ideas.route.behaviour.test.ts; not repeated here.
// ---------------------------------------------------------------------------

describe("Auth", () => {
  it("rejects a request with no Authorization header without reaching the service", async () => {
    const res = await request(server()).get("/v1/packaging/list");

    expect(res.status).not.toBe(200);
    expect(res.body.success).toBe(false);
    expect(mockPackagingService.getPackagingByAccount).not.toHaveBeenCalled();
  });

  it("rejects a request with an invalid token without reaching the service", async () => {
    mockVerifyIdToken.mockRejectedValueOnce(new Error("invalid token"));

    const res = await request(server()).get("/v1/packaging/list").set("Authorization", "Bearer bad-token");

    expect(res.status).not.toBe(200);
    expect(res.body.success).toBe(false);
    expect(mockPackagingService.getPackagingByAccount).not.toHaveBeenCalled();
  });
});
