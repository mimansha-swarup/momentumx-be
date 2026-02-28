import ResearchRepository, {
  KeywordSignal,
  TrendingVideo,
} from "../repository/research.repository.js";
import UserRepository from "../repository/user.repository.js";

export type { TrendingVideo, KeywordSignal };

export interface CompetitorInsight {
  channelTitle: string;
  titles: string[];
}

class ResearchService {
  constructor(
    private repo: ResearchRepository,
    private userRepo: UserRepository,
  ) {}

  getTrending = async (userId: string): Promise<TrendingVideo[]> => {
    const userRecord = await this.userRepo.get(userId);
    if (!userRecord?.niche) {
      const err = new Error("User niche not set — complete onboarding first") as Error & {
        statusCode: number;
      };
      err.statusCode = 400;
      throw err;
    }

    return this.repo.getTrendingVideos(userRecord.niche);
  };

  getCompetitorInsights = async (userId: string): Promise<CompetitorInsight[]> => {
    const userRecord = await this.userRepo.get(userId);
    const competitors: { id: string; url: string }[] = userRecord?.competitors || [];

    const withChannelId = competitors.filter((c) => c.id);

    const results = await Promise.allSettled(
      withChannelId.map((c) => this.repo.getChannelTopVideos(c.id)),
    );

    return withChannelId.map((c, idx) => {
      const result = results[idx];
      return {
        channelTitle: c.url,
        titles: result.status === "fulfilled" ? result.value : [],
      };
    });
  };

  getKeywords = async (query: string): Promise<KeywordSignal[]> => {
    if (!query || query.trim() === "") {
      const err = new Error("query is required") as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }

    return this.repo.getKeywordSignals(query);
  };
}

export default ResearchService;
