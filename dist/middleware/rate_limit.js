import rateLimit from "express-rate-limit";
const rateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: {
        success: false,
        message: "Too many requests from this IP, please try again later",
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Off under test. Every supertest request comes from the same IP and the
    // integration suite makes ~113 of them against a limit of 100, so a shared
    // counter would start returning 429 partway through a run.
    //
    // NOTE: this was investigated as the cause of an intermittent suite failure and
    // was NOT it — disabling it changed nothing. The real cause was `request(app)`
    // binding a fresh `app.listen(0)` per request (see tests/integration/shared-server.ts).
    // A leaked `mockResolvedValueOnce` queue was a second, genuine bug found along
    // the way; it improved the failure rate but did not remove it. This skip stays
    // because the arithmetic above is real and will bite as the suite grows, not
    // because it fixed anything.
    //
    // Skipping beats raising the cap: a limit high enough for the suite is no limit
    // at all, and rate limiting is not what these tests assert.
    //
    // ACCEPTED GAP: because of this skip, nothing verifies the limiter actually
    // limits. Proving it needs 101 real requests with NODE_ENV unset — slow, and it
    // would mostly be testing express-rate-limit rather than us. What is ours is the
    // config above; if that ever grows real logic (per-account limits in Phase 08),
    // extract the options object and test it directly instead of the middleware.
    // PHASE 05, NOT DONE — and it cannot be done here.
    //
    // The phase doc asks for this limiter to be keyed on `userId` rather than IP,
    // so that several members of one shared channel behind one office NAT don't
    // share a budget. A `keyGenerator: (req) => req.userId || req.ip` looks like it
    // does that and does not: `app.use(rateLimiter)` runs at `app.ts:49`, before
    // `app.use(rootRouter)` at `:61`, and `authMiddleware` lives INSIDE the
    // routers. So `req.userId` is always undefined at key time — the fallback fires
    // on every request and the limiter stays per-IP while reading as per-user.
    //
    // Doing it properly means either moving this limiter after auth (which leaves
    // the unauthenticated surface unlimited) or mounting a second per-user limiter
    // at router level. Both are real changes; neither belongs in a phase whose own
    // doc calls this "not a blocker". Revisit with Phase 09, when shared channels
    // actually exist.
    skip: () => process.env.NODE_ENV === "test",
});
export default rateLimiter;
