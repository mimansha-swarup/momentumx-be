import { DEFAULT_NICHE } from "../constants/research.js";
import { BadRequest } from "../utlils/errors.js";
class ResearchService {
    constructor(repo, userRepo) {
        this.repo = repo;
        this.userRepo = userRepo;
        this.getTrending = async (userId) => {
            const userRecord = await this.userRepo.get(userId);
            const niche = userRecord?.niche || DEFAULT_NICHE;
            return this.repo.getTrendingVideos(niche);
        };
        this.getCompetitorInsights = async (userId) => {
            const userRecord = await this.userRepo.get(userId);
            const competitors = userRecord?.competitors || [];
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
