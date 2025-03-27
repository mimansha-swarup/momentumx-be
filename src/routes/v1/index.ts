import { Router } from "express";
import userRouter from "./user.route";
import contentRouter from "./content.route";

const router = Router();

router.use("/user", userRouter);
router.use("/content", contentRouter);

export default router;
