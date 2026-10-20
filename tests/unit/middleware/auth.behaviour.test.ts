// Behaviour contract (backend-standards.md / api-design.md):
//  - Every protected route resolves identity via authMiddleware; req.userId is
//    NEVER trusted from the client.
//  - All auth failures respond through res.sendError({ message, statusCode: 401 })
//    — never a raw res.status().json()/res.send().
//  - sseAuthMiddleware PREFERS the Authorization header and falls back to
//    `?token=`. It was query-only because EventSource cannot send headers; the
//    frontend now streams via axios's fetch adapter, which sends the header and
//    no longer appends `?token=` — so query-only 401'd every script generation,
//    and the client signs out on a 401. The fallback remains for tabs loaded
//    before that deploy.
//  - An empty/absent `uid` on an otherwise-verified token must be REFUSED — a
//    verified token with uid "" would write "" as a real, shared owner value
//    into every downstream record (see the guard's own comment in auth.ts).
//
// Firebase itself is mocked at the config-module boundary per the project's
// testing-patterns skill — never firebase-admin directly.

import type { NextFunction, Request, Response } from "express";

const mockVerifyIdToken = jest.fn();

jest.mock("../../../src/config/firebase", () => ({
  db: {},
  auth: {},
  firebase: {
    auth: jest.fn().mockReturnValue({ verifyIdToken: mockVerifyIdToken }),
  },
}));

import { authMiddleware, sseAuthMiddleware } from "../../../src/middleware/auth";

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

function makeRes() {
  return {
    sendError: jest.fn(),
    // Present so a middleware that "cheats" by calling raw res methods instead
    // of res.sendError is caught, instead of throwing a confusing TypeError.
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as unknown as Response & {
    sendError: jest.Mock;
    status: jest.Mock;
    json: jest.Mock;
    send: jest.Mock;
  };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, query: {}, ...overrides } as unknown as Request;
}

