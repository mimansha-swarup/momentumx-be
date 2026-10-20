import { firebase } from "../config/firebase.js";
export const authMiddleware = (req, res, next) => {
    // Idempotent. `accountRouter` and `sharingRouter` both mount on `/accounts`, so
    // a member-management request enters accountRouter, runs this, matches no route
    // there, and falls through to sharingRouter which runs it again — two
    // `verifyIdToken` round trips per request. `req.userId` is server-set and
    // unforgeable, so its presence is proof this already ran.
    if (req.userId)
        return next();
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
        req.userEmail = decodedToken.email;
        req.emailVerified = decodedToken.email_verified === true;
        next();
    })
        .catch(() => {
        res.sendError({ message: "Unable to authenticate", statusCode: 401 });
    });
};
export const sseAuthMiddleware = (req, res, next) => {
    // Prefer the Authorization header; fall back to `?token=`.
    //
    // This route was query-authed because `EventSource` cannot send headers. The
    // frontend no longer uses `EventSource`: `service/script.ts` streams through
    // axios with `adapter: "fetch"`, which attaches the same interceptor-applied
    // `Authorization` header as every other call — and stopped appending
    // `?token=`. Reading only the query param therefore 401'd EVERY script
    // generation, and the client signs the user out on a 401, so clicking
    // "Generate" logged the user out.
    //
    // The header is also the better credential: a token in a query string is
    // recorded verbatim in access logs, proxy logs and `Referer`, a header is not.
    // The query fallback stays so a tab loaded before this deploy — still
    // appending `?token=` — keeps working across the rollout.
    const [scheme, headerToken] = req.headers.authorization?.split(" ") ?? [];
    const token = scheme === "Bearer" && headerToken ? headerToken : req.query.token;
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
        req.userEmail = decodedToken.email;
        req.emailVerified = decodedToken.email_verified === true;
        next();
    })
        .catch(() => {
        res.sendError({ message: "Unable to authenticate", statusCode: 401 });
    });
};
