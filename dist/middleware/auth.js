import { firebase } from "../config/firebase.js";
export const authMiddleware = (req, res, next) => {
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
        // verifyIdToken should always yield a uid, but an empty one would be written
        // as a real owner value that every such record shares (Phase 01 item 1).
        // Refusing here keeps that impossible for every route at once.
        if (!decodedToken.uid) {
            res.sendError({ message: "Unauthorized", statusCode: 401 });
            return;
        }
        req.userId = decodedToken.uid;
        next();
    })
        .catch(() => {
        res.sendError({ message: "Unable to authenticate", statusCode: 401 });
    });
};
export const sseAuthMiddleware = (req, res, next) => {
    const token = req.query.token;
    if (!token || typeof token !== "string") {
        res.sendError({ message: "Unauthorized", statusCode: 401 });
        return;
    }
    firebase
        .auth()
        .verifyIdToken(token)
        .then((decodedToken) => {
        // verifyIdToken should always yield a uid, but an empty one would be written
        // as a real owner value that every such record shares (Phase 01 item 1).
        // Refusing here keeps that impossible for every route at once.
        if (!decodedToken.uid) {
            res.sendError({ message: "Unauthorized", statusCode: 401 });
            return;
        }
        req.userId = decodedToken.uid;
        next();
    })
        .catch(() => {
        res.sendError({ message: "Unable to authenticate", statusCode: 401 });
    });
};