describe("authMiddleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects with 401 via res.sendError when the Authorization header is missing", () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    authMiddleware(req, res, next as NextFunction);

    expect(res.sendError).toHaveBeenCalledWith({
      message: "Unauthorized",
      statusCode: 401,
    });
    expect(next).not.toHaveBeenCalled();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    // Never a raw response — only the res.sendError contract.
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it.each([
    ["Basic sometoken", "wrong scheme"],
    ["Bearer", "scheme with no token"],
    ["Bearer ", "scheme with only whitespace"],
    ["justatoken", "no scheme at all"],
  ])("rejects with 401 for a malformed Authorization header: %s (%s)", (header) => {
    const req = makeReq({ headers: { authorization: header } as any });
    const res = makeRes();
    const next = jest.fn();

    authMiddleware(req, res, next as NextFunction);

    expect(res.sendError).toHaveBeenCalledWith({
      message: "Unauthorized",
      statusCode: 401,
    });
    expect(next).not.toHaveBeenCalled();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects with 401 via res.sendError when the token fails verification", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("invalid signature"));
    const req = makeReq({ headers: { authorization: "Bearer bad-token" } as any });
    const res = makeRes();
    const next = jest.fn();

    authMiddleware(req, res, next as NextFunction);
    await flushPromises();

    expect(mockVerifyIdToken).toHaveBeenCalledWith("bad-token");
    expect(res.sendError).toHaveBeenCalledWith({
      message: "Unable to authenticate",
      statusCode: 401,
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("sets req.userId and calls next() for a valid token", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-123" });
    const req = makeReq({ headers: { authorization: "Bearer good-token" } as any });
    const res = makeRes();
    const next = jest.fn();

    authMiddleware(req, res, next as NextFunction);
    await flushPromises();

    expect(req.userId).toBe("user-123");
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.sendError).not.toHaveBeenCalled();
  });

  it.each([
    ["", "empty string"],
    [undefined, "absent"],
    [null, "null"],
    // Both tuple members named: it.each passes the label too, and a one-parameter
    // callback no longer matches the tuple under strict mode.
  ])("refuses a verified token whose uid is %s (%s)", async (uid, _label) => {
    mockVerifyIdToken.mockResolvedValue({ uid });
    const req = makeReq({ headers: { authorization: "Bearer good-token" } as any });
    const res = makeRes();
    const next = jest.fn();

    authMiddleware(req, res, next as NextFunction);
    await flushPromises();

    expect(res.sendError).toHaveBeenCalledWith({
      message: "Unauthorized",
      statusCode: 401,
    });
    expect(next).not.toHaveBeenCalled();
    expect(req.userId).toBeUndefined();
  });
});

describe("sseAuthMiddleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("prefers the Authorization header over ?token=", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-123" });
    // A token in a query string is written verbatim into access logs, proxy logs
    // and Referer; the header is not. When both are offered, take the header.
    const req = makeReq({
      headers: { authorization: "Bearer header-token" } as any,
      query: { token: "query-token" } as any,
    });
    const res = makeRes();
    const next = jest.fn();

    sseAuthMiddleware(req, res, next as NextFunction);
    await flushPromises();

    expect(mockVerifyIdToken).toHaveBeenCalledWith("header-token");
    expect(req.userId).toBe("user-123");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("authenticates from the header alone, which is how the client streams now", async () => {
    // The regression this pins: `service/script.ts` streams through axios with
    // `adapter: "fetch"` and sends NO `?token=`. Query-only auth 401'd every
    // generation, and a 401 signs the user out — so clicking Generate logged
    // you out. Nothing caught it because the FE test mocks baseFetch wholesale.
    mockVerifyIdToken.mockResolvedValue({ uid: "user-123" });
    const req = makeReq({
      headers: { authorization: "Bearer header-token" } as any,
      query: {},
    });
    const res = makeRes();
    const next = jest.fn();

    sseAuthMiddleware(req, res, next as NextFunction);
    await flushPromises();

    expect(mockVerifyIdToken).toHaveBeenCalledWith("header-token");
    expect(req.userId).toBe("user-123");
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.sendError).not.toHaveBeenCalled();
  });

  it("rejects with 401 when NEITHER a header nor ?token= is present", () => {
    const req = makeReq({ headers: {} as any, query: {} });
    const res = makeRes();
    const next = jest.fn();

    sseAuthMiddleware(req, res, next as NextFunction);

    expect(res.sendError).toHaveBeenCalledWith({
      message: "Unauthorized",
      statusCode: 401,
    });
    expect(next).not.toHaveBeenCalled();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("ignores a malformed Authorization scheme and falls back to ?token=", () => {
    // `Basic abc` is not a bearer token. Falling through to the query param is
    // what keeps a pre-deploy tab working; verifying "abc" as a Firebase ID
    // token would not.
    mockVerifyIdToken.mockResolvedValue({ uid: "user-123" });
    const req = makeReq({
      headers: { authorization: "Basic abc" } as any,
      query: { token: "query-token" } as any,
    });

    sseAuthMiddleware(req, makeRes(), jest.fn() as NextFunction);

    expect(mockVerifyIdToken).toHaveBeenCalledWith("query-token");
  });

  it("rejects with 401 when the ?token= fallback is not a single string (repeated query param)", () => {
    // Express/qs parses ?token=a&token=b as an array — the middleware's
    // `typeof token !== "string"` guard must reject that, not pass it to Firebase.
    const req = makeReq({ query: { token: ["a", "b"] } as any });
    const res = makeRes();
    const next = jest.fn();

    sseAuthMiddleware(req, res, next as NextFunction);

    expect(res.sendError).toHaveBeenCalledWith({
      message: "Unauthorized",
      statusCode: 401,
    });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("rejects with 401 via res.sendError when the token fails verification", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("expired"));
    const req = makeReq({ query: { token: "bad-token" } as any });
    const res = makeRes();
    const next = jest.fn();

    sseAuthMiddleware(req, res, next as NextFunction);
    await flushPromises();

    expect(res.sendError).toHaveBeenCalledWith({
      message: "Unable to authenticate",
      statusCode: 401,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("refuses a verified token with an empty uid, same as authMiddleware", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "" });
    const req = makeReq({ query: { token: "good-token" } as any });
    const res = makeRes();
    const next = jest.fn();

    sseAuthMiddleware(req, res, next as NextFunction);
    await flushPromises();

    expect(res.sendError).toHaveBeenCalledWith({
      message: "Unauthorized",
      statusCode: 401,
    });
    expect(next).not.toHaveBeenCalled();
  });
});
