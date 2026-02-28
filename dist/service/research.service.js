class ResearchService {
    constructor(repo, userRepo) {
        this.repo = repo;
        this.userRepo = userRepo;
        this.getTrending = async (userId) => {
            const userRecord = await this.userRepo.get(userId);
            if (!userRecord?.niche) {
                const err = new Error("User niche not set — complete onboarding first");
                err.statusCode = 400;
                throw err;
            }
            return this.repo.getTrendingVideos(userRecord.niche);
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
                const err = new Error("query is required");
                err.statusCode = 400;
                throw err;
            }
            return this.repo.getKeywordSignals(query);
        };
    }
}
export default ResearchService;
