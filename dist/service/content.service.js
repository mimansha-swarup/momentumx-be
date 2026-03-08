import { randomUUID } from "crypto";
import { SCRIPT_SYSTEM_PROMPT, SCRIPT_USER_PROMPT, TOPIC_SYSTEM_PROMPT, TOPIC_USER_PROMPT, } from "../constants/prompt.js";
import { generateContent, generateStreamingContent } from "../utlils/ai.js";
import { formatCreatorsData, formatGeneratedScript, formatGeneratedTitle, getClusteredTitles, } from "../utlils/content.js";
import { GENERATION_CONFIG_SCRIPTS, GENERATION_CONFIG_TITLES, } from "../constants/firebase.js";
import { firebase } from "../config/firebase.js";
//  createOnboardingData
class ContentService {
    constructor(repo, userRepo, videoProjectService) {
        this.videoProjectService = videoProjectService;
        this.getPaginatedUsersTopics = async ({ userId, limit, cursor, filters, }) => {
            try {
                const docs = await this.repo.getTopics({
                    userId,
                    limit,
                    cursor,
                    filters,
                });
                const lastDoc = docs[docs.length - 1];
                const nextCursor = lastDoc
                    ? {
                        createdAt: lastDoc.createdAt.toDate().toISOString(),
                        docId: lastDoc.id,
                    }
                    : null;
                return {
                    meta: {
                        nextCursor,
                        hasNextPage: limit === docs.length,
                    },
                    lists: docs?.map((doc) => ({
                        ...doc,
                        createdAt: typeof doc.createdAt === "string"
                            ? doc.createdAt
                            : doc.createdAt?.toDate()?.toISOString(),
                        updatedAt: doc?.updatedAt,
                    })),
                };
            }
            catch (error) {
                console.log("error", error);
            }
            return {};
        };
        this.generateTopics = async (userId) => {
            try {
                const similarTitles = await getClusteredTitles(userId, this.repo);
                const userRecord = await this.userRepo.get(userId);
                let userPrompt = TOPIC_USER_PROMPT
                    .replace(/{niche}/g, userRecord?.niche ?? "")
                    .replace("{website}", userRecord?.website ?? "")
                    .replace("{websiteContent}", userRecord?.websiteContent ?? "")
                    .replace("{competitors}", userRecord?.competitors?.map((c) => c?.url ?? c).filter(Boolean).join(", ") ?? "")
                    .replace("{targetAudience}", userRecord?.targetAudience ?? "")
                    .replace("{userName}", userRecord?.brandName ?? "");
                const text = formatCreatorsData(userRecord, similarTitles.flat());
                const result = await generateContent(TOPIC_SYSTEM_PROMPT, userPrompt, GENERATION_CONFIG_TITLES, "text/plain", text);
                let accumulatedRes = "";
                for await (const chunk of result.stream) {
                    const part = chunk.text();
                    if (part) {
                        accumulatedRes += part;
                    }
                }
                const parsedRes = JSON.parse(accumulatedRes);
                this.userRepo.update(userId, {
                    "stats.topics": firebase.firestore.FieldValue.increment(parsedRes.length),
                });
                return parsedRes;
            }
            catch (error) {
                console.log("error", error);
            }
        };
        this.saveBatchTopics = async (data) => {
            try {
                return await this.repo.batchSaveTopics(data);
            }
            catch (error) {
                console.log("error: ", error);
            }
        };
        this.editTopics = async (titleId, userId, resBody) => {
            const topic = await this.repo.getTopic(titleId);
            if (!topic)
                throw new Error("Topic not found");
            if (topic.createdBy !== userId)
                throw new Error("Forbidden");
            await this.repo.updateTopic(titleId, resBody);
            return resBody;
        };
        this.editScript = async (scriptId, userId, resBody) => {
            const script = await this.repo.getScriptById(scriptId);
            if (!script)
                throw new Error("Script not found");
            if (script.createdBy !== userId)
                throw new Error("Forbidden");
            await this.repo.editScript(scriptId, resBody);
            return resBody;
        };
        this.generateScripts = async (userId, scriptId, res) => {
            try {
                const [userRecord, titleRecord] = await Promise.all([
                    this.userRepo.get(userId),
                    this.repo.getTopic(scriptId),
                ]);
                let userPrompt = SCRIPT_USER_PROMPT.replace("{userName}", userRecord?.brandName ?? "")
                    .replace("{targetAudience}", userRecord?.targetAudience ?? "")
                    .replace("{competitors}", userRecord?.competitors?.map((c) => c?.url ?? c).filter(Boolean).join(", ") ?? "")
                    .replace("{niche}", userRecord?.niche ?? "")
                    .replace("{websiteContent}", userRecord?.websiteContent ?? "")
                    .replace("{title}", titleRecord?.title ?? "");
                const result = await generateStreamingContent(SCRIPT_SYSTEM_PROMPT, userPrompt, GENERATION_CONFIG_SCRIPTS);
                let accumulatedRes = "";
                if (titleRecord?.videoProjectId && this.videoProjectService) {
                    this.videoProjectService.startStep(titleRecord.videoProjectId, "script", userId).catch(console.error);
                }
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                res.flushHeaders();
                for await (const chunk of result.stream) {
                    const part = chunk.text();
                    if (part) {
                        accumulatedRes += part;
                        res.write(`data: ${JSON.stringify(part)}\n\n`);
                    }
                }
                res.write(`data: [DONE]\n\n`);
                res.end();
                const formattedData = formatGeneratedScript(titleRecord?.title, titleRecord?.id, accumulatedRes, userId);
                this.repo.updateTopic(titleRecord?.id, {
                    isScriptGenerated: true,
                });
                await this.repo.saveScript(titleRecord?.id, formattedData);
                this.userRepo.update(userId, {
                    "stats.scripts": firebase.firestore.FieldValue.increment(1),
                });
                if (titleRecord?.videoProjectId && this.videoProjectService) {
                    const vpId = titleRecord.videoProjectId;
                    const scriptId = titleRecord.id;
                    const vps = this.videoProjectService;
                    vps.linkResource(vpId, "script", scriptId, userId)
                        .then(() => vps.completeStep(vpId, "script", userId))
                        .catch(console.error);
                }
                return accumulatedRes;
            }
            catch (error) {
                console.log("error", error);
            }
            return {};
        };
        this.getUsersScript = async (userId) => {
            try {
                const doc = await this.repo.getScripts(userId);
                return doc;
            }
            catch (error) {
                console.log("error", error);
            }
            return {};
        };
        this.getScriptById = async (scriptId, userId) => {
            try {
                const doc = await this.repo.getScriptById(scriptId);
                if (!doc)
                    return null;
                if (doc.createdBy !== userId)
                    throw new Error("Forbidden");
                return doc;
            }
            catch (error) {
                console.log("error", error);
                throw error;
            }
        };
        this.regenerateAll = async (userId) => {
            const activeTopics = await this.repo.getActiveBatch(userId);
            // Fire stale cascade for any topics linked to a video project
            if (this.videoProjectService) {
                for (const topic of activeTopics) {
                    if (topic.videoProjectId) {
                        this.videoProjectService.markStale(topic.videoProjectId, "research").catch((err) => console.error("markStale failed for project", topic.videoProjectId, err));
                    }
                }
            }
            // Archive current active batch
            await this.repo.archiveUserTopics(userId);
            // Generate new titles
            const titles = await this.generateTopics(userId);
            if (!titles || titles.length === 0) {
                throw new Error("Unable to generate topics at the moment");
            }
            const batchId = randomUUID();
            const formattedResults = await Promise.allSettled(titles.map((title) => formatGeneratedTitle(title, userId, batchId)));
            const formatted = formattedResults
                .filter((r) => r.status === "fulfilled")
                .map((r) => r.value);
            return this.saveBatchTopics(formatted);
        };
        this.regenerateOne = async (userId, topicId) => {
            const topic = await this.repo.getTopic(topicId);
            if (!topic) {
                const err = new Error("Topic not found");
                err.statusCode = 404;
                throw err;
            }
            if (topic.createdBy !== userId) {
                const err = new Error("Forbidden");
                err.statusCode = 403;
                throw err;
            }
            const titles = await this.generateTopics(userId);
            if (!titles || titles.length === 0) {
                throw new Error("Unable to generate topics at the moment");
            }
            const newTitle = titles[0];
            const formatted = await formatGeneratedTitle(newTitle, userId, topic.batchId ?? undefined);
            await this.repo.updateTopic(topicId, {
                title: formatted.title,
                embedding: formatted.embedding,
                isScriptGenerated: false,
                videoProjectId: null,
                userFeedback: null,
            });
            return { ...formatted, id: topicId };
        };
        this.updateFeedback = async (userId, topicId, feedback) => {
            const topic = await this.repo.getTopic(topicId);
            if (!topic) {
                const err = new Error("Topic not found");
                err.statusCode = 404;
                throw err;
            }
            if (topic.createdBy !== userId) {
                const err = new Error("Forbidden");
                err.statusCode = 403;
                throw err;
            }
            const validFeedback = ["like", "dislike", null];
            if (!validFeedback.includes(feedback)) {
                const err = new Error('feedback must be "like", "dislike", or null');
                err.statusCode = 400;
                throw err;
            }
            await this.repo.updateTopic(topicId, { userFeedback: feedback });
            return { id: topicId, userFeedback: feedback };
        };
        this.updateScriptFeedback = async (userId, scriptId, feedback) => {
            const script = await this.repo.getScriptById(scriptId);
            if (!script) {
                const err = new Error("Script not found");
                err.statusCode = 404;
                throw err;
            }
            if (script.createdBy !== userId) {
                const err = new Error("Forbidden");
                err.statusCode = 403;
                throw err;
            }
            const validFeedback = ["like", "dislike", null];
            if (!validFeedback.includes(feedback)) {
                const err = new Error('feedback must be "like", "dislike", or null');
                err.statusCode = 400;
                throw err;
            }
            await this.repo.editScript(scriptId, { userFeedback: feedback });
            return { id: scriptId, userFeedback: feedback };
        };
        this.exportScript = async (userId, scriptId) => {
            const script = await this.repo.getScriptById(scriptId);
            if (!script) {
                const err = new Error("Script not found");
                err.statusCode = 404;
                throw err;
            }
            if (script.createdBy !== userId) {
                const err = new Error("Forbidden");
                err.statusCode = 403;
                throw err;
            }
            return { title: script.title, text: script.script };
        };
        this.regenerateScript = async (userId, scriptId) => {
            const scriptDoc = await this.repo.getScriptById(scriptId);
            if (!scriptDoc) {
                const err = new Error("Script not found");
                err.statusCode = 404;
                throw err;
            }
            if (scriptDoc.createdBy !== userId) {
                const err = new Error("Forbidden");
                err.statusCode = 403;
                throw err;
            }
            const userRecord = await this.userRepo.get(userId);
            const userPrompt = SCRIPT_USER_PROMPT.replace("{userName}", userRecord?.brandName ?? "")
                .replace("{targetAudience}", userRecord?.targetAudience ?? "")
                .replace("{competitors}", userRecord?.competitors?.map((c) => c?.url ?? c).filter(Boolean).join(", ") ?? "")
                .replace("{niche}", userRecord?.niche ?? "")
                .replace("{websiteContent}", userRecord?.websiteContent ?? "")
                .replace("{title}", scriptDoc.title);
            const result = await generateStreamingContent(SCRIPT_SYSTEM_PROMPT, userPrompt, GENERATION_CONFIG_SCRIPTS);
            let accumulatedRes = "";
            for await (const chunk of result.stream) {
                const part = chunk.text();
                if (part)
                    accumulatedRes += part;
            }
            await this.repo.editScript(scriptId, { script: accumulatedRes });
            if (this.videoProjectService) {
                this.videoProjectService.getByScriptId(scriptId, userId)
                    .then(proj => {
                    if (proj)
                        this.videoProjectService.markStale(proj.id, "script").catch(console.error);
                })
                    .catch(console.error);
            }
            return { id: scriptId, title: scriptDoc.title, script: accumulatedRes };
        };
        this.exportTopics = async (userId) => {
            const activeTopics = await this.repo.getActiveBatch(userId);
            const sorted = [...activeTopics].sort((a, b) => {
                const aTime = a.createdAt?.toDate?.()?.getTime?.() ?? 0;
                const bTime = b.createdAt?.toDate?.()?.getTime?.() ?? 0;
                return aTime - bTime;
            });
            const today = new Date().toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
            });
            const lines = [
                `Research Topics — ${today}`,
                "──────────────────────────────────",
                ...sorted.map((t, i) => `${i + 1}. ${t.title}`),
            ];
            return { text: lines.join("\n"), count: sorted.length };
        };
        this.repo = repo;
        this.userRepo = userRepo;
    }
}
export default ContentService;
