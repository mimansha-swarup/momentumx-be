import { RequestHandler } from "express";
import { ZodType } from "zod";
import { BadRequest } from "../utlils/errors.js";

// Reusable body-validation middleware (phase 3.1). Parses req.body against a Zod
// schema; on success it replaces req.body with the parsed value (trimmed, capped,
// unknown keys stripped) so controllers/services receive clean, typed input. On
// failure it forwards a 400 with a field-prefixed message via the error handler.
//
// Follows the middleware folder's snake_case convention (auth.ts, rate_limit.ts).
export const validate =
  (schema: ZodType): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => {
          const path = issue.path.join(".");
          return path ? `${path}: ${issue.message}` : issue.message;
        })
        .join("; ");
      return next(BadRequest(message || "Invalid request body"));
    }
    req.body = result.data;
    return next();
  };
