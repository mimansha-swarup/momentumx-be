import ResearchRepository, {
  KeywordSignal,
  TrendingVideo,
} from "../repository/research.repository.js";
import AccountRepository from "../repository/account.repository.js";
import { RecordOwner } from "../utlils/content.js";
import { DEFAULT_NICHE } from "../constants/research.js";
import { BadRequest } from "../utlils/errors.js";

export type { TrendingVideo, KeywordSignal };

export interface CompetitorInsight {
  channelTitle: string;
  titles: string[];
}

class ResearchService {
  constructor(
    private repo: ResearchRepository,
    private accounts: AccountRepository,
  ) {}

  getTrending = async (owner: RecordOwner): Promise<TrendingVideo[]> => {
    // The CHANNEL's niche. Read from the user record, trending for the finance
    // channel came back full of cooking videos.
    const context = await this.accounts.getContext(owner.accountId);
    const niche = context?.niche || DEFAULT_NICHE;

    return this.repo.getTrendingVideos(niche);
  };

  getCompetitorInsights = async (owner: RecordOwner): Promise<CompetitorInsight[]> => {
    const context = await this.accounts.getContext(owner.accountId);
    const competitors: { id: string; url: string }[] =
      (context?.competitors as { id: string; url: string }[]) || [];

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
      throw BadRequest("query is required");
    }

    return this.repo.getKeywordSignals(query);
  };
}

export default ResearchService;
