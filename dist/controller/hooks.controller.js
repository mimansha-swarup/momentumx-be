import { asyncHandler } from "../middleware/async_handler.js";
import { BadRequest } from "../utlils/errors.js";
import { eventService } from "../service/event.service.js";
class HooksController {
    constructor(service) {
        this.service = service;
        this.generate = asyncHandler(async (req, res) => {
            const { videoProjectId, script } = req.body;
            if (!videoProjectId) {
                throw BadRequest("videoProjectId is required");
            }
            // script is optional — resolved server-side from the project when omitted.
            const data = await this.service.generate(req.userId, videoProjectId, script);
            res.sendSuccess({ message: "Hooks generated successfully", data });
        });
        this.select = asyncHandler(async (req, res) => {
            const hooksId = req.params.hooksId;
            const { hookIndex } = req.body;
            if (hookIndex === undefined || hookIndex === null) {
                throw BadRequest("hookIndex is required");
            }
            // videoProjectId is NOT taken from the client — select resolves it from the stored hooks batch.
            const data = await this.service.select(req.userId, hooksId, hookIndex);
            eventService.capture(req.userId, "hook_selected" /* EventType.HOOK_SELECTED */, { hooksId, hookIndex });
            res.sendSuccess({ message: "Hook selected successfully", data });
        });
        this.regenerate = asyncHandler(async (req, res) => {
            const hooksId = req.params.hooksId;
            // script is optional — resolved server-side from the stored batch's project.
            const { script } = req.body;
            const data = await this.service.regenerate(req.userId, hooksId, script);
            eventService.capture(req.userId, "regenerate" /* EventType.REGENERATE */, { resource: "hooks", hooksId });
            res.sendSuccess({ message: "Hooks regenerated successfully", data });
        });
        this.exportHooks = asyncHandler(async (req, res) => {
            const hooksId = req.params.hooksId;
            const data = await this.service.exportHooks(req.userId, hooksId);
            eventService.capture(req.userId, "export" /* EventType.EXPORT */, { resource: "hooks", hooksId });
            res.sendSuccess({ message: "Hooks exported successfully", data });
        });
    }
}
export default HooksController;
