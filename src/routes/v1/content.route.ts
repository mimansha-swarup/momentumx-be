import { Router } from "express";
import ContentRepository from "../../repository/content.repository";
import ContentService from "../../service/content.service";
import ContentController from "../../controller/content.controller";
// import { authMiddleware } from "../../middleware/auth";

const router = Router();

const contentRepository = new ContentRepository();
const contentService = new ContentService(contentRepository);
const contentController = new ContentController(contentService);

router.post(
  "/topics",
  // authMiddleware,
  contentController.generateTopics
);

router.get(
  "/topics",
  // authMiddleware,
  contentController.generateTopics
);

export default router;
