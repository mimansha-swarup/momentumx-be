import { HttpError } from "../utlils/errors.js";
// Legacy string sentinels thrown by existing services. Maps the error message
// to the HTTP status it should resolve to during the migration window.
const STRING_SENTINELS = {
    Forbidden: 403,
    // 401, not 403 — "Unauthorized" means NOT AUTHENTICATED (who are you?), while
    // 403 means authenticated-but-not-allowed. This entry said 403 and contradicted
    // both `Unauthorized()` in utlils/errors.ts and what authMiddleware actually
    // sends. It is currently unreachable for auth failures (auth.ts calls
    // res.sendError directly, and an HttpError always outranks this map), but a
    // wrong fallback is worse than no fallback the day something does throw the
    // bare string.
    Unauthorized: 401,
    "Not found": 404,
    "Idea not found": 404,
    "Script not found": 404,
    "Hooks batch not found": 404,
    "Packaging not found": 404,
};
// A status Node cannot write is worse than a wrong status. `res.writeHead` throws
// ERR_HTTP_INVALID_STATUS_CODE from inside `res.json`, Express hands off to
// finalhandler, and the client receives 500 text/html with no `success` field —
// breaking the "Standard Response Shape — Always" contract at exactly the point
// every client's error interceptor reads. NaN was worse: the request HUNG.
//
// Normalised HERE rather than in response_formatter.ts on purpose. That file's
// `Number(statusCode) || 500` catches falsy values only, and does not protect this
// file's own raw-JSON fallback branch (used when responseFormatter has not mounted),
// which called res.status(0).json() directly. One guard, both output paths.
// 400-599, not 100-599. This handler always writes a JSON error envelope, and 1xx,
// 204, 205 and 304 are defined to carry NO body — Node accepts them at writeHead
// (it allows 100-999), then the response either hangs or arrives empty, which breaks
// the "Standard Response Shape — Always" contract just as surely as a throw. A 2xx or
// 3xx reaching an ERROR handler is a bug in the thrower either way.
const writable = (status) => Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
const resolveStatus = (err) => writable(rawStatus(err));
const rawStatus = (err) => {
    if (err instanceof HttpError)
        return err.statusCode;
    if (err && typeof err === "object") {
        const candidate = err;
        if (typeof candidate.statusCode === "number")
            return candidate.statusCode;
        if (typeof candidate.status === "number")
            return candidate.status;
        if (typeof candidate.message === "string") {
            const sentinel = STRING_SENTINELS[candidate.message];
            if (sentinel)
                return sentinel;
        }
    }
    return 500;
};
export const errorHandler = (err, req, res, 
// eslint-disable-next-line @typescript-eslint/no-unused-vars
_next) => {
    // SSE safety — never write after a stream (or any response) has started.
    if (res.headersSent)
        return;
    const statusCode = resolveStatus(err);
    const rawMessage = err && typeof err === "object" && typeof err.message === "string"
        ? err.message
        : "Something went wrong";
    // 500-disclosure policy: never echo internal details; log structured.
    if (statusCode >= 500) {
        console.error(JSON.stringify({
            event: "unhandled_error",
            path: req.originalUrl,
            message: rawMessage,
            stack: err instanceof Error ? err.stack : undefined,
        }));
        // Disclosure policy: mask *unexpected* throws (raw driver/runtime messages,
        // stack-bearing errors). A thrown HttpError is author-written for the creator
        // to read — masking it turns "regeneration returned nothing, your script is
        // unchanged" into "Something went wrong", which is strictly less safe to act on.
        const message = err instanceof HttpError ? rawMessage : "Something went wrong";
        // Only the confirmed "you were not charged" marker crosses the 5xx boundary;
        // driver details remain private. The UI must never infer it from an arbitrary
        // failure. It replaced `refunded: true` when credits moved to charge-on-success:
        // a failed run is never charged, so there is nothing to refund and the honest
        // claim is the weaker one.
        const uncharged = err instanceof HttpError && err.detail?.charged === false;
        const refundDetail = uncharged ? { detail: { charged: false } } : {};
        if (typeof res.sendError === "function") {
            res.sendError({ message, statusCode, ...refundDetail });
        }
        else {
            res.status(statusCode).json({ success: false, message, ...refundDetail });
        }
        return;
    }
    // 4xx: do not log (avoid spam); echo the curated message.
    //
    // `code` and `detail` ARE forwarded here, unlike the 5xx branch. That is the
    // whole point of Phase 05's contract: the client has to tell `account_forbidden`
    // (eject to the channel list) from `role_forbidden` (stay put) from
    // `wrong_account` (offer a switch), and `wrong_account` carries the owning
    // account in `detail` so it can name the channel. Dropping either here leaves
    // Phase 07 rendering every 403 identically — and, for a bookmarked project in
    // the user's other channel, rendering it as "may have been deleted".
    //
    // Only author-written HttpErrors carry these; an unexpected throw has neither,
    // so nothing internal leaks by forwarding them.
    const code = err instanceof HttpError ? err.code : undefined;
    const detail = err instanceof HttpError ? err.detail : undefined;
    if (typeof res.sendError === "function") {
        res.sendError({ message: rawMessage, statusCode, code, detail });
    }
    else {
        res.status(statusCode).json({ success: false, message: rawMessage, code, detail });
    }
};
