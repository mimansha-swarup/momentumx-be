import { asyncHandler } from "../middleware/async_handler.js";
import { BadRequest } from "../utlils/errors.js";
class VideoProjectController {
    constructor(service) {
        this.service = service;
        this.create = asyncHandler(async (req, res) => {
            const { topicId } = req.body;
            if (!topicId) {
                throw BadRequest("topicId is required");
            }
            const data = await this.service.create(req.userId, topicId);
            res.sendSuccess({ data, message: "Video project created successfully", statusCode: 201 });
        });
        this.list = asyncHandler(async (req, res) => {
            const { status, limit, cursor } = req.query;
            const data = await this.service.list(req.userId, {
                status: status,
                limit: limit ? parseInt(limit, 10) : undefined,
                cursor,
            });
            res.sendSuccess({ data, message: "Video projects retrieved successfully" });
        });
        this.getById = asyncHandler(async (req, res) => {
            const { projectId } = req.params;
            const data = await this.service.getReconciledById(projectId, req.userId);
            res.sendSuccess({ data, message: "Video project retrieved successfully" });
        });
        this.update = asyncHandler(async (req, res) => {
            const { projectId } = req.params;
            const { title } = req.body;
            const data = await this.service.update(projectId, req.userId, { title });
            res.sendSuccess({ data, message: "Video project updated successfully" });
        });
        this.delete = asyncHandler(async (req, res) => {
            const { projectId } = req.params;
            const data = await this.service.delete(projectId, req.userId);
            res.sendSuccess({ data, message: "Video project deleted successfully" });
        });
        this.startStep = asyncHandler(async (req, res) => {
            const { projectId, stepName } = req.params;
            const data = await this.service.startStep(projectId, stepName, req.userId);
            res.sendSuccess({ data, message: "Step started successfully" });
        });
        this.completeStep = asyncHandler(async (req, res) => {
            const { projectId, stepName } = req.params;
            const data = await this.service.completeStep(projectId, stepName, req.userId);
            res.sendSuccess({ data, message: "Step completed successfully" });
        });
        this.linkResource = asyncHandler(async (req, res) => {
            const { projectId, resourceType } = req.params;
            const { resourceId } = req.body;
            if (!resourceId) {
                throw BadRequest("resourceId is required");
            }
            const data = await this.service.linkResource(projectId, resourceType, resourceId, req.userId);
            res.sendSuccess({ data, message: "Resource linked successfully" });
        });
    }
}
export default VideoProjectController;
