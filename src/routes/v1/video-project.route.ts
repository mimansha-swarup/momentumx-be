import { requireRole } from "../../middleware/role.js";
import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { accountMiddleware } from "../../middleware/account.js";
import { validate } from "../../middleware/validate.js";
import {
  createVideoProjectSchema,
  linkResourceSchema,
  updateVideoProjectSchema,
} from "../../validation/video-project.validation.js";
import { videoProjectController } from "../../container.js";

const router = Router();

router.use(authMiddleware);
router.use(accountMiddleware);
router.post("/", requireRole("editor"), validate(createVideoProjectSchema), videoProjectController.create);
router.get("/", videoProjectController.list);
router.get("/:projectId", videoProjectController.getById);
router.patch("/:projectId", requireRole("editor"), validate(updateVideoProjectSchema), videoProjectController.update);
router.delete("/:projectId", requireRole("editor"), videoProjectController.delete);
router.patch("/:projectId/step/:stepName/complete", requireRole("editor"), videoProjectController.completeStep);
router.patch(
  "/:projectId/link/:resourceType", requireRole("editor"),
  validate(linkResourceSchema),
  videoProjectController.linkResource
);

export default router;
