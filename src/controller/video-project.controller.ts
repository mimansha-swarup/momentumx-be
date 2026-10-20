import { publicProject } from "../utlils/public-response.js";
import { Request, Response } from "express";
import VideoProjectService from "../service/video-project.service.js";
import { ICreateVideoProjectBody, ILinkResourceBody, IUpdateVideoProjectBody } from "../types/routes/video-project.js";
import { asyncHandler } from "../middleware/async_handler.js";
import { ownerOf } from "../utlils/content.js";
import { BadRequest } from "../utlils/errors.js";
import { parseListLimit, PROJECTS_PAGE } from "../utlils/pagination.js";
import { eventService } from "../service/event.service.js";
import { EventType } from "../types/routes/event.js";

class VideoProjectController {
  constructor(private service: VideoProjectService) {}

  create = asyncHandler(async (req: Request, res: Response) => {
    const { ideaId, title } = req.body as ICreateVideoProjectBody;
    if (Boolean(ideaId) === Boolean(title)) {
      throw BadRequest("Provide exactly one of ideaId or title");
    }
    const data = ideaId
      ? await this.service.create(ownerOf(req), ideaId)
      : await this.service.createFromTitle(ownerOf(req), title as string);
    eventService.capture(ownerOf(req), EventType.PROJECT_CREATED, {
      projectId: (data as { id?: string }).id,
      ideaId,
      title,
    });
    res.sendSuccess({ data: publicProject(data), message: "Video project created successfully", statusCode: 201 });
  });

  list = asyncHandler(async (req: Request, res: Response) => {
    const { status, limit, cursor } = req.query as {
      status?: string;
      limit?: string;
      cursor?: string;
    };
    const data = await this.service.list(ownerOf(req), {
      status: status as "in_progress" | "completed" | "stale" | undefined,
      limit: parseListLimit(limit, PROJECTS_PAGE),
      cursor,
    });
    res.sendSuccess({ data: { ...data, projects: data.projects.map(publicProject) }, message: "Video projects retrieved successfully" });
  });

  getById = asyncHandler(async (req: Request, res: Response) => {
    const { projectId } = req.params;
    // A viewer reads the repaired view but does not persist it — see
    // `getReconciledById`. This route has no role gate by design (reads are open
    // to every member), so the distinction has to be made here.
    const data = await this.service.getReconciledById(projectId, ownerOf(req), req.role !== "viewer");
    res.sendSuccess({ data: publicProject(data), message: "Video project retrieved successfully" });
  });

  update = asyncHandler(async (req: Request, res: Response) => {
    const { projectId } = req.params;
    const { title } = req.body as IUpdateVideoProjectBody;
    const data = await this.service.update(projectId, ownerOf(req), { title });
    res.sendSuccess({ data, message: "Video project updated successfully" });
  });

  delete = asyncHandler(async (req: Request, res: Response) => {
    const { projectId } = req.params;
    const data = await this.service.delete(projectId, ownerOf(req));
    res.sendSuccess({ data: { id: data.id, isDeleted: data.isDeleted }, message: "Video project deleted successfully" });
  });

  // startStep has no route: the generation endpoints (script stream, hooks
  // generate, packaging save) own the in_progress transition server-side.
  completeStep = asyncHandler(async (req: Request, res: Response) => {
    const { projectId, stepName } = req.params;
    const data = await this.service.completeStep(projectId, stepName, ownerOf(req));
    res.sendSuccess({ data, message: "Step completed successfully" });
  });

  linkResource = asyncHandler(async (req: Request, res: Response) => {
    const { projectId, resourceType } = req.params;
    const { resourceId } = req.body as ILinkResourceBody;
    if (!resourceId) {
      throw BadRequest("resourceId is required");
    }
    const data = await this.service.linkResource(projectId, resourceType, resourceId, ownerOf(req));
    res.sendSuccess({ data, message: "Resource linked successfully" });
  });
}

export default VideoProjectController;
