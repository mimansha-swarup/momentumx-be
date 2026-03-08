import { Router } from "express";
import PackagingRepository from "../../repository/packaging.repository.js";
import PackagingService from "../../service/packaging.service.js";
import PackagingController from "../../controller/packaging.controller.js";
import { authMiddleware } from "../../middleware/auth.js";

const router = Router();

const packagingRepository = new PackagingRepository();
const packagingService = new PackagingService(packagingRepository);
const packagingController = new PackagingController(packagingService);

router.use(authMiddleware);

// Generation endpoints
router.post("/generate-title", packagingController.generateTitle);
router.post("/generate-description", packagingController.generateDescription);
router.post("/generate-thumbnail", packagingController.generateThumbnail);
router.post("/generate-hooks", packagingController.generateHooks);
router.post("/generate-shorts", packagingController.generateShorts);

// CRUD endpoints
router.post("/save", packagingController.save);
router.get("/list", packagingController.getPackagingByUser);
router.get("/:packagingId", packagingController.getPackaging);
router.post("/:packagingId/regenerate/:item", packagingController.regenerateItem);
router.patch("/:packagingId/feedback", packagingController.updateFeedback);
router.get("/:packagingId/export", packagingController.exportPackaging);

export default router;
