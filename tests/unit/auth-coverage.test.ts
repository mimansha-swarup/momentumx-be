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
 *     the SSE route uses `sseAuthMiddleware` + `resolveAccountFromProject`. It
 *     derives the channel from the PROJECT rather than a header; the client now
 *     streams via fetch and sends a bearer header, which `sseAuthMiddleware`
 *     prefers, falling back to `?token=` for tabs loaded before that change.
 *  4. …with ONE named exception per route, listed in ACCOUNT_EXEMPT below. The
 *     exemption is from the ACCOUNT half only; auth is never optional.
 */

/**
 * Routes that deliberately run without account context, named one at a time.
 *
 * An allowlist rather than a rule, because there is no property that
 * distinguishes "legitimately has no channel yet" from "someone forgot the
 * middleware" — both look like a route above the mount. Naming each one means
 * adding another is a visible edit to this file with a reason attached, which is
 * the whole point: applying the middleware unevenly is the dangerous mistake in
 * Phase 05, and it is invisible until Phase 06 makes reads account-scoped.
 *
 * Shrink-only. If a route stops needing the exemption, delete the entry.
 */
const ACCOUNT_EXEMPT: Record<string, { route: string; why: string }[]> = {
  "invite.route.ts": [
    { route: 'router.get("/:token"', why: "public secret-token preview" },
    { route: 'router.get("/"', why: "verified email invitation discovery" },
    { route: 'router.post("/:token/accept"', why: "membership does not exist until accepted" },
  ],
  "account.route.ts": [
    {
      route: 'router.post("/bootstrap"',
      why: "idempotently resolves or creates the first channel before a header exists",
    },
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
/**
 * The ONE route that runs without authentication, named the same way account
 * exemptions are.
 *
 * It was an inline `file === "invite.route.ts" && text.startsWith(...)` condition
 * buried in the loop, so it escaped the "does not carry a stale exemption" check
 * below — the mechanism that stops an allowlist entry outliving the route it was
 * written for.
 */
const AUTH_EXEMPT: Record<string, { route: string; why: string }[]> = {
  "invite.route.ts": [
    {
      route: 'router.get("/:token"',
      why: "a 43-char, 256-bit secret token authorizes a masked preview; the invitee has no account yet",
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
    // SHRINK-ONLY, like ACCOUNT_EXEMPT. One entry, and it is pinned below.
    const UNCHECKED: Record<string, string> = {
      "index.ts": "mounts the sub-routers; its only own route is /health",
    };
    expect(Object.keys(UNCHECKED)).toEqual(["index.ts"]);

    // RECURSIVE. The first version used a flat `readdirSync`, so a directory
    // entry like `admin` matched neither `.ts` nor `.route.ts` and was dropped
    // by both filters — meaning `src/routes/v1/admin/admin.route.ts`, mounted
    // from index.ts with `router.use("/admin", adminRouter)`, shipped with no
    // auth and no account context, invisible to this entire suite. That is
    // exactly the failure this test was added to close, and it closed only the
    // flat-file half of it.
    const walk = (dir: string, prefix = ""): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return walk(path.join(dir, entry.name), rel);
        return entry.name.endsWith(".ts") ? [rel] : [];
      });

    // A nested *.route.ts is not checked by the per-file describes above either,
    // because those iterate the flat listing — so nesting is banned outright
    // rather than silently half-covered.
    const unchecked = walk(ROUTES_DIR).filter(
      (f) => f.includes("/") || !f.endsWith(".route.ts")
    );

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
        if (file === "invite.route.ts") {
          // Asserted POSITIVELY rather than skipped. These two blocks used to run
          // with no expectations at all for this file — reporting green while
          // checking nothing, which is worse than not having them.
          expect(at(ROUTER_LEVEL_ACCOUNT)).toBeLessThan(0);
          return;
        }
        expect(at(ROUTER_LEVEL_ACCOUNT)).toBeGreaterThanOrEqual(0);
      });

      it("resolves identity before account context", () => {
        // accountMiddleware reads req.userId. Mounted first it would resolve the
        // account for `undefined` on every request.
        if (file === "invite.route.ts") {
          expect(at(ROUTER_LEVEL_ACCOUNT)).toBeLessThan(0);
          return;
        }
        expect(at(ROUTER_LEVEL_AUTH)).toBeLessThan(at(ROUTER_LEVEL_ACCOUNT));
      });

      it("guards every route registered before those lines with inline equivalents", () => {
        const authAt = at(ROUTER_LEVEL_AUTH);
        const accountAt = at(ROUTER_LEVEL_ACCOUNT);
        const exempt = ACCOUNT_EXEMPT[file] ?? [];

        routeStatements(source).forEach(({ text, index }) => {
          // Auth has no exemptions, in any file, ever.
          const authExempt = (AUTH_EXEMPT[file] ?? []).some((e) => text.startsWith(e.route));
          if ((authAt < 0 || index < authAt) && !authExempt) expect(text).toMatch(INLINE_AUTH);

          if (accountAt >= 0 && index >= accountAt) return;
          if (exempt.some((e) => text.startsWith(e.route))) return;
          expect(text).toMatch(INLINE_ACCOUNT);
        });
      });

      it("gates mutations and quota-consuming GETs by effect", () => {
        routeStatements(source).forEach(({ text, index }) => {
          const personal = file === "account.route.ts" && ['router.post("/"', 'router.post("/bootstrap"', 'router.post("/:id/activate"'].some(route => text.startsWith(route));
          if (personal || file === "invite.route.ts") return;
          const mutation = /^router\.(post|put|patch|delete)/.test(text);
          const costlyRead = file === "research.route.ts" || text.includes('"/stream/:projectId"');
          if (!mutation && !costlyRead) return;
          const mounted = source.slice(0, index).includes('router.use(requireRole("editor"))');
          if (!mounted) expect(text).toMatch(/requireRole\("(editor|owner|viewer)"\)/);
          if (text.includes('requireRole("viewer")')) expect(text).toContain('"/:id/leave"');
        });
      });

      it("does not carry a stale AUTH exemption", () => {
        (AUTH_EXEMPT[file] ?? []).forEach((entry) => {
          expect(source).toContain(entry.route);
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

/**
 * The MINIMUM role, per route, where the answer is "owner".
 *
 * The test above only asks that *some* `requireRole` is present. That is enough
 * to catch a forgotten gate and useless against a wrong one: downgrading
 * `DELETE /v1/accounts/:id` from owner to editor leaves all 1243 tests green
 * (verified by mutation), so any editor could delete the channel as far as the
 * middleware layer is concerned.
 *
 * Service-side checks (`AccountService.assertOwner`, `SharingRepository.live(...,
 * owner=true)`) independently refuse today, so this is defence in depth — but the
 * middleware is the layer the route file is read as documentation of, and nothing
 * warns you when a future owner-only route ships without its service-side twin.
 *
 * Shrink-only, and every entry is asserted to still exist so a renamed route
 * cannot leave a silently-unused line behind.
 */
const OWNER_ONLY: Record<string, string[]> = {
  "account.route.ts": ['router.patch("/:id"', 'router.delete("/:id"'],
  "sharing.route.ts": [
    'router.get("/:id/members"',
    'router.get("/:id/invites"',
    'router.post("/:id/invites"',
    'router.delete("/:id/invites/:token"',
    'router.patch("/:id/members/:uid"',
    'router.delete("/:id/members/:uid"',
    'router.post("/:id/transfer-ownership"',
  ],
};

describe("owner-only routes name owner, not merely some role", () => {
  Object.entries(OWNER_ONLY).forEach(([file, routes]) => {
    const source = stripComments(
      fs.readFileSync(path.join(ROUTES_DIR, file), "utf8")
    );
    const statements = routeStatements(source);

    routes.forEach((route) => {
      it(`${file} — ${route} requires owner`, () => {
        const statement = statements.find((s) => s.text.startsWith(route));

        // A stale entry is a dead assertion, so the lookup is the first check.
        expect(statement).toBeDefined();
        expect(statement!.text).toContain('requireRole("owner")');
      });
    });
  });

  it("keeps channel-exit available to any member", () => {
    // The inverse mistake: owner-gating `leave` would trap a viewer in a channel
    // they want out of, and it is the one member route that must NOT be owner.
    const source = stripComments(
      fs.readFileSync(path.join(ROUTES_DIR, "sharing.route.ts"), "utf8")
    );
    const leave = routeStatements(source).find((s) =>
      s.text.startsWith('router.post("/:id/leave"')
    );

    expect(leave).toBeDefined();
    expect(leave!.text).toContain('requireRole("viewer")');
  });
});

/**
 * Layer boundary (backend-standards.md): "No Firestore access outside
 * repositories", "No service calls in routes". A route file is documentation of
 * what the endpoint does and who is allowed to call it — a repository or service
 * method invoked inline there is invisible to that reading, and was exactly how
 * `billing.route.ts` and `sharing.route.ts` built their response bodies before a
 * controller existed for either.
 *
 * The check is on USE, not on import path: the violation was calling
 * `sharingRepository.members(...)` / `billingRepository.getBalance(...)` etc.
 * directly in a handler, and both were reached through `container.js` — the same
 * module every route file legitimately imports its controller from. Grepping
 * import paths would not have caught it; this greps for an identifier ending in
 * `Repository` or `Service` immediately followed by a method call.
 */
describe("route files stay thin — no repository or service calls", () => {
  const REPO_OR_SERVICE_CALL = /\b\w*(?:Repository|Service)\b\s*\./;
  // Recomputed rather than reusing the outer describe's `routeFiles` — that
  // const is block-scoped to the first `describe` callback above.
  const routeFiles = fs
    .readdirSync(ROUTES_DIR)
    .filter((file) => file.endsWith(".route.ts"));

  routeFiles.forEach((file) => {
    it(`${file} does not call a repository or service method directly`, () => {
      const source = stripComments(
        fs.readFileSync(path.join(ROUTES_DIR, file), "utf8")
      );

      expect(source).not.toMatch(REPO_OR_SERVICE_CALL);
    });
  });
});
