import { Router } from "express";
// import { authMiddleware } from "../../middleware/auth.js";
import ResearchRepository from "../../repository/research.repository.js";
import TitleIntelligenceService from "../../service/title-intelligence.service.js";
import TitleIntelligenceController from "../../controller/title-intelligence.controller.js";

const researchRepo = new ResearchRepository();
const service = new TitleIntelligenceService(researchRepo);
const controller = new TitleIntelligenceController(service);

const router = Router();
// router.use(authMiddleware);
router.post("/generate", controller.generate);

export default router;
