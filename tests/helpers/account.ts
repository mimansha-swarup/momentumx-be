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
 * A SECOND channel, for the cross-tenant cases.
 *
 * From Phase 06 "belongs to someone else" is a different `accountId`, not a
 * different `createdBy`. A fixture that varies only the author now describes a
 * co-member of the SAME channel — who is allowed — so it would assert a 403 that
 * no longer happens, or worse, stop asserting anything.
 */
export const OTHER_ACCOUNT_ID = "acc-99999999-8888-4777-8666-555555555555";

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

/**
 * The owner stamp the helpers above produce — for asserting on a written doc, and
 * (from Phase 06) on the argument a controller hands its service.
 *
 * Asserting the whole object is what keeps the route suites meaningful. Right uid
 * plus WRONG account is the bug this phase can introduce, and an assertion that
 * checked only the uid would wave it through.
 */
export const testOwner = (userId: string, accountId = TEST_ACCOUNT_ID): RecordOwner => ({
  userId,
  accountId,
});


/**
 * An `AccountRepository` that answers with ONE channel context.
 *
 * Phase 06b moved the channel — niche, audience, competitors, website text —
 * from `users/{uid}` onto `accounts/{id}/context/channel`, so the suites that
 * used to stub `userRepo.get` stub this instead. Defaults to a populated channel
 * because most of them are asserting on a prompt built from it; pass `null` for
 * the "channel not found" path.
 */
export const fakeAccountRepo = (
  context: Record<string, unknown> | null = {
    niche: "cooking",
    targetAudience: "home cooks",
    brandName: "Test Kitchen",
    format: "talking_head",
  },
  /**
   * Channels this fake knows about, keyed by id. `forbidCrossAccount` reads
   * them to decide WHICH 403 a cross-channel refusal is.
   *
   * This defaulted to `findById: async () => null`, which meant every service
   * suite took the `account_forbidden` branch and the `wrong_account` path —
   * the entire reason those call sites exist — was produced by no service,
   * controller or route test in the repo. Pass a channel here to exercise the
   * "you are a member, you are just standing somewhere else" case.
   */
  knownAccounts: Record<string, Record<string, unknown>> = {}
) =>
  ({
    getContext: jest.fn(async () => context),
    writeContext: jest.fn(async () => undefined),
    findById: jest.fn(async (id: string) => knownAccounts[id] ?? null),
    findByMember: jest.fn(async () => []),
    update: jest.fn(async () => undefined),
  }) as never;

/** A channel the caller belongs to — the switch target in a `wrong_account`. */
export const memberChannel = (id: string, userId: string, displayName = "Other Channel") => ({
  id,
  displayName,
  memberUids: [userId],
  ownerUids: [userId],
  deletedAt: null,
});
