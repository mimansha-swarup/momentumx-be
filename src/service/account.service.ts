import { randomUUID } from "crypto";
import { firebase } from "../config/firebase.js";
import AccountRepository from "../repository/account.repository.js";
import UserRepository from "../repository/user.repository.js";
import { IAccount, IChannelContext } from "../types/routes/account.js";
import { extractChannelInfo } from "../utlils/regex.js";
import VideoProjectRepository from "../repository/video-project.repository.js";
import { computeProfileCompleteness } from "../utlils/profile.js";
import { AccountForbidden, BadRequest, Gone, RoleForbidden } from "../utlils/errors.js";
import { IAccountSummary } from "../types/routes/account.js";

/**
 * The same rule the frontend's `selectIsOnboarded` uses: a channel URL, OR a
 * niche and a target audience. Onboarding accepts either, so both have to count.
 *
 * Read from the ACCOUNT's context, never the user record. The user record holds
 * one channel's worth of answers, so sourcing it there would make every channel
 * a user owns report the first one's state — a brand-new channel would claim to
 * be onboarded the moment it was created.
 */
export const isChannelOnboarded = (context: IChannelContext | null): boolean => {
  if (!context) return false;
  const filled = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  return filled(context.userName) || (filled(context.niche) && filled(context.targetAudience));
};

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

/**
 * The ONE writer of `memberUids`, `ownerUids` and `members`.
 *
 * Phase 02 and Phase 09 both state the rule, and the plan broke it at the design
 * level: `ensureDefaultAccount` assembled all three inline, and Phase 06a's
 * create endpoint would have been a second independent writer of the same three
 * fields. Two writers is how you get a member who can query an account but has
 * no role — the array and the map disagree, and nothing fails until someone
 * checks a permission.
 */
export const buildOwnedAccount = (
  userId: string,
  channel: { displayName: string; handle: string | null }
): Omit<IAccount, "createdAt" | "updatedAt"> => ({
  id: randomUUID(),
  displayName: channel.displayName,
  handle: channel.handle,
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
});

