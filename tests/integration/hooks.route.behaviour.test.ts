// Behaviour-driven integration tests for /v1/hooks (routes + controller).
//
// Contract derived FIRST from .claude/rules/api-design.md ("Owning IDs" rule —
// select/regenerate must derive videoProjectId from the stored hooks batch,
// never the body) and docs/features/hooks/api.md, then checked against
// src/controller/hooks.controller.ts + src/routes/v1/hooks.route.ts.
// HooksService is mocked at the module boundary; src/container.ts wires the
// real class into hooksController.

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

const mockHooksService = {
  generate: jest.fn(),
  select: jest.fn(),
  regenerate: jest.fn(),
  getById: jest.fn(),
  exportHooks: jest.fn(),
};

jest.mock("../../src/service/hooks.service", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => mockHooksService),
}));

import request from "supertest";
import app from "../../src/app";
import { useSharedServer } from "./shared-server";

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
  Object.values(mockHooksService).forEach((fn) => (fn as jest.Mock).mockReset());
});

// ---------------------------------------------------------------------------
// POST /v1/hooks/generate
// ---------------------------------------------------------------------------

describe("POST /v1/hooks/generate", () => {
  it("returns 200 with the generated batch on success", async () => {
    mockHooksService.generate.mockResolvedValueOnce({ id: "hooks-1", hooks: ["h1", "h2", "h3", "h4", "h5"] });

    const res = await request(server())
      .post("/v1/hooks/generate")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "proj-1", script: "the script" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: expect.any(Object) });
    expect(mockHooksService.generate).toHaveBeenCalledWith("user-1", "proj-1", "the script");
  });

  it("returns 400 when videoProjectId is missing (this is a create/generate op, so it IS accepted in the body)", async () => {
    const res = await request(server())
      .post("/v1/hooks/generate")
      .set(...AUTH_HEADER)
      .send({ script: "the script" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, message: expect.any(String) });
    expect(mockHooksService.generate).not.toHaveBeenCalled();
  });

  it("allows an omitted script — resolved server-side from the project", async () => {
    mockHooksService.generate.mockResolvedValueOnce({ id: "hooks-1", hooks: [] });

    const res = await request(server())
      .post("/v1/hooks/generate")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "proj-1" });

    expect(res.status).toBe(200);
    expect(mockHooksService.generate).toHaveBeenCalledWith("user-1", "proj-1", undefined);
  });

  it("returns 404 when the video project does not exist", async () => {
    mockHooksService.generate.mockRejectedValueOnce(makeServiceError("Video project not found", 404));

    const res = await request(server())
      .post("/v1/hooks/generate")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "missing", script: "s" });

    expect(res.status).toBe(404);
  });

  it("returns 403 when the video project is not owned by the requester", async () => {
    mockHooksService.generate.mockRejectedValueOnce(makeServiceError("Forbidden", 403));

    const res = await request(server())
      .post("/v1/hooks/generate")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "someone-elses-project", script: "s" });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/hooks/:hooksId/select
// ---------------------------------------------------------------------------

