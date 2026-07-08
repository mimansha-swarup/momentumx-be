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
