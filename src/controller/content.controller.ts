import { NextFunction, Request, Response } from "express";
import ContentService from "../service/content.service.js";
import {
  formatGeneratedTitle,
} from "../utlils/content.js";
import { firebase } from "../config/firebase.js";

class ContentController {
  private service: ContentService;

  constructor(service: ContentService) {
    this.service = service;
  }

  retrieveTopics = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        limit = "10",
        createdAt = "",
        docId = "",
        searchText = "",
        isScriptGenerated = "",
      } = req.query;
      const cursor = {
        createdAt: createdAt as string,
        docId: docId as string,
      };
      const filters = {
        searchText: searchText as string,
        isScriptGenerated: Boolean(isScriptGenerated),
      };

      const data = await this.service.getPaginatedUsersTopics({
        userId: req.userId,
        limit: parseInt(limit as string, 10),
        cursor,
        filters,
      });

      res.sendSuccess({
        message: "successfully retrieved topics",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  retrieveScripts = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getUsersScript(req.userId);
      res.sendSuccess({
        message: "successfully retrieved scripts",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  generateTopics = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.generateTopics(req.userId);
      const modifiedData = (data || [])?.map((record) =>
        formatGeneratedTitle(record, req.userId)
      );

      if (!modifiedData?.length) {
        throw new Error("Unable to generate at the moment");
      }
      const updatedData = this.service.saveBatchTopics(modifiedData);
      res.sendSuccess({
        message: "successfully generated topics",
        data: updatedData,
      });
    } catch (e) {
      console.log("e: ", e);
      next(e);
    }
  };

  editTopic = async (req: Request, res: Response) => {
    const topicId = req.params.scriptId;
    await this.service.editTopics(topicId, req.body);
    res.sendSuccess({
      message: "Title updated successfully",
      data: req.body,
    });
  };

  generateScript = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.query.token || "";
      const scriptId = req.params.scriptId;
      if (!token) {
        return res.sendError({ message: "Unauthorized" });
      }

      const decodedToken = await firebase.auth().verifyIdToken(token as string);
      const uid = decodedToken.uid;
      await this.service.generateScripts(uid, scriptId, res);
    } catch (error) {
      next(error);
    }
  };

  retrieveScriptById = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const data = await this.service.getScriptById(req.params.scriptId);
      res.sendSuccess({
        message: "successfully retrieved script",
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}

export default ContentController;
