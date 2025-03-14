import express, { Request, Response } from "express";
import { authMiddleware } from "./middleware/auth";
import { responseFormatter } from "./middleware/response_formatter";

const app = express();

// app.use(authMiddleware);
app.use(responseFormatter);

app.get("/", (req: Request, res: Response) => {
  res.sendSuccess({ statusCode: 200, message: "Hello World!" });
});
export default app;
