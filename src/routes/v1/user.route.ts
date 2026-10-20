import { requireRole } from "../../middleware/role.js";
import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { accountMiddleware } from "../../middleware/account.js";
import { validate } from "../../middleware/validate.js";
import {
  onboardingSchema,
  prefillSchema,
  profileUpdateSchema,
} from "../../validation/user.validation.js";
import { userController } from "../../container.js";

const router = Router();

router.use(authMiddleware);
router.use(accountMiddleware);
router.post("/onboarding/prefill", requireRole("editor"), validate(prefillSchema), userController.prefill);
router.patch("/onboarding", requireRole("editor"), validate(onboardingSchema), userController.saveOnboarding);

router.post("/refresh-context", requireRole("editor"), userController.refreshContext);

router.get("/profile", userController.getProfile);

router.patch("/profile", requireRole("editor"), validate(profileUpdateSchema), userController.updateProfile);

export default router;
