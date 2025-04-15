import { NextFunction, Request, Response } from "express";
import ContentService from "../service/content.service";
import UserService from "../service/user.service";
import { randomUUID } from "crypto";

class ContentController {
  private service: ContentService;

  constructor(service: ContentService) {
    this.service = service;
  }

  generateTopics = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.generateTopics(req.userId);
      const modifiedData = (data?.items || []).map((title: string) => ({
        id: randomUUID(),
        title: title,
        createdBy: req.userId,
        createdAt: new Date(),
      }));

      if (!modifiedData?.length) {
        throw new Error("Unable to generate at the moment");
      }
      this.service.saveTopics(req.userId, modifiedData);
      res.sendSuccess({
        message: "Titles generated successfully",
        data: modifiedData,
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
