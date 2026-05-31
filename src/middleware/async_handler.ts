import { NextFunction, Request, RequestHandler, Response } from "express";

export const asyncHandler =
  (
    fn: (req: Request, res: Response, next: NextFunction) => unknown
  ): RequestHandler =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
