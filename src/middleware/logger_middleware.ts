import { NextFunction, Request, Response } from "express";

const loggerMiddleware = (req: Request, _res: Response, next: NextFunction) => {
  const log = `${new Date().toISOString()} - ${req.method} ${req.originalUrl}`;
  console.log(log);
  next();
};

export default loggerMiddleware;
