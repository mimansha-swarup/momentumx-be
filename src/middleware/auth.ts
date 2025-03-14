import { NextFunction, Request, Response } from "express";
import { firebase } from "../config/firebase";

export const authMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!req.headers.authorization) {
    res.status(401).send("Unauthorized");
    return;
  }
  const [bearer, token] = req.headers.authorization?.split(" ");

  if (bearer !== "Bearer" || !token) {
    res.status(401).send("Unauthorized");
    return;
  }

  firebase
    .auth()
    .verifyIdToken(token)
    .then((decodedToken) => {
      decodedToken.uid;
      next();
    })
    .catch(() => {
      res.status(403).send("Unable to authenticate");
    });
};
