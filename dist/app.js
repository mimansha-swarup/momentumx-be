import express from "express";
import cors from "cors";
// import { authMiddleware } from "./middleware/auth";
import { responseFormatter } from "./middleware/response_formatter.js";
import loggerMiddleware from "./middleware/logger_middleware.js";
import rateLimiter from "./middleware/rate_limit.js";
import { errorHandler } from "./middleware/error_handler.js";
import rootRouter from "./routes/index.js";
const app = express();
// app.use(authMiddleware);
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
// responseFormatter runs before express.json/rateLimiter so res.sendError
// exists when those middlewares error (e.g. malformed JSON body).
app.use(responseFormatter);
app.use(express.json());
app.use(rateLimiter);
app.use(loggerMiddleware);
app.get("/", (_req, res) => {
    res.sendSuccess({ statusCode: 200, message: "Hello World!" });
});
app.use(rootRouter);
// errorHandler must be the LAST app.use — after all routes.
app.use(errorHandler);
export default app;
