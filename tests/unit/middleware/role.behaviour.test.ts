import type { NextFunction, Request, Response } from "express";
import { requireRole } from "../../../src/middleware/role";
import { AccountRole } from "../../../src/types/routes/account";

/**
 * The role gate. It had no behavioural test at all — only the source-level
 * `auth-coverage` ratchet, which checks that a `requireRole(...)` call is PRESENT
 * on a route, never what it decides.
 *
 * The gap that hid: the guard was `req.role in levels`, and `in` walks the
 * prototype chain. A stored role of `constructor`, `toString`, `hasOwnProperty`
 * or `__proto__` resolved to a function or an object, `< levels[minimum]`
 * produced `NaN`, the comparison was false — and the middleware called `next()`.
 * All four passed a `requireRole("owner")` gate.
 *
 * Not reachable through the API today: every writer of a role is zod-restricted
 * to owner|editor|viewer. But this is the one gate in the codebase that must fail
 * closed, and a direct Firestore write, a data import or a migration is enough to
 * reach it — so it is asserted rather than reasoned about.
 */
const run = (role: unknown, minimum: AccountRole) => {
  const next = jest.fn();
  requireRole(minimum)(
    { role } as unknown as Request,
    {} as Response,
    next as NextFunction
  );
  return next;
};

const allowed = (role: unknown, minimum: AccountRole) => {
  const next = run(role, minimum);
  return next.mock.calls.length === 1 && next.mock.calls[0].length === 0;
};

describe("requireRole", () => {
  it.each([
    ["owner", "owner"],
    ["owner", "editor"],
    ["owner", "viewer"],
    ["editor", "editor"],
    ["editor", "viewer"],
    ["viewer", "viewer"],
  ] as const)("admits %s where %s is the minimum", (role, minimum) => {
    expect(allowed(role, minimum)).toBe(true);
  });

  it.each([
    ["editor", "owner"],
    ["viewer", "owner"],
    ["viewer", "editor"],
  ] as const)("refuses %s where %s is the minimum", (role, minimum) => {
    expect(allowed(role, minimum)).toBe(false);
  });

  // The fix. Every one of these ALLOWED an owner-only route before.
  it.each(["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"])(
    "refuses the inherited Object property %s",
    (role) => {
      expect(allowed(role, "owner")).toBe(false);
      expect(allowed(role, "editor")).toBe(false);
      expect(allowed(role, "viewer")).toBe(false);
    }
  );

  it.each([undefined, null, "", "admin", "OWNER", 2, {}])(
    "refuses the non-role %p",
    (role) => {
      expect(allowed(role, "viewer")).toBe(false);
    }
  );

  it("refuses with role_forbidden, so the client shows an inline message and stays put", () => {
    // The 403 discriminator: `role_forbidden` must NOT eject the user from the
    // channel — they are a member, their role just does not allow this.
    const next = run("viewer", "owner");

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toMatchObject({
      statusCode: 403,
      code: "role_forbidden",
    });
  });
});
