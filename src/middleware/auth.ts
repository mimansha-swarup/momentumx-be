import { NextFunction, Request, Response } from "express";
import { firebase } from "../config/firebase.js";

export const authMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!req.headers.authorization) {
    res.sendError({ message: "Unauthorized", statusCode: 401 });
    return;
  }
  const [bearer, token] = req.headers.authorization?.split(" ");

  if (bearer !== "Bearer" || !token) {
    res.sendError({ message: "Unauthorized", statusCode: 401 });
    return;
  }

  firebase
    .auth()
    .verifyIdToken(token)
    .then((decodedToken) => {
      req.userId = decodedToken.uid;
      next();
    })
    .catch(() => {
      res.sendError({ message: "Unable to authenticate", statusCode: 403 });
    });
};
