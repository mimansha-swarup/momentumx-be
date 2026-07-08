import { Router } from "express";
import ContentRepository from "../../repository/content.repository.js";
import ContentService from "../../service/content.service.js";
import TopicController from "../../controller/topic.controller.js";
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
const topicController = new TopicController(contentService);

router.use(authMiddleware);

router.post("/generate", validate(generateIdeasSchema), topicController.generateTopics);

// Specific routes BEFORE parameterized /:topicId routes
router.post("/regenerate-all", topicController.regenerateAll);
router.get("/export", topicController.exportTopics);
router.get("/", topicController.retrieveTopics);

router.patch("/edit/:topicId", topicController.editTopic);
router.post("/:topicId/regenerate", topicController.regenerateOne);
router.patch("/:topicId/feedback", topicController.updateFeedback);

export default router;
