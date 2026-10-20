// Two small guarantees that had no test, and both fail silently when broken.

import { errorHandler } from "../../../src/middleware/error_handler";
import loggerMiddleware from "../../../src/middleware/logger_middleware";
import { ServiceUnavailable } from "../../../src/utlils/errors";
import type { NextFunction, Request, Response } from "express";

describe("errorHandler — never writes to a response that has already started", () => {
  // Annotated because `status: jest.fn(() => res)` references `res` inside its own
  // initializer, which strict mode cannot infer. Typed as the Response surface the
  // handler actually touches, so a handler reaching for anything else fails to compile.
  type FakeRes = Pick<Response, "headersSent"> & {
    sendError: jest.Mock;
    status: jest.Mock;
    json: jest.Mock;
    end: jest.Mock;
  };

  const makeRes = (headersSent: boolean) => {
    const res: FakeRes = {
      headersSent,
      sendError: jest.fn(),
      status: jest.fn(() => res),
      json: jest.fn(),
      end: jest.fn(),
    };
    return res as unknown as Response & { sendError: jest.Mock; status: jest.Mock; json: jest.Mock };
  };

  const req = { originalUrl: "/v1/scripts/stream/proj-1" } as Request;

  it("stays silent once headers are flushed — an SSE stream is already in flight", async () => {
    const res = makeRes(true);

    errorHandler(ServiceUnavailable("upstream died"), req, res, jest.fn() as NextFunction);

    // Appending a JSON error object to an open event-stream corrupts the frame
    // the client is mid-parse on. There is nothing useful left to say; say nothing.
    expect(res.sendError).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it("still answers normally when nothing has been written yet", async () => {
    const res = makeRes(false);

    errorHandler(ServiceUnavailable("upstream died"), req, res, jest.fn() as NextFunction);

    expect(res.sendError).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 503, message: "upstream died" })
    );
  });
});

describe("loggerMiddleware — credentials must not reach the logs", () => {
  let logged: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    logged = [];
    spy = jest.spyOn(console, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
  });

  afterEach(() => spy.mockRestore());

  const run = (originalUrl: string) => {
    const next = jest.fn();
    loggerMiddleware({ method: "GET", originalUrl } as Request, {} as Response, next as NextFunction);
    expect(next).toHaveBeenCalled();
    return logged.join("\n");
  };

  // The SSE route puts a real Firebase ID token in the query string, because
  // EventSource cannot set headers. Logging it verbatim would put a working
  // credential into every log sink the app writes to.
  it("redacts the SSE ?token=", () => {
    const line = run("/v1/scripts/stream/proj-1?token=eyJhbGciOi.REAL.SECRET");

    expect(line).not.toContain("REAL.SECRET");
    expect(line).toContain("token=[REDACTED]");
  });

  it.each(["key", "apikey", "api_key", "APIKEY", "Token"])(
    "redacts ?%s= regardless of case",
    (param) => {
      const line = run(`/v1/thing?${param}=supersecret`);

      expect(line).not.toContain("supersecret");
      expect(line).toContain("[REDACTED]");
    }
  );

  it("redacts a credential that is not the first param, and stops at the next &", () => {
    const line = run("/v1/scripts/stream/p1?limit=5&token=secret123&status=done");

    expect(line).not.toContain("secret123");
    expect(line).toContain("limit=5");
    expect(line).toContain("status=done");
  });

  it("redacts every credential when more than one is present", () => {
    const line = run("/v1/thing?token=aaa&key=bbb");

    expect(line).not.toContain("aaa");
    expect(line).not.toContain("bbb");
  });

  it("leaves an ordinary URL readable — the log is still meant to be useful", () => {
    const line = run("/v1/ideas?limit=9&searchText=ai");

    expect(line).toContain("GET /v1/ideas?limit=9&searchText=ai");
  });
});
