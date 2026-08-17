jest.mock("../../src/config/firebase", () => ({
  db: {},
  firebase: { firestore: { FieldValue: { serverTimestamp: jest.fn() } } },
}));
jest.mock("../../src/config/ai", () => ({
  embeddingModel: { embedContent: jest.fn() },
}));

import { formatUserData } from "../../src/utlils/content";
import ExtractService from "../../src/service/extract.service";

type ExtractOverrides = Partial<Record<keyof ExtractService, unknown>>;

const makeExtract = (over: ExtractOverrides = {}) =>
  ({
    getWebsiteContent: jest.fn().mockResolvedValue("site text"),
    retrieveChannelId: jest
      .fn()
      .mockResolvedValue({ id: "chan-me", description: "My channel desc" }),
    getTopTenTitle: jest.fn().mockResolvedValue(["T1", "T2"]),
    ...over,
  }) as unknown as ExtractService;

const baseOnboarding = {
  userName: "https://youtube.com/@me",
  brandName: "B",
  niche: "N",
  targetAudience: "A",
};

describe("formatUserData", () => {
  it("preserves user description and stores the channel description separately (3.5)", async () => {
    const result = await formatUserData(
      {
        ...baseOnboarding,
        competitors: [],
        description: "User wrote this",
      } as never,
      makeExtract()
    );

    expect(result.description).toBe("User wrote this");
    expect(result.channelDescription).toBe("My channel desc");
    expect(result.channelId).toBe("chan-me");
    expect(result.userTitle).toEqual(["T1", "T2"]);
    expect(result.competitors).toEqual([]);
  });

  it("resolves the user's own channel from the URL alone, with no competitors (low-friction onboarding)", async () => {
    const extract = makeExtract();
    const result = await formatUserData(
      { ...baseOnboarding } as never, // note: no `competitors` field at all
      extract
    );

    expect(result.channelId).toBe("chan-me");
    expect(result.channelDescription).toBe("My channel desc");
    expect(result.userTitle).toEqual(["T1", "T2"]);
    expect(extract.retrieveChannelId).toHaveBeenCalledWith(baseOnboarding.userName);
    // competitors omitted → the field is left untouched (not written).
    expect(result).not.toHaveProperty("competitors");
  });

  it("does not crash and blanks nothing on a partial update with no website/competitors (#1, #2)", async () => {
    const extract = makeExtract();
    const result = await formatUserData({ niche: "finance" } as never, extract);

    expect(result).toEqual({ niche: "finance" });
    expect(result).not.toHaveProperty("channelId");
    expect(result).not.toHaveProperty("channelDescription");
    expect(result).not.toHaveProperty("userTitle");
    expect(result).not.toHaveProperty("websiteContent");
    // No source fields provided → no fetches attempted.
    expect(extract.retrieveChannelId).not.toHaveBeenCalled();
    expect(extract.getTopTenTitle).not.toHaveBeenCalled();
  });

  it("resolves competitor id + titles when competitors are provided", async () => {
    // Argument-keyed (order-independent) — the user's channel and competitors
    // resolve concurrently, so we must not depend on call sequence.
    const extract = makeExtract({
      retrieveChannelId: jest.fn().mockImplementation((url: string) =>
        url.includes("@a")
          ? { id: "chan-a", description: "" }
          : { id: "chan-me", description: "My channel desc" }
      ),
      getTopTenTitle: jest
        .fn()
        .mockImplementation((id: string) => (id === "chan-a" ? ["A1"] : ["T1", "T2"])),
    });

    const result = await formatUserData(
      { ...baseOnboarding, competitors: ["https://youtube.com/@a"] } as never,
      extract
    );

    expect(result.competitors).toEqual([
      { url: "https://youtube.com/@a", id: "chan-a", titles: ["A1"] },
    ]);
    expect(result.userTitle).toEqual(["T1", "T2"]);
    expect(result.channelDescription).toBe("My channel desc");
  });

  it("only writes websiteContent when a website was provided", async () => {
    const withSite = await formatUserData(
      { ...baseOnboarding, competitors: [], website: "https://acme.io" } as never,
      makeExtract()
    );
    expect(withSite.websiteContent).toBe("site text");

    const noSite = await formatUserData(
      { ...baseOnboarding, competitors: [] } as never,
      makeExtract()
    );
    expect(noSite).not.toHaveProperty("websiteContent");
  });
});

// A failed YouTube/website lookup used to be written out as empty strings and
// arrays. `refreshContext` re-runs this over the STORED record, so a quota
// exhaustion (100 units per search — routine) silently blanked a user's
// channelDescription, userTitle and websiteContent, and dropped their
// completeness score with it.
describe("formatUserData — a failed lookup must not blank stored enrichment", () => {
  it("omits channel fields entirely when the channel can't be resolved", async () => {
    const extract = makeExtract({
      retrieveChannelId: jest.fn().mockRejectedValue(new Error("quota exceeded")),
    });

    const result = await formatUserData({ ...baseOnboarding } as never, extract);

    // Omitted, not empty — the repository skips undefined, so the stored values survive.
    expect(result).not.toHaveProperty("channelDescription");
    expect(result).not.toHaveProperty("userTitle");
    expect(result).not.toHaveProperty("channelId");
    // The user's own fields still round-trip.
    expect(result.niche).toBe("N");
    expect(result.targetAudience).toBe("A");
  });

  it("omits websiteContent when the site fetch fails", async () => {
    const extract = makeExtract({
      getWebsiteContent: jest.fn().mockRejectedValue(new Error("timeout")),
    });

    const result = await formatUserData(
      { ...baseOnboarding, website: "https://example.com" } as never,
      extract
    );

    expect(result).not.toHaveProperty("websiteContent");
    expect(result.website).toBe("https://example.com");
  });

  it("keeps a competitor's URL even when its channel can't be resolved", async () => {
    const extract = makeExtract({
      retrieveChannelId: jest.fn().mockRejectedValue(new Error("quota exceeded")),
    });

    const result = await formatUserData(
      { ...baseOnboarding, competitors: ["https://youtube.com/@rival"] } as never,
      extract
    );

    expect(result.competitors).toEqual([
      { url: "https://youtube.com/@rival", id: "", titles: [] },
    ]);
  });
});
