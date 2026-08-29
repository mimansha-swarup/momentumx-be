import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { accountMiddleware } from "../../middleware/account.js";
import { validate } from "../../middleware/validate.js";
import { createAccountSchema, updateAccountSchema, } from "../../validation/account.validation.js";
import { accountController } from "../../container.js";
const router = Router();
router.use(authMiddleware);
/**
 * THESE TWO ARE DELIBERATELY ABOVE `router.use(accountMiddleware)`.
 *
 * You cannot present an `X-Account-Id` for a channel you do not have yet, and a
 * brand-new user's very first list call has no channel at all. Mounting the
 * account middleware in front of them would drop that request into Phase 05's
 * header-less fallback, which mints an account as a side effect of *reading the
 * list* — and, once Phase 07 flips `FALLBACK_ALLOWS_WRITES` to false, would
 * reject `POST /v1/accounts` outright: the one call whose entire purpose is to
 * produce the id the header needs.
 *
 * The exemption is narrow on purpose. It covers the two COLLECTION routes only;
 * everything addressed by `:id` sits below the mount and is account-checked like
 * every other route in the API. `tests/unit/auth-coverage.test.ts` names these two
 * explicitly, so a third one cannot be added by accident.
 *
 * They are not unprotected. `authMiddleware` is already mounted above, and each
 * handler scopes to `req.userId`: `list` returns only channels whose `memberUids`
 * contain the caller, and `create` can only ever make a channel owned by them.
 */
router.get("/", accountController.list);
router.post("/", validate(createAccountSchema), accountController.create);
router.use(accountMiddleware);
router.get("/:id", accountController.getById);
router.patch("/:id", validate(updateAccountSchema), accountController.update);
router.post("/:id/activate", accountController.activate);
router.delete("/:id", accountController.remove);
export default router;
