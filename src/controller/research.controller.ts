import { NextFunction, Request, Response } from "express";
import ResearchService from "../service/research.service.js";

class ResearchController {
  constructor(private service: ResearchService) {}

  private handleError = (
    error: unknown,
    res: Response,
    next: NextFunction,
  ): void => {
    const err = error as Error & { statusCode?: number };
    if (err.statusCode) {
      res.sendError({ message: err.message, statusCode: err.statusCode });
    } else {
      next(error);
    }
  };

  getTrending = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getTrending(req.userId);
      res.sendSuccess({ message: "Trending videos retrieved successfully", data });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };

  getCompetitors = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getCompetitorInsights(req.userId);
      res.sendSuccess({ message: "Competitor insights retrieved successfully", data });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };

  getKeywords = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { query } = req.query as { query?: string };
      const data = await this.service.getKeywords(query || "");
      res.sendSuccess({ message: "Keyword signals retrieved successfully", data });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };
}

export default ResearchController;
