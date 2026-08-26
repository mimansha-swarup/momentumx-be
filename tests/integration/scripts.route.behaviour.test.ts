// Behaviour-driven integration tests for /v1/scripts — the router had none.
//
// Script is pipeline step 2 and the primary generation flow, and it was the only
// resource router with zero HTTP-level coverage: its auth wiring was asserted
// only by `auth-coverage.test.ts`, which greps the source for the string
// `router.use(authMiddleware)` and never sends a request.
//
// Contract taken from .claude/rules/api-design.md (route inventory, the SSE
// exception, the 401-vs-403 split, `userId` never from the body) and from the
// real frontend caller `momentumx-fe/src/service/script.ts` — which sends
// `{ script }` to PATCH /edit/:scriptId, a bare POST to /:scriptId/regenerate,
// and reaches the stream ONLY as `?token=`, because EventSource cannot set
// headers. ContentService is mocked at the module boundary; container.ts wires
// the real controller.

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

const mockContentService = {
  generateScripts: jest.fn(),
  getUsersScript: jest.fn(),
  getScriptById: jest.fn(),
  editScript: jest.fn(),
  regenerateScript: jest.fn(),
  exportScript: jest.fn(),
};

jest.mock("../../src/service/content.service", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => mockContentService),
}));

import request from "supertest";
import app from "../../src/app";
import { ServiceUnavailable } from "../../src/utlils/errors";
import { useSharedServer } from "./shared-server";

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
  // mockReset, not mockClear: clearMocks leaves the `mockResolvedValueOnce`
  // queue intact, so a request that short-circuits before the service (a 400
  // from validation) hands its queued value to whichever test runs next.
  Object.values(mockContentService).forEach((fn) => (fn as jest.Mock).mockReset());

  // The SSE controller owns no response of its own — the service writes and ends
  // it. A bare `jest.fn()` therefore resolves without ever ending the response,
  // and the request hangs until the test times out. Default to a stream that
  // terminates properly; the SSE tests below override it.
  mockContentService.generateScripts.mockImplementation(async (_u, _p, res) => {
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

// ---------------------------------------------------------------------------
// Auth — the actual requests, not a source-text grep
// ---------------------------------------------------------------------------

describe("/v1/scripts — nothing is reachable without a verified token", () => {
  const routes = [
    ["get", "/v1/scripts"],
    ["get", "/v1/scripts/script-1"],
    ["get", "/v1/scripts/script-1/export"],
    ["patch", "/v1/scripts/edit/script-1"],
    ["post", "/v1/scripts/script-1/regenerate"],
  ] as const;

  it.each(routes)("%s %s is 401 with no Authorization header", async (method, path) => {
    const res = await (request(server()) as never as Record<string, (p: string) => never>)[method](path);

    expect((res as unknown as { status: number }).status).toBe(401);
    expect(mockContentService.getUsersScript).not.toHaveBeenCalled();
    expect(mockContentService.editScript).not.toHaveBeenCalled();
  });

  it.each(routes)("%s %s is 401 when the token is rejected", async (method, path) => {
    mockVerifyIdToken.mockRejectedValue(new Error("token expired"));

    const res = await (request(server()) as never as Record<string, (p: string) => never>)[method](path);

    expect((res as unknown as { status: number }).status).toBe(401);
  });

  // 401 and 403 are not interchangeable: 401 sends the user to log in again,
  // 403 means "we know who you are, and no". Reading someone else's script is
  // the second one.
  it("keeps 403 distinct from 401 when the caller is known but not the owner", async () => {
    mockContentService.getScriptById.mockRejectedValueOnce(makeServiceError("Forbidden", 403));

    const res = await request(server()).get("/v1/scripts/script-1").set(...AUTH_HEADER);

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// SSE — the one route that authenticates differently
// ---------------------------------------------------------------------------

describe("GET /v1/scripts/stream/:projectId — the EventSource exception", () => {
  it("authenticates from ?token=, because EventSource cannot send headers", async () => {
    mockContentService.generateScripts.mockImplementationOnce(async (_u, _p, res) => {
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const res = await request(server()).get("/v1/scripts/stream/proj-1?token=valid-token");

    expect(res.status).toBe(200);
    expect(mockVerifyIdToken).toHaveBeenCalledWith("valid-token");
    expect(mockContentService.generateScripts).toHaveBeenCalledWith(
      "user-1",
      "proj-1",
      expect.anything()
    );
  });

  it("401s with no token, without starting a stream", async () => {
    const res = await request(server()).get("/v1/scripts/stream/proj-1");

    expect(res.status).toBe(401);
    expect(mockContentService.generateScripts).not.toHaveBeenCalled();
  });

  it("401s on an invalid token rather than opening a stream that then fails", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("bad token"));

    const res = await request(server()).get("/v1/scripts/stream/proj-1?token=nope");

    expect(res.status).toBe(401);
    expect(mockContentService.generateScripts).not.toHaveBeenCalled();
  });

  // A failure BEFORE flushHeaders is still an ordinary JSON error the client can
  // read. After the stream opens it is too late — the controller must not try.
  it("returns a normal JSON error when generation fails before any bytes are written", async () => {
    mockContentService.generateScripts.mockRejectedValueOnce(
      makeServiceError("Video project not found", 404)
    );

    const res = await request(server()).get("/v1/scripts/stream/proj-1?token=valid-token");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, message: "Video project not found" });
  });

  it("ends the response instead of appending JSON once the stream has started", async () => {
    mockContentService.generateScripts.mockImplementationOnce(async (_u, _p, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.flushHeaders();
      res.write('data: "partial"\n\n');
      throw makeServiceError("upstream died", 503);
    });

    const res = await request(server()).get("/v1/scripts/stream/proj-1?token=valid-token");

    // Headers were already sent, so the status is the stream's 200 and the body
    // is SSE frames — never a JSON error object spliced into the stream.
    expect(res.status).toBe(200);
    expect(res.text).toContain('data: "partial"');
    expect(res.text).not.toContain('"success":false');
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("GET /v1/scripts and /:scriptId", () => {
  it("lists the caller's scripts in the standard envelope", async () => {
    mockContentService.getUsersScript.mockResolvedValueOnce([{ id: "script-1" }]);

    const res = await request(server()).get("/v1/scripts").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: [{ id: "script-1" }] });
    // Identity comes from the verified token, never the query string.
    expect(mockContentService.getUsersScript).toHaveBeenCalledWith("user-1");
  });

  it("ignores a userId supplied by the client and uses the token's uid", async () => {
    mockContentService.getUsersScript.mockResolvedValueOnce([]);

    await request(server()).get("/v1/scripts?userId=someone-else").set(...AUTH_HEADER);

    expect(mockContentService.getUsersScript).toHaveBeenCalledWith("user-1");
  });

  it("passes scriptId from the path and userId from the token, in that order", async () => {
    mockContentService.getScriptById.mockResolvedValueOnce({ id: "script-1" });

    const res = await request(server()).get("/v1/scripts/script-1").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    // A swapped pair here would read one user's id as a document id — the exact
    // wiring bug nothing was watching for on this router.
    expect(mockContentService.getScriptById).toHaveBeenCalledWith("script-1", "user-1");
  });

  it("does not let /:scriptId swallow the /stream path", async () => {
    mockContentService.getScriptById.mockResolvedValueOnce(null);

    await request(server()).get("/v1/scripts/stream/proj-1?token=valid-token");

    expect(mockContentService.getScriptById).not.toHaveBeenCalled();
  });

  it("exports through the two-segment route, not the single-segment one", async () => {
    mockContentService.exportScript.mockResolvedValueOnce({ text: "SCRIPT", title: "T" });

    const res = await request(server()).get("/v1/scripts/script-1/export").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ text: "SCRIPT" });
    expect(mockContentService.exportScript).toHaveBeenCalledWith("user-1", "script-1");
    expect(mockContentService.getScriptById).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Edit — the validated body
// ---------------------------------------------------------------------------

describe("PATCH /v1/scripts/edit/:scriptId", () => {
  it("accepts { script }, the payload the frontend actually sends", async () => {
    mockContentService.editScript.mockResolvedValueOnce({ script: "new text" });

    const res = await request(server())
      .patch("/v1/scripts/edit/script-1")
      .set(...AUTH_HEADER)
      .send({ script: "new text" });

    expect(res.status).toBe(200);
    expect(mockContentService.editScript).toHaveBeenCalledWith(
      "script-1",
      "user-1",
      { script: "new text" }
    );
    // The client needs the id back to update its own store.
    expect(res.body.data).toMatchObject({ scriptId: "script-1" });
  });

  it("400s an empty body rather than writing nothing and reporting success", async () => {
    const res = await request(server())
      .patch("/v1/scripts/edit/script-1")
      .set(...AUTH_HEADER)
      .send({});

    expect(res.status).toBe(400);
    expect(mockContentService.editScript).not.toHaveBeenCalled();
  });

  it("400s an empty script string — a blank save is data loss, not an edit", async () => {
    const res = await request(server())
      .patch("/v1/scripts/edit/script-1")
      .set(...AUTH_HEADER)
      .send({ script: "" });

    expect(res.status).toBe(400);
    expect(mockContentService.editScript).not.toHaveBeenCalled();
  });

  it("strips fields the schema does not allow, so a client cannot write server-owned state", async () => {
    mockContentService.editScript.mockResolvedValueOnce({ script: "ok" });

    await request(server())
      .patch("/v1/scripts/edit/script-1")
      .set(...AUTH_HEADER)
      .send({ script: "ok", createdBy: "someone-else", videoProjectId: "proj-9" });

    expect(mockContentService.editScript).toHaveBeenCalledWith("script-1", "user-1", {
      script: "ok",
    });
  });

  it("surfaces the service's 404 as 404", async () => {
    mockContentService.editScript.mockRejectedValueOnce(makeServiceError("Script not found", 404));

    const res = await request(server())
      .patch("/v1/scripts/edit/script-1")
      .set(...AUTH_HEADER)
      .send({ script: "x" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false });
  });
});

// ---------------------------------------------------------------------------
// Regenerate
// ---------------------------------------------------------------------------

describe("POST /v1/scripts/:scriptId/regenerate", () => {
  it("regenerates from the path id alone — the frontend sends no body", async () => {
    mockContentService.regenerateScript.mockResolvedValueOnce({ id: "script-1", script: "new" });

    const res = await request(server())
      .post("/v1/scripts/script-1/regenerate")
      .set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(mockContentService.regenerateScript).toHaveBeenCalledWith("user-1", "script-1");
    expect(res.body.data).toMatchObject({ id: "script-1" });
  });

  // The 5xx disclosure policy, from the creator's side: an author-written
  // ServiceUnavailable reaches them verbatim ("retry, your script is unchanged"),
  // while an unexpected throw is masked so no driver internals leak.
  it("shows the author-written 503 message, and masks an unexpected throw", async () => {
    mockContentService.regenerateScript.mockRejectedValueOnce(
      ServiceUnavailable("Couldn't generate a script. Please try again.")
    );

    const retryable = await request(server())
      .post("/v1/scripts/script-1/regenerate")
      .set(...AUTH_HEADER);

    // 503 tells the client "retry"; a 500 tells it "give up".
    expect(retryable.status).toBe(503);
    expect(retryable.body.message).toMatch(/try again/i);

    mockContentService.regenerateScript.mockRejectedValueOnce(
      new Error("FIRESTORE (11.0.1) INTERNAL ASSERTION FAILED")
    );

    const masked = await request(server())
      .post("/v1/scripts/script-1/regenerate")
      .set(...AUTH_HEADER);

    expect(masked.status).toBe(500);
    expect(masked.body.message).toBe("Something went wrong");
    expect(masked.body.message).not.toMatch(/FIRESTORE/);
  });
});
