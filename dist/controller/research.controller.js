import { asyncHandler } from "../middleware/async_handler.js";
class ResearchController {
    constructor(service) {
        this.service = service;
        this.getTrending = asyncHandler(async (req, res) => {
            const data = await this.service.getTrending(req.userId);
            res.sendSuccess({ message: "Trending videos retrieved successfully", data });
        });
        this.getCompetitors = asyncHandler(async (req, res) => {
            const data = await this.service.getCompetitorInsights(req.userId);
            res.sendSuccess({ message: "Competitor insights retrieved successfully", data });
        });
        this.getKeywords = asyncHandler(async (req, res) => {
            const { query } = req.query;
            const data = await this.service.getKeywords(query || "");
            res.sendSuccess({ message: "Keyword signals retrieved successfully", data });
        });
    }
}
export default ResearchController;
