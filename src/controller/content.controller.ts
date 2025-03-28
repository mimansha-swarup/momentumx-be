import { NextFunction, Request, Response } from "express";
import ContentService from "../service/content.service";

class ContentController {
  private service: ContentService;

  constructor(service: ContentService) {
    this.service = service;
  }

  generateTopics = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.generateTopics(req.userId, req.body);

      res.sendSuccess({
        message: "User updated successfully",
        data,
      });
    } catch (e) {
      next(e);
    }
  };

  retrieveTopics = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getUsersTopic(req.userId);
      res.sendSuccess({
        message: "successfully retrieved topics",
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}

export default ContentController;
