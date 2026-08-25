import type { Express } from "express";
import type { Server } from "http";

/**
 * One HTTP server per test file, instead of one per request.
 *
 * `request(app)` — passing the Express app rather than a listening server — makes
 * supertest call `app.listen(0)` for EVERY request and tear the server down
 * afterwards. Across the integration suite that is ~113 ephemeral servers bound
 * and closed in a few seconds.
 *
 * That produced an intermittent failure (roughly 1 run in 12) that cost a long
 * investigation: a different test each time, always in the integration group,
 * never reproducible when a file ran alone. The tell was the failure *shape* —
 * `Number of calls: 0` on a service mock, `res.body.success` undefined, and
 * finally a bare **501** with an empty body. A 501 does not come from this app;
 * it comes from Node's HTTP layer rejecting a request before Express sees it. The
 * request never arrived, so of course no mock was called.
 *
 * Ruled out along the way, each with measurements: the per-IP rate limiter
 * (disabled under test, no change), parallel workers (`--runInBand` still
 * reproduced), the ts-jest cache (`--no-cache` still reproduced), and a leaked
 * `mockResolvedValueOnce` queue (a real and separate bug — see the `beforeEach`
 * in each suite — which improved the rate but did not remove it).
 *
 * Binding once per file removes the churn. It is also simply the correct way to
 * use supertest against a suite of requests.
 *
 * Usage:
 *   const server = useSharedServer(app);
 *   ... request(server()).get("/v1/health")
 *
 * The accessor is a function because `beforeAll` has not run at module-eval time,
 * so the server does not exist yet when the tests are being defined.
 */
export function useSharedServer(app: Express): () => Server {
  let server: Server;

  beforeAll(() => {
    // Port 0 → the OS assigns a free port.
    server = app.listen(0);
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return () => server;
}
