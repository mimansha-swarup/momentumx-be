import { Router, Request, Response } from "express";
import userRouter from "./user.route.js";
import topicsRouter from "./topics.route.js";
import scriptsRouter from "./scripts.route.js";
import packagingRouter from "./packaging.route.js";
import videoProjectRouter from "./video-project.route.js";
import researchRouter from "./research.route.js";
import hooksRouter from "./hooks.route.js";

const router = Router();

router.use("/user", userRouter);
router.use("/topics", topicsRouter);
router.use("/scripts", scriptsRouter);
router.use("/packaging", packagingRouter);
router.use("/video-projects", videoProjectRouter);
router.use("/research", researchRouter);
router.use("/hooks", hooksRouter);
router.get("/health", (_req: Request, res: Response) => {
  res.sendSuccess({ statusCode: 200, message: "ok" });
});

export default router;
