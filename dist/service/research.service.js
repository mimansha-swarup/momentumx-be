import { BadRequest } from "../utlils/errors.js";
class ResearchService {
    constructor(repo, accounts) {
        this.repo = repo;
        this.accounts = accounts;
        this.getTrending = async (owner) => {
            // The CHANNEL's niche. Read from the user record, trending for the finance
            // channel came back full of cooking videos.
            const context = await this.accounts.getContext(owner.accountId);
            const niche = context?.niche?.trim();
            if (!niche)
                throw BadRequest("Set this channel's niche before requesting trending videos");
            return this.repo.getTrendingVideos(niche);
        };
        this.getCompetitorInsights = async (owner) => {
            const context = await this.accounts.getContext(owner.accountId);
            const competitors = context?.competitors || [];
            const withChannelId = competitors.filter((c) => c.id);
            return Promise.all(withChannelId.map(async (c) => {
                const [name, videos] = await Promise.allSettled([
                    this.repo.getChannelTitle(c.id),
                    this.repo.getChannelTopVideos(c.id),
                ]);
                return {
                    channelTitle: name.status === "fulfilled" && name.value ? name.value : "Unknown channel",
                    titles: videos.status === "fulfilled" ? videos.value : [],
                };
            }));
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
