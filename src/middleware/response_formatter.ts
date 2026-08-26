import { NextFunction, Request, Response } from "express";
import { sendErrorProps, sendSuccessProps } from "../types/customTypes.js";

export const responseFormatter = (
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  res.sendSuccess = ({
    message = "",
    statusCode = 200,
    meta,
    data,
    warning = "",
  }: sendSuccessProps) => {
    res.status(statusCode).json({
      success: true,
      data,
      message,
      meta,
      warning,
    });
  };

  res.sendError = ({ message, statusCode, detail, code }: sendErrorProps) => {
    // `status` is the HTTP code; `code` is the machine-readable reason (Phase 05).
    // They were both called `code` here before, which is why this reads oddly.
    const status = Number(statusCode) || 500;
    res.status(status).json({
      success: false,
      message,
      code,
      detail,
    });
  };

  next();
};
