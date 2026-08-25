// Contract (api-design.md / backend-standards.md):
//   Success: { success: true, data, message?, meta? }
//   Error:   { success: false, message, detail? }
// Achieved exclusively via res.sendSuccess / res.sendError — statusCode drives
// res.status(...), it is never a field inside the JSON body.

import type { NextFunction, Request, Response } from "express";
import { responseFormatter } from "../../../src/middleware/response_formatter";

function makeRes() {
  const status = jest.fn().mockReturnThis();
  const json = jest.fn().mockReturnThis();
  return { status, json } as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

function attach(res: Response) {
  const next = jest.fn();
  responseFormatter({} as Request, res, next as NextFunction);
  return next;
}

describe("responseFormatter", () => {
  it("attaches sendSuccess/sendError and calls next()", () => {
    const res = makeRes();
    const next = attach(res);

    expect(typeof res.sendSuccess).toBe("function");
    expect(typeof res.sendError).toBe("function");
    expect(next).toHaveBeenCalledTimes(1);
  });

  describe("sendSuccess", () => {
    it("produces the documented success envelope with the given data", () => {
      const res = makeRes();
      attach(res);

      res.sendSuccess({ data: { id: "abc" }, message: "created" });

      expect(res.status).toHaveBeenCalledWith(200); // default statusCode
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: { id: "abc" }, message: "created" })
      );
    });

    it("uses the given statusCode for the HTTP status, and never leaks it into the body", () => {
      const res = makeRes();
      attach(res);

      res.sendSuccess({ data: [], statusCode: 201 });

      expect(res.status).toHaveBeenCalledWith(201);
      const body = res.json.mock.calls[0][0];
      expect(body).not.toHaveProperty("statusCode");
      expect(body.success).toBe(true);
    });

    it("defaults message to an empty string when omitted", () => {
      const res = makeRes();
      attach(res);

      res.sendSuccess({ data: null });

      const body = res.json.mock.calls[0][0];
      expect(body.message).toBe("");
    });
  });

  describe("sendError", () => {
    it("produces the documented error envelope: success:false, message, detail", () => {
      const res = makeRes();
      attach(res);

      res.sendError({ message: "Idea not found", statusCode: 404, detail: { ideaId: "x" } });

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Idea not found",
        detail: { ideaId: "x" },
      });
    });

    it("never includes `data` on an error body", () => {
      const res = makeRes();
      attach(res);

      res.sendError({ message: "boom" });

      const body = res.json.mock.calls[0][0];
      expect(body).not.toHaveProperty("data");
    });

    it("defaults to 500 when statusCode is omitted", () => {
      const res = makeRes();
      attach(res);

      res.sendError({ message: "unexpected" });

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it("defaults to 500 when statusCode is not a valid number (e.g. NaN from a bad string)", () => {
      const res = makeRes();
      attach(res);

      res.sendError({ message: "unexpected", statusCode: "not-a-number" as unknown as number });

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it("statusCode is the HTTP status, not a body field", () => {
      const res = makeRes();
      attach(res);

      res.sendError({ message: "forbidden", statusCode: 403 });

      const body = res.json.mock.calls[0][0];
      expect(body).not.toHaveProperty("statusCode");
    });
  });
});
