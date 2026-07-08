import { computeProfileCompleteness } from "../../src/utlils/profile";

const CORE = {
  niche: "AI tools",
  targetAudience: "founders",
  brandName: "MomentumX",
  userName: "https://youtube.com/@momentumx",
};

const ENRICHMENT = {
  website: "https://momentumx.io",
  competitors: [{ url: "https://youtube.com/@a" }],
  userTitle: ["Top video"],
  channelDescription: "A channel about AI",
};

describe("computeProfileCompleteness", () => {
  it("scores 0 with all fields missing (undefined/null/empty record)", () => {
    for (const record of [undefined, null, {}]) {
      const result = computeProfileCompleteness(record as never);
      expect(result.score).toBe(0);
      expect(result.missing).toHaveLength(8);
    }
  });

  it("scores 100 with every field filled and reports nothing missing", () => {
    const result = computeProfileCompleteness({ ...CORE, ...ENRICHMENT } as never);
    expect(result.score).toBe(100);
    expect(result.missing).toEqual([]);
  });

  it("scores 60 for core identity only, listing the missing enrichment", () => {
    const result = computeProfileCompleteness(CORE as never);
    expect(result.score).toBe(60);
    expect(result.missing).toEqual([
      "website",
      "competitors",
      "userTitle",
      "channelDescription",
    ]);
  });

  it("treats whitespace-only strings and empty arrays as unfilled", () => {
    const result = computeProfileCompleteness({
      ...CORE,
      niche: "   ",
      competitors: [],
      userTitle: [],
    } as never);
    // niche drops (-15); competitors/userTitle empty are already enrichment-missing.
    expect(result.score).toBe(45);
    expect(result.missing).toContain("niche");
    expect(result.missing).toContain("competitors");
  });

  it("weights core identity fields at 15 and enrichment at 10", () => {
    expect(computeProfileCompleteness({ niche: "x" } as never).score).toBe(15);
    expect(computeProfileCompleteness({ website: "https://x.io" } as never).score).toBe(10);
  });
});
