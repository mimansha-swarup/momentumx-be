import { asyncHandler } from "../middleware/async_handler.js";
import { ownerOf } from "../utlils/content.js";
import { BadRequest, NotFound } from "../utlils/errors.js";
import { eventService } from "../service/event.service.js";
class PackagingController {
    constructor(service) {
        // Title is script-native: a script must exist, but it can come from the
        // body OR be resolved server-side from the project (phases 1D).
        this.generateTitle = asyncHandler(async (req, res) => {
            const { script, videoProjectId } = req.body;
            if (!script && !videoProjectId) {
                throw BadRequest("Provide a script or a videoProjectId with a generated script");
            }
            const data = await this.service.generateTitle(ownerOf(req), script, videoProjectId);
            res.sendSuccess({
                message: "Title generated successfully",
                data,
            });
        });
        // Description degrades to best-available context — title only is enough.
        this.generateDescription = asyncHandler(async (req, res) => {
            const { script, title, videoProjectId } = req.body;
            if (!title) {
                throw BadRequest("Title is required");
            }
            const data = await this.service.generateDescription(ownerOf(req), script, title, videoProjectId);
            res.sendSuccess({
                message: "Description generated successfully",
                data,
            });
        });
        // Thumbnail is a DOOR: works from title + channel context alone.
        this.generateThumbnail = asyncHandler(async (req, res) => {
            const { script, title, videoProjectId } = req.body;
            if (!title) {
                throw BadRequest("Title is required");
            }
            const data = await this.service.generateThumbnail(ownerOf(req), script, title, videoProjectId);
            res.sendSuccess({
                message: "Thumbnail instructions generated successfully",
                data,
            });
        });
        this.generateShorts = asyncHandler(async (req, res) => {
            const { script, duration, videoProjectId } = req.body;
            if (!duration) {
                throw BadRequest("Duration is required");
            }
            // script optional — resolved server-side from the project when omitted.
            const data = await this.service.generateShorts(ownerOf(req), script, duration, videoProjectId);
            res.sendSuccess({
                message: "Shorts script generated successfully",
                data,
            });
        });
        this.save = asyncHandler(async (req, res) => {
            const { videoProjectId, ...rest } = req.body;
            const data = await this.service.savePackaging(ownerOf(req), rest, videoProjectId);
            res.sendSuccess({
                message: "Packaging saved successfully",
                data,
            });
        });
        this.getPackaging = asyncHandler(async (req, res) => {
            const { packagingId } = req.params;
            const data = await this.service.getPackaging(packagingId, ownerOf(req));
            if (!data) {
                throw NotFound("Packaging not found");
            }
            res.sendSuccess({
                message: "Packaging retrieved successfully",
                data,
            });
        });
        this.getPackagingByAccount = asyncHandler(async (req, res) => {
            const data = await this.service.getPackagingByAccount(ownerOf(req));
            res.sendSuccess({
                message: "Packaging list retrieved successfully",
                data,
            });
        });
        this.regenerateItem = asyncHandler(async (req, res) => {
            const { packagingId, item } = req.params;
            // script is optional — the service resolves the stored project script
            // server-side; per-item requirements are validated in the service.
            const { script, title, duration } = req.body;
            const data = await this.service.regenerateItem(ownerOf(req), packagingId, item, script, title, duration);
            eventService.capture(ownerOf(req), "regenerate" /* EventType.REGENERATE */, { resource: "packaging", packagingId, item });
            res.sendSuccess({ message: "Packaging item regenerated successfully", data });
        });
        this.selectTitle = asyncHandler(async (req, res) => {
            const { packagingId } = req.params;
            const { index } = req.body;
            if (typeof index !== "number") {
                throw BadRequest("index (number) is required");
            }
            const data = await this.service.selectTitle(ownerOf(req), packagingId, index);
            eventService.capture(ownerOf(req), "title_selected" /* EventType.TITLE_SELECTED */, { packagingId, index });
            res.sendSuccess({ message: "Title selected successfully", data });
        });
        this.exportPackaging = asyncHandler(async (req, res) => {
            const { packagingId } = req.params;
            const data = await this.service.exportPackaging(ownerOf(req), packagingId);
            eventService.capture(ownerOf(req), "export" /* EventType.EXPORT */, { resource: "packaging", packagingId });
            res.sendSuccess({ message: "Packaging exported successfully", data });
        });
        this.service = service;
    }
}
export default PackagingController;
