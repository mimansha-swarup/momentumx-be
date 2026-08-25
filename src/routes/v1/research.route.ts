import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { researchController } from "../../container.js";

const router = Router();

router.use(authMiddleware);
router.get("/trending", researchController.getTrending);
router.get("/competitors", researchController.getCompetitors);
router.get("/keywords", researchController.getKeywords);

export default router;
