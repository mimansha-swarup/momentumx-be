import { Request, Response } from "express";
import ResearchService from "../service/research.service.js";
import { asyncHandler } from "../middleware/async_handler.js";

class ResearchController {
  constructor(private service: ResearchService) {}

  getTrending = asyncHandler(async (req: Request, res: Response) => {
    const data = await this.service.getTrending(req.userId);
    res.sendSuccess({ message: "Trending videos retrieved successfully", data });
  });

  getCompetitors = asyncHandler(async (req: Request, res: Response) => {
    const data = await this.service.getCompetitorInsights(req.userId);
    res.sendSuccess({ message: "Competitor insights retrieved successfully", data });
  });

  getKeywords = asyncHandler(async (req: Request, res: Response) => {
    const { query } = req.query as { query?: string };
    const data = await this.service.getKeywords(query || "");
    res.sendSuccess({ message: "Keyword signals retrieved successfully", data });
  });
}

export default ResearchController;
