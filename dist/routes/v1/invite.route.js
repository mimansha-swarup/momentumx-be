import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { inviteController } from "../../container.js";
const router = Router();
// Public bearer-secret preview: masked email only. No account context exists before joining.
router.get("/:token", inviteController.preview);
router.use(authMiddleware);
router.get("/", inviteController.pending);
router.post("/:token/accept", inviteController.accept);
export default router;
