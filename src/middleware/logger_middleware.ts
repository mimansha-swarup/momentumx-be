import { NextFunction, Request, Response } from "express";

// Credentials arrive as query params on some routes (SSE ?token=) — never log them.
const redactQueryParams = (url: string): string =>
  url.replace(/([?&](?:token|key|apikey|api_key)=)[^&]*/gi, "$1[REDACTED]");

const loggerMiddleware = (req: Request, _res: Response, next: NextFunction) => {
  const log = `${new Date().toISOString()} - ${req.method} ${redactQueryParams(req.originalUrl)}`;
  console.log(log);
  next();
};

export default loggerMiddleware;
