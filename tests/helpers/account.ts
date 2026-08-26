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
