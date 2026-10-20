// Integration tests for /v1/video-projects routes
// VideoProjectService is fully mocked -- no Firestore calls are made.

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
  auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
}));

jest.mock("../../src/config/firebase", () => ({
  db: {},
  auth: {},
  firebase: {
    firestore: {
      FieldValue: { serverTimestamp: jest.fn().mockReturnValue({ _sentinel: "ts" }) },
      FieldPath: { documentId: jest.fn() },
    },
    auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
  },
}));

// Replace auth middleware with simple stubs that set req.userId.
// Both authMiddleware and sseAuthMiddleware must be mocked: app.ts loads every
// router (including scripts.route, which wires sseAuthMiddleware on the SSE
// endpoint), so an undefined export would break route registration at import.
jest.mock("../../src/middleware/auth", () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.userId = "test-user-id";
    next();
  },
  sseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.userId = "test-user-id";
    next();
  },
}));

// Stable service mock instance (mock-prefix allows use in hoisted jest.mock factory)
const mockServiceInstance = {
  create: jest.fn(),
  createFromTitle: jest.fn(),
  list: jest.fn(),
  getById: jest.fn(),
  getReconciledById: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  startStep: jest.fn(),
  completeStep: jest.fn(),
  linkResource: jest.fn(),
  markStale: jest.fn(),
};

// Mock the service class so no repo/Firestore is touched
jest.mock("../../src/service/video-project.service", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => mockServiceInstance),
}));

import request from "supertest";
import app from "../../src/app";
import { useSharedServer } from "./shared-server";
import { OTHER_ACCOUNT_ID, TEST_ACCOUNT_ID, testOwner } from "../helpers/account";
import { AccountForbidden, NotFound, WrongAccount } from "../../src/utlils/errors";

// One HTTP server for the whole file. `request(app)` starts and tears down a
// FRESH ephemeral server per call; across ~113 requests that intermittently
// produced connection-level failures (a 501 from Node with an empty body, once a
// socket hang up) on an arbitrary test, never reproducible in isolation.
const server = useSharedServer(app);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Drain any queued `mockResolvedValueOnce` between tests. `clearMocks: true`
// calls mockClear(), which resets call history but LEAVES the once-queue intact
// — so a test whose request short-circuits before reaching the service (a 400
// from validation, a 404 thrown upstream) leaves its queued value for whichever
// test calls that mock next. That produced intermittent, order-dependent
// failures on a different test each run. mockReset() drains the queue.
beforeEach(() => {
  Object.values(mockServiceInstance).forEach((fn) => (fn as jest.Mock).mockReset());
});

function getService() {
  return mockServiceInstance;
}

function makeServiceError(message: string, statusCode: number) {
  const err = new Error(message) as any;
  err.statusCode = statusCode;
  return err;
}

/**
 * What `VideoProjectService.list` actually hands back per row: a SEVEN-FIELD
 * projection, not the stored document. The suite used to feed `[PROJECT_STUB]`
 * — a full project, pipeline and `accountId` included — to the list mock and then
 * assert only `data.projects).toHaveLength(1)`, so the list envelope (and which
 * fields the dashboard card can rely on) was asserted by nothing.
 */
const PROJECT_CARD = {
  id: "proj-1",
  title: "Test Video",
  currentStep: "research",
  overallStatus: "in_progress",
  updatedAt: "2024-01-01",
  createdAt: "2024-01-01",
  thumbnailHint: null,
};

const PROJECT_STUB = {
  id: "proj-1",
  createdBy: "test-user-id", accountId: TEST_ACCOUNT_ID,
  title: "Test Video",
  ideaId: "idea-1",
  scriptId: null,
  hooksId: null,
  packagingId: null,
  thumbnailHint: null,
  overallStatus: "in_progress",
  currentStep: "research",
  isDeleted: false,
  deletedAt: null,
  pipeline: {
    research: { status: "completed", startedAt: null, completedAt: null },
    script: { status: "not_started", startedAt: null, completedAt: null },
    hooks: { status: "not_started", startedAt: null, completedAt: null },
    packaging: { status: "not_started", startedAt: null, completedAt: null },
  },
  createdAt: "2024-01-01",
  updatedAt: "2024-01-01",
};

// ---------------------------------------------------------------------------
// POST /v1/video-projects
// ---------------------------------------------------------------------------

