import { PACKAGING_SYSTEM_PROMPT, GENERATE_HOOKS_PROMPT, } from "../constants/prompt.js";
import { GENERATION_CONFIG_PACKAGING } from "../constants/firebase.js";
import { generateStreamingContent } from "../utlils/ai.js";
class HooksService {
    constructor(repo, videoProjectService) {
        this.repo = repo;
        this.videoProjectService = videoProjectService;
        this.generate = async (userId, videoProjectId, script) => {
            await this.videoProjectService.getById(videoProjectId, userId);
            const userPrompt = GENERATE_HOOKS_PROMPT.replace("{script}", script);
            const result = await generateStreamingContent(PACKAGING_SYSTEM_PROMPT, userPrompt, GENERATION_CONFIG_PACKAGING);
            let accumulatedRes = "";
            for await (const chunk of result.stream) {
                const part = chunk.text();
                if (part) {
                    accumulatedRes += part;
                }
            }
            const parsed = JSON.parse(accumulatedRes);
            const hooksBatch = await this.repo.save({
                videoProjectId,
                createdBy: userId,
                hooks: parsed.hooks,
                hookFeedback: {},
            });
            this.videoProjectService.linkResource(videoProjectId, "hooks", hooksBatch.id, userId).catch(console.error);
            return hooksBatch;
        };
        this.select = async (userId, hooksId, hookIndex, videoProjectId) => {
            const hooksBatch = await this.repo.findById(hooksId);
            if (!hooksBatch) {
                const err = new Error("Hooks batch not found");
                err.statusCode = 404;
                throw err;
            }
            if (hooksBatch.createdBy !== userId) {
                const err = new Error("Forbidden");
                err.statusCode = 403;
                throw err;
            }
            if (hookIndex < 0 || hookIndex >= hooksBatch.hooks.length) {
                const err = new Error(`hookIndex out of range. Must be 0–${hooksBatch.hooks.length - 1}`);
                err.statusCode = 400;
                throw err;
            }
            const result = await this.videoProjectService.setSelectedHook(videoProjectId, hooksId, hookIndex, userId);
            this.videoProjectService.completeStep(videoProjectId, "hooks", userId).catch(console.error);
            return result;
        };
        this.regenerate = async (userId, hooksId, script) => {
            const hooksBatch = await this.repo.findById(hooksId);
            if (!hooksBatch) {
                const err = new Error("Hooks batch not found");
                err.statusCode = 404;
                throw err;
            }
            if (hooksBatch.createdBy !== userId) {
                const err = new Error("Forbidden");
                err.statusCode = 403;
                throw err;
            }
            if (!script) {
                const err = new Error("script is required");
                err.statusCode = 400;
                throw err;
            }
            const userPrompt = GENERATE_HOOKS_PROMPT.replace("{script}", script);
            const result = await generateStreamingContent(PACKAGING_SYSTEM_PROMPT, userPrompt, GENERATION_CONFIG_PACKAGING);
            let accumulatedRes = "";
            for await (const chunk of result.stream) {
                const part = chunk.text();
                if (part)
                    accumulatedRes += part;
            }
            const parsed = JSON.parse(accumulatedRes);
            await this.repo.update(hooksId, { hooks: parsed.hooks, hookFeedback: {} });
            await this.videoProjectService.clearSelectedHook(hooksBatch.videoProjectId, userId);
            await this.videoProjectService.markStale(hooksBatch.videoProjectId, "hooks");
            return { id: hooksId, hooks: parsed.hooks, hookFeedback: {} };
        };
        this.updateFeedback = async (userId, hooksId, hookIndex, feedback) => {
            const hooksBatch = await this.repo.findById(hooksId);
            if (!hooksBatch) {
                const err = new Error("Hooks batch not found");
                err.statusCode = 404;
                throw err;
            }
            if (hooksBatch.createdBy !== userId) {
                const err = new Error("Forbidden");
                err.statusCode = 403;
                throw err;
            }
            if (hookIndex < 0 || hookIndex >= hooksBatch.hooks.length) {
                const err = new Error(`hookIndex out of range. Must be 0–${hooksBatch.hooks.length - 1}`);
                err.statusCode = 400;
                throw err;
            }
            const validFeedback = ["like", "dislike", null];
            if (!validFeedback.includes(feedback)) {
                const err = new Error('feedback must be "like", "dislike", or null');
                err.statusCode = 400;
                throw err;
            }
            await this.repo.update(hooksId, { [`hookFeedback.${hookIndex}`]: feedback });
            return { id: hooksId, hookIndex, feedback };
        };
        this.exportHooks = async (userId, hooksId) => {
            const hooksBatch = await this.repo.findById(hooksId);
            if (!hooksBatch) {
                const err = new Error("Hooks batch not found");
                err.statusCode = 404;
                throw err;
            }
            if (hooksBatch.createdBy !== userId) {
                const err = new Error("Forbidden");
                err.statusCode = 403;
                throw err;
            }
            const today = new Date().toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
            });
            const lines = [
                `Hooks — ${today}`,
                "──────────────────────────────────",
                ...hooksBatch.hooks.map((h, i) => `${i + 1}. ${h}`),
            ];
            return { text: lines.join("\n"), count: hooksBatch.hooks.length };
        };
    }
}
export default HooksService;
