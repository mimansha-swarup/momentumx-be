import { Router, Request, Response } from "express";
import userRouter from "./user.route.js";
import contentRouter from "./content.route.js";
import packagingRouter from "./packaging.route.js";

const router = Router();

router.use("/user", userRouter);
router.use("/content", contentRouter);
router.use("/packaging", packagingRouter);
router.get("/health", (_req: Request, res: Response) => {
  res.sendSuccess({ statusCode: 200, message: "ok" });
});

export default router;
