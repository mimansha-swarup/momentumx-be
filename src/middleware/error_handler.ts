import { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { HttpError } from "../utlils/errors.js";

// Legacy string sentinels thrown by existing services. Maps the error message
// to the HTTP status it should resolve to during the migration window.
const STRING_SENTINELS: Record<string, number> = {
  Forbidden: 403,
  Unauthorized: 403,
  "Not found": 404,
  "Idea not found": 404,
  "Script not found": 404,
  "Hooks batch not found": 404,
  "Packaging not found": 404,
};

const resolveStatus = (err: unknown): number => {
  if (err instanceof HttpError) return err.statusCode;

  if (err && typeof err === "object") {
    const candidate = err as {
      statusCode?: unknown;
      status?: unknown;
      message?: unknown;
    };

    if (typeof candidate.statusCode === "number") return candidate.statusCode;
    if (typeof candidate.status === "number") return candidate.status;

    if (typeof candidate.message === "string") {
      const sentinel = STRING_SENTINELS[candidate.message];
      if (sentinel) return sentinel;
    }
  }

  return 500;
};

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void => {
  // SSE safety — never write after a stream (or any response) has started.
  if (res.headersSent) return;

  const statusCode = resolveStatus(err);
  const rawMessage =
    err && typeof err === "object" && typeof (err as Error).message === "string"
      ? (err as Error).message
      : "Something went wrong";

  // 500-disclosure policy: never echo internal details; log structured.
  if (statusCode >= 500) {
    console.error(
      JSON.stringify({
        event: "unhandled_error",
        path: req.originalUrl,
        message: rawMessage,
        stack: err instanceof Error ? err.stack : undefined,
      })
    );

    const message = "Something went wrong";
    if (typeof res.sendError === "function") {
      res.sendError({ message, statusCode });
    } else {
      res.status(statusCode).json({ success: false, message });
    }
    return;
  }

  // 4xx: do not log (avoid spam); echo the curated message. Never forward detail.
  if (typeof res.sendError === "function") {
    res.sendError({ message: rawMessage, statusCode });
  } else {
    res.status(statusCode).json({ success: false, message: rawMessage });
  }
};
