import { requireRole } from "../../middleware/role.js";
import { Router } from "express";
import { authMiddleware, sseAuthMiddleware } from "../../middleware/auth.js";
import { accountMiddleware, resolveAccountFromProject, } from "../../middleware/account.js";
import { validate } from "../../middleware/validate.js";
import { editScriptSchema } from "../../validation/content.validation.js";
import { scriptController } from "../../container.js";
const router = Router();
// SSE endpoint — uses sseAuthMiddleware (?token= query param -> req.userId)
// EventSource cannot send headers, so the account comes from the PROJECT, not
// the query string. resolveAccountFromProject sets req.accountId AND req.role.
router.get("/stream/:projectId", sseAuthMiddleware, resolveAccountFromProject, requireRole("editor"), scriptController.generateScript);
router.use(authMiddleware);
router.use(accountMiddleware);
router.get("/", scriptController.retrieveScripts);
router.patch("/edit/:scriptId", requireRole("editor"), validate(editScriptSchema), scriptController.editScript);
router.get("/:scriptId/export", scriptController.exportScript);
router.post("/:scriptId/regenerate", requireRole("editor"), scriptController.regenerateScript);
router.get("/:scriptId", scriptController.retrieveScriptById);
export default router;
