import fs from "fs";
import path from "path";

/**
 * Every /v1 router must mount auth AND account context. A router left unprotected
 * (even "temporarily") is exactly how /v1/title-intelligence shipped public.
 *
 * The account half matters for a different reason than the auth half. A route
 * that skips `accountMiddleware` has no `req.accountId`, so when Phase 06 makes
 * queries account-scoped that route either throws or — worse — falls back to
 * something wrong and returns another channel's data. Applying the middleware
 * unevenly is the dangerous mistake in Phase 05, and it is invisible until then.
 *
 * Rules enforced per route file:
 *  1. `router.use(authMiddleware)` present and uncommented.
 *  2. `router.use(accountMiddleware)` present and uncommented.
 *  3. Any route registered BEFORE those lines must carry inline equivalents —
 *     the SSE route uses `sseAuthMiddleware` + `resolveAccountFromProject`,
 *     because EventSource cannot send the header.
 *  4. …with ONE named exception per route, listed in ACCOUNT_EXEMPT below. The
 *     exemption is from the ACCOUNT half only; auth is never optional.
 */

/**
 * Routes that deliberately run without account context, named one at a time.
 *
 * An allowlist rather than a rule, because there is no property that
 * distinguishes "legitimately has no channel yet" from "someone forgot the
 * middleware" — both look like a route above the mount. Naming each one means
 * adding a third is a visible edit to this file with a reason attached, which is
 * the whole point: applying the middleware unevenly is the dangerous mistake in
 * Phase 05, and it is invisible until Phase 06 makes reads account-scoped.
 *
 * Shrink-only. If a route stops needing the exemption, delete the entry.
 */
const ACCOUNT_EXEMPT: Record<string, { route: string; why: string }[]> = {
  "account.route.ts": [
    {
      route: 'router.get("/"',
      why: "the switcher's list — a brand-new user has no channel to name in a header",
    },
    {
      route: 'router.post("/"',
      why: "creates the channel whose id the header would have to carry",
    },
  ],
};
const ROUTES_DIR = path.join(process.cwd(), "src", "routes", "v1");

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

const ROUTER_LEVEL_AUTH = /router\.use\(\s*authMiddleware\s*\)/;
const ROUTER_LEVEL_ACCOUNT = /router\.use\(\s*accountMiddleware\s*\)/;
const INLINE_AUTH = /\b(sseAuthMiddleware|authMiddleware)\b/;
const INLINE_ACCOUNT = /\b(resolveAccountFromProject|accountMiddleware)\b/;

/**
 * Whole `router.get(...)` statements, brace-balanced.
 *
 * Deliberately not line-based. The previous version scanned single lines, so
 * wrapping the SSE registration across four lines — which is what adding a second
 * middleware to it did — made `router.get(` appear on a line with no middleware
 * on it, and the suite failed on correct code. A line-based reader of a
 * multi-line language reports on formatting, not on protection.
 */
const routeStatements = (source: string): { text: string; index: number }[] => {
  const out: { text: string; index: number }[] = [];
  const re = /router\.(get|post|patch|put|delete)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(source))) {
    let depth = 0;
    let end = match.index;
    for (let i = source.indexOf("(", match.index); i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    out.push({ text: source.slice(match.index, end + 1), index: match.index });
  }
  return out;
};

describe("auth + account coverage — every /v1 router mounts both middlewares", () => {
  const routeFiles = fs
    .readdirSync(ROUTES_DIR)
    .filter((file) => file.endsWith(".route.ts"));

  it("discovers the v1 route files", () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  /**
   * The glob is `*.route.ts`, so everything below is invisible to a file named
   * anything else — and `src/routes/v1/index.ts` is exactly such a file, and it
   * already registers a route (`/health`, deliberately unauthenticated). Adding
   * a second one there, or creating `src/routes/v1/admin.ts`, would ship a route
   * with no auth and no account context that this suite never looks at.
   *
   * So: every `.ts` under the routes directory either follows the naming
   * convention and gets the full check above, or is named here with its reason.
   */
  it("every file under src/routes is either checked above or named here", () => {
    const UNCHECKED: Record<string, string> = {
      "index.ts": "mounts the sub-routers; its only own route is /health",
    };

    const unchecked = fs
      .readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".route.ts"));

    expect(unchecked.filter((f) => !UNCHECKED[f])).toEqual([]);
  });

  // And the reason index.ts is allowed to skip auth has to stay true. `/health`
  // is a liveness probe — Render's free instance spins down after ~15 minutes
  // idle and the frontend pings it. Anything else registered here is a route
  // shipping without auth.
  it("index.ts registers nothing but /health of its own", () => {
    const source = stripComments(fs.readFileSync(path.join(ROUTES_DIR, "index.ts"), "utf8"));
    const own = [...source.matchAll(/router\.(get|post|patch|put|delete)\(\s*["'`]([^"'`]+)/g)];

    expect(own.map((m) => `${m[1].toUpperCase()} ${m[2]}`)).toEqual(["GET /health"]);
  });

  routeFiles.forEach((file) => {
    describe(file, () => {
      const source = stripComments(
        fs.readFileSync(path.join(ROUTES_DIR, file), "utf8")
      );
      const at = (re: RegExp) => source.search(re);

      it("mounts router-level authMiddleware (uncommented)", () => {
        expect(at(ROUTER_LEVEL_AUTH)).toBeGreaterThanOrEqual(0);
      });

      it("mounts router-level accountMiddleware (uncommented)", () => {
        expect(at(ROUTER_LEVEL_ACCOUNT)).toBeGreaterThanOrEqual(0);
      });

      it("resolves identity before account context", () => {
        // accountMiddleware reads req.userId. Mounted first it would resolve the
        // account for `undefined` on every request.
        expect(at(ROUTER_LEVEL_AUTH)).toBeLessThan(at(ROUTER_LEVEL_ACCOUNT));
      });

      it("guards every route registered before those lines with inline equivalents", () => {
        const authAt = at(ROUTER_LEVEL_AUTH);
        const accountAt = at(ROUTER_LEVEL_ACCOUNT);
        const exempt = ACCOUNT_EXEMPT[file] ?? [];

        routeStatements(source).forEach(({ text, index }) => {
          // Auth has no exemptions, in any file, ever.
          if (authAt < 0 || index < authAt) expect(text).toMatch(INLINE_AUTH);

          if (accountAt >= 0 && index >= accountAt) return;
          if (exempt.some((e) => text.startsWith(e.route))) return;
          expect(text).toMatch(INLINE_ACCOUNT);
        });
      });

      it("does not carry a stale account exemption", () => {
        // The allowlist shrinks, never grows silently. An entry naming a route
        // this file no longer registers is a licence sitting unused, and the next
        // person to add `router.get("/")` here inherits it without knowing.
        (ACCOUNT_EXEMPT[file] ?? []).forEach((entry) => {
          expect(source).toContain(entry.route);
        });
      });
    });
  });
});
