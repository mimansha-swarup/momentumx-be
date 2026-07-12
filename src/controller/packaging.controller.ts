import { Request, Response } from "express";
import PackagingService from "../service/packaging.service.js";
import { asyncHandler } from "../middleware/async_handler.js";
import { BadRequest, NotFound } from "../utlils/errors.js";
import { eventService } from "../service/event.service.js";
import { EventType } from "../types/routes/event.js";

class PackagingController {
  private service: PackagingService;

  constructor(service: PackagingService) {
    this.service = service;
  }

  // Title is script-native: a script must exist, but it can come from the
  // body OR be resolved server-side from the project (phases 1D).
  generateTitle = asyncHandler(async (req: Request, res: Response) => {
    const { script, videoProjectId } = req.body;
    if (!script && !videoProjectId) {
      throw BadRequest("Provide a script or a videoProjectId with a generated script");
    }
    const data = await this.service.generateTitle(req.userId, script, videoProjectId);
    res.sendSuccess({
      message: "Title generated successfully",
      data,
    });
  });

  // Description degrades to best-available context — title only is enough.
  generateDescription = asyncHandler(async (req: Request, res: Response) => {
    const { script, title, videoProjectId } = req.body;
    if (!title) {
      throw BadRequest("Title is required");
    }
    const data = await this.service.generateDescription(req.userId, script, title, videoProjectId);
    res.sendSuccess({
      message: "Description generated successfully",
      data,
    });
  });

  // Thumbnail is a DOOR: works from title + channel context alone.
  generateThumbnail = asyncHandler(async (req: Request, res: Response) => {
    const { script, title, videoProjectId } = req.body;
    if (!title) {
      throw BadRequest("Title is required");
    }
    const data = await this.service.generateThumbnail(req.userId, script, title, videoProjectId);
    res.sendSuccess({
      message: "Thumbnail instructions generated successfully",
      data,
    });
  });

  generateShorts = asyncHandler(async (req: Request, res: Response) => {
    const { script, duration, videoProjectId } = req.body;
    if (!duration) {
      throw BadRequest("Duration is required");
    }
    // script optional — resolved server-side from the project when omitted.
    const data = await this.service.generateShorts(req.userId, script, duration, videoProjectId);
    res.sendSuccess({
      message: "Shorts script generated successfully",
      data,
    });
  });

  save = asyncHandler(async (req: Request, res: Response) => {
    const { videoProjectId, ...rest } = req.body;
    const data = await this.service.savePackaging(req.userId, rest, videoProjectId);
    res.sendSuccess({
      message: "Packaging saved successfully",
      data,
    });
  });

  getPackaging = asyncHandler(async (req: Request, res: Response) => {
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

  getPackagingByUser = asyncHandler(async (req: Request, res: Response) => {
    const data = await this.service.getPackagingByUser(req.userId);
    res.sendSuccess({
      message: "Packaging list retrieved successfully",
      data,
    });
  });

  regenerateItem = asyncHandler(async (req: Request, res: Response) => {
    const { packagingId, item } = req.params;
    // script is optional — the service resolves the stored project script
    // server-side; per-item requirements are validated in the service.
    const { script, title, duration } = req.body as { script?: string; title?: string; duration?: number };
    const data = await this.service.regenerateItem(req.userId, packagingId, item, script, title, duration);
    eventService.capture(req.userId, EventType.REGENERATE, { resource: "packaging", packagingId, item });
    res.sendSuccess({ message: "Packaging item regenerated successfully", data });
  });

  selectTitle = asyncHandler(async (req: Request, res: Response) => {
    const { packagingId } = req.params;
    const { index } = req.body as { index?: number };
    if (typeof index !== "number") {
      throw BadRequest("index (number) is required");
    }
    const data = await this.service.selectTitle(req.userId, packagingId, index);
    eventService.capture(req.userId, EventType.TITLE_SELECTED, { packagingId, index });
    res.sendSuccess({ message: "Title selected successfully", data });
  });

  exportPackaging = asyncHandler(async (req: Request, res: Response) => {
    const { packagingId } = req.params;
    const data = await this.service.exportPackaging(req.userId, packagingId);
    eventService.capture(req.userId, EventType.EXPORT, { resource: "packaging", packagingId });
    res.sendSuccess({ message: "Packaging exported successfully", data });
  });
}

export default PackagingController;
