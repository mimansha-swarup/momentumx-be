import { generationResponse } from "../utlils/generation-progress.js";
import { publicIdea } from "../utlils/public-response.js";
import { IDEAS_PAGE, parseListLimit } from "../utlils/pagination.js";
import { asyncHandler } from "../middleware/async_handler.js";
import { ownerOf } from "../utlils/content.js";
import { eventService } from "../service/event.service.js";
class IdeaController {
    constructor(service) {
        this.retrieveIdeas = asyncHandler(async (req, res) => {
            const { limit = "9", createdAt = "", docId = "", title = "", searchText = "", isScriptGenerated = "", } = req.query;
            // Both cursor shapes are accepted; which one is meaningful depends on the
            // ordering the repository picks (createdAt for the default list, title for a
            // prefix search). The client just echoes back the `nextCursor` it was given.
            const cursor = {
                createdAt: createdAt,
                title: title,
                docId: docId,
            };
            // Query params are strings, so `Boolean(isScriptGenerated)` made
            // `?isScriptGenerated=false` mean TRUE — Boolean("false") is true — and the
            // filter returned the exact opposite set. Absent must stay distinct from
            // false: absent means "don't filter", false means "only ideas without a
            // script", which is the more useful of the two and was unreachable.
            const scriptFilter = isScriptGenerated === "true"
                ? true
                : isScriptGenerated === "false"
                    ? false
                    : undefined;
            const filters = {
                searchText: searchText,
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
        this.generateIdeas = asyncHandler(async (req, res) => {
            // Optional instant-first-idea context (validated by generateIdeasSchema) —
            // absent means generate from the persisted user record as before.
            await generationResponse(req, res, "Ideas generated successfully", async (progress) => {
                const data = await this.service.generateIdeas(ownerOf(req), true, req.body.context, progress);
                return data.map(publicIdea);
            });
        });
        this.editIdea = asyncHandler(async (req, res) => {
            const ideaId = req.params.ideaId;
            const data = await this.service.editIdeas(ideaId, ownerOf(req), req.body);
            res.sendSuccess({
                message: "Title updated successfully",
                data: { ...data, id: ideaId },
            });
        });
        this.regenerateAll = asyncHandler(async (req, res) => {
            await generationResponse(req, res, "Ideas regenerated successfully", async (progress) => {
                const data = await this.service.regenerateAll(ownerOf(req), progress);
                eventService.capture(ownerOf(req), "regenerate" /* EventType.REGENERATE */, { resource: "idea", scope: "all" });
                return data.map(publicIdea);
            });
        });
        this.regenerateOne = asyncHandler(async (req, res) => {
            await generationResponse(req, res, "Idea regenerated successfully", async (progress) => {
                const data = await this.service.regenerateOne(ownerOf(req), req.params.ideaId, progress);
                eventService.capture(ownerOf(req), "regenerate" /* EventType.REGENERATE */, { resource: "idea", ideaId: req.params.ideaId });
                return publicIdea(data);
            });
        });
        this.exportIdeas = asyncHandler(async (req, res) => {
            const data = await this.service.exportIdeas(ownerOf(req));
            eventService.capture(ownerOf(req), "export" /* EventType.EXPORT */, { resource: "idea" });
            res.sendSuccess({ message: "Ideas exported successfully", data });
        });
        this.service = service;
    }
}
export default IdeaController;
