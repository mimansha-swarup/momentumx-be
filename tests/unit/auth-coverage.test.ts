import fs from "fs";
import path from "path";

/**
 * Every /v1 router must mount auth. A router left unprotected (even
 * "temporarily") is exactly how /v1/title-intelligence shipped public.
 *
 * Rules enforced per route file:
 *  1. `router.use(authMiddleware)` must be present and uncommented.
 *  2. Any route registered BEFORE that line must carry an inline auth
 *     middleware (e.g. the SSE route uses sseAuthMiddleware per-route).
 */
const ROUTES_DIR = path.join(process.cwd(), "src", "routes", "v1");

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

const ROUTE_REGISTRATION = /router\.(get|post|patch|put|delete)\s*\(/;
const ROUTER_LEVEL_AUTH = /router\.use\(\s*authMiddleware\s*\)/;
const INLINE_AUTH = /\b(sseAuthMiddleware|authMiddleware)\b/;

describe("auth coverage — every /v1 router mounts auth middleware", () => {
  const routeFiles = fs
    .readdirSync(ROUTES_DIR)
    .filter((file) => file.endsWith(".route.ts"));

  it("discovers the v1 route files", () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  routeFiles.forEach((file) => {
    describe(file, () => {
      const source = stripComments(
        fs.readFileSync(path.join(ROUTES_DIR, file), "utf8")
      );
      const lines = source.split("\n");
      const routerAuthIndex = lines.findIndex((line) =>
        ROUTER_LEVEL_AUTH.test(line)
      );

      it("mounts router-level authMiddleware (uncommented)", () => {
        expect(routerAuthIndex).toBeGreaterThanOrEqual(0);
      });

      it("guards every route registered before router.use(authMiddleware) with inline auth", () => {
        const preAuthLines =
          routerAuthIndex >= 0 ? lines.slice(0, routerAuthIndex) : lines;
        preAuthLines.forEach((line) => {
          if (ROUTE_REGISTRATION.test(line)) {
            expect(line).toMatch(INLINE_AUTH);
          }
        });
      });
    });
  });
});
