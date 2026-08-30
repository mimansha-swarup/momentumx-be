// Every user gets exactly one channel, minted on first use.
//
// Contract from docs/multi-account/phase-03-dual-write-account-tag.md. The single
// invariant everything else in the migration rests on: `accountId` is a UUID v4
// and NEVER the uid. The old design reused the uid, and the reason it was dropped
// is that a `userId` passed where an `accountId` belongs still isolated
// correctly between two users — so the bug was invisible to every test that
// could be written. These assert the id spaces stay disjoint.

jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: () => "server-ts" },
  }),
  auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
}));

jest.mock("../../../src/config/firebase", () => ({
  db: {},
  auth: {},
  firebase: { firestore: { FieldValue: { serverTimestamp: () => "server-ts" } } },
}));

import AccountService, {
  adoptChannelIdentity,
  forbidCrossAccount,
  deriveDisplayName,
  deriveHandle,
  PLACEHOLDER_CHANNEL_NAME,
} from "../../../src/service/account.service";
import AccountRepository from "../../../src/repository/account.repository";
import UserRepository from "../../../src/repository/user.repository";
import { testOwner } from "../../helpers/account";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A stand-in user record that REMEMBERS its pointer.
 *
 * The real `createWithContext` writes `lastActiveAccountId` inside the claim
 * transaction, and `userRepo.update` writes it on the membership-repair path — so
 * a second `ensureDefaultAccount` for the same user reads a pointer and returns
 * early. A fake that always replayed the ORIGINAL record made every call look
 * like a first call, and idempotency appeared to hold only because a
 * process-lifetime cache sat in front of it. That cache is gone (Phase 06 made
 * the active account per-request), so the fake has to model the store instead.
 */
const make = (user: Record<string, unknown> | null, members: unknown[] = []) => {
  const stored = user === null ? null : { ...user };

  const repo = {
    findByMember: jest.fn().mockResolvedValue(members),
    // Returns the id that WON the claim — normally the one it was handed.
    createWithContext: jest.fn(async (a: { id: string }) => {
      if (stored) stored.lastActiveAccountId = a.id;
      return a.id;
    }),
  } as unknown as jest.Mocked<AccountRepository>;

  const userRepo = {
    get: jest.fn(async () => stored),
    update: jest.fn(async (_uid: string, patch: Record<string, unknown>) => {
      if (stored) Object.assign(stored, patch);
    }),
  } as unknown as jest.Mocked<UserRepository>;

  // Only `listAccounts` counts projects, and nothing in this file lists.
  const projectRepo = { countForAccount: jest.fn(async () => 0) } as never;

  return { service: new AccountService(repo, userRepo, projectRepo), repo, userRepo, projectRepo };
};

// No cache to clear any more. `ensureDefaultAccount` memoized uid → accountId for
// the life of the process, which was safe only while every user had exactly one
// account that never changed. Phase 06 made the active account per-REQUEST, and a
// process-lifetime map beside a per-request account is a user working in channel B
// whose records are stamped channel A — intermittent, because it rebuilds on every
// deploy. It was deleted rather than invalidated.

