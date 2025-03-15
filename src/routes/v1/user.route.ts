import { Router } from "express";

const router = Router();

router.get("/status", (_req, res) => {
  res.sendSuccess({ statusCode: 200, message: "Hello from user status!" }); // Send a simple response
});

export default router;
