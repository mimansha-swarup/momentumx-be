import { NextFunction, Request, Response } from "express";
import { sendErrorProps, sendSuccessProps } from "../types/customTypes";

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
  }: sendSuccessProps) => {
    res.status(statusCode).json({
      success: true,
      data,
      message,
      meta,
    });
  };

  res.sendError = ({ message, statusCode, detail }: sendErrorProps) => {
    const code = Number(statusCode) || 500;
    res.status(code).json({
      success: false,
      message,
      detail,
    });
  };

  next();
};
