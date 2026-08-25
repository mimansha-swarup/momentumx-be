import { Router } from "express";
import { authMiddleware, sseAuthMiddleware } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { editScriptSchema } from "../../validation/content.validation.js";
import { scriptController } from "../../container.js";

const router = Router();

// SSE endpoint — uses sseAuthMiddleware (?token= query param -> req.userId)
router.get("/stream/:projectId", sseAuthMiddleware, scriptController.generateScript);

router.use(authMiddleware);

router.get("/", scriptController.retrieveScripts);
router.patch("/edit/:scriptId", validate(editScriptSchema), scriptController.editScript);
router.get("/:scriptId/export", scriptController.exportScript);
router.post("/:scriptId/regenerate", scriptController.regenerateScript);
router.get("/:scriptId", scriptController.retrieveScriptById);

export default router;