/** A brand-new channel knows nothing about itself until onboarding runs against it. */
const EMPTY_CHANNEL_CONTEXT: IChannelContext = {
  userName: "",
  channelId: "",
  channelDescription: "",
  userTitle: "",
  niche: "",
  targetAudience: "",
  brandName: "",
  website: "",
  websiteContent: "",
  competitors: [],
  format: "talking_head",
  purpose: "",
  description: "",
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
    private userRepo: UserRepository,
    private projects: VideoProjectRepository
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
    const user = (await this.userRepo.get(userId)) as Record<string, unknown> | null;

    const pointer = user?.lastActiveAccountId;
    if (typeof pointer === "string" && pointer) return pointer;

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
      return found.id;
    }

    // May return a DIFFERENT id: a concurrent first request can win the claim,
    // in which case nothing was written and we adopt theirs.
    return this.repo.createWithContext(
      buildOwnedAccount(userId, {
        displayName: deriveDisplayName(user ?? {}),
        handle: deriveHandle(user?.userName),
      }),
      toChannelContext(user ?? {})
    );
  };

  /**
   * Create an ADDITIONAL channel (Phase 06a).
   *
   * No body: onboarding already owns URL entry, prefill and confirmation, and it
   * needs a real account id to send `X-Account-Id` against. Create-then-onboard
   * reuses those endpoints unchanged, and leaves a visible half-configured channel
   * in the switcher if the user abandons setup — which is what lets them come back
   * to it or delete it. A one-shot create-with-URL would leave nothing behind.
   *
   * The context starts EMPTY, which is what makes the new channel report
   * `isOnboarded: false`. Copying the user record in here would make every new
   * channel claim the first channel's niche and audience.
   */
  createAccount = async (userId: string): Promise<IAccount> => {
    const account = buildOwnedAccount(userId, {
      displayName: "Untitled channel",
      handle: null,
    });
    const id = await this.repo.createAdditional(account, EMPTY_CHANNEL_CONTEXT);
    const created = await this.repo.findById(id);
    if (!created) throw new Error("account create returned an unreadable id");
    return created;
  };

  /**
   * The switcher's list.
   *
   * `role`, `isOnboarded` and `projectCount` are the three fields that are not
   * obvious and are each load-bearing:
   *
   * - `role` — Phase 09's read-only UI spans seven screens and there is no role
   *   anywhere client-side today. This is where it comes from.
   * - `isOnboarded` — the switcher ROUTES on it: pick a channel that is not
   *   onboarded and you land on onboarding rather than the dashboard. Deriving it
   *   client-side would put the same rule in two places that then drift.
   * - `projectCount` — the cheapest defence against the silent-data-loss class
   *   that Phase 04 and Phase 06 both name as their top risk. A user whose
   *   projects vanished sees "0 videos" beside a channel they know has forty,
   *   from the menu, without opening it. So does support, in one screenshot.
   */
  listAccounts = async (userId: string): Promise<IAccountSummary[]> => {
    const memberships = (await this.repo.findByMember(userId)).filter(
      (account) => !account.deletedAt
    );

    return Promise.all(
      memberships.map(async (account) => {
        const [context, projectCount] = await Promise.all([
          this.repo.getContext(account.id),
          this.projects.countForAccount(account.id),
        ]);

        return {
          id: account.id,
          name: account.displayName,
          handle: account.handle,
          role: account.members?.[userId]?.role ?? "viewer",
          isOnboarded: isChannelOnboarded(context),
          projectCount,
          completeness: computeProfileCompleteness(context ?? {}),
          // Phase 08. Null rather than absent, and null for everyone until then,
          // so the client renders one shape instead of branching on a missing key.
          credits: null,
        };
      })
    );
  };

  /**
   * Which channel a fresh tab should open in.
   *
   * The stored pointer, but only if it still names a channel the caller can
   * actually enter — a pointer at a tombstoned or departed channel would send the
   * tab straight into a 410/403 loop. Falls back to the first live membership,
   * which is what the middleware would have picked anyway.
   */
  resolveActiveAccountId = async (
    userId: string,
    accounts: IAccountSummary[]
  ): Promise<string | null> => {
    const user = (await this.userRepo.get(userId)) as Record<string, unknown> | null;
    const pointer = user?.lastActiveAccountId;
    if (typeof pointer === "string" && accounts.some((a) => a.id === pointer)) {
      return pointer;
    }
    return accounts[0]?.id ?? null;
  };

  /** One channel in full, for the settings screen. Membership is the gate. */
  getAccount = async (userId: string, accountId: string): Promise<IAccount> => {
    const account = await this.repo.findById(accountId);
    if (!account) throw AccountForbidden("Channel not found");
    if (account.deletedAt) throw Gone();
    if (!account.memberUids?.includes(userId)) throw AccountForbidden();
    return account;
  };

  /** Owner-only channel edits. */
  updateAccount = async (
    userId: string,
    accountId: string,
    patch: { displayName?: string }
  ): Promise<IAccount> => {
    const account = await this.assertOwner(userId, accountId);

    const displayName = patch.displayName?.trim();
    if (!displayName) throw BadRequest("displayName is required");

    await this.repo.update(accountId, { displayName });
    return { ...account, displayName };
  };

  /** Which channel a fresh tab should open in. */
  activateAccount = async (userId: string, accountId: string): Promise<void> => {
    const account = await this.repo.findById(accountId);
    if (!account || account.deletedAt) throw AccountForbidden("Channel not found");
    if (!account.memberUids?.includes(userId)) throw AccountForbidden();

    await this.userRepo.update(userId, { lastActiveAccountId: accountId });
  };

  /**
   * Owner-only, and it refuses the user's LAST channel.
   *
   * Without that refusal the next request finds zero memberships and
   * `ensureDefaultAccount` mints a fresh empty one — so "delete my channel"
   * silently becomes "replace my channel with an empty one", and every document
   * still carrying the old accountId is present, billable and unreachable.
   */
  deleteAccount = async (userId: string, accountId: string): Promise<void> => {
    await this.assertOwner(userId, accountId);

    const live = (await this.repo.findByMember(userId)).filter((a) => !a.deletedAt);
    if (live.length <= 1) {
      throw BadRequest("You cannot delete your only channel");
    }

    await this.repo.softDelete(accountId);
    // Leaving the pointer on a tombstone costs the user a 410 on their next
    // request before the middleware repairs it. Clearing it here is one write.
    await this.clearActiveAccount(userId, accountId);
  };

  private assertOwner = async (userId: string, accountId: string): Promise<IAccount> => {
    const account = await this.repo.findById(accountId);
    if (!account) throw AccountForbidden("Channel not found");
    if (account.deletedAt) throw Gone();
    if (!account.memberUids?.includes(userId)) throw AccountForbidden();
    if (!account.ownerUids?.includes(userId)) {
      throw RoleForbidden("Only the channel owner can do this");
    }
    return account;
  };

  /**
   * Drop the user's pointer at a channel that can no longer be entered.
   *
   * The repair path for a tombstone. Without it the pointer keeps naming a dead
   * account, `ensureDefaultAccount` keeps returning it from the pointer branch,
   * and the user gets 410 on every request forever.
   *
   * Guarded on the id matching so a stale request cannot clear a pointer the user
   * has since moved somewhere live.
   */
  clearActiveAccount = async (userId: string, accountId: string): Promise<void> => {
    const user = (await this.userRepo.get(userId)) as Record<string, unknown> | null;
    if (user?.lastActiveAccountId !== accountId) return;
    await this.userRepo.update(userId, { lastActiveAccountId: null });
  };
}

export default AccountService;
