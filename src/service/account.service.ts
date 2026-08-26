import { randomUUID } from "crypto";
import { firebase } from "../config/firebase.js";
import AccountRepository from "../repository/account.repository.js";
import UserRepository from "../repository/user.repository.js";
import { IAccount, IChannelContext } from "../types/routes/account.js";
import { extractChannelInfo } from "../utlils/regex.js";

/**
 * `brandName → userTitle → handle(userName) → niche → "Untitled channel"`.
 *
 * `displayName` is required and cannot be left to the channel URL, because a user
 * can finish onboarding today with no URL at all — `PATCH /v1/user/onboarding`
 * accepts niche + targetAudience instead. Those users have no `userName`, no
 * `brandName` and no `userTitle`, and a switcher rendering the handle would show
 * them a blank row with nothing to click.
 */
export const deriveDisplayName = (user: Record<string, unknown>): string => {
  const pick = (value: unknown): string =>
    typeof value === "string" && value.trim() ? value.trim() : "";

  const handle = (() => {
    const url = pick(user.userName);
    if (!url) return "";
    const info = extractChannelInfo(url);
    return info?.type === "handle" ? `@${info.value}` : "";
  })();

  return (
    pick(user.brandName) ||
    pick(user.userTitle) ||
    handle ||
    pick(user.niche) ||
    "Untitled channel"
  );
};

/** `"@foo"` when the stored channel URL is a handle URL, else null. */
export const deriveHandle = (userName: unknown): string | null => {
  if (typeof userName !== "string" || !userName.trim()) return null;
  const info = extractChannelInfo(userName);
  return info?.type === "handle" ? `@${info.value}` : null;
};

/** The channel half of `users/{uid}`, moved verbatim. Phase 06b retires the original. */
const toChannelContext = (user: Record<string, unknown>): IChannelContext => ({
  userName: (user.userName as string) ?? "",
  channelId: (user.channelId as string) ?? "",
  channelDescription: (user.channelDescription as string) ?? "",
  userTitle: (user.userTitle as string) ?? "",
  niche: (user.niche as string) ?? "",
  targetAudience: (user.targetAudience as string) ?? "",
  brandName: (user.brandName as string) ?? "",
  website: (user.website as string) ?? "",
  websiteContent: (user.websiteContent as string) ?? "",
  competitors: (user.competitors as IChannelContext["competitors"]) ?? [],
  format: (user.format as IChannelContext["format"]) ?? "talking_head",
  purpose: (user.purpose as string) ?? "",
  description: (user.description as string) ?? "",
});

class AccountService {
  constructor(
    private repo: AccountRepository,
    private userRepo: UserRepository
  ) {}

  /**
   * Every user's `accountId` for this phase, minting one on first use.
   *
   * `accountId` is a UUID v4 and NEVER the uid (decision 2026-08-25, see the
   * README). So existence cannot be probed by document id: check the pointer,
   * then membership, and only create when both come back empty.
   *
   * Lazy rather than in the auth trigger, so a user missing an account self-heals
   * on their next request instead of being stuck.
   */
  ensureDefaultAccount = async (userId: string): Promise<string> => {
    const cached = accountIdCache.get(userId);
    if (cached) return cached;

    const user = (await this.userRepo.get(userId)) as Record<string, unknown> | null;

    const pointer = user?.lastActiveAccountId;
    if (typeof pointer === "string" && pointer) {
      accountIdCache.set(userId, pointer);
      return pointer;
    }

    // No pointer. Membership is the authority — a pointer can be missing while
    // the account exists (an interrupted first write, or a restore).
    //
    // The id is re-checked rather than trusted: an account document with a blank
    // `id` would otherwise be adopted and stamped onto every record this user
    // writes. `""` is worse than a missing tag — it is a real value shared by
    // every affected record across every user, so Phase 04 would resolve them
    // into one bucket. Skip the malformed document and mint instead.
    const existing = await this.repo.findByMember(userId);
    const found = existing.find(
      (account) =>
        typeof account?.id === "string" &&
        account.id.trim() &&
        // A tombstoned channel must not be adopted here. Doing so hands the
        // caller an account that `accountMiddleware` will immediately 410, on
        // every request, with no way out of the loop.
        !account.deletedAt
    );
    if (found) {
      await this.userRepo.update(userId, { lastActiveAccountId: found.id });
      accountIdCache.set(userId, found.id);
      return found.id;
    }

    const account: Omit<IAccount, "createdAt" | "updatedAt"> = {
      id: randomUUID(),
      displayName: deriveDisplayName(user ?? {}),
      handle: deriveHandle(user?.userName),
      // Written together, by this one helper. A caller assembling these by hand
      // is how you get a member who can query an account but has no role.
      memberUids: [userId],
      ownerUids: [userId],
      members: {
        [userId]: {
          role: "owner",
          // The sentinel resolves even nested in a map, so no `new Date()` here.
          addedAt: firebase.firestore.FieldValue.serverTimestamp() as never,
        },
      },
      billingOwnerUid: userId,
      deletedAt: null,
    };

    // May return a DIFFERENT id: a concurrent first request can win the claim,
    // in which case nothing was written and we adopt theirs.
    const accountId = await this.repo.createWithContext(
      account,
      toChannelContext(user ?? {})
    );
    accountIdCache.set(userId, accountId);
    return accountId;
  };

  /**
   * Drop the user's pointer at a channel that can no longer be entered.
   *
   * The repair path for a tombstone. Without it the pointer keeps naming a dead
   * account, `ensureDefaultAccount` keeps returning it from the pointer branch,
   * and the user gets 410 on every request forever. Evicting the process cache
   * matters as much as the stored pointer — that cache is checked first.
   *
   * Guarded on the id matching so a stale request cannot clear a pointer the user
   * has since moved somewhere live.
   */
  clearActiveAccount = async (userId: string, accountId: string): Promise<void> => {
    if (accountIdCache.get(userId) === accountId) accountIdCache.delete(userId);

    const user = (await this.userRepo.get(userId)) as Record<string, unknown> | null;
    if (user?.lastActiveAccountId !== accountId) return;
    await this.userRepo.update(userId, { lastActiveAccountId: null });
  };
}

/**
 * uid → accountId, for the life of the process.
 *
 * ponytail: safe only because this phase gives every user exactly ONE account
 * that never changes. Phase 05 introduces switching, at which point the active
 * account comes from the request and this cache is wrong — delete it then, do not
 * try to invalidate it. It exists so stamping a write does not cost a user read
 * every time.
 */
const accountIdCache = new Map<string, string>();

/** Test seam — the cache is process-wide and would otherwise leak across suites. */
export const __clearAccountIdCache = () => accountIdCache.clear();

export default AccountService;
