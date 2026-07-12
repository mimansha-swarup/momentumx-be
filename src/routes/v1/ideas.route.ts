import { Router } from "express";
import ContentRepository from "../../repository/content.repository.js";
import ContentService from "../../service/content.service.js";
import IdeaController from "../../controller/idea.controller.js";
import UserRepository from "../../repository/user.repository.js";
import VideoProjectRepository from "../../repository/video-project.repository.js";
import VideoProjectService from "../../service/video-project.service.js";
import PackagingRepository from "../../repository/packaging.repository.js";
import ResearchRepository from "../../repository/research.repository.js";
import ResearchContextService from "../../service/research-context.service.js";
import { authMiddleware } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { generateIdeasSchema } from "../../validation/content.validation.js";

const router = Router();

const contentRepository = new ContentRepository();
const userRepository = new UserRepository();
const videoProjectRepo = new VideoProjectRepository();
const packagingRepo = new PackagingRepository();
const researchRepo = new ResearchRepository();
const videoProjectService = new VideoProjectService(videoProjectRepo, contentRepository, packagingRepo);
const researchContextService = new ResearchContextService(researchRepo);
const contentService = new ContentService(contentRepository, userRepository, videoProjectService, researchContextService);
const ideaController = new IdeaController(contentService);

router.use(authMiddleware);

router.post("/generate", validate(generateIdeasSchema), ideaController.generateIdeas);

// Specific routes BEFORE parameterized /:ideaId routes
router.post("/regenerate-all", ideaController.regenerateAll);
router.get("/export", ideaController.exportIdeas);
router.get("/", ideaController.retrieveIdeas);

router.patch("/edit/:ideaId", ideaController.editIdea);
router.post("/:ideaId/regenerate", ideaController.regenerateOne);

export default router;
