// Unit tests for the central error handler middleware.
// Focus: the 500-disclosure policy — a non-HttpError (no statusCode) must map
// to a generic 500 JSON {success:false} that does NOT leak the raw internal
// error text.

import express from "express";
import request from "supertest";
import { errorHandler } from "../../src/middleware/error_handler";
import { responseFormatter } from "../../src/middleware/response_formatter";
import { HttpError } from "../../src/utlils/errors";
import type { NextFunction, Request, Response } from "express";

// Builds a minimal Express-like res that mirrors responseFormatter's sendError,
// so assertions reflect the real response shape the handler produces.
//
// `sendError` here is a line-for-line mirror of src/middleware/response_formatter.ts
// — including `Number(statusCode) || 500` and the `code` field. If it drifts, these
// tests assert a response shape no client ever receives.
//
// `{ withSendError: false }` builds the res the handler meets when responseFormatter
// never ran (an error thrown by a middleware mounted before it), which is the only
// reason error_handler.ts carries a raw `res.status().json()` fallback at all.
function makeRes(opts: { withSendError?: boolean } = {}) {
  const { withSendError = true } = opts;
  const state: { statusCode?: number; body?: any; headersSent: boolean } = {
    headersSent: false,
  };

  const res: Record<string, unknown> = {
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
  };

  if (withSendError) {
    res.sendError = ({
      message,
      statusCode,
      detail,
      code,
    }: {
      message: string;
      statusCode?: number;
      detail?: unknown;
      code?: string;
    }) => {
      const status = Number(statusCode) || 500;
      state.statusCode = status;
      state.body = { success: false, message, code, detail };
      return res;
    };
  }

  return { res: res as unknown as Response, state };
}

