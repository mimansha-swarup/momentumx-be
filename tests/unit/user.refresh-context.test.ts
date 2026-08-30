jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn() },
  }),
  auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
}));

jest.mock("../../src/config/firebase", () => ({
  db: {},
  auth: {},
  firebase: { firestore: { FieldValue: { serverTimestamp: jest.fn() } } },
}));

jest.mock("../../src/config/ai", () => ({
  __esModule: true,
  default: jest.fn(),
  embeddingModel: { embedContent: jest.fn() },
}));

jest.mock("../../src/utlils/ai", () => ({
  // collectJson stays REAL: it is the empty/malformed-JSON guard, and the fake
  // streams below are exactly what should be driving it.
  collectJson: jest.requireActual("../../src/utlils/ai").collectJson,
  generateStreamingContent: jest.fn(),
  generateContent: jest.fn(),
}));

jest.mock("../../src/utlils/content", () => ({
  resolveChannel: jest.fn(),
  formatUserData: jest.fn(),
}));

jest.mock("../../src/repository/user.repository");
jest.mock("../../src/repository/extract.repository");

import { testOwner, fakeAccountRepo, TEST_ACCOUNT_ID } from "../helpers/account";
import UserService from "../../src/service/user.service";
import UserRepository from "../../src/repository/user.repository";
import { formatUserData } from "../../src/utlils/content";

const mockFormat = formatUserData as jest.Mock;

/**
 * The channel, from the ACCOUNT (Phase 06b). These suites used to stub
 * `userRepo.get` for this — the same record that holds identity — which is
 * exactly the conflation the phase removed: one record cannot answer for two
 * channels.
 */
const accountRepo = {
  getContext: jest.fn(),
  // Parameters declared so `mock.calls[n][1]` is the patch, not `never`.
  writeContext: jest.fn(async (_accountId: string, _patch: Record<string, unknown>) => undefined),
};
const channelRepo = () => accountRepo as never;

describe("UserService.refreshContext", () => {
  let service: UserService;
  let repo: jest.Mocked<UserRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new UserRepository() as jest.Mocked<UserRepository>;
    service = new UserService(repo as never, channelRepo());
  });

  it("re-runs enrichment from stored inputs, mapping competitors back to URLs", async () => {
    accountRepo.getContext.mockResolvedValue({
      userName: "https://youtube.com/@me",
      website: "https://site.io",
      niche: "AI tools",
      targetAudience: "founders",
      brandName: "MomentumX",
      competitors: [
        { url: "https://youtube.com/@a", id: "chan-a", titles: ["A1"] },
        { url: "https://youtube.com/@b", id: "chan-b", titles: ["B1"] },
      ],
    });
    repo.update = jest.fn().mockResolvedValue(undefined);
    mockFormat.mockResolvedValue({
      userName: "https://youtube.com/@me",
      niche: "AI tools",
      targetAudience: "founders",
      brandName: "MomentumX",
      channelId: "chan-me",
      userTitle: ["T1"],
      channelDescription: "desc",
    });

    const result = await service.refreshContext(testOwner("user-1"));

    // Stored competitor objects are re-flattened to URL strings for formatUserData.
    const input = mockFormat.mock.calls[0][0];
    expect(input.competitors).toEqual([
      "https://youtube.com/@a",
      "https://youtube.com/@b",
    ]);
    expect(accountRepo.writeContext).toHaveBeenCalledTimes(1);
    // The refreshed record is returned with a computed completeness score.
    expect(result.completeness.score).toBeGreaterThan(0);
  });

  it("404s when the user record is missing", async () => {
    accountRepo.getContext.mockResolvedValue(undefined);
    await expect(service.refreshContext(testOwner("user-1"))).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("tolerates competitors stored as raw URL strings (fresh, pre-enrichment)", async () => {
    accountRepo.getContext.mockResolvedValue({
      userName: "https://youtube.com/@me",
      competitors: ["https://youtube.com/@a", "https://youtube.com/@b"],
    });
    repo.update = jest.fn().mockResolvedValue(undefined);
    mockFormat.mockResolvedValue({ userName: "https://youtube.com/@me" });

    await service.refreshContext(testOwner("user-1"));

    const input = mockFormat.mock.calls[0][0];
    expect(input.competitors).toEqual([
      "https://youtube.com/@a",
      "https://youtube.com/@b",
    ]);
  });
});

