import { PACKAGING_SYSTEM_PROMPT, GENERATE_TITLE_PROMPT, GENERATE_DESCRIPTION_PROMPT, GENERATE_THUMBNAIL_PROMPT, GENERATE_SHORTS_PROMPT, } from "../constants/prompt.js";
import { GENERATION_CONFIG_PACKAGING } from "../constants/firebase.js";
import { generateStreamingContent } from "../utlils/ai.js";
import { firebase } from "../config/firebase.js";
import { BadRequest, Forbidden, NotFound } from "../utlils/errors.js";
class PackagingService {
    constructor(repo, hooksRepo, videoProjectService) {
        this.hooksRepo = hooksRepo;
        this.videoProjectService = videoProjectService;
        this.resolveSelectedHook = async (videoProjectId, userId) => {
            if (!videoProjectId || !this.videoProjectService)
                return "";
            const project = await this.videoProjectService.getById(videoProjectId, userId);
            if (!project.hooksId || project.selectedHookIndex == null)
                return "";
            const hooksBatch = await this.hooksRepo.findById(project.hooksId);
            if (!hooksBatch)
                return "";
            return hooksBatch.hooks?.[project.selectedHookIndex] ?? "";
        };
        this.generateContent = async (userPrompt) => {
            const result = await generateStreamingContent(PACKAGING_SYSTEM_PROMPT, userPrompt, GENERATION_CONFIG_PACKAGING);
            let accumulatedRes = "";
            for await (const chunk of result.stream) {
                const part = chunk.text();
                if (part) {
                    accumulatedRes += part;
                }
            }
            return JSON.parse(accumulatedRes);
        };
        this.generateTitle = async (userId, script, videoProjectId) => {
            try {
                const selectedHook = await this.resolveSelectedHook(videoProjectId, userId);
                const userPrompt = GENERATE_TITLE_PROMPT
                    .replace("{script}", script)
                    .replace("{selectedHook}", selectedHook);
                const result = await this.generateContent(userPrompt);
                return result;
            }
            catch (error) {
                throw error;
            }
        };
        this.generateDescription = async (userId, script, title, videoProjectId) => {
            try {
                const selectedHook = await this.resolveSelectedHook(videoProjectId, userId);
                const userPrompt = GENERATE_DESCRIPTION_PROMPT
                    .replace("{script}", script)
                    .replace("{title}", title)
                    .replace("{selectedHook}", selectedHook);
                const result = await this.generateContent(userPrompt);
                return result;
            }
            catch (error) {
                throw error;
            }
        };
        this.generateThumbnail = async (userId, script, title, videoProjectId) => {
            try {
                const selectedHook = await this.resolveSelectedHook(videoProjectId, userId);
                const userPrompt = GENERATE_THUMBNAIL_PROMPT
                    .replace("{script}", script)
                    .replace("{title}", title)
                    .replace("{selectedHook}", selectedHook);
                const result = await this.generateContent(userPrompt);
                return result;
            }
            catch (error) {
                throw error;
            }
        };
        this.generateShorts = async (script, duration) => {
            try {
                const userPrompt = GENERATE_SHORTS_PROMPT
                    .replace("{script}", script)
                    .replace(/{duration}/g, duration.toString());
                const result = await this.generateContent(userPrompt);
                return result;
            }
            catch (error) {
                throw error;
            }
        };
        this.buildItemStatuses = (data) => {
            const hasContent = (key) => {
                const val = data[key];
                if (val === undefined || val === null)
                    return false;
                if (Array.isArray(val))
                    return val.length > 0;
                if (typeof val === "string")
                    return val.trim().length > 0;
                return true;
            };
            return {
                title: hasContent("titles") ? "completed" : "not_started",
                description: hasContent("description") ? "completed" : "not_started",
                thumbnail: hasContent("thumbnail") ? "completed" : "not_started",
                shorts: hasContent("shorts") ? "completed" : "not_started",
            };
        };
        this.savePackaging = async (userId, data, videoProjectId) => {
            try {
                if (videoProjectId && this.videoProjectService) {
                    await this.videoProjectService.getById(videoProjectId, userId);
                }
                const itemStatuses = this.buildItemStatuses(data);
                const packagingData = {
                    ...data,
                    createdBy: userId,
                    itemStatuses,
                    isStale: false,
                    staleReason: null,
                    staleSince: null,
                    ...(videoProjectId ? { videoProjectId } : {}),
                };
                let result;
                // Upsert: check if packaging already exists for this video project
                if (videoProjectId) {
                    const existing = await this.repo.findByVideoProject(videoProjectId);
                    if (existing) {
                        result = await this.repo.update(existing.id, {
                            ...packagingData,
                            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                        });
                    }
                    else {
                        result = await this.repo.save({
                            ...packagingData,
                            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                        });
                    }
                }
                else {
                    result = await this.repo.save({
                        ...packagingData,
                        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    });
                }
                if (videoProjectId && this.videoProjectService) {
                    try {
                        await this.videoProjectService.linkResource(videoProjectId, "packaging", result.id, userId);
                        await this.videoProjectService.completeStep(videoProjectId, "packaging", userId);
                    }
                    catch (pipelineError) {
                        console.error(JSON.stringify({ event: "pipeline_transition_failed", step: "packaging", projectId: videoProjectId, packagingId: result.id, userId, message: pipelineError?.message }));
                    }
                }
                return result;
            }
            catch (error) {
                throw error;
            }
        };
        this.getPackaging = async (packagingId, userId) => {
            try {
                const result = await this.repo.get(packagingId);
                if (!result)
                    return null;
                if (result.createdBy !== userId)
                    throw Forbidden();
                return result;
            }
            catch (error) {
                throw error;
            }
        };
        this.getPackagingByUser = async (userId) => {
            try {
                const result = await this.repo.getByUserId(userId);
                return result;
            }
            catch (error) {
                throw error;
            }
        };
        this.regenerateItem = async (userId, packagingId, item, script, title, duration) => {
            const pkg = await this.repo.get(packagingId);
            if (!pkg) {
                throw NotFound("Packaging not found");
            }
            if (pkg.createdBy !== userId) {
                throw Forbidden();
            }
            // Resolve the selected hook from the STORED project on this packaging doc —
            // never from a client-supplied id (that would re-open the trust gap on regenerate).
            const videoProjectId = pkg.videoProjectId;
            const validItems = ["title", "description", "thumbnail", "shorts"];
            if (!validItems.includes(item)) {
                throw BadRequest(`item must be one of: ${validItems.join(", ")}`);
            }
            if (!script) {
                throw BadRequest("script is required");
            }
            if ((item === "description" || item === "thumbnail") && !title) {
                throw BadRequest("title is required for description and thumbnail regeneration");
            }
            if (item === "shorts" && !duration) {
                throw BadRequest("duration is required for shorts regeneration");
            }
            // Save previous item status for rollback on failure
            const currentStatuses = (pkg.itemStatuses ?? {});
            const statusKey = item;
            const previousStatus = currentStatuses[statusKey] ?? "not_started";
            let result;
            let fieldKey;
            try {
                if (item === "title") {
                    result = await this.generateTitle(userId, script, videoProjectId);
                    fieldKey = "titles";
                }
                else if (item === "description") {
                    result = await this.generateDescription(userId, script, title, videoProjectId);
                    fieldKey = "description";
                }
                else if (item === "thumbnail") {
                    result = await this.generateThumbnail(userId, script, title, videoProjectId);
                    fieldKey = "thumbnail";
                }
                else {
                    result = await this.generateShorts(script, duration);
                    fieldKey = "shorts";
                }
            }
            catch (genError) {
                // Rollback status on generation failure
                await this.repo.update(packagingId, {
                    [`itemStatuses.${statusKey}`]: previousStatus,
                });
                throw genError;
            }
            // Atomic write: content + status update
            const updateData = {
                [fieldKey]: result,
                [`itemStatuses.${statusKey}`]: "completed",
            };
            // Check if clearing stale flag is needed
            const allItems = ["title", "description", "thumbnail", "shorts"];
            const anyStillStale = allItems.some((k) => k !== statusKey && currentStatuses[k] === "stale");
            if (!anyStillStale) {
                updateData.isStale = false;
                updateData.staleReason = null;
                updateData.staleSince = null;
            }
            await this.repo.update(packagingId, updateData);
            // Packaging is fresh again — clear the project's stale packaging step so the
            // dashboard "needs update" badge actually clears. Best-effort: a sync failure
            // must not fail the already-saved regeneration.
            if (!anyStillStale && videoProjectId && this.videoProjectService) {
                try {
                    await this.videoProjectService.refreshPackagingStep(videoProjectId, userId);
                }
                catch (syncError) {
                    console.error(JSON.stringify({ event: "stale_cascade_clear_failed", projectId: videoProjectId, packagingId, userId, message: syncError?.message }));
                }
            }
            return { id: packagingId, item, data: result };
        };
        this.updateFeedback = async (userId, packagingId, item, feedback) => {
            const pkg = await this.repo.get(packagingId);
            if (!pkg) {
                throw NotFound("Packaging not found");
            }
            if (pkg.createdBy !== userId) {
                throw Forbidden();
            }
            const validItems = ["title", "description", "thumbnail", "shorts"];
            if (!validItems.includes(item)) {
                throw BadRequest(`item must be one of: ${validItems.join(", ")}`);
            }
            const validFeedback = ["like", "dislike", null];
            if (!validFeedback.includes(feedback)) {
                throw BadRequest('feedback must be "like", "dislike", or null');
            }
            await this.repo.update(packagingId, { [`feedback.${item}`]: feedback });
            return { id: packagingId, item, feedback };
        };
        this.exportPackaging = async (userId, packagingId) => {
            const pkg = await this.repo.get(packagingId);
            if (!pkg) {
                throw NotFound("Packaging not found");
            }
            if (pkg.createdBy !== userId) {
                throw Forbidden();
            }
            const today = new Date().toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
            });
            const formatValue = (val) => {
                if (val === undefined || val === null)
                    return "N/A";
                if (typeof val === "string")
                    return val;
                return JSON.stringify(val, null, 2);
            };
            const titles = pkg.titles;
            const titlesText = Array.isArray(titles)
                ? titles.map((t, i) => `${i + 1}. ${typeof t === "string" ? t : JSON.stringify(t)}`).join("\n")
                : formatValue(titles);
            const lines = [
                `Video Package — ${today}`,
                "══════════════════════════════════",
                "",
                "TITLES",
                "──────",
                titlesText,
                "",
                "DESCRIPTION",
                "───────────",
                formatValue(pkg.description),
                "",
                "THUMBNAIL BRIEF",
                "───────────────",
                formatValue(pkg.thumbnail),
                "",
                "SHORTS SCRIPT",
                "─────────────",
                formatValue(pkg.shorts),
            ];
            return { text: lines.join("\n") };
        };
        this.repo = repo;
    }
}
export default PackagingService;
