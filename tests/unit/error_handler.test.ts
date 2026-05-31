// Unit tests for the central error handler middleware.
// Focus: the 500-disclosure policy — a non-HttpError (no statusCode) must map
// to a generic 500 JSON {success:false} that does NOT leak the raw internal
// error text.

import { errorHandler } from "../../src/middleware/error_handler";
import { HttpError } from "../../src/utlils/errors";
import type { NextFunction, Request, Response } from "express";

// Builds a minimal Express-like res that mirrors responseFormatter's sendError,
// so assertions reflect the real response shape the handler produces.
function makeRes() {
  const state: { statusCode?: number; body?: any; headersSent: boolean } = {
    headersSent: false,
  };

  const res = {
    get headersSent() {
      return state.headersSent;
    },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: any) {
      state.body = payload;
      return res;
    },
    sendError({ message, statusCode, detail }: { message: string; statusCode?: number; detail?: unknown }) {
      const code = Number(statusCode) || 500;
      state.statusCode = code;
      state.body = { success: false, message, detail };
      return res;
    },
  } as unknown as Response;

  return { res, state };
}

const req = { originalUrl: "/v1/anything" } as unknown as Request;
const next = (() => undefined) as unknown as NextFunction;

describe("errorHandler — 500 disclosure policy", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("maps a non-HttpError (no statusCode) to a generic 500 that hides internal text", () => {
    const secret = "Database connection string postgres://user:pass@host leaked";
    const { res, state } = makeRes();

    errorHandler(new Error(secret), req, res, next);

    expect(state.statusCode).toBe(500);
    expect(state.body.success).toBe(false);
    // The raw internal error text must NOT be disclosed to the client.
    expect(state.body.message).not.toContain(secret);
    expect(state.body.message).not.toContain("postgres://");
    expect(state.body.message).toBe("Something went wrong");
  });

  it("logs the internal detail server-side even though it is not returned", () => {
    const secret = "internal stack detail";
    const { res } = makeRes();

    errorHandler(new Error(secret), req, res, next);

    const logged = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).toContain(secret);
  });

  it("still echoes the curated message for 4xx HttpErrors", () => {
    const { res, state } = makeRes();

    errorHandler(new HttpError("title is required", 400), req, res, next);

    expect(state.statusCode).toBe(400);
    expect(state.body.success).toBe(false);
    expect(state.body.message).toBe("title is required");
  });
});