// `updateProfile` is the OTHER path that re-runs enrichment, and it had no test
// of its own — only a route test against a fully-mocked UserService. The pair
// deserves pinning together, because the difference between them is easy to
// erase by accident in either direction.
describe("UserService.updateProfile", () => {
  let service: UserService;
  let repo: jest.Mocked<UserRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new UserRepository() as jest.Mocked<UserRepository>;
    repo.update = jest.fn().mockResolvedValue(undefined);
    service = new UserService(repo as never, channelRepo());
  });

  it("enriches the submitted form before storing it, rather than persisting raw input", async () => {
    mockFormat.mockResolvedValue({ niche: "AI tools", websiteContent: "scraped" });

    const result = await service.updateProfile(testOwner("user-1"), {
      niche: "AI tools",
      website: "https://site.io",
    } as never);

    expect(mockFormat).toHaveBeenCalledWith(
      { niche: "AI tools", website: "https://site.io" },
      expect.anything()
    );
    expect(accountRepo.writeContext).toHaveBeenCalledWith(
      TEST_ACCOUNT_ID, {
      niche: "AI tools",
      websiteContent: "scraped",
    });
    expect(result).toMatchObject({ websiteContent: "scraped" });
  });

  it("writes to the authenticated uid it was given", async () => {
    mockFormat.mockResolvedValue({ niche: "n" });

    await service.updateProfile(testOwner("user-1"), { niche: "n" } as never);

    expect(accountRepo.writeContext.mock.calls[0][0]).toBe(TEST_ACCOUNT_ID);
  });

  it("does not attach a completeness score — unlike refreshContext and getProfile", async () => {
    // Deliberate asymmetry, pinned so a refactor that "harmonises" the three
    // has to do it on purpose. The FE reads completeness from GET /profile.
    mockFormat.mockResolvedValue({ niche: "n" });

    const result = await service.updateProfile(testOwner("user-1"), { niche: "n" } as never);

    expect(result).not.toHaveProperty("completeness");
  });

  it("propagates an enrichment failure instead of storing a half-written profile", async () => {
    mockFormat.mockRejectedValue(new Error("scrape timed out"));

    await expect(service.updateProfile(testOwner("user-1"), { website: "x" } as never)).rejects.toThrow(
      "scrape timed out"
    );
    expect(accountRepo.writeContext).not.toHaveBeenCalled();
  });
});

describe("UserService.createOnboardingData (fast save)", () => {
  let service: UserService;
  let repo: jest.Mocked<UserRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new UserRepository() as jest.Mocked<UserRepository>;
    service = new UserService(repo as never, channelRepo());
  });

  it("persists the raw minimum immediately WITHOUT inline enrichment", async () => {
    repo.add = jest.fn().mockResolvedValue(undefined);
    const data = { userName: "https://youtube.com/@me" } as never;

    const result = await service.createOnboardingData(testOwner("user-1"), data);

    // Fast path: saves the provided fields, never calls the (slow) enrichment.
    expect(accountRepo.writeContext).toHaveBeenCalledWith(
      TEST_ACCOUNT_ID, data);
    expect(mockFormat).not.toHaveBeenCalled();
    expect(result).toBe(data);
  });
});

// The onboarding write (`repo.add`) never stores `uid`, so a profile created that
// way came back without one. The client read a uid-less response as "no profile",
// discarded the niche/targetAudience the user had just saved, and the onboarding
// gate bounced them back to the start on every single attempt.
describe("UserService.getProfile", () => {
  let service: UserService;
  let repo: jest.Mocked<UserRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new UserRepository() as jest.Mocked<UserRepository>;
    // Identity half. getProfile merges this with the channel half below.
    repo.get = jest.fn().mockResolvedValue({});
    service = new UserService(repo as never, channelRepo());
  });

  it("always returns the uid, even when the stored doc has no uid field", async () => {
    accountRepo.getContext.mockResolvedValue({
      niche: "AI automation",
      targetAudience: "solo founders",
    });

    const result = await service.getProfile(testOwner("user-1"));

    expect(result.uid).toBe("user-1");
    // ...and the fields the user actually onboarded with survive.
    expect(result).toMatchObject({
      niche: "AI automation",
      targetAudience: "solo founders",
    });
  });

  it("returns the uid even when no document exists yet", async () => {
    accountRepo.getContext.mockResolvedValue(null);

    const result = await service.getProfile(testOwner("user-1"));

    expect(result.uid).toBe("user-1");
  });

  it("never lets a stored uid override the authenticated one", async () => {
    accountRepo.getContext.mockResolvedValue({ uid: "stale-or-wrong", niche: "x" });

    const result = await service.getProfile(testOwner("user-1"));

    expect(result.uid).toBe("user-1");
  });
});