describe("POST /v1/hooks/:hooksId/select", () => {
  it("returns 200 on success", async () => {
    mockHooksService.select.mockResolvedValueOnce({ id: "proj-1", hooksId: "hooks-1", selectedHookIndex: 2 });

    const res = await request(server())
      .post("/v1/hooks/hooks-1/select")
      .set(...AUTH_HEADER)
      .send({ hookIndex: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: expect.any(Object) });
  });

  it("returns 400 when hookIndex is missing", async () => {
    const res = await request(server())
      .post("/v1/hooks/hooks-1/select")
      .set(...AUTH_HEADER)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockHooksService.select).not.toHaveBeenCalled();
  });

  // Owning-ID rule (api-design.md): the target project must be resolved from
  // the stored hooks batch, never a client-supplied videoProjectId. A client
  // trying to smuggle one in should have no effect on the call.
  it("derives the owning project server-side — a body-supplied videoProjectId is not read", async () => {
    mockHooksService.select.mockResolvedValueOnce({ id: "proj-1", hooksId: "hooks-1", selectedHookIndex: 1 });

    await request(server())
      .post("/v1/hooks/hooks-1/select")
      .set(...AUTH_HEADER)
      .send({ hookIndex: 1, videoProjectId: "attacker-chosen-project" });

    expect(mockHooksService.select).toHaveBeenCalledWith("user-1", "hooks-1", 1);
  });

  it("returns 404 for another user's hooks batch (never that user's data)", async () => {
    mockHooksService.select.mockRejectedValueOnce(makeServiceError("Hooks batch not found", 404));

    const res = await request(server())
      .post("/v1/hooks/someone-elses-batch/select")
      .set(...AUTH_HEADER)
      .send({ hookIndex: 0 });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/hooks/:hooksId/regenerate
// ---------------------------------------------------------------------------

describe("POST /v1/hooks/:hooksId/regenerate", () => {
  it("returns 200 with the regenerated batch", async () => {
    mockHooksService.regenerate.mockResolvedValueOnce({ id: "hooks-1", hooks: ["a", "b", "c", "d", "e"] });

    const res = await request(server())
      .post("/v1/hooks/hooks-1/regenerate")
      .set(...AUTH_HEADER)
      .send({ script: "updated script" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: expect.any(Object) });
  });

  it("derives the owning project server-side — a body-supplied videoProjectId is not read", async () => {
    mockHooksService.regenerate.mockResolvedValueOnce({ id: "hooks-1", hooks: [] });

    await request(server())
      .post("/v1/hooks/hooks-1/regenerate")
      .set(...AUTH_HEADER)
      .send({ script: "updated script", videoProjectId: "attacker-chosen-project" });

    expect(mockHooksService.regenerate).toHaveBeenCalledWith("user-1", "hooks-1", "updated script");
  });

  it("returns 404 for a nonexistent hooks batch", async () => {
    mockHooksService.regenerate.mockRejectedValueOnce(makeServiceError("Hooks batch not found", 404));

    const res = await request(server())
      .post("/v1/hooks/missing/regenerate")
      .set(...AUTH_HEADER)
      .send({ script: "s" });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/hooks/:hooksId/export
// ---------------------------------------------------------------------------

describe("GET /v1/hooks/:hooksId/export", () => {
  it("returns 200 with exported text", async () => {
    mockHooksService.exportHooks.mockResolvedValueOnce({ text: "1. hook one", count: 5 });

    const res = await request(server()).get("/v1/hooks/hooks-1/export").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { text: expect.any(String), count: 5 } });
  });

  it("returns 404 for another user's hooks batch", async () => {
    mockHooksService.exportHooks.mockRejectedValueOnce(makeServiceError("Hooks batch not found", 404));

    const res = await request(server()).get("/v1/hooks/someone-elses-batch/export").set(...AUTH_HEADER);

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/hooks/:hooksId
// ---------------------------------------------------------------------------

describe("GET /v1/hooks/:hooksId", () => {
  it("returns 200 with the saved batch", async () => {
    mockHooksService.getById.mockResolvedValueOnce({ id: "hooks-1", hooks: ["a", "b", "c", "d", "e"] });

    const res = await request(server()).get("/v1/hooks/hooks-1").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: expect.any(Object) });
  });

  it("returns 404 for another user's hooks batch (never that user's data)", async () => {
    mockHooksService.getById.mockRejectedValueOnce(makeServiceError("Hooks batch not found", 404));

    const res = await request(server()).get("/v1/hooks/someone-elses-batch").set(...AUTH_HEADER);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auth — router-wide via router.use(authMiddleware). The documented-403-vs-
// actual-401 status code mismatch is flagged once (with a `test.failing`) in
// ideas.route.behaviour.test.ts; not repeated here.
// ---------------------------------------------------------------------------

describe("Auth", () => {
  it("rejects a request with no Authorization header without reaching the service", async () => {
    const res = await request(server()).get("/v1/hooks/hooks-1");

    expect(res.status).not.toBe(200);
    expect(res.body.success).toBe(false);
    expect(mockHooksService.getById).not.toHaveBeenCalled();
  });

  it("rejects a request with an invalid token without reaching the service", async () => {
    mockVerifyIdToken.mockRejectedValueOnce(new Error("invalid token"));

    const res = await request(server()).get("/v1/hooks/hooks-1").set("Authorization", "Bearer bad-token");

    expect(res.status).not.toBe(200);
    expect(res.body.success).toBe(false);
    expect(mockHooksService.getById).not.toHaveBeenCalled();
  });
});
