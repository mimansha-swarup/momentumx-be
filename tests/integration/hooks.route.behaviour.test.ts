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
import { testOwner, TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID } from "../helpers/account";
import { AccountForbidden, NotFound, WrongAccount } from "../../src/utlils/errors";

// One HTTP server for the whole file. `request(app)` starts and tears down a
// FRESH ephemeral server per call; across ~113 requests that intermittently
// produced connection-level failures (a 501 from Node with an empty body, once a
// socket hang up) on an arbitrary test, never reproducible in isolation.
const server = useSharedServer(app);

const AUTH_HEADER = ["Authorization", "Bearer valid-token"] as const;

/**
 * A real `IHooksBatch` (src/types/routes/hooks.ts), not a two-key stand-in.
 *
 * Every fixture in this file used to be `{ id, hooks }`, which cannot exist —
 * `videoProjectId`, `accountId`, `createdBy` and `hookFeedback` are all required
 * on the type. Paired with `data: expect.any(Object)`, the response body was
 * asserted by nothing: `{}` passed, and so did a batch with no hooks in it.
 */
const FIVE_HOOKS = ["Hook one", "Hook two", "Hook three", "Hook four", "Hook five"];

const hooksBatch = (overrides: Record<string, unknown> = {}) => ({
  id: "hooks-1",
  videoProjectId: "proj-1",
  createdBy: "user-1",
  accountId: TEST_ACCOUNT_ID,
  hooks: FIVE_HOOKS,
  hookFeedback: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

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
    mockHooksService.generate.mockResolvedValueOnce(hooksBatch());

    const res = await request(server())
      .post("/v1/hooks/generate")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "proj-1", script: "the script" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The batch id and the five hooks are the response: the client selects by
    // index against this array and posts back to `/:hooksId/select`. A body with
    // the id but no hooks renders five empty cards, and `expect.any(Object)`
    // could not tell them apart.
    expect(res.body.data).toMatchObject({
      id: "hooks-1",
      videoProjectId: "proj-1",
      hooks: FIVE_HOOKS,
    });
    expect(mockHooksService.generate).toHaveBeenCalledWith(
      testOwner("user-1"), "proj-1", "the script");
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
    mockHooksService.generate.mockResolvedValueOnce(hooksBatch());

    const res = await request(server())
      .post("/v1/hooks/generate")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "proj-1" });

    expect(res.status).toBe(200);
    expect(mockHooksService.generate).toHaveBeenCalledWith(
      testOwner("user-1"), "proj-1", undefined);
  });

  it("returns 404 when the video project does not exist", async () => {
    mockHooksService.generate.mockRejectedValueOnce(NotFound("Video project not found"));

    const res = await request(server())
      .post("/v1/hooks/generate")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "missing", script: "s" });

    expect(res.status).toBe(404);
  });

  // A cross-channel refusal, with the reason. The fixture used to be a bare
  // `Error` carrying `statusCode: 403` — a shape no service produces: `generate`
  // resolves the project through `videoProjectService.getById`, which calls
  // `forbidCrossAccount`, and that only ever throws `WrongAccount` or
  // `AccountForbidden`. Asserting the status alone let the two collapse into one.
  it("offers a switch for a project in the caller's OTHER channel", async () => {
    // HARM PREVENTED: generating hooks against a project bookmarked from the
    // user's other channel must offer "Switch to «Finance»", not eject them from
    // the channel they are standing in.
    mockHooksService.generate.mockRejectedValueOnce(
      WrongAccount({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" })
    );

    const res = await request(server())
      .post("/v1/hooks/generate")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "project-in-my-other-channel", script: "s" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_account");
    expect(res.body.detail).toMatchObject({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" });
  });

  it("ejects for a project in a channel the caller is not a member of", async () => {
    mockHooksService.generate.mockRejectedValueOnce(AccountForbidden());

    const res = await request(server())
      .post("/v1/hooks/generate")
      .set(...AUTH_HEADER)
      .send({ videoProjectId: "a-strangers-project", script: "s" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("account_forbidden");
    // Nothing about a channel the caller has no membership in is disclosed.
    expect(res.body.detail).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/hooks/:hooksId/select
// ---------------------------------------------------------------------------

describe("POST /v1/hooks/:hooksId/select", () => {
  it("echoes back the PROJECT id, the batch id and the chosen index", async () => {
    mockHooksService.select.mockResolvedValueOnce({ id: "proj-1", hooksId: "hooks-1", selectedHookIndex: 2 });

    const res = await request(server())
      .post("/v1/hooks/hooks-1/select")
      .set(...AUTH_HEADER)
      .send({ hookIndex: 2 });

    expect(res.status).toBe(200);
    // `id` here is the PROJECT (VideoProjectService.setSelectedHook), which is
    // what the pipeline view re-reads — not the hooks batch. Dropping
    // `selectedHookIndex` would leave the UI showing no hook selected right after
    // the user selected one.
    expect(res.body.data).toEqual({ id: "proj-1", hooksId: "hooks-1", selectedHookIndex: 2 });
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

    expect(mockHooksService.select).toHaveBeenCalledWith(
      testOwner("user-1"), "hooks-1", 1);
  });

  it("returns 404 for a hooks batch that does not exist", async () => {
    mockHooksService.select.mockRejectedValueOnce(NotFound("Hooks batch not found"));

    const res = await request(server())
      .post("/v1/hooks/no-such-batch/select")
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
    mockHooksService.regenerate.mockResolvedValueOnce({
      id: "hooks-1",
      hooks: FIVE_HOOKS,
      hookFeedback: {},
    });

    const res = await request(server())
      .post("/v1/hooks/hooks-1/regenerate")
      .set(...AUTH_HEADER)
      .send({ script: "updated script" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: "hooks-1", hooks: FIVE_HOOKS, hookFeedback: {} });
    // Regeneration clears per-hook feedback, because the hooks it referred to are
    // gone. A response that carried the old feedback would show likes against
    // hooks the creator has never seen.
    expect(res.body.data.hookFeedback).toEqual({});
  });

  it("derives the owning project server-side — a body-supplied videoProjectId is not read", async () => {
    mockHooksService.regenerate.mockResolvedValueOnce({ id: "hooks-1", hooks: FIVE_HOOKS, hookFeedback: {} });

    await request(server())
      .post("/v1/hooks/hooks-1/regenerate")
      .set(...AUTH_HEADER)
      .send({ script: "updated script", videoProjectId: "attacker-chosen-project" });

    expect(mockHooksService.regenerate).toHaveBeenCalledWith(
      testOwner("user-1"), "hooks-1", "updated script");
  });

  it("returns 404 for a nonexistent hooks batch", async () => {
    mockHooksService.regenerate.mockRejectedValueOnce(NotFound("Hooks batch not found"));

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
    mockHooksService.exportHooks.mockResolvedValueOnce({ text: `Hooks\n1. ${FIVE_HOOKS[0]}`, count: 5 });

    const res = await request(server()).get("/v1/hooks/hooks-1/export").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ text: expect.stringContaining(FIVE_HOOKS[0]), count: 5 });
  });

  it("returns 404 for a hooks batch that does not exist", async () => {
    mockHooksService.exportHooks.mockRejectedValueOnce(NotFound("Hooks batch not found"));

    const res = await request(server()).get("/v1/hooks/no-such-batch/export").set(...AUTH_HEADER);

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/hooks/:hooksId
// ---------------------------------------------------------------------------

describe("GET /v1/hooks/:hooksId", () => {
  it("returns 200 with the saved batch", async () => {
    mockHooksService.getById.mockResolvedValueOnce(hooksBatch({ hookFeedback: { "0": "like" } }));

    const res = await request(server()).get("/v1/hooks/hooks-1").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    // This read exists so a refresh can show the hook itself, not just "Hook 3
    // was selected" — so the hooks and the stored feedback are the contract.
    expect(res.body.data).toMatchObject({
      id: "hooks-1",
      videoProjectId: "proj-1",
      hooks: FIVE_HOOKS,
      hookFeedback: { "0": "like" },
    });
  });

  it("returns 404 for a hooks batch that does not exist", async () => {
    mockHooksService.getById.mockRejectedValueOnce(NotFound("Hooks batch not found"));

    const res = await request(server()).get("/v1/hooks/no-such-batch").set(...AUTH_HEADER);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  // The read is where "offer the switch" matters most: this is the request a
  // bookmarked link makes. Answering it without `wrong_account` is what renders a
  // batch that is one channel-switch away as "not found, it may have been deleted".
  it("names the owning channel when the batch lives in the caller's other channel", async () => {
    mockHooksService.getById.mockRejectedValueOnce(
      WrongAccount({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" })
    );

    const res = await request(server()).get("/v1/hooks/batch-in-my-other-channel").set(...AUTH_HEADER);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_account");
    expect(res.body.detail).toMatchObject({ accountId: OTHER_ACCOUNT_ID, displayName: "Finance Channel" });
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
