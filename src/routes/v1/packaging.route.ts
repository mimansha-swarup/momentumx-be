import { Router } from "express";
import PackagingRepository from "../../repository/packaging.repository.js";
import PackagingService from "../../service/packaging.service.js";
import PackagingController from "../../controller/packaging.controller.js";
import VideoProjectRepository from "../../repository/video-project.repository.js";
import VideoProjectService from "../../service/video-project.service.js";
import ContentRepository from "../../repository/content.repository.js";
import HooksRepository from "../../repository/hooks.repository.js";
import UserRepository from "../../repository/user.repository.js";
import ResearchRepository from "../../repository/research.repository.js";
import ContextService from "../../service/context.service.js";
import ResearchContextService from "../../service/research-context.service.js";
import { authMiddleware } from "../../middleware/auth.js";

const router = Router();

const packagingRepository = new PackagingRepository();
const videoProjectRepo = new VideoProjectRepository();
const contentRepo = new ContentRepository();
const hooksRepository = new HooksRepository();
const userRepository = new UserRepository();
const researchRepo = new ResearchRepository();
const videoProjectService = new VideoProjectService(videoProjectRepo, contentRepo, packagingRepository);
const contextService = new ContextService(userRepository, contentRepo, hooksRepository, videoProjectService);
const researchContextService = new ResearchContextService(researchRepo);
const packagingService = new PackagingService(packagingRepository, videoProjectService, contextService, researchContextService);
const packagingController = new PackagingController(packagingService);

router.use(authMiddleware);

// Generation endpoints
router.post("/generate-title", packagingController.generateTitle);
router.post("/generate-description", packagingController.generateDescription);
router.post("/generate-thumbnail", packagingController.generateThumbnail);
router.post("/generate-shorts", packagingController.generateShorts);

// CRUD endpoints
router.post("/save", packagingController.save);
router.get("/list", packagingController.getPackagingByUser);
router.get("/:packagingId", packagingController.getPackaging);
router.post("/:packagingId/regenerate/:item", packagingController.regenerateItem);
router.patch("/:packagingId/feedback", packagingController.updateFeedback);
router.get("/:packagingId/export", packagingController.exportPackaging);

export default router;
