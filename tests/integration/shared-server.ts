import type { Express } from "express";
import type { Server } from "http";

/** Share a listening server across requests; close all sockets during teardown.
 * A prior full-suite bare-501 failure remains unexplained; reuse does not prove its cause.
 */
export function useSharedServer(app: Express): () => Server {
  let server: Server;

  beforeAll(() => {
    // Port 0 → the OS assigns a free port.
    server = app.listen(0);
  });

  afterAll(async () => {
    if (!server) return;
    // `server.close()` waits for every idle keep-alive socket to drain, and supertest
    // leaves them open. On a loaded machine that outran jest's 5s hook timeout and
    // took the whole suite down with "exceeded timeout of 5000 ms for a hook" —
    // failures that vanished when run in isolation, which is what made them look
    // like a race in the app. Drop idle connections first so close() returns at once.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return () => server;
}
