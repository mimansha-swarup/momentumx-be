import { asyncHandler } from "../middleware/async_handler.js";
import { BadRequest, NotFound } from "../utlils/errors.js";
class PackagingController {
    constructor(service) {
        this.generateTitle = asyncHandler(async (req, res) => {
            const { script, selectedHook } = req.body;
            if (!script) {
                throw BadRequest("Script is required");
            }
            const data = await this.service.generateTitle(script, selectedHook);
            res.sendSuccess({
                message: "Title generated successfully",
                data,
            });
        });
        this.generateDescription = asyncHandler(async (req, res) => {
            const { script, title, selectedHook } = req.body;
            if (!script) {
                throw BadRequest("Script is required");
            }
            if (!title) {
                throw BadRequest("Title is required");
            }
            const data = await this.service.generateDescription(script, title, selectedHook);
            res.sendSuccess({
                message: "Description generated successfully",
                data,
            });
        });
        this.generateThumbnail = asyncHandler(async (req, res) => {
            const { script, title, selectedHook } = req.body;
            if (!script) {
                throw BadRequest("Script is required");
            }
            if (!title) {
                throw BadRequest("Title is required");
            }
            const data = await this.service.generateThumbnail(script, title, selectedHook);
            res.sendSuccess({
                message: "Thumbnail instructions generated successfully",
                data,
            });
        });
        this.generateShorts = asyncHandler(async (req, res) => {
            const { script, duration } = req.body;
            if (!script) {
                throw BadRequest("Script is required");
            }
            if (!duration) {
                throw BadRequest("Duration is required");
            }
            const data = await this.service.generateShorts(script, duration);
            res.sendSuccess({
                message: "Shorts script generated successfully",
                data,
            });
        });
        this.save = asyncHandler(async (req, res) => {
            const { videoProjectId, ...rest } = req.body;
            const data = await this.service.savePackaging(req.userId, rest, videoProjectId);
            res.sendSuccess({
                message: "Packaging saved successfully",
                data,
            });
        });
        this.getPackaging = asyncHandler(async (req, res) => {
            const { packagingId } = req.params;
            const data = await this.service.getPackaging(packagingId, req.userId);
            if (!data) {
                throw NotFound("Packaging not found");
            }
            res.sendSuccess({
                message: "Packaging retrieved successfully",
                data,
            });
        });
        this.getPackagingByUser = asyncHandler(async (req, res) => {
            const data = await this.service.getPackagingByUser(req.userId);
            res.sendSuccess({
                message: "Packaging list retrieved successfully",
                data,
            });
        });
        this.regenerateItem = asyncHandler(async (req, res) => {
            const { packagingId, item } = req.params;
            const { script, title, duration, selectedHook } = req.body;
            if (!script) {
                throw BadRequest("script is required");
            }
            const data = await this.service.regenerateItem(req.userId, packagingId, item, script, title, duration, selectedHook);
            res.sendSuccess({ message: "Packaging item regenerated successfully", data });
        });
        this.updateFeedback = asyncHandler(async (req, res) => {
            const { packagingId } = req.params;
            const { item, feedback } = req.body;
            if (!item) {
                throw BadRequest("item is required");
            }
            if (feedback === undefined) {
                throw BadRequest("feedback is required");
            }
            const data = await this.service.updateFeedback(req.userId, packagingId, item, feedback);
            res.sendSuccess({ message: "Feedback updated successfully", data });
        });
        this.exportPackaging = asyncHandler(async (req, res) => {
            const { packagingId } = req.params;
            const data = await this.service.exportPackaging(req.userId, packagingId);
            res.sendSuccess({ message: "Packaging exported successfully", data });
        });
        this.service = service;
    }
}
export default PackagingController;