describe("POST /v1/video-projects", () => {
  it("returns 201 with the created project, linked to the idea it came from", async () => {
    getService().create.mockResolvedValueOnce(PROJECT_STUB as any);

    const res = await request(server())
      .post("/v1/video-projects")
      .send({ ideaId: "idea-1" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    // `data).toBeDefined()` is true for `{}` and for `null`-free junk alike. The
    // client routes straight to `/project/:id` from this response and reads the
    // pipeline to decide which step to open.
    expect(res.body.data).toMatchObject({
      id: "proj-1",
      title: "Test Video",
      ideaId: "idea-1",
      currentStep: "research",
      overallStatus: "in_progress",
    });
    expect(res.body.data.pipeline.script).toMatchObject({ status: "not_started" });
  });

  it("returns 201 creating from a title (project-first, no pre-existing idea)", async () => {
    getService().createFromTitle.mockResolvedValueOnce({ ...PROJECT_STUB, title: "My Idea" } as any);

    const res = await request(server())
      .post("/v1/video-projects")
      .send({ title: "My Idea" });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: "proj-1", title: "My Idea" });
    expect(getService().createFromTitle).toHaveBeenCalledWith(
      testOwner("test-user-id"), "My Idea");
    expect(getService().create).not.toHaveBeenCalled();
  });

  it("returns 400 when neither ideaId nor title is provided", async () => {
    const res = await request(server())
      .post("/v1/video-projects")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 when both ideaId and title are provided", async () => {
    const res = await request(server())
      .post("/v1/video-projects")
      .send({ ideaId: "idea-1", title: "My Idea" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // `create` resolves the idea and hands a cross-channel one to
  // `forbidCrossAccount`, so the refusal is always CODED. The fixture was a bare
  // `Error` with `statusCode: 403`, a shape no service produces, and the assertion
  // stopped at the status — which is the one thing the two refusals share.
  it("offers a switch when the source idea lives in the caller's other channel", async () => {
    // HARM PREVENTED: "Start a video from this idea" on an idea the user can see
    // in their other channel must offer the switch, not eject them.
    getService().create.mockRejectedValueOnce(
      WrongAccount({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" })
    );

    const res = await request(server())
      .post("/v1/video-projects")
      .send({ ideaId: "idea-in-my-other-channel" });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("wrong_account");
    expect(res.body.detail).toMatchObject({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" });
  });

  it("ejects when the source idea belongs to a channel the caller is not in", async () => {
    getService().create.mockRejectedValueOnce(AccountForbidden());

    const res = await request(server())
      .post("/v1/video-projects")
      .send({ ideaId: "a-strangers-idea" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("account_forbidden");
    expect(res.body.detail).toBeUndefined();
  });

  it("returns 404 when idea is not found", async () => {
    getService().create.mockRejectedValueOnce(NotFound("Idea not found"));

    const res = await request(server())
      .post("/v1/video-projects")
      .send({ ideaId: "idea-missing" });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/video-projects
// ---------------------------------------------------------------------------

describe("GET /v1/video-projects", () => {
  it("returns the list envelope — the cards, hasMore and the cursor", async () => {
    getService().list.mockResolvedValueOnce({
      projects: [PROJECT_CARD],
      hasMore: true,
      nextCursor: "proj-1",
    } as any);

    const res = await request(server()).get("/v1/video-projects");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The whole envelope: `nextCursor` is "Load more", and the card fields are what
    // the dashboard row renders. Only the LENGTH was asserted before, which a row
    // of `{}` would have satisfied.
    expect(res.body.data).toEqual({
      projects: [PROJECT_CARD],
      hasMore: true,
      nextCursor: "proj-1",
    });
  });

  // api.md documents "Maximum: 50" for `limit`. Nothing enforced it: the value
  // went parseInt → service → `query.limit(limit + 1)`, so `?limit=1000000` was a
  // million-document read inside a Vercel time budget.
  it("enforces the documented maximum page size, and falls back on a nonsense one", async () => {
    getService().list.mockResolvedValue({ projects: [], hasMore: false, nextCursor: null } as any);

    await request(server()).get("/v1/video-projects?limit=1000000");
    expect(getService().list).toHaveBeenLastCalledWith(
      testOwner("test-user-id"),
      expect.objectContaining({ limit: 50 })
    );

    await request(server()).get("/v1/video-projects?limit=abc");
    expect(getService().list).toHaveBeenLastCalledWith(
      testOwner("test-user-id"),
      expect.objectContaining({ limit: 20 })
    );

    await request(server()).get("/v1/video-projects");
    expect(getService().list).toHaveBeenLastCalledWith(
      testOwner("test-user-id"),
      expect.objectContaining({ limit: 20 })
    );
  });

  // The other route `query_normalizer`'s comment names. A repeated `?status=`
  // would reach `service.list` as an array, sail past the `validStatuses.includes`
  // check as "not a valid status", and 400 a request that named a real status.
  it("collapses a repeated status param instead of passing an array to the service", async () => {
    getService().list.mockResolvedValue({ projects: [], hasMore: false, nextCursor: null } as any);

    const res = await request(server()).get("/v1/video-projects?status=stale&status=completed");

    expect(res.status).toBe(200);
    const [, opts] = getService().list.mock.calls.at(-1)!;
    expect(typeof (opts as { status?: unknown }).status).toBe("string");
    expect((opts as { status?: unknown }).status).toBe("completed");
  });

  it("returns 400 when service throws for invalid status", async () => {
    getService().list.mockRejectedValueOnce(makeServiceError("Invalid status value", 400));

    const res = await request(server()).get("/v1/video-projects?status=bad");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("passes status, limit, cursor query params to service", async () => {
    getService().list.mockResolvedValueOnce({ projects: [], hasMore: false, nextCursor: null } as any);

    await request(server()).get("/v1/video-projects?status=completed&limit=5&cursor=abc");

    expect(getService().list).toHaveBeenCalledWith(
      testOwner("test-user-id"),
      expect.objectContaining({ status: "completed", limit: 5, cursor: "abc" })
    );
  });

  it("passes hasMore and nextCursor in response", async () => {
    getService().list.mockResolvedValueOnce({ projects: [], hasMore: true, nextCursor: "next" } as any);

    const res = await request(server()).get("/v1/video-projects");

    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.nextCursor).toBe("next");
  });
});

// ---------------------------------------------------------------------------
// GET /v1/video-projects/:projectId
// ---------------------------------------------------------------------------

describe("GET /v1/video-projects/:projectId", () => {
  // The passthrough role is module-level shared state: a test that fails before
  // restoring it would otherwise run every later test as a viewer, turning one
  // failure into a cascade that hides its own cause.
  afterEach(() => {
    require("../helpers/account").passthroughRole.value = "owner";
  });

  it("returns the full project, pipeline included — the step the UI opens", async () => {
    getService().getReconciledById.mockResolvedValueOnce(PROJECT_STUB as any);

    const res = await request(server()).get("/v1/video-projects/proj-1");

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: "proj-1",
      title: "Test Video",
      currentStep: "research",
      ideaId: "idea-1",
    });
    // Unlike the list, the single read carries the whole pipeline: this is what
    // decides which step the project screen lands on.
    expect(res.body.data.pipeline).toMatchObject({
      research: { status: "completed" },
      script: { status: "not_started" },
      hooks: { status: "not_started" },
      packaging: { status: "not_started" },
    });
  });

  it("asks the service NOT to persist the repair when the caller is a viewer", async () => {
    // This route has no role gate — every member may read. The read-time repair
    // used to WRITE, so a viewer opening a project mutated channel data. The
    // controller is the only place that knows the role, so it is the only place
    // this can be decided; a service-level test cannot prove the controller
    // passes the right value.
    const account = require("../helpers/account");
    account.passthroughRole.value = "viewer";
    getService().getReconciledById.mockResolvedValueOnce(PROJECT_STUB as any);

    const res = await request(server()).get("/v1/video-projects/proj-1");

    expect(res.status).toBe(200);
    expect(getService().getReconciledById).toHaveBeenCalledWith("proj-1", expect.anything(), false);
  });

  it("lets an editor's GET persist the repair, so filtered lists stay in step", async () => {
    getService().getReconciledById.mockResolvedValueOnce(PROJECT_STUB as any);

    await request(server()).get("/v1/video-projects/proj-1");

    expect(getService().getReconciledById).toHaveBeenCalledWith("proj-1", expect.anything(), true);
  });

  it("returns 404 when project not found", async () => {
    getService().getReconciledById.mockRejectedValueOnce(NotFound());

    const res = await request(server()).get("/v1/video-projects/missing");

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  // THE canonical case from api-design.md: "a bookmarked project living in the
  // user's other channel renders as 'Project not found. It may have been
  // deleted.' — when it is one switch away". This route is that bookmark.
  it("tells the client the project is in another of the caller's channels, and which", async () => {
    getService().getReconciledById.mockRejectedValueOnce(
      WrongAccount({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" })
    );

    const res = await request(server()).get("/v1/video-projects/proj-in-my-other-channel");

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("wrong_account");
    expect(res.body.detail).toMatchObject({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" });
  });

  it("ejects, naming nothing, for a project in a channel the caller is not in", async () => {
    getService().getReconciledById.mockRejectedValueOnce(AccountForbidden());

    const res = await request(server()).get("/v1/video-projects/a-strangers-project");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("account_forbidden");
    expect(res.body.detail).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/video-projects/:projectId
// ---------------------------------------------------------------------------

describe("PATCH /v1/video-projects/:projectId", () => {
  it("returns 200 with updated title", async () => {
    getService().update.mockResolvedValueOnce({ title: "New Title" } as any);

    const res = await request(server())
      .patch("/v1/video-projects/proj-1")
      .send({ title: "New Title" });

    expect(res.status).toBe(200);
    // `update` returns `{ title }` and the client renames the row from it. A bare
    // `success: true` held even if the controller answered with the request body
    // or with nothing.
    expect(res.body.data).toEqual({ title: "New Title" });
  });

  it("refuses a rename of another channel's project, with the reason", async () => {
    getService().update.mockRejectedValueOnce(
      WrongAccount({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" })
    );

    const res = await request(server())
      .patch("/v1/video-projects/proj-in-my-other-channel")
      .send({ title: "Renamed" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_account");
    expect(res.body.detail).toMatchObject({ accountId: OTHER_ACCOUNT_ID });
  });

  it("returns 400 when title missing (service throws 400)", async () => {
    getService().update.mockRejectedValueOnce(makeServiceError("title is required", 400));

    const res = await request(server())
      .patch("/v1/video-projects/proj-1")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 404 when project not found", async () => {
    getService().update.mockRejectedValueOnce(NotFound());

    const res = await request(server())
      .patch("/v1/video-projects/missing")
      .send({ title: "Title" });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/video-projects/:projectId
// ---------------------------------------------------------------------------

describe("DELETE /v1/video-projects/:projectId", () => {
  it("returns the tombstoned project, so the client can drop the row", async () => {
    getService().delete.mockResolvedValueOnce({ ...PROJECT_STUB, isDeleted: true } as any);

    const res = await request(server()).delete("/v1/video-projects/proj-1");

    expect(res.status).toBe(200);
    // Soft delete: `isDeleted` is the whole outcome. `success: true` alone was
    // equally satisfied by a response that reported a delete which never happened.
    expect(res.body.data).toMatchObject({ id: "proj-1", isDeleted: true });
  });

  it("returns 404 when project not found", async () => {
    getService().delete.mockRejectedValueOnce(NotFound());

    const res = await request(server()).delete("/v1/video-projects/missing");

    expect(res.status).toBe(404);
  });

  it("refuses to delete another channel's project, and says which refusal it is", async () => {
    // HARM PREVENTED: the destructive case. `account_forbidden` here ejects the
    // user; `wrong_account` keeps them where they are and names the channel that
    // actually owns the project.
    getService().delete.mockRejectedValueOnce(
      WrongAccount({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" })
    );

    const res = await request(server()).delete("/v1/video-projects/proj-in-my-other-channel");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_account");
    expect(res.body.detail).toMatchObject({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" });

    getService().delete.mockRejectedValueOnce(AccountForbidden());

    const strangers = await request(server()).delete("/v1/video-projects/a-strangers-project");

    expect(strangers.status).toBe(403);
    expect(strangers.body.code).toBe("account_forbidden");
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/video-projects/:projectId/step/:stepName/start
// ---------------------------------------------------------------------------

describe("PATCH /v1/video-projects/:projectId/step/:stepName/start (removed)", () => {
  it("404s — generation endpoints own the in_progress transition server-side", async () => {
    const res = await request(server()).patch("/v1/video-projects/proj-1/step/script/start");

    expect(res.status).toBe(404);
    expect(getService().startStep).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/video-projects/:projectId/step/:stepName/complete
// ---------------------------------------------------------------------------

describe("PATCH /v1/video-projects/:projectId/step/:stepName/complete", () => {
  it("returns the full transition the client patches its store from", async () => {
    // The service documents this exactly: "it must still answer with the full
    // shape the client patches from — a partial body here crashes the same
    // reducer". So the shape IS the contract, and `success: true` asserted none of it.
    getService().completeStep.mockResolvedValueOnce({
      id: "proj-1",
      currentStep: "hooks",
      overallStatus: "in_progress",
      pipeline: { ...PROJECT_STUB.pipeline, script: { status: "completed", startedAt: null, completedAt: null } },
    } as any);

    const res = await request(server()).patch("/v1/video-projects/proj-1/step/script/complete");

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: "proj-1",
      currentStep: "hooks",
      overallStatus: "in_progress",
      pipeline: { script: { status: "completed" } },
    });
  });

  it("refuses a step transition on another channel's project, with the reason", async () => {
    getService().completeStep.mockRejectedValueOnce(
      WrongAccount({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" })
    );

    const res = await request(server()).patch("/v1/video-projects/proj-in-my-other-channel/step/script/complete");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_account");
  });

  it("returns 400 when step is not_started", async () => {
    getService().completeStep.mockRejectedValueOnce(
      makeServiceError("Cannot complete a step that has not been started", 400)
    );

    const res = await request(server()).patch("/v1/video-projects/proj-1/step/script/complete");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 for invalid stepName", async () => {
    getService().completeStep.mockRejectedValueOnce(makeServiceError("Invalid step", 400));

    const res = await request(server()).patch("/v1/video-projects/proj-1/step/research/complete");

    expect(res.status).toBe(400);
  });

  it("returns 404 when project not found", async () => {
    getService().completeStep.mockRejectedValueOnce(NotFound());

    const res = await request(server()).patch("/v1/video-projects/missing/step/script/complete");

    expect(res.status).toBe(404);
  });

  it("passes projectId, stepName and the owner to service", async () => {
    getService().completeStep.mockResolvedValueOnce({ id: "proj-42", currentStep: "packaging" } as any);

    await request(server()).patch("/v1/video-projects/proj-42/step/hooks/complete");

    expect(getService().completeStep).toHaveBeenCalledWith("proj-42", "hooks", testOwner("test-user-id"));
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/video-projects/:projectId/link/:resourceType
// ---------------------------------------------------------------------------

describe("PATCH /v1/video-projects/:projectId/link/:resourceType", () => {
  it("returns the project with the resource now linked", async () => {
    getService().linkResource.mockResolvedValueOnce({ ...PROJECT_STUB, scriptId: "script-abc" } as any);

    const res = await request(server())
      .patch("/v1/video-projects/proj-1/link/script")
      .send({ resourceId: "script-abc" });

    expect(res.status).toBe(200);
    // The link IS the outcome — a response that reported success without it would
    // leave the client believing a script is attached when none is.
    expect(res.body.data).toMatchObject({ id: "proj-1", scriptId: "script-abc" });
  });

  it("returns 400 when resourceId is missing", async () => {
    const res = await request(server())
      .patch("/v1/video-projects/proj-1/link/script")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/resourceId/i);
  });

  it("returns 400 for invalid resourceType (service throws 400)", async () => {
    getService().linkResource.mockRejectedValueOnce(makeServiceError("Invalid resourceType", 400));

    const res = await request(server())
      .patch("/v1/video-projects/proj-1/link/invalid")
      .send({ resourceId: "res-1" });

    expect(res.status).toBe(400);
  });

  // The body-supplied-id case: the project is yours, the RESOURCE is not.
  // `linkResource` checks the resource's account too, and that refusal is coded.
  it("refuses a foreign resource id linked onto a project the caller does own", async () => {
    // HARM PREVENTED: without the discriminator, attaching a resource that lives
    // in the caller's other channel ejects them from the channel they are in —
    // instead of telling them the script they picked is in «Finance».
    getService().linkResource.mockRejectedValueOnce(
      WrongAccount({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" })
    );

    const res = await request(server())
      .patch("/v1/video-projects/proj-1/link/script")
      .send({ resourceId: "script-in-my-other-channel" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_account");
    expect(res.body.detail).toMatchObject({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" });

    getService().linkResource.mockRejectedValueOnce(AccountForbidden());

    const strangers = await request(server())
      .patch("/v1/video-projects/proj-1/link/script")
      .send({ resourceId: "a-strangers-script" });

    expect(strangers.status).toBe(403);
    expect(strangers.body.code).toBe("account_forbidden");
  });

  it("returns 404 when project not found", async () => {
    getService().linkResource.mockRejectedValueOnce(NotFound("script not found"));

    const res = await request(server())
      .patch("/v1/video-projects/missing/link/script")
      .send({ resourceId: "script-abc" });

    expect(res.status).toBe(404);
  });

  it("passes projectId, resourceType, resourceId and the owner to service", async () => {
    getService().linkResource.mockResolvedValueOnce({ id: "proj-1", packagingId: "pkg-xyz" } as any);

    await request(server())
      .patch("/v1/video-projects/proj-1/link/packaging")
      .send({ resourceId: "pkg-xyz" });

    expect(getService().linkResource).toHaveBeenCalledWith(
      "proj-1", "packaging", "pkg-xyz", testOwner("test-user-id"));
  });
});
