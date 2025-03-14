import express, { Request, Response } from "express";
import { authMiddleware } from "./middleware/auth";

const app = express();

app.use(authMiddleware);

app.get("/", (req: Request, res: Response) => {
  res.json({ message: "Welcome to the Express + TypeScript Server!" });
});
export default app;
