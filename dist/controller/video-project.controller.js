import { asyncHandler } from "../middleware/async_handler.js";
import { ownerOf } from "../utlils/content.js";
import { BadRequest } from "../utlils/errors.js";
import { parseListLimit, PROJECTS_PAGE } from "../utlils/pagination.js";
import { eventService } from "../service/event.service.js";
class VideoProjectController {
    constructor(service) {
        this.service = service;
        this.create = asyncHandler(async (req, res) => {
            const { ideaId, title } = req.body;
            if (Boolean(ideaId) === Boolean(title)) {
                throw BadRequest("Provide exactly one of ideaId or title");
            }
            const data = ideaId
                ? await this.service.create(ownerOf(req), ideaId)
                : await this.service.createFromTitle(ownerOf(req), title);
            eventService.capture(ownerOf(req), "project_created" /* EventType.PROJECT_CREATED */, {
                projectId: data.id,
                ideaId,
                title,
            });
            res.sendSuccess({ data, message: "Video project created successfully", statusCode: 201 });
        });
        this.list = asyncHandler(async (req, res) => {
            const { status, limit, cursor } = req.query;
            const data = await this.service.list(ownerOf(req), {
                status: status,
                limit: parseListLimit(limit, PROJECTS_PAGE),
                cursor,
            });
            res.sendSuccess({ data, message: "Video projects retrieved successfully" });
        });
        this.getById = asyncHandler(async (req, res) => {
            const { projectId } = req.params;
            const data = await this.service.getReconciledById(projectId, ownerOf(req));
            res.sendSuccess({ data, message: "Video project retrieved successfully" });
        });
        this.update = asyncHandler(async (req, res) => {
            const { projectId } = req.params;
            const { title } = req.body;
            const data = await this.service.update(projectId, ownerOf(req), { title });
            res.sendSuccess({ data, message: "Video project updated successfully" });
        });
        this.delete = asyncHandler(async (req, res) => {
            const { projectId } = req.params;
            const data = await this.service.delete(projectId, ownerOf(req));
            res.sendSuccess({ data, message: "Video project deleted successfully" });
        });
        // startStep has no route: the generation endpoints (script stream, hooks
        // generate, packaging save) own the in_progress transition server-side.
        this.completeStep = asyncHandler(async (req, res) => {
            const { projectId, stepName } = req.params;
            const data = await this.service.completeStep(projectId, stepName, ownerOf(req));
            res.sendSuccess({ data, message: "Step completed successfully" });
        });
        this.linkResource = asyncHandler(async (req, res) => {
            const { projectId, resourceType } = req.params;
            const { resourceId } = req.body;
            if (!resourceId) {
                throw BadRequest("resourceId is required");
            }
            const data = await this.service.linkResource(projectId, resourceType, resourceId, ownerOf(req));
            res.sendSuccess({ data, message: "Resource linked successfully" });
        });
    }
}
export default VideoProjectController;
