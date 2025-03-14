import { NextFunction, Request } from "express";
import {
  CustomResponse,
  sendErrorProps,
  sendSuccessProps,
} from "../types/root";

export const responseFormatter = (
  _req: Request,
  res: CustomResponse,
  next: NextFunction
) => {
  res.sendSuccess = ({
    message = "",
    statusCode,
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
