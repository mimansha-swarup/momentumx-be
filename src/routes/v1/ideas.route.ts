import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { accountMiddleware } from "../../middleware/account.js";
import { validate } from "../../middleware/validate.js";
import { editIdeaSchema, generateIdeasSchema } from "../../validation/content.validation.js";
import { ideaController } from "../../container.js";

const router = Router();

router.use(authMiddleware);
router.use(accountMiddleware);

router.post("/generate", validate(generateIdeasSchema), ideaController.generateIdeas);

// Specific routes BEFORE parameterized /:ideaId routes
router.post("/regenerate-all", ideaController.regenerateAll);
router.get("/export", ideaController.exportIdeas);
router.get("/", ideaController.retrieveIdeas);

router.patch("/edit/:ideaId", validate(editIdeaSchema), ideaController.editIdea);
router.post("/:ideaId/regenerate", ideaController.regenerateOne);

export default router;
