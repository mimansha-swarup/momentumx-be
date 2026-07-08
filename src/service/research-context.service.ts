import ResearchRepository from "../repository/research.repository.js";

interface IResearchVideo {
  title: string;
  channelTitle: string;
  videoId: string;
}

/**
 * Research grounding engine (phase 2A) — extracted from the title-intelligence
 * pipelines so Idea generation (and later the Title step) can ground output in
 * live YouTube signals.
 *
 * Degradation contract: research is an ENHANCER, never a gate. Any YouTube
 * failure (quota, outage) yields an empty signals block and generation
 * proceeds on channel context alone.
 */
class ResearchContextService {
  constructor(private researchRepo: ResearchRepository) {}

  // The research pool decides what the model imitates — spam in, spam out.
  // Drop Shorts/livestream junk, collapse duplicates, limit each channel to 2
  // titles (kills "EPISODE #11 / #12 / #13" series spam), and cap the list.
  // `seen` and `channelCounts` are shared across lists so the keyword list
  // can't re-introduce trending entries.
  cleanVideos = <T extends { title: string; channelTitle: string }>(
    videos: T[],
    seen: Set<string>,
    channelCounts: Map<string, number>,
    cap: number
  ): T[] => {
    const isJunk = (t: string): boolean =>
      /#shorts?\b/i.test(t) || /🔴|\bLIVE\b/.test(t) || t.trim().length < 15;
    const normalize = (t: string): string =>
      t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

    const out: T[] = [];
    for (const video of videos) {
      if (out.length >= cap) break;
      if (isJunk(video.title)) continue;
      const key = normalize(video.title);
      if (!key || seen.has(key)) continue;
      const channelCount = channelCounts.get(video.channelTitle) ?? 0;
      if (channelCount >= 2) continue;
      seen.add(key);
      channelCounts.set(video.channelTitle, channelCount + 1);
      out.push(video);
    }
    return out;
  };

  // "1.2M views" tells the model which titles actually earned clicks — without
  // it, a 2M-view winner and a 3K-view also-ran read as equals.
  formatViews = (views: number): string => {
    if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1)}M views`;
    if (views >= 1_000) return `${Math.round(views / 1_000)}K views`;
    return `${views} views`;
  };

  formatTitleLines = (
    videos: { title: string; videoId: string }[],
    stats: Record<string, number>
  ): string =>
    videos
      .map((v) => {
        const views = stats[v.videoId];
        return views ? `${v.title} — ${this.formatViews(views)}` : v.title;
      })
      .join("\n");

  /**
   * Live signals block for Idea generation, keyed on the creator's niche.
   * Returns "" when nothing usable could be fetched — callers inject the
   * block as-is and generation degrades gracefully.
   */
  getIdeaSignals = async (niche: string): Promise<string> => {
    if (!niche?.trim()) return "";
    try {
      const [trendingResult, keywordResult] = await Promise.allSettled([
        this.researchRepo.getTrendingVideos(niche),
        this.researchRepo.getKeywordSignals(niche),
      ]);
      const trending: IResearchVideo[] =
        trendingResult.status === "fulfilled" ? trendingResult.value : [];
      const keyword: IResearchVideo[] =
        keywordResult.status === "fulfilled" ? keywordResult.value : [];

      const seen = new Set<string>();
      const channelCounts = new Map<string, number>();
      const cleanTrending = this.cleanVideos(trending, seen, channelCounts, 12);
      const cleanKeyword = this.cleanVideos(keyword, seen, channelCounts, 12);
      if (cleanTrending.length === 0 && cleanKeyword.length === 0) return "";

      let stats: Record<string, number> = {};
      try {
        stats = await this.researchRepo.getVideoStats(
          [...cleanTrending, ...cleanKeyword].map((v) => v.videoId)
        );
      } catch {
        stats = {}; // titles without view counts still carry signal
      }

      const sections: string[] = [
        "Live research signals (ground ideas in these and cite the relevant signal in each idea's evidence):",
      ];
      if (cleanTrending.length) {
        sections.push(
          `Trending now in this niche:\n${this.formatTitleLines(cleanTrending, stats)}`
        );
      }
      if (cleanKeyword.length) {
        sections.push(
          `What audiences are searching for:\n${this.formatTitleLines(cleanKeyword, stats)}`
        );
      }
      return sections.join("\n\n");
    } catch {
      return ""; // research must never block generation
    }
  };
}

export default ResearchContextService;
