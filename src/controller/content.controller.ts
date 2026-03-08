import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";
import ContentService from "../service/content.service.js";
import { formatGeneratedTitle } from "../utlils/content.js";
import { firebase } from "../config/firebase.js";

class ContentController {
  private service: ContentService;

  constructor(service: ContentService) {
    this.service = service;
  }

  private handleError = (
    error: unknown,
    res: Response,
    next: NextFunction,
  ): void => {
    const err = error as Error & { statusCode?: number };
    if (err.message === "Forbidden") {
      res.sendError({ message: "Forbidden", statusCode: 403 });
    } else if (err.message === "Topic not found") {
      res.sendError({ message: "Topic not found", statusCode: 404 });
    } else if (err.statusCode) {
      res.sendError({ message: err.message, statusCode: err.statusCode });
    } else {
      next(error);
    }
  };

  retrieveTopics = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        limit = "9",
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
      const batchId = randomUUID();
      const modifiedDataResults = await Promise.allSettled(
        (data || [])?.map(async (record) =>
          formatGeneratedTitle(record, req.userId, batchId),
        ),
      );
      // Filter out failed ones, keep only successful
      const modifiedData = modifiedDataResults
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);

      if (!modifiedData?.length) {
        throw new Error("Unable to generate at the moment");
      }
      const updatedData = await this.service.saveBatchTopics(modifiedData);
      res.sendSuccess({
        message: "successfully generated topics",
        data: updatedData,
      });
    } catch (e) {
      console.log("e: ", e);
      next(e);
    }
  };

  editTopic = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const topicId = req.params.topicId;
      await this.service.editTopics(topicId, req.userId, req.body);
      res.sendSuccess({
        message: "Title updated successfully",
        data: { ...req.body, id: topicId },
      });
    } catch (error) {
      next(error);
    }
  };

  editScript = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scriptId = req.params.scriptId;
      await this.service.editScript(scriptId, req.userId, req.body);
      res.sendSuccess({
        message: "Title updated successfully",
        data: { ...req.body, scriptId },
      });
    } catch (error) {
      next(error);
    }
  };

  regenerateAll = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.regenerateAll(req.userId);
      res.sendSuccess({ message: "Topics regenerated successfully", data });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };

  regenerateOne = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.regenerateOne(req.userId, req.params.topicId);
      res.sendSuccess({ message: "Topic regenerated successfully", data });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };

  updateFeedback = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { feedback } = req.body as { feedback: "like" | "dislike" | null };
      const data = await this.service.updateFeedback(req.userId, req.params.topicId, feedback);
      res.sendSuccess({ message: "Feedback updated successfully", data });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };

  exportTopics = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.exportTopics(req.userId);
      res.sendSuccess({ message: "Topics exported successfully", data });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };

  updateScriptFeedback = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { scriptId } = req.params;
      const { feedback } = req.body as { feedback: "like" | "dislike" | null };
      if (feedback === undefined) {
        return res.sendError({ message: "feedback is required", statusCode: 400 });
      }
      const data = await this.service.updateScriptFeedback(req.userId, scriptId, feedback);
      res.sendSuccess({ message: "Script feedback updated", data });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };

  exportScript = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { scriptId } = req.params;
      const data = await this.service.exportScript(req.userId, scriptId);
      res.sendSuccess({ message: "Script exported successfully", data });
    } catch (error) {
      this.handleError(error, res, next);
    }
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
    next: NextFunction,
  ) => {
    try {
      const data = await this.service.getScriptById(req.params.scriptId, req.userId);
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
