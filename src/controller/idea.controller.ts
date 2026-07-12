import { randomUUID } from "crypto";
import { Request, Response } from "express";
import ContentService from "../service/content.service.js";
import { formatGeneratedIdea } from "../utlils/content.js";
import { asyncHandler } from "../middleware/async_handler.js";
import { eventService } from "../service/event.service.js";
import { EventType } from "../types/routes/event.js";

class IdeaController {
  private service: ContentService;

  constructor(service: ContentService) {
    this.service = service;
  }

  retrieveIdeas = asyncHandler(async (req: Request, res: Response) => {
    const {
      limit = "9",
      createdAt = "",
      docId = "",
      searchText = "",
      isScriptGenerated = "",
    } = req.query;
    const cursor = {
      createdAt: createdAt as string,
      docId: docId as string,
    };
    const filters = {
      searchText: searchText as string,
      isScriptGenerated: Boolean(isScriptGenerated),
    };

    const data = await this.service.getPaginatedUsersIdeas({
      userId: req.userId,
      limit: parseInt(limit as string, 10),
      cursor,
      filters,
    });

    res.sendSuccess({
      message: "successfully retrieved ideas",
      data,
    });
  });

  generateIdeas = asyncHandler(async (req: Request, res: Response) => {
    // Optional instant-first-idea context (validated by generateIdeasSchema) —
    // absent means generate from the persisted user record as before.
    const ideas = await this.service.generateIdeas(
      req.userId,
      true,
      req.body.context
    );
    const batchId = randomUUID();
    const modifiedDataResults = await Promise.allSettled(
      (ideas || [])?.map(async (idea) =>
        formatGeneratedIdea(idea, req.userId, batchId),
      ),
    );
    const modifiedData = modifiedDataResults
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);

    if (!modifiedData?.length) {
      throw new Error("Unable to generate at the moment");
    }
    const updatedData = await this.service.saveBatchIdeas(modifiedData);
    res.sendSuccess({
      message: "successfully generated ideas",
      data: updatedData,
    });
  });

  editIdea = asyncHandler(async (req: Request, res: Response) => {
    const ideaId = req.params.ideaId;
    const data = await this.service.editIdeas(ideaId, req.userId, req.body);
    res.sendSuccess({
      message: "Title updated successfully",
      data: { ...data, id: ideaId },
    });
  });

  regenerateAll = asyncHandler(async (req: Request, res: Response) => {
    const data = await this.service.regenerateAll(req.userId);
    eventService.capture(req.userId, EventType.REGENERATE, { resource: "idea", scope: "all" });
    res.sendSuccess({ message: "Ideas regenerated successfully", data });
  });

  regenerateOne = asyncHandler(async (req: Request, res: Response) => {
    const data = await this.service.regenerateOne(req.userId, req.params.ideaId);
    eventService.capture(req.userId, EventType.REGENERATE, { resource: "idea", ideaId: req.params.ideaId });
    res.sendSuccess({ message: "Idea regenerated successfully", data });
  });

  exportIdeas = asyncHandler(async (req: Request, res: Response) => {
    const data = await this.service.exportIdeas(req.userId);
    eventService.capture(req.userId, EventType.EXPORT, { resource: "idea" });
    res.sendSuccess({ message: "Ideas exported successfully", data });
  });
}

export default IdeaController;
