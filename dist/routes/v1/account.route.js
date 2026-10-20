import { requireRole } from "../../middleware/role.js";
import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { accountMiddleware } from "../../middleware/account.js";
import { validate } from "../../middleware/validate.js";
import { createAccountSchema, updateAccountSchema, } from "../../validation/account.validation.js";
import { wrongAccountGuard } from "../../middleware/wrong_account.js";
import { accountController } from "../../container.js";
const router = Router();
router.use(authMiddleware);
/**
 * Authenticated discovery, creation and bootstrap cannot require an existing
 * channel header. Bootstrap atomically adopts or creates the first channel;
 * POST / creates an additional one. All three scope to req.userId and are
 * explicitly named in tests/unit/auth-coverage.test.ts.
 */
router.get("/", accountController.list);
router.post("/", validate(createAccountSchema), accountController.create);
// Bootstrap is authenticated but cannot require the channel it is resolving.
router.post("/bootstrap", accountController.bootstrap);
router.use(accountMiddleware);
/**
 * Every `/:id` route below acts on `params.id`, while `requireRole` reads
 * `req.role` — which `accountMiddleware` resolved from the HEADER's channel.
 * Unpinned, those are two different channels: a user who owns B but is a viewer
 * in the active channel A got `role_forbidden` for `PATCH /accounts/B`, which the
 * client contract defines as "inline message, stay put" — so it never offered the
 * switch that would make the call succeed. `wrong_account` is the honest answer,
 * and it is what this produces. Same guard, same reason, as `sharing.route.ts` —
 * shared as `wrongAccountGuard` (`src/middleware/wrong_account.ts`).
 */
router.use("/:id", wrongAccountGuard);
router.get("/:id", accountController.getById);
router.patch("/:id", requireRole("owner"), validate(updateAccountSchema), accountController.update);
router.post("/:id/activate", accountController.activate);
router.delete("/:id", requireRole("owner"), accountController.remove);
export default router;
