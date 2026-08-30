// Behaviour-driven integration tests for /v1/user (routes + controller).
//
// Contract derived FIRST from .claude/rules/api-design.md's route summary
// ("required minimum: channel URL, OR niche + targetAudience") and
// src/validation/user.validation.ts (the current, authoritative schema — see
// note below on docs/features/onboarding/api.md), then checked against
// src/controller/user.controller.ts + src/routes/v1/user.route.ts.
// UserService is mocked at the module boundary; src/container.ts wires the
// real class into userController.
//
// NOTE on doc staleness (reported, not tested): docs/features/onboarding/api.md
// says "No server-side validation" and marks every onboarding field
// individually Required. That is stale — src/validation/user.validation.ts
// (wired via `validate(onboardingSchema)` on the route) enforces "channel URL,
// OR (niche AND targetAudience)" via a cross-field .refine(), matching the
// newer .claude/rules/api-design.md route summary. Tests below follow the
// current, more-recently-synced contract (api-design.md + the actual schema).

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

const mockUserService = {
  createOnboardingData: jest.fn(),
  prefillFromChannel: jest.fn(),
  refreshContext: jest.fn(),
  getProfile: jest.fn(),
  updateProfile: jest.fn(),
};

jest.mock("../../src/service/user.service", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => mockUserService),
}));

import request from "supertest";
import app from "../../src/app";
import { useSharedServer } from "./shared-server";
import { testOwner } from "../helpers/account";

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
const VALID_CHANNEL_URL = "https://www.youtube.com/@somecreator";

beforeEach(() => {
  mockVerifyIdToken.mockReset();
  mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });

  // Drain any queued `mockResolvedValueOnce`. `clearMocks: true` calls
  // mockClear(), which resets call history but LEAVES the once-queue intact — so
  // a test whose request short-circuits before reaching the service (a 400 from
  // validation, a 404 thrown upstream) leaves its queued value for whichever
  // test calls that mock next. That produced intermittent, order-dependent
  // failures on a different test each run. mockReset() drains the queue.
  Object.values(mockUserService).forEach((fn) => (fn as jest.Mock).mockReset());
});

// ---------------------------------------------------------------------------
// POST /v1/user/onboarding/prefill
// ---------------------------------------------------------------------------

