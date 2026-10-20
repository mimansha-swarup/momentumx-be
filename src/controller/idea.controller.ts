import { generationResponse } from "../utlils/generation-progress.js";
import { publicIdea } from "../utlils/public-response.js";
import { Request, Response } from "express";
import ContentService from "../service/content.service.js";
import { IDEAS_PAGE, parseListLimit } from "../utlils/pagination.js";
import { asyncHandler } from "../middleware/async_handler.js";
import { ownerOf } from "../utlils/content.js";
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
      title = "",
      searchText = "",
      isScriptGenerated = "",
    } = req.query;
    // Both cursor shapes are accepted; which one is meaningful depends on the
    // ordering the repository picks (createdAt for the default list, title for a
    // prefix search). The client just echoes back the `nextCursor` it was given.
    const cursor = {
      createdAt: createdAt as string,
      title: title as string,
      docId: docId as string,
    };
    // Query params are strings, so `Boolean(isScriptGenerated)` made
    // `?isScriptGenerated=false` mean TRUE — Boolean("false") is true — and the
    // filter returned the exact opposite set. Absent must stay distinct from
    // false: absent means "don't filter", false means "only ideas without a
    // script", which is the more useful of the two and was unreachable.
    const scriptFilter =
      isScriptGenerated === "true"
        ? true
        : isScriptGenerated === "false"
          ? false
          : undefined;

    const filters = {
      searchText: searchText as string,
      ...(scriptFilter !== undefined && { isScriptGenerated: scriptFilter }),
    };

    const data = await this.service.getPaginatedUsersIdeas({
      accountId: req.accountId,
      limit: parseListLimit(limit, IDEAS_PAGE),
      cursor,
      filters,
    });

    res.sendSuccess({
      message: "successfully retrieved ideas",
      data: { ...data, lists: data.lists.map(publicIdea) },
    });
  });

  generateIdeas = asyncHandler(async (req: Request, res: Response) => {
    // Optional instant-first-idea context (validated by generateIdeasSchema) —
    // absent means generate from the persisted user record as before.
    await generationResponse(req, res, "Ideas generated successfully", async progress => {
      const data = await this.service.generateIdeas(ownerOf(req), true, req.body.context, progress);
      return data.map(publicIdea);
    });
  });

  editIdea = asyncHandler(async (req: Request, res: Response) => {
    const ideaId = req.params.ideaId;
    const data = await this.service.editIdeas(ideaId, ownerOf(req), req.body);
    res.sendSuccess({
      message: "Title updated successfully",
      data: { ...data, id: ideaId },
    });
  });

  regenerateAll = asyncHandler(async (req: Request, res: Response) => {
    await generationResponse(req, res, "Ideas regenerated successfully", async progress => {
      const data = await this.service.regenerateAll(ownerOf(req), progress);
      eventService.capture(ownerOf(req), EventType.REGENERATE, { resource: "idea", scope: "all" });
      return data.map(publicIdea);
    });
  });

  regenerateOne = asyncHandler(async (req: Request, res: Response) => {
    await generationResponse(req, res, "Idea regenerated successfully", async progress => {
      const data = await this.service.regenerateOne(ownerOf(req), req.params.ideaId, progress);
      eventService.capture(ownerOf(req), EventType.REGENERATE, { resource: "idea", ideaId: req.params.ideaId });
      return publicIdea(data);
    });
  });

  exportIdeas = asyncHandler(async (req: Request, res: Response) => {
    const data = await this.service.exportIdeas(ownerOf(req));
    eventService.capture(ownerOf(req), EventType.EXPORT, { resource: "idea" });
    res.sendSuccess({ message: "Ideas exported successfully", data });
  });
}

export default IdeaController;
