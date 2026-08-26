import AccountService from "../../src/service/account.service";
import { RecordOwner } from "../../src/utlils/content";

/**
 * A stand-in AccountService that hands back a FIXED account id.
 *
 * Deliberately a constant that is obviously not a uid. Phase 03's whole point is
 * that `accountId` and `userId` are different values from disjoint spaces — a
 * stub returning the uid would let a service that stamps the wrong one pass every
 * assertion, which is the bug the UUID-v4 decision exists to make visible.
 *
 * `ensureDefaultAccount` is the only method any service calls. Minting, the
 * membership fallback and the display-name chain are the real class's job and are
 * tested against it directly in
 * `tests/unit/service/account.service.behaviour.test.ts`.
 */
export const TEST_ACCOUNT_ID = "acc-11111111-2222-4333-8444-555555555555";

/**
 * A pass-through `src/middleware/account` for ROUTE suites.
 *
 * Those suites mock `config/firebase` with an empty `db`, so the real middleware
 * — which reads the account document to check membership — cannot run. They are
 * testing their own route's contract, not membership.
 *
 * The middleware's actual behaviour (403 on a non-member, 410 on a tombstone, the
 * header fallback, the role default) is tested for real in
 * `tests/integration/account-middleware.behaviour.test.ts`, against a live Express
 * app. And `tests/unit/auth-coverage.test.ts` is what proves each router still
 * MOUNTS it — a stub here cannot hide an unmounted router, because that ratchet
 * reads the route files rather than running them.
 *
 * Usage, at the top of a route suite:
 *
 *   jest.mock("../../src/middleware/account", () =>
 *     require("../helpers/account").passthroughAccountMiddleware());
 */
export function passthroughAccountMiddleware(accountId = TEST_ACCOUNT_ID) {
  const pass = (
    req: { accountId?: string; role?: string },
    _res: unknown,
    next: () => void
  ) => {
    req.accountId = accountId;
    req.role = "owner";
    next();
  };
  return {
    ACCOUNT_HEADER: "x-account-id",
    FALLBACK_ALLOWS_WRITES: true,
    accountMiddleware: pass,
    resolveAccountFromProject: pass,
    roleFor: () => "owner",
    default: pass,
  };
}

export function makeTestAccountService(accountId = TEST_ACCOUNT_ID): AccountService {
  return {
    ensureDefaultAccount: jest.fn(async () => accountId),
  } as unknown as AccountService;
}

/** The owner stamp the helpers above produce, for asserting on a written doc. */
export const testOwner = (userId: string, accountId = TEST_ACCOUNT_ID): RecordOwner => ({
  userId,
  accountId,
});
