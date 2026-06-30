import { asyncHandler } from "../middleware/async_handler.js";
import { BadRequest } from "../utlils/errors.js";
class HooksController {
    constructor(service) {
        this.service = service;
        this.generate = asyncHandler(async (req, res) => {
            const { videoProjectId, script } = req.body;
            if (!videoProjectId || !script) {
                throw BadRequest("videoProjectId and script are required");
            }
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
            res.sendSuccess({ message: "Hook selected successfully", data });
        });
        this.regenerate = asyncHandler(async (req, res) => {
            const hooksId = req.params.hooksId;
            const { script } = req.body;
            if (!script) {
                throw BadRequest("script is required");
            }
            const data = await this.service.regenerate(req.userId, hooksId, script);
            res.sendSuccess({ message: "Hooks regenerated successfully", data });
        });
        this.updateFeedback = asyncHandler(async (req, res) => {
            const hooksId = req.params.hooksId;
            const { hookIndex, feedback } = req.body;
            if (hookIndex === undefined || hookIndex === null) {
                throw BadRequest("hookIndex is required");
            }
            if (feedback === undefined) {
                throw BadRequest("feedback is required");
            }
            const data = await this.service.updateFeedback(req.userId, hooksId, hookIndex, feedback);
            res.sendSuccess({ message: "Feedback updated successfully", data });
        });
        this.exportHooks = asyncHandler(async (req, res) => {
            const hooksId = req.params.hooksId;
            const data = await this.service.exportHooks(req.userId, hooksId);
            res.sendSuccess({ message: "Hooks exported successfully", data });
        });
    }
}
export default HooksController;
