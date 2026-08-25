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
  skip: () => process.env.NODE_ENV === "test",
});

export default rateLimiter;