const silenceConsole = () => {
  let spy: jest.SpyInstance;
  beforeEach(() => {
    spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => spy.mockRestore());
};

/** Throws `err` at the handler and returns the status + body the client would see. */
function handle(err: unknown, opts?: { withSendError?: boolean }) {
  const { res, state } = makeRes(opts);
  errorHandler(err, req, res, next);
  return state;
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

// ---------------------------------------------------------------------------
// The error-mapping contract matrix.
//
// Everything below tests `resolveStatus` through its only public door. The
// branches it covers are the ones nothing else reaches: seven integration
// suites build their failures with `makeServiceError(message, statusCode)`,
// which attaches a numeric `statusCode` and therefore short-circuits legacy
// message resolution, `status`, and every normalisation question entirely.
// ---------------------------------------------------------------------------

describe("legacy string sentinels — the complete family", () => {
  silenceConsole();

  // Harm prevented: a bare `throw new Error("Idea not found")` surfacing as a
  // 500 "Something went wrong" tells the creator the product is broken when the
  // truth is "that idea is gone" — and a 500 is not retried or handled by the
  // client the way a 404 is.
  it.each([
    ["Forbidden", 403],
    ["Unauthorized", 401],
    ["Not found", 404],
    ["Idea not found", 404],
    ["Script not found", 404],
    ["Hooks batch not found", 404],
    ["Packaging not found", 404],
  ])('a bare Error("%s") resolves to %i', (message, expected) => {
    const state = handle(new Error(message));

    expect(state.statusCode).toBe(expected);
    // 4xx echoes the curated sentinel message rather than masking it.
    expect(state.body.message).toBe(message);
  });

  // Harm prevented: 401 and 403 send the client to two different places. A 403
  // makes Phase 07's handler treat this as a permission problem and eject the
  // user from the channel; 401 means "sign in again". The map entry carries a
  // comment saying it was once wrongly 403 — this is what keeps it from
  // regressing.
  it('"Unauthorized" is 401 — never 403, and never one of the permission codes', () => {
    const state = handle(new Error("Unauthorized"));

    expect(state.statusCode).toBe(401);
    expect(state.statusCode).not.toBe(403);
    // No `code`: the three 403 discriminators must not be forgeable from a
    // message-only throw, or the client branches on a reason nobody authored.
    expect(state.body.code).toBeUndefined();
  });
});

describe("status precedence — HttpError, then statusCode, then status, then the sentinel map", () => {
  silenceConsole();

  // Harm prevented: the sentinel map is documented as a *fallback* for legacy
  // bare throws. If a message could outrank an explicitly authored status, any
  // service that happens to phrase a 400 as "Not found" silently becomes a 404,
  // and `BadRequest("Not found")` would stop meaning what its author wrote.
  it.each([
    [
      "an authored HttpError outranks a colliding sentinel message",
      new HttpError("Not found", 400),
      400,
    ],
    [
      "an explicit numeric statusCode outranks the sentinel map",
      Object.assign(new Error("Not found"), { statusCode: 400 }),
      400,
    ],
    [
      "an explicit numeric status outranks the sentinel map",
      Object.assign(new Error("Not found"), { status: 418 }),
      418,
    ],
    [
      "statusCode outranks status when both are present",
      Object.assign(new Error("Not found"), { statusCode: 400, status: 418 }),
      400,
    ],
    [
      "a non-numeric statusCode is not trusted, so the sentinel map still applies",
      Object.assign(new Error("Not found"), { statusCode: "418" }),
      404,
    ],
    [
      "a non-numeric status is not trusted either",
      Object.assign(new Error("Not found"), { status: "418" }),
      404,
    ],
  ])("%s", (_label, err, expected) => {
    expect(handle(err).statusCode).toBe(expected);
  });
});

describe("hostile throws — strings, null, and non-Error objects", () => {
  silenceConsole();

  // Harm prevented: a handler that trips over a non-Error throw never writes a
  // response at all, and the request hangs until the client times out.
  it.each([
    ["a thrown string", "Not found"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an array", []],
    ["an object with no recognised fields", { kind: "weird" }],
  ])("%s still produces a well-formed generic 500", (_label, err) => {
    const state = handle(err);

    expect(state.statusCode).toBe(500);
    expect(state.body).toMatchObject({ success: false, message: "Something went wrong" });
  });

  // Harm prevented: a thrown string is not an author-written HttpError, so its
  // text is untrusted and must be masked like any other unexpected throw.
  it("never echoes the contents of a thrown string", () => {
    const state = handle("connect ECONNREFUSED postgres://user:pw@10.0.0.1:5432");

    expect(state.body.message).toBe("Something went wrong");
    expect(JSON.stringify(state.body)).not.toContain("postgres://");
  });

  // Harm prevented: stringifying a non-string `message` would ship
  // "[object Object]" — or worse, the object's internals — as the user-facing
  // message on a 4xx, which is echoed rather than masked.
  it("masks a non-string message even on a 4xx, where messages are echoed", () => {
    const state = handle({ statusCode: 400, message: { serviceAccountKey: "PRIVATE KEY" } });

    expect(state.statusCode).toBe(400);
    expect(state.body.message).toBe("Something went wrong");
    expect(JSON.stringify(state.body)).not.toContain("PRIVATE KEY");
  });

  // A plain object literal is the shape an Express-internal or third-party
  // failure arrives as; it must get the same treatment as a real Error.
  it("resolves a plain object literal through the same rules as an Error", () => {
    const state = handle({ message: "Script not found" });

    expect(state.statusCode).toBe(404);
    expect(state.body.message).toBe("Script not found");
  });
});

describe("the raw JSON fallback, when res.sendError is absent", () => {
  silenceConsole();

  // Harm prevented: an error thrown before responseFormatter mounted (or by
  // responseFormatter itself) must still answer in the documented envelope
  // instead of hanging the request or crashing the process.
  it("keeps the standard envelope, code and detail on a 4xx", () => {
    const state = handle(new HttpError("nope", 403, { accountId: "acc-1" }, "wrong_account"), {
      withSendError: false,
    });

    expect(state.statusCode).toBe(403);
    expect(state.body).toEqual({
      success: false,
      message: "nope",
      code: "wrong_account",
      detail: { accountId: "acc-1" },
    });
  });

  it("applies the same 500 masking, with no code or detail", () => {
    const state = handle(new Error("connect ECONNREFUSED postgres://user:pw@host"), {
      withSendError: false,
    });

    expect(state.statusCode).toBe(500);
    expect(state.body.success).toBe(false);
    expect(state.body.message).toBe("Something went wrong");
    expect(state.body.code).toBeUndefined();
    expect(state.body.detail).toBeUndefined();
    expect(JSON.stringify(state.body)).not.toContain("postgres://");
  });

  // Harm prevented: "you were not charged" is the one marker allowed across the
  // 5xx boundary. Losing it on this path makes a failed generation look like it
  // may have cost credits.
  it("still carries the uncharged marker across the 5xx boundary", () => {
    const state = handle(new HttpError("generation returned nothing", 503, { charged: false }), {
      withSendError: false,
    });

    expect(state.statusCode).toBe(503);
    expect(state.body.detail).toEqual({ charged: false });
  });
});

describe("invalid numeric statuses", () => {
  silenceConsole();

  // Falsy garbage is normalised — but only because responseFormatter's
  // `Number(statusCode) || 500` happens to catch falsy values. Asserted through
  // the REAL formatter and a real request, because the fake above only mirrors
  // that expression: mirrored, it would keep passing if the real one changed.
  //
  // Harm prevented: `res.status(0)` makes Node throw from inside res.json, and
  // the request dies without the documented envelope.
  it.each([
    ["zero", 0],
    ["NaN", NaN],
  ])("%s becomes a 500 with the standard envelope", async (_label, status) => {
    // Bound once per case rather than shared, because each case throws a different
    // status and a shared mutable would race `it.each`. Two binds, not ten.
    const app = express();
    app.use(responseFormatter);
    app.get("/probe", () => {
      throw new HttpError("boom", status as number);
    });
    app.use(errorHandler);

    const res = await request(app).get("/probe");

    expect(res.status).toBe(500);
    // "boom", not "Something went wrong": an author-written HttpError message is
    // deliberately echoed on 5xx (only unexpected throws are masked).
    expect(res.body).toMatchObject({ success: false, message: "boom" });
  });

  // KNOWN FAILING — this asserts the INTENDED contract, which the code does not
  // yet meet. See the report: resolveStatus returns any number verbatim, and the
  // only normalisation in the stack is `Number(statusCode) || 500`, which catches
  // 0 and NaN and nothing else.
  //
  // Harm prevented: a status outside 100–599 makes Node's writeHead throw from
  // inside `res.json`. Express then hands the request to finalhandler, which
  // answers **500 text/html** — so the client's interceptor reads an HTML page
  // where `{ success: false, message }` is contractually guaranteed ("Standard
  // Response Shape — Always"). 600 is worse in a quieter way: it ships as-is, a
  // status no HTTP client has a meaning for.
  //
  // resolveStatus now clamps via `writable()`; this was an `it.failing` until then.
  it("normalises out-of-range and non-integer statuses to something writable", () => {
    const unwritable = [-1, 99, 600, 1000, 404.7];

    const resolved = unwritable.map((s) => handle(new HttpError("boom", s)).statusCode);

    for (const status of resolved) {
      expect(Number.isInteger(status)).toBe(true);
      expect(status).toBeGreaterThanOrEqual(100);
      expect(status).toBeLessThanOrEqual(599);
    }
  });
});
