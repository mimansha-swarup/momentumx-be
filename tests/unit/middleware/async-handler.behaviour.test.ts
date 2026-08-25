// Contract: asyncHandler exists so a REJECTED promise from an async controller
// reaches Express's error pipeline via next(err) instead of hanging the request
// (Express does not auto-catch async rejections — only synchronous throws).
//
// Two levels are covered:
//  1. Unit level — asyncHandler forwards a rejection to next() and does NOT
//     forward on a normal resolution.
//  2. Integration level — wired into a real (tiny) Express app with
//     responseFormatter + errorHandler, proving the request actually
//     terminates with a response instead of hanging.

import type { NextFunction, Request, Response } from "express";
import express from "express";
import request from "supertest";
import { asyncHandler } from "../../../src/middleware/async_handler";
import { responseFormatter } from "../../../src/middleware/response_formatter";
import { errorHandler } from "../../../src/middleware/error_handler";
import { HttpError } from "../../../src/utlils/errors";

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

describe("asyncHandler — unit", () => {
  it("forwards a rejected promise's error to next(), and does not call next() on success", async () => {
    const err = new Error("boom");
    const rejecting = asyncHandler(async () => {
      throw err;
    });
    const next = jest.fn();

    rejecting({} as Request, {} as Response, next as NextFunction);
    await flushPromises();

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(err);
  });

  it("does not call next() when the wrapped handler resolves normally", async () => {
    const sendSuccess = jest.fn();
    const resolving = asyncHandler(async (_req, res) => {
      (res as unknown as { sendSuccess: typeof sendSuccess }).sendSuccess({ data: "ok" });
    });
    const next = jest.fn();
    const res = { sendSuccess } as unknown as Response;

    resolving({} as Request, res, next as NextFunction);
    await flushPromises();

    expect(next).not.toHaveBeenCalled();
    expect(sendSuccess).toHaveBeenCalledWith({ data: "ok" });
  });
});

describe("asyncHandler — wired into a real Express pipeline", () => {
  function buildApp() {
    const app = express();
    app.use(responseFormatter);

    app.get(
      "/rejects",
      asyncHandler(async () => {
        throw new HttpError("nope", 404);
      })
    );

    app.get(
      "/resolves",
      asyncHandler(async (_req, res) => {
        res.sendSuccess({ data: { ok: true } });
      })
    );

    app.use(errorHandler);
    return app;
  }

  it("a rejected promise reaches the error handler and the request completes (does not hang)", async () => {
    const res = await request(buildApp()).get("/rejects");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, message: "nope" });
  });

  it("a resolved promise completes the request via the normal success path", async () => {
    const res = await request(buildApp()).get("/resolves");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { ok: true } });
  });
});