describe("POST /v1/user/onboarding/prefill", () => {
  it("returns 200 with prefill suggestions", async () => {
    mockUserService.prefillFromChannel.mockResolvedValueOnce({ niche: "n", targetAudience: "a", brandName: "b" });

    const res = await request(server())
      .post("/v1/user/onboarding/prefill")
      .set(...AUTH_HEADER)
      .send({ channelUrl: VALID_CHANNEL_URL });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: expect.any(Object) });
    expect(mockUserService.prefillFromChannel).toHaveBeenCalledWith(VALID_CHANNEL_URL);
  });

  it("returns 400 when channelUrl is missing", async () => {
    const res = await request(server()).post("/v1/user/onboarding/prefill").set(...AUTH_HEADER).send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockUserService.prefillFromChannel).not.toHaveBeenCalled();
  });

  it("returns 400 with a field-prefixed message for a non-YouTube URL", async () => {
    const res = await request(server())
      .post("/v1/user/onboarding/prefill")
      .set(...AUTH_HEADER)
      .send({ channelUrl: "https://example.com/not-youtube" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/channelUrl/);
    expect(mockUserService.prefillFromChannel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/user/onboarding
// ---------------------------------------------------------------------------

describe("PATCH /v1/user/onboarding", () => {
  it("returns 200 when a channel URL alone is provided", async () => {
    mockUserService.createOnboardingData.mockResolvedValueOnce({ userName: VALID_CHANNEL_URL });

    const res = await request(server())
      .patch("/v1/user/onboarding")
      .set(...AUTH_HEADER)
      .send({ userName: VALID_CHANNEL_URL });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { payload: expect.any(Object) } });
  });

  it("returns 200 when niche + targetAudience alone are provided (no-channel path)", async () => {
    mockUserService.createOnboardingData.mockResolvedValueOnce({ niche: "n", targetAudience: "a" });

    const res = await request(server())
      .patch("/v1/user/onboarding")
      .set(...AUTH_HEADER)
      .send({ niche: "fitness", targetAudience: "beginners" });

    expect(res.status).toBe(200);
    expect(mockUserService.createOnboardingData).toHaveBeenCalledWith(
      testOwner("user-1"), expect.any(Object));
  });

  it("returns 400 when neither a channel URL nor (niche + targetAudience) is provided", async () => {
    const res = await request(server())
      .patch("/v1/user/onboarding")
      .set(...AUTH_HEADER)
      .send({ niche: "fitness" }); // targetAudience missing — incomplete no-channel path

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockUserService.createOnboardingData).not.toHaveBeenCalled();
  });

  it("uses the authenticated uid, ignoring a body-supplied userId", async () => {
    mockUserService.createOnboardingData.mockResolvedValueOnce({});

    await request(server())
      .patch("/v1/user/onboarding")
      .set(...AUTH_HEADER)
      .send({ userName: VALID_CHANNEL_URL, userId: "someone-elses-uid" });

    expect(mockUserService.createOnboardingData).toHaveBeenCalledWith(
      testOwner("user-1"), expect.any(Object));
  });
});

// ---------------------------------------------------------------------------
// POST /v1/user/refresh-context
// ---------------------------------------------------------------------------

describe("POST /v1/user/refresh-context", () => {
  it("returns 200 with refreshed context", async () => {
    mockUserService.refreshContext.mockResolvedValueOnce({ channelId: "abc" });

    const res = await request(server()).post("/v1/user/refresh-context").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: expect.any(Object) });
    expect(mockUserService.refreshContext).toHaveBeenCalledWith(
      testOwner("user-1"));
  });

  it("propagates a service failure as an error response, not an unhandled rejection", async () => {
    mockUserService.refreshContext.mockRejectedValueOnce(new Error("enrichment failed"));

    const res = await request(server()).post("/v1/user/refresh-context").set(...AUTH_HEADER);

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/user/profile
// ---------------------------------------------------------------------------

describe("GET /v1/user/profile", () => {
  it("returns 200 with the profile for the authenticated uid", async () => {
    mockUserService.getProfile.mockResolvedValueOnce({ niche: "fitness" });

    const res = await request(server()).get("/v1/user/profile").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { niche: "fitness" } });
    expect(mockUserService.getProfile).toHaveBeenCalledWith(
      testOwner("user-1"));
  });

  it("returns an empty object, not null/undefined, when the user has no document yet", async () => {
    mockUserService.getProfile.mockResolvedValueOnce(null);

    const res = await request(server()).get("/v1/user/profile").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/user/profile
// ---------------------------------------------------------------------------

describe("PATCH /v1/user/profile", () => {
  it("returns 200 for a single-field partial update", async () => {
    mockUserService.updateProfile.mockResolvedValueOnce({ brandName: "New Brand" });

    const res = await request(server())
      .patch("/v1/user/profile")
      .set(...AUTH_HEADER)
      .send({ brandName: "New Brand" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { payload: expect.any(Object) } });
    expect(mockUserService.updateProfile).toHaveBeenCalledWith(
      testOwner("user-1"), expect.objectContaining({ brandName: "New Brand" }));
  });

  it("returns 400 for a malformed website URL", async () => {
    const res = await request(server())
      .patch("/v1/user/profile")
      .set(...AUTH_HEADER)
      .send({ website: "not-a-url" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/website/);
    expect(mockUserService.updateProfile).not.toHaveBeenCalled();
  });

  it("propagates a service failure as an error response", async () => {
    mockUserService.updateProfile.mockRejectedValueOnce(new Error("Firestore update failed"));

    const res = await request(server())
      .patch("/v1/user/profile")
      .set(...AUTH_HEADER)
      .send({ brandName: "New Brand" });

    expect(res.status).toBe(500);
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
    const res = await request(server()).get("/v1/user/profile");

    expect(res.status).not.toBe(200);
    expect(res.body.success).toBe(false);
    expect(mockUserService.getProfile).not.toHaveBeenCalled();
  });

  it("rejects a request with an invalid token without reaching the service", async () => {
    mockVerifyIdToken.mockRejectedValueOnce(new Error("invalid token"));

    const res = await request(server()).get("/v1/user/profile").set("Authorization", "Bearer bad-token");

    expect(res.status).not.toBe(200);
    expect(res.body.success).toBe(false);
    expect(mockUserService.getProfile).not.toHaveBeenCalled();
  });
});
