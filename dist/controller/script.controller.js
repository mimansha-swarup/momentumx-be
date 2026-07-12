import { asyncHandler } from "../middleware/async_handler.js";
import { eventService } from "../service/event.service.js";
class ScriptController {
    constructor(service) {
        // SSE: NOT wrapped in asyncHandler — keeps its own headersSent-aware try/catch
        // so it never writes a JSON error after the stream has started. Auth is handled
        // by sseAuthMiddleware (?token= -> req.userId) before this runs.
        this.generateScript = async (req, res) => {
            try {
                const projectId = req.params.projectId;
                await this.service.generateScripts(req.userId, projectId, res);
            }
            catch (error) {
                // If the stream hasn't started (e.g. ownership failure before flushHeaders),
                // return a clean error. Once headers are flushed, only [DONE] can be sent, so just end.
                if (!res.headersSent) {
                    const err = error;
                    res.sendError({ message: err.message || "Failed to generate script", statusCode: err.statusCode || 500 });
                }
                else {
                    res.end();
                }
            }
        };
        this.retrieveScripts = asyncHandler(async (req, res) => {
            const data = await this.service.getUsersScript(req.userId);
            res.sendSuccess({
                message: "successfully retrieved scripts",
                data,
            });
        });
        this.retrieveScriptById = asyncHandler(async (req, res) => {
            const data = await this.service.getScriptById(req.params.scriptId, req.userId);
            res.sendSuccess({
                message: "successfully retrieved script",
                data,
            });
        });
        this.editScript = asyncHandler(async (req, res) => {
            const scriptId = req.params.scriptId;
            const data = await this.service.editScript(scriptId, req.userId, req.body);
            res.sendSuccess({
                message: "Script updated successfully",
                data: { ...data, scriptId },
            });
        });
        this.regenerateScript = asyncHandler(async (req, res) => {
            const { scriptId } = req.params;
            const data = await this.service.regenerateScript(req.userId, scriptId);
            eventService.capture(req.userId, "regenerate" /* EventType.REGENERATE */, { resource: "script", scriptId });
            res.sendSuccess({ message: "Script regenerated successfully", data });
        });
        this.exportScript = asyncHandler(async (req, res) => {
            const { scriptId } = req.params;
            const data = await this.service.exportScript(req.userId, scriptId);
            eventService.capture(req.userId, "export" /* EventType.EXPORT */, { resource: "script", scriptId });
            res.sendSuccess({ message: "Script exported successfully", data });
        });
        this.service = service;
    }
}
export default ScriptController;
