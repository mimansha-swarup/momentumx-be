import { Request, Response } from "express";
import VideoProjectService from "../service/video-project.service.js";
import { ICreateVideoProjectBody, ILinkResourceBody, IUpdateVideoProjectBody } from "../types/routes/video-project.js";
import { asyncHandler } from "../middleware/async_handler.js";
import { BadRequest } from "../utlils/errors.js";

class VideoProjectController {
  constructor(private service: VideoProjectService) {}

  create = asyncHandler(async (req: Request, res: Response) => {
    const { topicId, title } = req.body as ICreateVideoProjectBody;
    if (Boolean(topicId) === Boolean(title)) {
      throw BadRequest("Provide exactly one of topicId or title");
    }
    const data = topicId
      ? await this.service.create(req.userId, topicId)
      : await this.service.createFromTitle(req.userId, title as string);
    res.sendSuccess({ data, message: "Video project created successfully", statusCode: 201 });
  });

  list = asyncHandler(async (req: Request, res: Response) => {
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
  });

  getById = asyncHandler(async (req: Request, res: Response) => {
    const { projectId } = req.params;
    const data = await this.service.getReconciledById(projectId, req.userId);
    res.sendSuccess({ data, message: "Video project retrieved successfully" });
  });

  update = asyncHandler(async (req: Request, res: Response) => {
    const { projectId } = req.params;
    const { title } = req.body as IUpdateVideoProjectBody;
    const data = await this.service.update(projectId, req.userId, { title });
    res.sendSuccess({ data, message: "Video project updated successfully" });
  });

  delete = asyncHandler(async (req: Request, res: Response) => {
    const { projectId } = req.params;
    const data = await this.service.delete(projectId, req.userId);
    res.sendSuccess({ data, message: "Video project deleted successfully" });
  });

  startStep = asyncHandler(async (req: Request, res: Response) => {
    const { projectId, stepName } = req.params;
    const data = await this.service.startStep(projectId, stepName, req.userId);
    res.sendSuccess({ data, message: "Step started successfully" });
  });

  completeStep = asyncHandler(async (req: Request, res: Response) => {
    const { projectId, stepName } = req.params;
    const data = await this.service.completeStep(projectId, stepName, req.userId);
    res.sendSuccess({ data, message: "Step completed successfully" });
  });

  linkResource = asyncHandler(async (req: Request, res: Response) => {
    const { projectId, resourceType } = req.params;
    const { resourceId } = req.body as ILinkResourceBody;
    if (!resourceId) {
      throw BadRequest("resourceId is required");
    }
    const data = await this.service.linkResource(projectId, resourceType, resourceId, req.userId);
    res.sendSuccess({ data, message: "Resource linked successfully" });
  });
}

export default VideoProjectController;
