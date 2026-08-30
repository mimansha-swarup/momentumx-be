// Behaviour-driven integration tests for /v1/research — the last router with no
// HTTP-level coverage.
//
// Small router, but two things here are only true at this layer: the three
// endpoints are auth-gated as actual requests (not as a source-text grep in
// auth-coverage.test.ts), and `?query=` is a client-supplied value that reaches
// the YouTube API, so how the controller handles a missing one is a contract.

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
    FieldValue: { serverTimestamp: jest.fn() },
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
      FieldValue: { serverTimestamp: jest.fn() },
      FieldPath: { documentId: jest.fn() },
    },
    auth: jest.fn().mockReturnValue({ verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) }),
  },
}));

const mockResearchService = {
  getTrending: jest.fn(),
  getCompetitorInsights: jest.fn(),
  getKeywords: jest.fn(),
};

jest.mock("../../src/service/research.service", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => mockResearchService),
}));

import request from "supertest";
import app from "../../src/app";
import { useSharedServer } from "./shared-server";
import { testOwner } from "../helpers/account";

const server = useSharedServer(app);

const AUTH_HEADER = ["Authorization", "Bearer valid-token"] as const;

beforeEach(() => {
  mockVerifyIdToken.mockReset();
  mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });
  Object.values(mockResearchService).forEach((fn) => (fn as jest.Mock).mockReset());
});

describe("/v1/research — auth, as real requests", () => {
  const paths = ["/v1/research/trending", "/v1/research/competitors", "/v1/research/keywords"];

  it.each(paths)("%s is 401 without a token", async (path) => {
    const res = await request(server()).get(path);

    expect(res.status).toBe(401);
    expect(mockResearchService.getTrending).not.toHaveBeenCalled();
    expect(mockResearchService.getCompetitorInsights).not.toHaveBeenCalled();
    expect(mockResearchService.getKeywords).not.toHaveBeenCalled();
  });

  it.each(paths)("%s is 401 when the token does not verify", async (path) => {
    mockVerifyIdToken.mockRejectedValue(new Error("expired"));

    const res = await request(server()).get(path);

    expect(res.status).toBe(401);
  });
});

describe("GET /v1/research/trending and /competitors", () => {
  it("scopes trending to the caller's own niche, taken from the token", async () => {
    mockResearchService.getTrending.mockResolvedValueOnce([{ videoId: "a" }]);

    const res = await request(server()).get("/v1/research/trending").set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: [{ videoId: "a" }] });
    expect(mockResearchService.getTrending).toHaveBeenCalledWith(
      testOwner("user-1"));
  });

  it("cannot be pointed at another user by query string", async () => {
    mockResearchService.getCompetitorInsights.mockResolvedValueOnce([]);

    await request(server())
      .get("/v1/research/competitors?userId=someone-else")
      .set(...AUTH_HEADER);

    expect(mockResearchService.getCompetitorInsights).toHaveBeenCalledWith(
      testOwner("user-1"));
  });

  // Research is an enhancer, never a gate — but that contract lives inside
  // ResearchContextService, which the generation paths use. These three routes
  // are the user asking for research directly, so a failure is honest here.
  it("surfaces an upstream failure as 503 rather than an empty 200", async () => {
    const err = new Error("YouTube quota exceeded") as Error & { statusCode: number };
    err.statusCode = 503;
    mockResearchService.getTrending.mockRejectedValueOnce(err);

    const res = await request(server()).get("/v1/research/trending").set(...AUTH_HEADER);

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
  });
});

describe("GET /v1/research/keywords", () => {
  it("passes the query through verbatim", async () => {
    mockResearchService.getKeywords.mockResolvedValueOnce([{ keyword: "ai tools" }]);

    const res = await request(server())
      .get("/v1/research/keywords?query=ai%20tools")
      .set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(mockResearchService.getKeywords).toHaveBeenCalledWith("ai tools");
  });

  it("sends an empty string, not undefined, when no query is given", async () => {
    mockResearchService.getKeywords.mockResolvedValueOnce([]);

    const res = await request(server()).get("/v1/research/keywords").set(...AUTH_HEADER);

    // The service signature is (query: string). Passing undefined through would
    // surface downstream as "undefined" in a YouTube search URL.
    expect(res.status).toBe(200);
    expect(mockResearchService.getKeywords).toHaveBeenCalledWith("");
  });

  // Found by this suite: Express parses a repeated param into an ARRAY, which the
  // controller's `as string` cast waved through, and `query.trim()` in the
  // service then threw — a malformed query came back as a 500 "Something went
  // wrong". Normalised app-wide now (middleware/query_normalizer.ts), because
  // ideas and video-projects cast query params exactly the same way.
  it("collapses a repeated query param to one string instead of 500ing", async () => {
    mockResearchService.getKeywords.mockResolvedValueOnce([]);

    const res = await request(server())
      .get("/v1/research/keywords?query=first&query=second")
      .set(...AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(mockResearchService.getKeywords).toHaveBeenCalledWith("second");
  });

  it("does not pass an object through when the param is sent as query[x]=1", async () => {
    mockResearchService.getKeywords.mockRejectedValueOnce(
      Object.assign(new Error("query is required"), { statusCode: 400 })
    );

    const res = await request(server())
      .get("/v1/research/keywords?query[x]=1")
      .set(...AUTH_HEADER);

    // "[object Object]" would be a perfectly valid-looking YouTube search.
    expect(mockResearchService.getKeywords).toHaveBeenCalledWith("");
    expect(res.status).toBe(400);
  });
});
