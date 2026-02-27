import { NextFunction, Request, Response } from "express";
import VideoProjectService from "../service/video-project.service.js";
import { ICreateVideoProjectBody, ILinkResourceBody, IUpdateVideoProjectBody } from "../types/routes/video-project.js";

class VideoProjectController {
  constructor(private service: VideoProjectService) {}

  private handleError = (
    error: unknown,
    res: Response,
    next: NextFunction
  ): void => {
    const err = error as Error & { statusCode?: number };
    if (err.message === "Not found") {
      res.sendError({ message: "Not found", statusCode: 404 });
    } else if (err.message === "Forbidden") {
      res.sendError({ message: "Forbidden", statusCode: 403 });
    } else if (err.statusCode) {
      res.sendError({ message: err.message, statusCode: err.statusCode });
    } else {
      next(error);
    }
  };

  create = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { topicId } = req.body as ICreateVideoProjectBody;
      if (!topicId) {
        return res.sendError({ message: "topicId is required", statusCode: 400 });
      }
      const data = await this.service.create(req.userId, topicId);
      res.sendSuccess({ data, message: "Video project created successfully", statusCode: 201 });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };

  list = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, limit, cursor } = req.query as {
        status?: string;
        limit?: string;
        cursor?: string;
      };
      const data = await this.service.list(req.userId, {
        status: status as "in_progress" | "completed" | "stale" | undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        cursor,
      });
      res.sendSuccess({ data, message: "Video projects retrieved successfully" });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };

  getById = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { projectId } = req.params;
      const data = await this.service.getById(projectId, req.userId);
      res.sendSuccess({ data, message: "Video project retrieved successfully" });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };

  update = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { projectId } = req.params;
      const { workingTitle } = req.body as IUpdateVideoProjectBody;
      const data = await this.service.update(projectId, req.userId, { workingTitle });
      res.sendSuccess({ data, message: "Video project updated successfully" });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };

  delete = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { projectId } = req.params;
      const data = await this.service.delete(projectId, req.userId);
      res.sendSuccess({ data, message: "Video project deleted successfully" });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };

  startStep = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { projectId, stepName } = req.params;
      const data = await this.service.startStep(projectId, stepName, req.userId);
      res.sendSuccess({ data, message: "Step started successfully" });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };

  completeStep = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { projectId, stepName } = req.params;
      const data = await this.service.completeStep(projectId, stepName, req.userId);
      res.sendSuccess({ data, message: "Step completed successfully" });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };

  linkResource = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { projectId, resourceType } = req.params;
      const { resourceId } = req.body as ILinkResourceBody;
      if (!resourceId) {
        return res.sendError({ message: "resourceId is required", statusCode: 400 });
      }
      const data = await this.service.linkResource(projectId, resourceType, resourceId, req.userId);
      res.sendSuccess({ data, message: "Resource linked successfully" });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };
}

export default VideoProjectController;
