import { Request, Response } from "express";
import HooksService from "../service/hooks.service.js";
import { IGenerateHooksBody, IHooksFeedbackBody, IRegenerateHooksBody, ISelectHookBody } from "../types/routes/hooks.js";
import { asyncHandler } from "../middleware/async_handler.js";
import { BadRequest } from "../utlils/errors.js";

class HooksController {
  constructor(private service: HooksService) {}

  generate = asyncHandler(async (req: Request, res: Response) => {
    const { videoProjectId, script } = req.body as IGenerateHooksBody;
    if (!videoProjectId || !script) {
      throw BadRequest("videoProjectId and script are required");
    }
    const data = await this.service.generate(req.userId, videoProjectId, script);
    res.sendSuccess({ message: "Hooks generated successfully", data });
  });

  select = asyncHandler(async (req: Request, res: Response) => {
    const hooksId = req.params.hooksId;
    const { hookIndex } = req.body as ISelectHookBody;
    if (hookIndex === undefined || hookIndex === null) {
      throw BadRequest("hookIndex is required");
    }
    // videoProjectId is NOT taken from the client — select resolves it from the stored hooks batch.
    const data = await this.service.select(req.userId, hooksId, hookIndex);
    res.sendSuccess({ message: "Hook selected successfully", data });
  });

  regenerate = asyncHandler(async (req: Request, res: Response) => {
    const hooksId = req.params.hooksId;
    const { script } = req.body as IRegenerateHooksBody;
    if (!script) {
      throw BadRequest("script is required");
    }
    const data = await this.service.regenerate(req.userId, hooksId, script);
    res.sendSuccess({ message: "Hooks regenerated successfully", data });
  });

  updateFeedback = asyncHandler(async (req: Request, res: Response) => {
    const hooksId = req.params.hooksId;
    const { hookIndex, feedback } = req.body as IHooksFeedbackBody;
    if (hookIndex === undefined || hookIndex === null) {
      throw BadRequest("hookIndex is required");
    }
    if (feedback === undefined) {
      throw BadRequest("feedback is required");
    }
    const data = await this.service.updateFeedback(req.userId, hooksId, hookIndex, feedback);
    res.sendSuccess({ message: "Feedback updated successfully", data });
  });

  exportHooks = asyncHandler(async (req: Request, res: Response) => {
    const hooksId = req.params.hooksId;
    const data = await this.service.exportHooks(req.userId, hooksId);
    res.sendSuccess({ message: "Hooks exported successfully", data });
  });
}

export default HooksController;
