class ResearchController {
    constructor(service) {
        this.service = service;
        this.handleError = (error, res, next) => {
            const err = error;
            if (err.statusCode) {
                res.sendError({ message: err.message, statusCode: err.statusCode });
            }
            else {
                next(error);
            }
        };
        this.getTrending = async (req, res, next) => {
            try {
                const data = await this.service.getTrending(req.userId);
                res.sendSuccess({ message: "Trending videos retrieved successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.getCompetitors = async (req, res, next) => {
            try {
                const data = await this.service.getCompetitorInsights(req.userId);
                res.sendSuccess({ message: "Competitor insights retrieved successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.getKeywords = async (req, res, next) => {
            try {
                const { query } = req.query;
                const data = await this.service.getKeywords(query || "");
                res.sendSuccess({ message: "Keyword signals retrieved successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
    }
}
export default ResearchController;
