import { Request, Response } from "express";
import TitleIntelligenceService from "../service/title-intelligence.service.js";
import { GenerateSmartTitlesBody } from "../types/routes/title-intelligence.js";

class TitleIntelligenceController {
  constructor(private service: TitleIntelligenceService) {}

  generate = async (req: Request, res: Response) => {
    try {
      const { idea, script } = req.body as GenerateSmartTitlesBody;

      if (!idea && !script) {
        return res.sendError({
          message: "At least one of 'idea' or 'script' is required",
          statusCode: 400,
        });
      }

      const { result, timings } = await this.service.generate(idea ?? "", script ?? "");
      res.sendSuccess({ data: result, meta: { timings }, statusCode: 200 });
    } catch (error) {
      res.sendError({ message: "Failed to generate smart titles", detail: error });
    }
  };
}

export default TitleIntelligenceController;
