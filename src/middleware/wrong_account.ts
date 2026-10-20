import { NextFunction, Request, Response } from "express";
import { accountService } from "../container.js";
import { asyncHandler } from "./async_handler.js";
import { WrongAccount } from "../utlils/errors.js";

/**
 * Shared by `account.route.ts` and `sharing.route.ts`: both mount `/:id`
 * handlers that act on `req.params.id`, while `requireRole` reads `req.role` —
 * which `accountMiddleware` resolved from the HEADER's channel. Unpinned, those
 * are two different channels: a user who owns B but is a viewer in the active
 * channel A got `role_forbidden` for e.g. `PATCH /accounts/B`, which the client
 * contract defines as "inline message, stay put" — so it never offered the
 * switch that would make the call succeed. `wrong_account` is the honest answer.
 *
 * This does NOT read account context from `req.params.id` — the account context
 * is still exactly what `accountMiddleware` attached to `req.accountId`. It only
 * compares the path param against that already-resolved value, and looks the
 * path param up (via `accountService.getAccount`, which itself re-checks
 * membership) only to name the switch target. Membership in the TARGET is
 * checked before its name is revealed.
 */
export const wrongAccountGuard = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    if (req.params.id !== req.accountId) {
      const target = await accountService.getAccount(req.userId, req.params.id);
      throw WrongAccount({ accountId: target.id, displayName: target.displayName });
    }
    next();
  }
);

export default wrongAccountGuard;
