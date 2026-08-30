import { DEFAULT_NICHE } from "../constants/research.js";
import { BadRequest } from "../utlils/errors.js";
class ResearchService {
    constructor(repo, accounts) {
        this.repo = repo;
        this.accounts = accounts;
        this.getTrending = async (owner) => {
            // The CHANNEL's niche. Read from the user record, trending for the finance
            // channel came back full of cooking videos.
            const context = await this.accounts.getContext(owner.accountId);
            const niche = context?.niche || DEFAULT_NICHE;
            return this.repo.getTrendingVideos(niche);
        };
        this.getCompetitorInsights = async (owner) => {
            const context = await this.accounts.getContext(owner.accountId);
            const competitors = context?.competitors || [];
            const withChannelId = competitors.filter((c) => c.id);
            const results = await Promise.allSettled(withChannelId.map((c) => this.repo.getChannelTopVideos(c.id)));
            return withChannelId.map((c, idx) => {
                const result = results[idx];
                return {
                    channelTitle: c.url,
                    titles: result.status === "fulfilled" ? result.value : [],
                };
            });
        };
        this.getKeywords = async (query) => {
            if (!query || query.trim() === "") {
                throw BadRequest("query is required");
            }
            return this.repo.getKeywordSignals(query);
        };
    }
}
export default ResearchService;
