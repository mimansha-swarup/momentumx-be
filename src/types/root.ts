import { HttpStatusCode } from "axios";
import { Response } from "express";

export interface CustomResponse extends Response {
  sendSuccess: (props: sendSuccessProps) => void;
  sendError: (props: sendErrorProps) => void;
}

export interface sendSuccessProps {
  message: string;
  statusCode: number;
  meta?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface sendErrorProps
  extends Omit<sendSuccessProps, "data" | "meta"> {
  detail?: unknown;
}
