import { generationResponse } from "../utlils/generation-progress.js";
import { HttpError } from "../utlils/errors.js";
import { asyncHandler } from "../middleware/async_handler.js";
import { ownerOf } from "../utlils/content.js";
import { eventService } from "../service/event.service.js";
class ScriptController {
    constructor(service) {
        // SSE: NOT wrapped in asyncHandler — keeps its own headersSent-aware try/catch
        // so it never writes a JSON error after the stream has started. Auth is handled
        // by sseAuthMiddleware (?token= -> req.userId) before this runs.
        this.generateScript = async (req, res) => {
            try {
                const projectId = req.params.projectId;
                await this.service.generateScripts(ownerOf(req), projectId, res);
            }
            catch (error) {
                const err = error instanceof HttpError ? error : new HttpError("Failed to generate script", 500);
                const detail = err.statusCode >= 500
                    ? (err.detail?.charged === false ? { charged: false } : undefined)
                    : err.detail;
                // If the stream hasn't started (e.g. ownership failure before flushHeaders),
                // return a clean error. Once headers are flushed, only [DONE] can be sent, so just end.
                if (!res.headersSent) {
                    res.sendError({ message: err.message || "Failed to generate script", statusCode: err.statusCode || 500, code: err.code, detail });
                }
                else {
                    res.write(`event: generation_error\ndata: ${JSON.stringify({ message: err.message || "Failed to generate script", code: err.code, detail })}\n\n`);
                    res.write(`data: [DONE]\n\n`);
                    res.end();
                }
            }
        };
        this.retrieveScripts = asyncHandler(async (req, res) => {
            const data = await this.service.getUsersScript(ownerOf(req));
            res.sendSuccess({
                message: "successfully retrieved scripts",
                data,
            });
        });
        this.retrieveScriptById = asyncHandler(async (req, res) => {
            const data = await this.service.getScriptById(req.params.scriptId, ownerOf(req));
            res.sendSuccess({
                message: "successfully retrieved script",
                data,
            });
        });
        this.editScript = asyncHandler(async (req, res) => {
            const scriptId = req.params.scriptId;
            const data = await this.service.editScript(scriptId, ownerOf(req), req.body);
            res.sendSuccess({
                message: "Script updated successfully",
                data: { ...data, scriptId },
            });
        });
        this.regenerateScript = asyncHandler(async (req, res) => {
            const { scriptId } = req.params;
            await generationResponse(req, res, "Script regenerated successfully", async (progress, chunk) => {
                const data = await this.service.regenerateScript(ownerOf(req), scriptId, progress, chunk);
                eventService.capture(ownerOf(req), "regenerate" /* EventType.REGENERATE */, { resource: "script", scriptId });
                return data;
            });
        });
        this.exportScript = asyncHandler(async (req, res) => {
            const { scriptId } = req.params;
            const data = await this.service.exportScript(ownerOf(req), scriptId);
            eventService.capture(ownerOf(req), "export" /* EventType.EXPORT */, { resource: "script", scriptId });
            res.sendSuccess({ message: "Script exported successfully", data });
        });
        this.service = service;
    }
}
export default ScriptController;
