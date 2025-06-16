import { Router } from "express";
import userRouter from "./user.route.js";
import contentRouter from "./content.route.js";

const router = Router();

router.use("/user", userRouter);
router.use("/content", contentRouter);

export default router;