describe("ensureDefaultAccount — minting", () => {
  it("mints a UUID v4 that is NOT the uid", async () => {
    const { service } = make({ brandName: "Ada TV" });

    const accountId = await service.ensureDefaultAccount("uid-123");

    expect(accountId).toMatch(UUID_V4);
    expect(accountId).not.toBe("uid-123");
  });

  it("writes the account, its context and the pointer for a brand-new user", async () => {
    const { service, repo, userRepo } = make({
      brandName: "Ada TV",
      userName: "https://youtube.com/@adatv",
      websiteContent: "scraped",
    });

    const accountId = await service.ensureDefaultAccount("uid-123");

    const [account, context] = repo.createWithContext.mock.calls[0];
    expect(account.id).toBe(accountId);
    expect(account.displayName).toBe("Ada TV");
    expect(account.handle).toBe("@adatv");
    expect(account.billingOwnerUid).toBe("uid-123");
    expect(account.deletedAt).toBeNull();
    // The channel blob rides in the context document, never on the account doc
    // that Phase 05 reads on every request.
    expect(context.websiteContent).toBe("scraped");
    expect(account).not.toHaveProperty("websiteContent");
    // The pointer is part of the same batch inside the repository, so the service
    // must not also write it separately.
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  // The doc's requirement is "all channel fields copied from users/{uid}" —
  // COPIED, with the user's real values. TypeScript only enforces that the keys
  // exist, because the mapper's return type is IChannelContext: a field wired to
  // the wrong source key, or one that quietly falls back to "" while the user
  // has a value, compiles clean. Phase 06b then generates against an empty
  // channel and produces plausible, silently wrong output.
  it("copies every channel field from the user, with the user's own values", async () => {
    const user = {
      userName: "https://youtube.com/@adatv",
      channelId: "UC123",
      channelDescription: "a channel about things",
      // The channel's top VIDEO titles, not its name — this fixture used to say
      // "Ada TV", which is what a `userTitle: string` declaration invites.
      userTitle: ["How Ada builds", "Ada explains RAG"],
      niche: "AI tools",
      targetAudience: "founders",
      brandName: "Ada",
      website: "https://ada.tv",
      websiteContent: "scraped page text",
      competitors: [{ url: "https://youtube.com/@rival" }],
      format: "faceless" as const,
      purpose: "educate",
      description: "long form explainers",
    };
    const { service, repo } = make(user);

    await service.ensureDefaultAccount("uid-123");

    const [, context] = repo.createWithContext.mock.calls[0];
    // Every declared field, compared to what the user actually had. Asserting the
    // whole object at once is deliberate: a field added to IChannelContext later
    // and left unmapped fails here instead of shipping as a silent "".
    expect(context).toEqual(user);
  });

  // A legacy user record can hold `""` here, and the empty string is exactly
  // what `formatCreatorsData` cannot map over — it threw a TypeError that
  // surfaced as a 500 on the first "Generate ideas" click. `?? []` would not
  // have caught it, because `""` is neither null nor undefined.
  it("coerces a non-array userTitle to an empty list, not through to the context", async () => {
    const { service, repo } = make({ niche: "AI tools", userTitle: "" });

    await service.ensureDefaultAccount("uid-123");

    const [, context] = repo.createWithContext.mock.calls[0];
    expect(context.userTitle).toEqual([]);
  });

  it("defaults missing channel fields rather than dropping the keys", async () => {
    // A user can finish onboarding with niche + targetAudience and no channel at
    // all. `ignoreUndefinedProperties: true` would silently drop undefined keys,
    // so the mapper must emit real empty values instead.
    const { service, repo } = make({ niche: "AI tools" });

    await service.ensureDefaultAccount("uid-123");

    const [, context] = repo.createWithContext.mock.calls[0];
    expect(context.niche).toBe("AI tools");
    expect(context.userName).toBe("");
    expect(context.competitors).toEqual([]);
    expect(context.format).toBe("talking_head");
    for (const [key, value] of Object.entries(context)) {
      expect({ key, value }).not.toEqual({ key, value: undefined });
    }
  });

  it("writes all three membership fields together, with an owner role", async () => {
    const { service, repo } = make({});

    await service.ensureDefaultAccount("uid-123");

    const [account] = repo.createWithContext.mock.calls[0];
    expect(account.memberUids).toEqual(["uid-123"]);
    expect(account.ownerUids).toEqual(["uid-123"]);
    expect(account.members["uid-123"].role).toBe("owner");
    // A member who can query the account but has no role is the exact failure
    // the "one helper writes all three" rule exists to prevent.
    expect(Object.keys(account.members)).toEqual(account.memberUids);
  });

  it("stamps addedAt server-side, never from the caller's clock", async () => {
    const { service, repo } = make({});

    await service.ensureDefaultAccount("uid-123");

    const [account] = repo.createWithContext.mock.calls[0];
    expect(account.members["uid-123"].addedAt).toBe("server-ts");
  });

  it("gives two different users different account ids", async () => {
    const a = await make({}).service.ensureDefaultAccount("uid-a");
    const b = await make({}).service.ensureDefaultAccount("uid-b");

    expect(a).not.toBe(b);
  });
});

describe("ensureDefaultAccount — never mints twice", () => {
  it("returns the pointer when the user already has one", async () => {
    const { service, repo } = make({ lastActiveAccountId: "acc-existing" });

    expect(await service.ensureDefaultAccount("uid-123")).toBe("acc-existing");
    expect(repo.createWithContext).not.toHaveBeenCalled();
    // The pointer is enough — no membership query needed on the common path.
    expect(repo.findByMember).not.toHaveBeenCalled();
  });

  it("falls back to membership when the pointer is missing, and repairs the pointer", async () => {
    // A pointer can be absent while the account exists — an interrupted first
    // write, or a restore. Minting a second account here would split the user's
    // data across two channels.
    const { service, repo, userRepo } = make({}, [{ id: "acc-orphaned" }]);

    expect(await service.ensureDefaultAccount("uid-123")).toBe("acc-orphaned");
    expect(repo.createWithContext).not.toHaveBeenCalled();
    expect(userRepo.update).toHaveBeenCalledWith("uid-123", {
      lastActiveAccountId: "acc-orphaned",
    });
  });

  it("is stable across calls — the second call mints nothing and returns the same id", async () => {
    // Idempotency comes from the STORED pointer, not from a cache. It used to
    // come from both, which meant this passed without the pointer ever being
    // consulted; the cache is gone and the pointer is now load-bearing.
    const { service, repo } = make({});

    const first = await service.ensureDefaultAccount("uid-123");
    const second = await service.ensureDefaultAccount("uid-123");

    expect(second).toBe(first);
    expect(repo.createWithContext).toHaveBeenCalledTimes(1);
  });

  it("adopts the id the claim returns, not the one it optimistically minted", async () => {
    // A concurrent first request for the same fresh user can win the claim; the
    // repository then writes nothing and hands back the winner. Returning the
    // locally-minted id here would tag this request's records with an account
    // that does not exist.
    const { service, repo } = make({});
    (repo.createWithContext as jest.Mock).mockResolvedValue("acc-winner");

    const accountId = await service.ensureDefaultAccount("uid-123");

    expect(accountId).toBe("acc-winner");
    expect(accountId).not.toBe(repo.createWithContext.mock.calls[0][0].id);
    // And the pointer holds the WINNER, so every later call agrees with it rather
    // than with the id this request optimistically minted.
    expect(await service.ensureDefaultAccount("uid-123")).toBe("acc-winner");
  });

  // The contract is "every user has exactly ONE account". This used to be tested
  // across two independently-constructed services, because `event.service.ts`
  // built its own AccountService to dodge an import cycle and the agreement
  // between them rested on the cache being module-scoped. Phase 06 removed that
  // dependency entirely — events carry the caller's account in — so the property
  // to hold now is that a SECOND service, sharing only the database, agrees.
  it("a second service sharing the same user record resolves the same account", async () => {
    const first = make({});
    const second = {
      ...first,
      service: new AccountService(first.repo, first.userRepo, first.projectRepo),
    };

    const a = await first.service.ensureDefaultAccount("uid-123");
    const b = await second.service.ensureDefaultAccount("uid-123");

    expect(b).toBe(a);
    // One mint total, across both instances — the pointer is what they share.
    expect(first.repo.createWithContext).toHaveBeenCalledTimes(1);
  });

  it("never returns an empty-string account id", async () => {
    // `""` is worse than absent: a real value that every affected record across
    // every user shares, so Phase 04 would bucket unrelated users together. A
    // malformed membership document is the one path that can produce it.
    const { service } = make({}, [{ id: "" }]);

    expect(await service.ensureDefaultAccount("uid-123")).not.toBe("");
  });

  it("still mints for a user with no profile document at all", async () => {
    // The auth trigger has a history of dropping its write; a missing profile
    // must not mean a missing channel.
    const { service, repo } = make(null);

    const accountId = await service.ensureDefaultAccount("uid-123");

    expect(accountId).toMatch(UUID_V4);
    expect(repo.createWithContext).toHaveBeenCalled();
  });
});

/**
 * 403 cannot mean one thing.
 *
 * Every ownership check in the services threw a bare `Forbidden()`. The
 * documented client handler reads a code-less 403 as `account_forbidden` and
 * ejects the user to the channel list — so opening a bookmarked project that
 * lives in your OWN other channel logged you out of the channel you were in,
 * when the fix was a single switch away.
 */
describe("forbidCrossAccount — which 403 is this", () => {
  const owner = testOwner("uid-me");

  it("offers the switch when the caller is a member of the resource's channel", async () => {
    const accounts = {
      findById: jest.fn(async () => ({
        id: "acc-other",
        displayName: "Cooking",
        memberUids: ["uid-me"],
        deletedAt: null,
      })),
    };

    const err = await forbidCrossAccount(accounts as never, "acc-other", owner).catch((e) => e);

    expect(err).toMatchObject({
      statusCode: 403,
      code: "wrong_account",
      // The name is the point — a client cannot render "Switch to «Cooking»?"
      // from an id the user has never seen.
      detail: { accountId: "acc-other", displayName: "Cooking" },
    });
  });

  it("ejects when the caller is not a member at all", async () => {
    const accounts = {
      findById: jest.fn(async () => ({
        id: "acc-theirs",
        displayName: "Someone else",
        memberUids: ["uid-stranger"],
        deletedAt: null,
      })),
    };

    const err = await forbidCrossAccount(accounts as never, "acc-theirs", owner).catch((e) => e);

    expect(err).toMatchObject({ statusCode: 403, code: "account_forbidden" });
    // Never name a channel the caller has no business knowing exists.
    expect(err.detail).toBeUndefined();
  });

  it("does not offer a tombstoned channel as a switch target", async () => {
    const accounts = {
      findById: jest.fn(async () => ({
        id: "acc-dead",
        displayName: "Deleted",
        memberUids: ["uid-me"],
        deletedAt: "2026-08-01",
      })),
    };

    const err = await forbidCrossAccount(accounts as never, "acc-dead", owner).catch((e) => e);

    expect(err).toMatchObject({ code: "account_forbidden" });
  });

  it("ejects when the resource carries no account at all", async () => {
    const accounts = { findById: jest.fn() };

    const err = await forbidCrossAccount(accounts as never, undefined, owner).catch((e) => e);

    expect(err).toMatchObject({ code: "account_forbidden" });
    expect(accounts.findById).not.toHaveBeenCalled();
  });
});

/**
 * The switcher rendered "Untitled channel" for every channel, forever.
 *
 * `deriveDisplayName` runs in exactly one place — `ensureDefaultAccount`, on the
 * user's FIRST authenticated request, before onboarding exists — and
 * `POST /v1/accounts` hardcodes the placeholder. Once Phase 06b moved the channel
 * fields off `users/{uid}`, nothing revisited the name, so the whole derive
 * ladder was unreachable in production.
 */
describe("adoptChannelIdentity — a channel gets its name from onboarding", () => {
  const repoWith = (displayName: string) => ({
    findById: jest.fn(async () => ({ id: "acc-1", displayName })),
    update: jest.fn(async () => undefined),
  });

  it("names a placeholder channel from the brand and channel URL", async () => {
    const repo = repoWith(PLACEHOLDER_CHANNEL_NAME);

    await adoptChannelIdentity(repo as never, "acc-1", {
      brandName: "Acme Tech",
      userName: "https://youtube.com/@acmetech",
    });

    expect(repo.update).toHaveBeenCalledWith("acc-1", {
      displayName: "Acme Tech",
      handle: "@acmetech",
    });
  });

  it("leaves a channel the owner renamed alone", async () => {
    // PATCH /v1/accounts/:id is the owner's choice. Onboarding must not rename a
    // channel out from under them, and neither must a later brand-name edit —
    // which is also why no "was this derived?" flag is needed.
    const repo = repoWith("My Cooking Channel");

    await adoptChannelIdentity(repo as never, "acc-1", { brandName: "Acme Tech" });

    expect(repo.update).not.toHaveBeenCalled();
  });

  it("leaves the placeholder rather than writing it back when nothing is usable", async () => {
    const repo = repoWith(PLACEHOLDER_CHANNEL_NAME);

    await adoptChannelIdentity(repo as never, "acc-1", { targetAudience: "founders" });

    expect(repo.update).not.toHaveBeenCalled();
  });

  it("does nothing when the account is gone", async () => {
    const repo = { findById: jest.fn(async () => null), update: jest.fn() };

    await adoptChannelIdentity(repo as never, "acc-1", { brandName: "Acme" });

    expect(repo.update).not.toHaveBeenCalled();
  });
});

describe("displayName — the switcher always has something to render", () => {
  it.each([
    [{ brandName: "Brand", niche: "AI" }, "Brand"],
    // `userTitle` is the channel's top VIDEO titles, a string[]. It used to sit
    // second in this ladder, where it could never match — and where it read as
    // if a channel could be named after one of its videos.
    [{ userTitle: ["A video title"], niche: "AI" }, "AI"],
    [{ userName: "https://youtube.com/@adatv", niche: "AI" }, "@adatv"],
    [{ niche: "AI tools" }, "AI tools"],
    [{}, "Untitled channel"],
  ])("resolves %o to %s", (user, expected) => {
    expect(deriveDisplayName(user)).toBe(expected);
  });

  it("skips blank fields rather than rendering whitespace", () => {
    expect(deriveDisplayName({ brandName: "   ", niche: "AI" })).toBe("AI");
  });

  // The case the fallback chain exists for: onboarding accepts niche +
  // targetAudience with NO channel URL, so a switcher keyed on the handle alone
  // would show these users a blank, unclickable row.
  it("never returns an empty string for a URL-less onboarding", () => {
    expect(deriveDisplayName({ niche: "", targetAudience: "founders" })).toBe(
      "Untitled channel"
    );
  });
});

describe("handle", () => {
  it("extracts a handle URL", () => {
    expect(deriveHandle("https://youtube.com/@adatv")).toBe("@adatv");
  });

  it.each([
    ["https://youtube.com/channel/UCabcdefghijklmnopqrstuv"],
    [""],
    [undefined],
    [null],
  ])("is null for %s, which is not a handle", (input) => {
    expect(deriveHandle(input)).toBeNull();
  });
});
