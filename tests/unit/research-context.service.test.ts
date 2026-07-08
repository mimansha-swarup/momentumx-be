import ResearchContextService from "../../src/service/research-context.service";
import ResearchRepository from "../../src/repository/research.repository";

jest.mock("../../src/repository/research.repository");

const MockResearchRepo = ResearchRepository as jest.MockedClass<typeof ResearchRepository>;

const video = (title: string, channelTitle = "Chan", videoId = "") => ({
  title,
  channelTitle,
  videoId: videoId || title.slice(0, 8),
});

describe("ResearchContextService", () => {
  let repo: jest.Mocked<ResearchRepository>;
  let service: ResearchContextService;

  beforeEach(() => {
    repo = new MockResearchRepo() as jest.Mocked<ResearchRepository>;
    service = new ResearchContextService(repo);
    repo.getTrendingVideos = jest.fn().mockResolvedValue([]);
    repo.getKeywordSignals = jest.fn().mockResolvedValue([]);
    repo.getVideoStats = jest.fn().mockResolvedValue({});
  });

  describe("cleanVideos", () => {
    const run = (videos: ReturnType<typeof video>[], cap = 12) =>
      service.cleanVideos(videos, new Set(), new Map(), cap);

    it("drops Shorts/livestream junk and too-short titles", () => {
      const out = run([
        video("Real long-form video title here"),
        video("My clip #shorts"),
        video("🔴 LIVE market open stream now"),
        video("short"),
      ]);
      expect(out.map((v) => v.title)).toEqual(["Real long-form video title here"]);
    });

    it("dedupes normalized titles and caps 2 per channel", () => {
      const out = run([
        video("How to invest in 2026!", "A", "v1"),
        video("HOW TO INVEST IN 2026", "B", "v2"), // dup after normalize
        video("Episode 11 of my money series", "C", "v3"),
        video("Episode 12 of my money series x", "C", "v4"),
        video("Episode 13 of my money series yz", "C", "v5"), // 3rd from C — dropped
      ]);
      expect(out.map((v) => v.videoId)).toEqual(["v1", "v3", "v4"]);
    });

    it("respects the cap", () => {
      const many = Array.from({ length: 20 }, (_, i) =>
        video(`Distinct video title number ${i} here`, `chan-${i}`)
      );
      expect(run(many, 5)).toHaveLength(5);
    });
  });

  describe("formatTitleLines / formatViews", () => {
    it("annotates titles with human view counts when stats exist", () => {
      const lines = service.formatTitleLines(
        [
          { title: "Big winner", videoId: "a" },
          { title: "No stats video", videoId: "b" },
        ],
        { a: 2_400_000 }
      );
      expect(lines).toBe("Big winner — 2.4M views\nNo stats video");
    });

    it("formats K/M/raw views", () => {
      expect(service.formatViews(999)).toBe("999 views");
      expect(service.formatViews(12_400)).toBe("12K views");
      expect(service.formatViews(1_250_000)).toBe("1.3M views");
    });
  });

  describe("getIdeaSignals — degradation contract", () => {
    it("returns a labeled block with trending and search sections", async () => {
      repo.getTrendingVideos = jest.fn().mockResolvedValue([
        video("Trending video about AI agents now", "T1", "t1"),
      ]);
      repo.getKeywordSignals = jest.fn().mockResolvedValue([
        video("What people search for in AI land", "K1", "k1"),
      ]);
      repo.getVideoStats = jest.fn().mockResolvedValue({ t1: 500_000 });

      const block = await service.getIdeaSignals("AI tools");

      expect(block).toContain("Live research signals");
      expect(block).toContain("Trending now in this niche:");
      expect(block).toContain("Trending video about AI agents now — 500K views");
      expect(block).toContain("What audiences are searching for:");
    });

    it("returns empty string when the niche is blank", async () => {
      expect(await service.getIdeaSignals("")).toBe("");
      expect(repo.getTrendingVideos).not.toHaveBeenCalled();
    });

    it("returns empty string when both fetches fail (never throws)", async () => {
      repo.getTrendingVideos = jest.fn().mockRejectedValue(new Error("quota"));
      repo.getKeywordSignals = jest.fn().mockRejectedValue(new Error("quota"));

      await expect(service.getIdeaSignals("finance")).resolves.toBe("");
    });

    it("keeps the surviving half on partial failure", async () => {
      repo.getTrendingVideos = jest.fn().mockRejectedValue(new Error("quota"));
      repo.getKeywordSignals = jest.fn().mockResolvedValue([
        video("Search-demand video that survived ok", "K1", "k1"),
      ]);

      const block = await service.getIdeaSignals("finance");
      expect(block).toContain("What audiences are searching for:");
      expect(block).not.toContain("Trending now in this niche:");
    });

    it("survives a stats fetch failure (titles without view counts)", async () => {
      repo.getTrendingVideos = jest.fn().mockResolvedValue([
        video("Trending video with no stats data", "T1", "t1"),
      ]);
      repo.getVideoStats = jest.fn().mockRejectedValue(new Error("boom"));

      const block = await service.getIdeaSignals("finance");
      expect(block).toContain("Trending video with no stats data");
      expect(block).not.toContain("views");
    });
  });
});
