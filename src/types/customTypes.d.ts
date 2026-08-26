import { Response, Request } from "express";
import { ErrorCode } from "../utlils/errors.js";
import { AccountRole } from "./routes/account.js";

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
  /** Phase 05. Discriminates the three different 403s — see ErrorCode. */
  code?: ErrorCode;
}

export interface IHookParagraph {
  openingLine: string;
  patternInterrupt: string;
  ctaHook: string;
}

declare global {
  namespace Express {
    interface Response {
      sendSuccess: (props: sendSuccessProps) => void;
      sendError: (props: sendErrorProps) => void;
    }

    interface Request {
      userId: string;
      /**
       * Phase 05. The channel this request is acting in, set by accountMiddleware
       * after it has verified membership. Nothing READS it until Phase 06 —
       * queries still filter `createdBy`.
       */
      accountId: string;
      /** The caller's role in that account. Phase 09's requireRole() gate reads it. */
      role: AccountRole;
    }
  }
}
