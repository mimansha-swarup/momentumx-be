import { Request, Response } from "express";
import ContentService from "../service/content.service.js";
import { asyncHandler } from "../middleware/async_handler.js";
import { BadRequest } from "../utlils/errors.js";

class ScriptController {
  private service: ContentService;

  constructor(service: ContentService) {
    this.service = service;
  }

  // SSE: NOT wrapped in asyncHandler — keeps its own headersSent-aware try/catch
  // so it never writes a JSON error after the stream has started. Auth is handled
  // by sseAuthMiddleware (?token= -> req.userId) before this runs.
  generateScript = async (req: Request, res: Response) => {
    try {
      const scriptId = req.params.scriptId;
      await this.service.generateScripts(req.userId, scriptId, res);
    } catch (error) {
      // If the stream hasn't started (e.g. ownership failure before flushHeaders),
      // return a clean error. Once headers are flushed, only [DONE] can be sent, so just end.
      if (!res.headersSent) {
        const err = error as Error & { statusCode?: number };
        res.sendError({ message: err.message || "Failed to generate script", statusCode: err.statusCode || 500 });
      } else {
        res.end();
      }
    }
  };

  retrieveScripts = asyncHandler(async (req: Request, res: Response) => {
    const data = await this.service.getUsersScript(req.userId);
    res.sendSuccess({
      message: "successfully retrieved scripts",
      data,
    });
  });

  retrieveScriptById = asyncHandler(async (req: Request, res: Response) => {
    const data = await this.service.getScriptById(req.params.scriptId, req.userId);
    res.sendSuccess({
      message: "successfully retrieved script",
      data,
    });
  });

  editScript = asyncHandler(async (req: Request, res: Response) => {
    const scriptId = req.params.scriptId;
    const data = await this.service.editScript(scriptId, req.userId, req.body);
    res.sendSuccess({
      message: "Script updated successfully",
      data: { ...data, scriptId },
    });
  });

  regenerateScript = asyncHandler(async (req: Request, res: Response) => {
    const { scriptId } = req.params;
    const data = await this.service.regenerateScript(req.userId, scriptId);
    res.sendSuccess({ message: "Script regenerated successfully", data });
  });

  updateScriptFeedback = asyncHandler(async (req: Request, res: Response) => {
    const { scriptId } = req.params;
    const { feedback } = req.body as { feedback: "like" | "dislike" | null };
    if (feedback === undefined) {
      throw BadRequest("feedback is required");
    }
    const data = await this.service.updateScriptFeedback(req.userId, scriptId, feedback);
    res.sendSuccess({ message: "Script feedback updated", data });
  });

  exportScript = asyncHandler(async (req: Request, res: Response) => {
    const { scriptId } = req.params;
    const data = await this.service.exportScript(req.userId, scriptId);
    res.sendSuccess({ message: "Script exported successfully", data });
  });
}

export default ScriptController;
