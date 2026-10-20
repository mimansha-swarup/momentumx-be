import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { accountMiddleware } from "../../middleware/account.js";
import { billingController } from "../../container.js";
const router = Router();
router.use(authMiddleware);
router.use(accountMiddleware);
router.get("/", billingController.getBalance);
export default router;
