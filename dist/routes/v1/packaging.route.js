import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { accountMiddleware } from "../../middleware/account.js";
import { validate } from "../../middleware/validate.js";
import { generateDescriptionSchema, generateShortsSchema, generateThumbnailSchema, generateTitleSchema, packagingSaveSchema, regenerateItemSchema, selectTitleSchema, } from "../../validation/packaging.validation.js";
import { packagingController } from "../../container.js";
const router = Router();
router.use(authMiddleware);
router.use(accountMiddleware);
// Generation endpoints
router.post("/generate-title", validate(generateTitleSchema), packagingController.generateTitle);
router.post("/generate-description", validate(generateDescriptionSchema), packagingController.generateDescription);
router.post("/generate-thumbnail", validate(generateThumbnailSchema), packagingController.generateThumbnail);
router.post("/generate-shorts", validate(generateShortsSchema), packagingController.generateShorts);
// CRUD endpoints
router.post("/save", validate(packagingSaveSchema), packagingController.save);
router.get("/list", packagingController.getPackagingByAccount);
router.get("/:packagingId", packagingController.getPackaging);
router.post("/:packagingId/regenerate/:item", validate(regenerateItemSchema), packagingController.regenerateItem);
router.post("/:packagingId/select-title", validate(selectTitleSchema), packagingController.selectTitle);
router.get("/:packagingId/export", packagingController.exportPackaging);
export default router;
