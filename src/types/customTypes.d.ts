import { Response, Request } from "express";

export interface sendSuccessProps {
  message?: string;
  warning?: string;
  statusCode?: number;
  meta?: Record<string, unknown>;
  data?: unknown;
}

export interface sendErrorProps
  extends Omit<sendSuccessProps, "data" | "meta"> {
  detail?: unknown;
}

declare global {
  namespace Express {
    interface Response {
      sendSuccess: (props: sendSuccessProps) => void;
      sendError: (props: sendErrorProps) => void;
    }

    interface Request {
      userId: string;
    }
  }
}
