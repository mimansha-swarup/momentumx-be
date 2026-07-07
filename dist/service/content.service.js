import { randomUUID } from "crypto";
import { SCRIPT_SYSTEM_PROMPT, SCRIPT_USER_PROMPT, TOPIC_SYSTEM_PROMPT, TOPIC_USER_PROMPT, } from "../constants/prompt.js";
import { generateContent, generateStreamingContent } from "../utlils/ai.js";
import { SCRIPT_FORMAT_STYLE, resolveVideoFormat } from "../utlils/prompt-blocks.js";
import { formatCreatorsData, formatGeneratedScript, formatGeneratedTitle, getClusteredTitles, } from "../utlils/content.js";
import { GENERATION_CONFIG_SCRIPTS, GENERATION_CONFIG_TITLES, } from "../constants/firebase.js";
import { firebase } from "../config/firebase.js";
import { BadRequest, Forbidden, NotFound } from "../utlils/errors.js";
//  createOnboardingData
function formatCompetitorUrls(competitors) {
    if (!Array.isArray(competitors))
        return "";
    return competitors
        .map((c) => (typeof c === "string" ? c : c?.url))
        .filter(Boolean)
        .join(", ");
}
class ContentService {
    constructor(repo, userRepo, videoProjectService) {
        this.videoProjectService = videoProjectService;
        // Builds the script user prompt from the creator's profile + a title.
        // Shared by generateScripts (SSE) and regenerateScript so the placeholder
        // replacement chain lives in one place.
        this.buildScriptUserPrompt = (userRecord, title) => SCRIPT_USER_PROMPT.replace("{userName}", userRecord?.brandName ?? "")
            .replace("{targetAudience}", userRecord?.targetAudience ?? "")
            .replace("{competitors}", formatCompetitorUrls(userRecord?.competitors))
            .replace("{niche}", userRecord?.niche ?? "")
            .replace("{websiteContent}", userRecord?.websiteContent ?? "")
            .replace("{title}", title);
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
                throw error;
            }
        };
        this.generateTopics = async (userId, countTowardStats = true) => {
            try {
                const similarTitles = await getClusteredTitles(userId, this.repo);
                const userRecord = await this.userRepo.get(userId);
                if (!userRecord) {
                    throw NotFound("User not found");
                }
                let userPrompt = TOPIC_USER_PROMPT
                    .replace(/{niche}/g, userRecord?.niche ?? "")
                    .replace("{website}", userRecord?.website ?? "")
                    .replace("{websiteContent}", userRecord?.websiteContent ?? "")
                    .replace("{competitors}", formatCompetitorUrls(userRecord?.competitors))
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
                if (countTowardStats) {
                    this.userRepo.update(userId, {
                        "stats.topics": firebase.firestore.FieldValue.increment(parsedRes.length),
                    });
                }
                return parsedRes;
            }
            catch (error) {
                throw error;
            }
        };
        this.saveBatchTopics = async (data) => {
            return this.repo.batchSaveTopics(data);
        };
        this.editTopics = async (titleId, userId, resBody) => {
            const topic = await this.repo.getTopic(titleId);
            if (!topic)
                throw NotFound("Topic not found");
            if (topic.createdBy !== userId)
                throw Forbidden();
            // Whitelist: only `title` is client-editable. Never let the client touch
            // server-owned fields (archived, videoProjectId, embedding, isScriptGenerated, createdBy, batchId).
            const updates = {};
            if (typeof resBody.title === "string")
                updates.title = resBody.title;
            if (Object.keys(updates).length === 0) {
                throw BadRequest("No editable fields provided (allowed: title)");
            }
            await this.repo.updateTopic(titleId, updates);
            return updates;
        };
        this.editScript = async (scriptId, userId, resBody) => {
            const script = await this.repo.getScriptById(scriptId);
            if (!script)
                throw NotFound("Script not found");
            if (script.createdBy !== userId)
                throw Forbidden();
            // Whitelist: only `script` and `title` are client-editable.
            const updates = {};
            if (typeof resBody.script === "string")
                updates.script = resBody.script;
            if (typeof resBody.title === "string")
                updates.title = resBody.title;
            if (Object.keys(updates).length === 0) {
                throw BadRequest("No editable fields provided (allowed: script, title)");
            }
            await this.repo.editScript(scriptId, updates);
            return updates;
        };
        this.generateScripts = async (userId, projectId, res) => {
            try {
                // Project is mandatory now — load it first (throws NotFound/Forbidden).
                const vps = this.videoProjectService;
                if (!vps) {
                    throw NotFound("Video project service unavailable");
                }
                const project = await vps.getById(projectId, userId);
                const [userRecord, topic] = await Promise.all([
                    this.userRepo.get(userId),
                    this.repo.getTopic(project.topicId),
                ]);
                if (!topic) {
                    throw NotFound("Topic not found");
                }
                // Reuse the existing script id on regenerate — minting a new uuid when
                // project.scriptId is set would orphan the old script doc.
                const scriptId = project.scriptId ?? randomUUID();
                const userPrompt = this.buildScriptUserPrompt(userRecord, topic.title);
                const systemPrompt = SCRIPT_SYSTEM_PROMPT.replace("{videoFormatStyle}", SCRIPT_FORMAT_STYLE[resolveVideoFormat(userRecord?.format)]);
                const result = await generateStreamingContent(systemPrompt, userPrompt, GENERATION_CONFIG_SCRIPTS);
                let accumulatedRes = "";
                try {
                    await vps.startStep(projectId, "script", userId);
                }
                catch (stepError) {
                    console.error(JSON.stringify({ event: "pipeline_start_failed", step: "script", projectId, userId, message: stepError?.message }));
                }
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                res.flushHeaders();
                try {
                    for await (const chunk of result.stream) {
                        const part = chunk.text();
                        if (part) {
                            accumulatedRes += part;
                            res.write(`data: ${JSON.stringify(part)}\n\n`);
                        }
                    }
                }
                catch (streamError) {
                    console.error("SSE stream error", streamError);
                }
                finally {
                    res.write(`data: [DONE]\n\n`);
                    res.end();
                }
                try {
                    const formattedData = formatGeneratedScript(topic.title, scriptId, project.topicId, projectId, accumulatedRes, userId);
                    await this.repo.saveScript(scriptId, formattedData);
                    await this.repo.updateTopic(project.topicId, {
                        isScriptGenerated: true,
                    });
                    // Pipeline transition (script saved -> mark step complete). Awaited so it
                    // actually runs — fire-and-forget after res.end() can be dropped on serverless —
                    // and logged with context instead of silently swallowed.
                    try {
                        await vps.linkResource(projectId, "script", scriptId, userId);
                        await vps.completeStep(projectId, "script", userId);
                    }
                    catch (pipelineError) {
                        console.error(JSON.stringify({ event: "pipeline_transition_failed", step: "script", projectId, scriptId, userId, message: pipelineError?.message }));
                    }
                    // Non-critical stats counter, last so a failure here can't skip the pipeline.
                    await this.userRepo.update(userId, {
                        "stats.scripts": firebase.firestore.FieldValue.increment(1),
                    });
                }
                catch (saveError) {
                    console.error("Post-stream save error", saveError);
                }
                return accumulatedRes;
            }
            catch (error) {
                console.error("Script generation error", error);
                throw error;
            }
        };
        this.getUsersScript = async (userId) => {
            return this.repo.getScripts(userId);
        };
        this.getScriptById = async (scriptId, userId) => {
            const doc = await this.repo.getScriptById(scriptId);
            if (!doc)
                return null;
            if (doc.createdBy !== userId)
                throw Forbidden();
            return doc;
        };
        this.regenerateAll = async (userId) => {
            const activeTopics = await this.repo.getActiveBatch(userId);
            // Fan out the stale cascade to ALL projects on each active topic — a topic
            // can back multiple video projects, so keying off topic.videoProjectId alone
            // would only reach one of them.
            if (this.videoProjectService) {
                for (const topic of activeTopics) {
                    let projects = [];
                    try {
                        projects = await this.videoProjectService.getProjectsByTopic(topic.id, userId);
                    }
                    catch (err) {
                        console.error(JSON.stringify({ event: "stale_cascade_lookup_failed", from: "research", topicId: topic.id, userId, message: err?.message }));
                        continue;
                    }
                    for (const project of projects) {
                        try {
                            await this.videoProjectService.markStale(project.id, "research");
                            await this.videoProjectService.markPackagingDocumentStale(project.id, "research_regenerated");
                        }
                        catch (err) {
                            console.error(JSON.stringify({ event: "stale_cascade_failed", from: "research", projectId: project.id, userId, message: err?.message }));
                        }
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
                throw NotFound("Topic not found");
            }
            if (topic.createdBy !== userId) {
                throw Forbidden();
            }
            // Suppress the batch-length stats increment — regenerating a single slot
            // keeps only titles[0], so a full +batch.length here would 10x-inflate stats.topics.
            const titles = await this.generateTopics(userId, false);
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
            // One topic regenerated -> count exactly one toward stats.
            await this.userRepo.update(userId, {
                "stats.topics": firebase.firestore.FieldValue.increment(1),
            });
            return { ...formatted, id: topicId };
        };
        this.updateFeedback = async (userId, topicId, feedback) => {
            const topic = await this.repo.getTopic(topicId);
            if (!topic) {
                throw NotFound("Topic not found");
            }
            if (topic.createdBy !== userId) {
                throw Forbidden();
            }
            const validFeedback = ["like", "dislike", null];
            if (!validFeedback.includes(feedback)) {
                throw BadRequest('feedback must be "like", "dislike", or null');
            }
            await this.repo.updateTopic(topicId, { userFeedback: feedback });
            return { id: topicId, userFeedback: feedback };
        };
        this.updateScriptFeedback = async (userId, scriptId, feedback) => {
            const script = await this.repo.getScriptById(scriptId);
            if (!script) {
                throw NotFound("Script not found");
            }
            if (script.createdBy !== userId) {
                throw Forbidden();
            }
            const validFeedback = ["like", "dislike", null];
            if (!validFeedback.includes(feedback)) {
                throw BadRequest('feedback must be "like", "dislike", or null');
            }
            await this.repo.editScript(scriptId, { userFeedback: feedback });
            return { id: scriptId, userFeedback: feedback };
        };
        this.exportScript = async (userId, scriptId) => {
            const script = await this.repo.getScriptById(scriptId);
            if (!script) {
                throw NotFound("Script not found");
            }
            if (script.createdBy !== userId) {
                throw Forbidden();
            }
            return { title: script.title, text: script.script };
        };
        this.regenerateScript = async (userId, scriptId) => {
            const scriptDoc = await this.repo.getScriptById(scriptId);
            if (!scriptDoc) {
                throw NotFound("Script not found");
            }
            if (scriptDoc.createdBy !== userId) {
                throw Forbidden();
            }
            const userRecord = await this.userRepo.get(userId);
            const userPrompt = this.buildScriptUserPrompt(userRecord, scriptDoc.title);
            const systemPrompt = SCRIPT_SYSTEM_PROMPT.replace("{videoFormatStyle}", SCRIPT_FORMAT_STYLE[resolveVideoFormat(userRecord?.format)]);
            const result = await generateStreamingContent(systemPrompt, userPrompt, GENERATION_CONFIG_SCRIPTS);
            let accumulatedRes = "";
            for await (const chunk of result.stream) {
                const part = chunk.text();
                if (part)
                    accumulatedRes += part;
            }
            await this.repo.editScript(scriptId, { script: accumulatedRes });
            if (this.videoProjectService && scriptDoc.videoProjectId) {
                try {
                    const proj = await this.videoProjectService.getById(scriptDoc.videoProjectId, userId);
                    if (proj) {
                        await this.videoProjectService.markStale(proj.id, "script");
                        await this.videoProjectService.markPackagingDocumentStale(proj.id, "script_regenerated");
                    }
                }
                catch (cascadeError) {
                    console.error(JSON.stringify({ event: "stale_cascade_failed", from: "script", scriptId, userId, message: cascadeError?.message }));
                }
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
