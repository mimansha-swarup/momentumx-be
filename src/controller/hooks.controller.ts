import { NextFunction, Request, Response } from "express";
import HooksService from "../service/hooks.service.js";
import { IGenerateHooksBody, ISelectHookBody } from "../types/routes/hooks.js";

class HooksController {
  constructor(private service: HooksService) {}

  private handleError = (error: unknown, res: Response, next: NextFunction): void => {
    const err = error as Error & { statusCode?: number };
    if (err.statusCode) {
      res.sendError({ message: err.message, statusCode: err.statusCode });
    } else {
      next(error);
    }
  };

  generate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { videoProjectId, script } = req.body as IGenerateHooksBody;
      if (!videoProjectId || !script) {
        return res.sendError({ message: "videoProjectId and script are required", statusCode: 400 });
      }
      const data = await this.service.generate(req.userId, videoProjectId, script);
      res.sendSuccess({ message: "Hooks generated successfully", data });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };

  select = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const hooksId = req.params.hooksId;
      const { hookIndex, videoProjectId } = req.body as ISelectHookBody;
      if (hookIndex === undefined || hookIndex === null || !videoProjectId) {
        return res.sendError({ message: "hookIndex and videoProjectId are required", statusCode: 400 });
      }
      const data = await this.service.select(req.userId, hooksId, hookIndex, videoProjectId);
      res.sendSuccess({ message: "Hook selected successfully", data });
    } catch (error) {
      this.handleError(error, res, next);
    }
  };
}

export default HooksController;
