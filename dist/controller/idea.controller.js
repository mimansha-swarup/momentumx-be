import { randomUUID } from "crypto";
import { formatGeneratedIdea, logDroppedFormats } from "../utlils/content.js";
import { ServiceUnavailable } from "../utlils/errors.js";
import { IDEAS_PAGE, parseListLimit } from "../utlils/pagination.js";
import { asyncHandler } from "../middleware/async_handler.js";
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
                userId: req.userId,
                limit: parseListLimit(limit, IDEAS_PAGE),
                cursor,
                filters,
            });
            res.sendSuccess({
                message: "successfully retrieved ideas",
                data,
            });
        });
        this.generateIdeas = asyncHandler(async (req, res) => {
            // Optional instant-first-idea context (validated by generateIdeasSchema) —
            // absent means generate from the persisted user record as before.
            const ideas = await this.service.generateIdeas(req.userId, true, req.body.context);
            const batchId = randomUUID();
            // Resolved once for the batch, not per idea — ensureDefaultAccount is cached,
            // but ten concurrent first-calls would otherwise race to mint an account.
            const owner = await this.service.resolveOwner(req.userId);
            const modifiedDataResults = await Promise.allSettled((ideas || [])?.map(async (idea) => formatGeneratedIdea(idea, owner, batchId)));
            const modifiedData = modifiedDataResults
                .filter((result) => result.status === "fulfilled")
                .map((result) => result.value);
            logDroppedFormats("generateIdeas", req.userId, modifiedDataResults);
            if (!modifiedData?.length) {
                // A bare Error resolves to 500 "Something went wrong". Every realistic cause
                // here is upstream (embedding call failed for every idea), which is a retry,
                // not a defect in the request.
                throw ServiceUnavailable("Couldn't generate ideas right now. Please try again.");
            }
            const updatedData = await this.service.saveBatchIdeas(modifiedData);
            res.sendSuccess({
                message: "successfully generated ideas",
                data: updatedData,
            });
        });
        this.editIdea = asyncHandler(async (req, res) => {
            const ideaId = req.params.ideaId;
            const data = await this.service.editIdeas(ideaId, req.userId, req.body);
            res.sendSuccess({
                message: "Title updated successfully",
                data: { ...data, id: ideaId },
            });
        });
        this.regenerateAll = asyncHandler(async (req, res) => {
            const data = await this.service.regenerateAll(req.userId);
            eventService.capture(req.userId, "regenerate" /* EventType.REGENERATE */, { resource: "idea", scope: "all" });
            res.sendSuccess({ message: "Ideas regenerated successfully", data });
        });
        this.regenerateOne = asyncHandler(async (req, res) => {
            const data = await this.service.regenerateOne(req.userId, req.params.ideaId);
            eventService.capture(req.userId, "regenerate" /* EventType.REGENERATE */, { resource: "idea", ideaId: req.params.ideaId });
            res.sendSuccess({ message: "Idea regenerated successfully", data });
        });
        this.exportIdeas = asyncHandler(async (req, res) => {
            const data = await this.service.exportIdeas(req.userId);
            eventService.capture(req.userId, "export" /* EventType.EXPORT */, { resource: "idea" });
            res.sendSuccess({ message: "Ideas exported successfully", data });
        });
        this.service = service;
    }
}
export default IdeaController;
