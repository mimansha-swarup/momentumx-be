import { Request, Response } from "express";
import PackagingService from "../service/packaging.service.js";
import { asyncHandler } from "../middleware/async_handler.js";
import { ownerOf } from "../utlils/content.js";
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
    const data = await this.service.generateTitle(ownerOf(req), script, videoProjectId);
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
    const data = await this.service.generateDescription(ownerOf(req), script, title, videoProjectId);
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
    const data = await this.service.generateThumbnail(ownerOf(req), script, title, videoProjectId);
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
    const data = await this.service.generateShorts(ownerOf(req), script, duration, videoProjectId);
    res.sendSuccess({
      message: "Shorts script generated successfully",
      data,
    });
  });

  save = asyncHandler(async (req: Request, res: Response) => {
    const { videoProjectId, ...rest } = req.body;
    const data = await this.service.savePackaging(ownerOf(req), rest, videoProjectId);
    res.sendSuccess({
      message: "Packaging saved successfully",
      data,
    });
  });

  getPackaging = asyncHandler(async (req: Request, res: Response) => {
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

  getPackagingByAccount = asyncHandler(async (req: Request, res: Response) => {
    const data = await this.service.getPackagingByAccount(ownerOf(req));
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
    const data = await this.service.regenerateItem(ownerOf(req), packagingId, item, script, title, duration);
    eventService.capture(ownerOf(req), EventType.REGENERATE, { resource: "packaging", packagingId, item });
    res.sendSuccess({ message: "Packaging item regenerated successfully", data });
  });

  selectTitle = asyncHandler(async (req: Request, res: Response) => {
    const { packagingId } = req.params;
    const { index } = req.body as { index?: number };
    if (typeof index !== "number") {
      throw BadRequest("index (number) is required");
    }
    const data = await this.service.selectTitle(ownerOf(req), packagingId, index);
    eventService.capture(ownerOf(req), EventType.TITLE_SELECTED, { packagingId, index });
    res.sendSuccess({ message: "Title selected successfully", data });
  });

  exportPackaging = asyncHandler(async (req: Request, res: Response) => {
    const { packagingId } = req.params;
    const data = await this.service.exportPackaging(ownerOf(req), packagingId);
    eventService.capture(ownerOf(req), EventType.EXPORT, { resource: "packaging", packagingId });
    res.sendSuccess({ message: "Packaging exported successfully", data });
  });
}

export default PackagingController;
