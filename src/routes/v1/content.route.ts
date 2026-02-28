import { Router } from "express";
import ContentRepository from "../../repository/content.repository.js";
import ContentService from "../../service/content.service.js";
import ContentController from "../../controller/content.controller.js";
import UserRepository from "../../repository/user.repository.js";
import VideoProjectRepository from "../../repository/video-project.repository.js";
import VideoProjectService from "../../service/video-project.service.js";
import PackagingRepository from "../../repository/packaging.repository.js";
import { authMiddleware } from "../../middleware/auth.js";

const router = Router();

const contentRepository = new ContentRepository();
const userRepository = new UserRepository();
const videoProjectRepo = new VideoProjectRepository();
const packagingRepo = new PackagingRepository();
const videoProjectService = new VideoProjectService(videoProjectRepo, contentRepository, packagingRepo);
const contentService = new ContentService(contentRepository, userRepository, videoProjectService);
const contentController = new ContentController(contentService);

router.get("/stream/scripts/:scriptId", contentController.generateScript);
router.use(authMiddleware);

router.get("/stream/topics", contentController.generateTopics);

// Specific topic routes BEFORE parameterized /:topicId routes
router.post("/topics/regenerate-all", contentController.regenerateAll);
router.get("/topics/export", contentController.exportTopics);

router.get("/topics", contentController.retrieveTopics);
router.patch("/topics/edit/:topicId", contentController.editTopic);
router.post("/topics/:topicId/regenerate", contentController.regenerateOne);
router.patch("/topics/:topicId/feedback", contentController.updateFeedback);

router.get("/scripts", contentController.retrieveScripts);
router.get("/script/:scriptId", contentController.retrieveScriptById);
router.patch("/script/edit/:scriptId", contentController.editScript);

export default router;
