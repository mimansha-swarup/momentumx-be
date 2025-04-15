import { Router } from "express";
import ContentRepository from "../../repository/content.repository";
import ContentService from "../../service/content.service";
import ContentController from "../../controller/content.controller";
import UserRepository from "../../repository/user.repository";
import { authMiddleware } from "../../middleware/auth";

const router = Router();

const contentRepository = new ContentRepository();
const userRepository = new UserRepository();
const contentService = new ContentService(contentRepository, userRepository);
const contentController = new ContentController(contentService);

router.use(authMiddleware);
router.post("/topics", contentController.generateTopics);

router.get(
  "/topics",
  contentController.retrieveTopics
);

export default router;
