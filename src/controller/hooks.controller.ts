import { Request, Response } from "express";
import HooksService from "../service/hooks.service.js";
import { IGenerateHooksBody, IRegenerateHooksBody, ISelectHookBody } from "../types/routes/hooks.js";
import { asyncHandler } from "../middleware/async_handler.js";
import { ownerOf } from "../utlils/content.js";
import { BadRequest } from "../utlils/errors.js";
import { eventService } from "../service/event.service.js";
import { EventType } from "../types/routes/event.js";

class HooksController {
  constructor(private service: HooksService) {}

  generate = asyncHandler(async (req: Request, res: Response) => {
    const { videoProjectId, script } = req.body as IGenerateHooksBody;
    if (!videoProjectId) {
      throw BadRequest("videoProjectId is required");
    }
    // script is optional — resolved server-side from the project when omitted.
    const data = await this.service.generate(ownerOf(req), videoProjectId, script);
    res.sendSuccess({ message: "Hooks generated successfully", data });
  });

  select = asyncHandler(async (req: Request, res: Response) => {
    const hooksId = req.params.hooksId;
    const { hookIndex } = req.body as ISelectHookBody;
    if (hookIndex === undefined || hookIndex === null) {
      throw BadRequest("hookIndex is required");
    }
    // videoProjectId is NOT taken from the client — select resolves it from the stored hooks batch.
    const data = await this.service.select(ownerOf(req), hooksId, hookIndex);
    eventService.capture(ownerOf(req), EventType.HOOK_SELECTED, { hooksId, hookIndex });
    res.sendSuccess({ message: "Hook selected successfully", data });
  });

  regenerate = asyncHandler(async (req: Request, res: Response) => {
    const hooksId = req.params.hooksId;
    // script is optional — resolved server-side from the stored batch's project.
    const { script } = req.body as IRegenerateHooksBody;
    const data = await this.service.regenerate(ownerOf(req), hooksId, script);
    eventService.capture(ownerOf(req), EventType.REGENERATE, { resource: "hooks", hooksId });
    res.sendSuccess({ message: "Hooks regenerated successfully", data });
  });

  getById = asyncHandler(async (req: Request, res: Response) => {
    const data = await this.service.getById(ownerOf(req), req.params.hooksId);
    res.sendSuccess({ message: "Hooks retrieved successfully", data });
  });

  exportHooks = asyncHandler(async (req: Request, res: Response) => {
    const hooksId = req.params.hooksId;
    const data = await this.service.exportHooks(ownerOf(req), hooksId);
    eventService.capture(ownerOf(req), EventType.EXPORT, { resource: "hooks", hooksId });
    res.sendSuccess({ message: "Hooks exported successfully", data });
  });
}

export default HooksController;
