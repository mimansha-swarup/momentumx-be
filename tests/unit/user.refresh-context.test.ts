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

import UserService from "../../src/service/user.service";
import UserRepository from "../../src/repository/user.repository";
import { formatUserData } from "../../src/utlils/content";

const mockFormat = formatUserData as jest.Mock;

describe("UserService.refreshContext", () => {
  let service: UserService;
  let repo: jest.Mocked<UserRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new UserRepository() as jest.Mocked<UserRepository>;
    service = new UserService(repo as never);
  });

  it("re-runs enrichment from stored inputs, mapping competitors back to URLs", async () => {
    repo.get = jest.fn().mockResolvedValue({
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

    const result = await service.refreshContext("user-1");

    // Stored competitor objects are re-flattened to URL strings for formatUserData.
    const input = mockFormat.mock.calls[0][0];
    expect(input.competitors).toEqual([
      "https://youtube.com/@a",
      "https://youtube.com/@b",
    ]);
    expect(repo.update).toHaveBeenCalledTimes(1);
    // The refreshed record is returned with a computed completeness score.
    expect(result.completeness.score).toBeGreaterThan(0);
  });

  it("404s when the user record is missing", async () => {
    repo.get = jest.fn().mockResolvedValue(undefined);
    await expect(service.refreshContext("user-1")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("tolerates competitors stored as raw URL strings (fresh, pre-enrichment)", async () => {
    repo.get = jest.fn().mockResolvedValue({
      userName: "https://youtube.com/@me",
      competitors: ["https://youtube.com/@a", "https://youtube.com/@b"],
    });
    repo.update = jest.fn().mockResolvedValue(undefined);
    mockFormat.mockResolvedValue({ userName: "https://youtube.com/@me" });

    await service.refreshContext("user-1");

    const input = mockFormat.mock.calls[0][0];
    expect(input.competitors).toEqual([
      "https://youtube.com/@a",
      "https://youtube.com/@b",
    ]);
  });
});

describe("UserService.createOnboardingData (fast save)", () => {
  let service: UserService;
  let repo: jest.Mocked<UserRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new UserRepository() as jest.Mocked<UserRepository>;
    service = new UserService(repo as never);
  });

  it("persists the raw minimum immediately WITHOUT inline enrichment", async () => {
    repo.add = jest.fn().mockResolvedValue(undefined);
    const data = { userName: "https://youtube.com/@me" } as never;

    const result = await service.createOnboardingData("user-1", data);

    // Fast path: saves the provided fields, never calls the (slow) enrichment.
    expect(repo.add).toHaveBeenCalledWith("user-1", data);
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
    service = new UserService(repo as never);
  });

  it("always returns the uid, even when the stored doc has no uid field", async () => {
    repo.get = jest.fn().mockResolvedValue({
      niche: "AI automation",
      targetAudience: "solo founders",
    });

    const result = await service.getProfile("user-1");

    expect(result.uid).toBe("user-1");
    // ...and the fields the user actually onboarded with survive.
    expect(result).toMatchObject({
      niche: "AI automation",
      targetAudience: "solo founders",
    });
  });

  it("returns the uid even when no document exists yet", async () => {
    repo.get = jest.fn().mockResolvedValue(null);

    const result = await service.getProfile("user-1");

    expect(result.uid).toBe("user-1");
  });

  it("never lets a stored uid override the authenticated one", async () => {
    repo.get = jest.fn().mockResolvedValue({ uid: "stale-or-wrong", niche: "x" });

    const result = await service.getProfile("user-1");

    expect(result.uid).toBe("user-1");
  });
});
