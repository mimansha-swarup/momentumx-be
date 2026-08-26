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
  __clearAccountIdCache,
  deriveDisplayName,
  deriveHandle,
} from "../../../src/service/account.service";
import AccountRepository from "../../../src/repository/account.repository";
import UserRepository from "../../../src/repository/user.repository";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const make = (user: Record<string, unknown> | null, members: unknown[] = []) => {
  const repo = {
    findByMember: jest.fn().mockResolvedValue(members),
    // Returns the id that WON the claim — normally the one it was handed.
    createWithContext: jest.fn(async (a: { id: string }) => a.id),
  } as unknown as jest.Mocked<AccountRepository>;

  const userRepo = {
    get: jest.fn().mockResolvedValue(user),
    update: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<UserRepository>;

  return { service: new AccountService(repo, userRepo), repo, userRepo };
};

beforeEach(() => __clearAccountIdCache());

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
      userTitle: "Ada TV",
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

  it("is stable across calls — a second call re-reads nothing and returns the same id", async () => {
    const { service, userRepo } = make({});

    const first = await service.ensureDefaultAccount("uid-123");
    const second = await service.ensureDefaultAccount("uid-123");

    expect(second).toBe(first);
    expect(userRepo.get).toHaveBeenCalledTimes(1);
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
    // And the cache holds the winner, so every later write in this process agrees.
    expect(await service.ensureDefaultAccount("uid-123")).toBe("acc-winner");
  });

  // The contract is "every user has exactly ONE account", and the ids have to
  // agree across every write path or that user's records split between two
  // accounts. `event.service.ts` deliberately constructs its OWN AccountService
  // to avoid an import cycle with the container, so "one account" is only true
  // because the cache is module-scoped. Move it to an instance field and events
  // would be tagged with a different account than the ideas from the same
  // request — with nothing failing.
  it("two independently-constructed services resolve one user to the SAME account", async () => {
    const container = make({});
    const telemetry = make({}); // what event.service.ts really does

    const fromContainer = await container.service.ensureDefaultAccount("uid-123");
    const fromTelemetry = await telemetry.service.ensureDefaultAccount("uid-123");

    expect(fromTelemetry).toBe(fromContainer);
    // ...and the second instance minted nothing of its own.
    expect(telemetry.repo.createWithContext).not.toHaveBeenCalled();
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

describe("displayName — the switcher always has something to render", () => {
  it.each([
    [{ brandName: "Brand", userTitle: "Title", niche: "AI" }, "Brand"],
    [{ userTitle: "Title", niche: "AI" }, "Title"],
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
