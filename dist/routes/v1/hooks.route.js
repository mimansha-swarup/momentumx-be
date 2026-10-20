import { requireRole } from "../../middleware/role.js";
import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { accountMiddleware } from "../../middleware/account.js";
import { validate } from "../../middleware/validate.js";
import { generateHooksSchema, regenerateHooksSchema, selectHookSchema, } from "../../validation/hooks.validation.js";
import { hooksController } from "../../container.js";
const router = Router();
router.use(authMiddleware);
router.use(accountMiddleware);
router.post("/generate", requireRole("editor"), validate(generateHooksSchema), hooksController.generate);
router.post("/:hooksId/select", requireRole("editor"), validate(selectHookSchema), hooksController.select);
router.post("/:hooksId/regenerate", requireRole("editor"), validate(regenerateHooksSchema), hooksController.regenerate);
router.get("/:hooksId/export", hooksController.exportHooks);
// Registered after /export so the literal segment wins the match.
router.get("/:hooksId", hooksController.getById);
export default router;
