import { randomUUID } from "crypto";
import { SCRIPT_SYSTEM_PROMPT, SCRIPT_USER_PROMPT, IDEA_SYSTEM_PROMPT, IDEA_USER_PROMPT, } from "../constants/prompt.js";
import { generateContent, generateStreamingContent } from "../utlils/ai.js";
import { SCRIPT_FORMAT_STYLE, fillTemplate, resolveVideoFormat } from "../utlils/prompt-blocks.js";
import { formatCreatorsData, formatGeneratedScript, formatGeneratedIdea, getClusteredTitles, } from "../utlils/content.js";
import { GENERATION_CONFIG_SCRIPTS, GENERATION_CONFIG_IDEAS, } from "../constants/firebase.js";
import { firebase } from "../config/firebase.js";
import { BadRequest, Conflict, Forbidden, NotFound } from "../utlils/errors.js";
const openSseStream = (res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
};
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
    constructor(repo, userRepo, videoProjectService, researchContext) {
        this.videoProjectService = videoProjectService;
        this.researchContext = researchContext;
        // Builds the script user prompt from the creator's profile + a title.
        // Shared by generateScripts (SSE) and regenerateScript so the placeholder
        // replacement chain lives in one place.
        this.buildScriptUserPrompt = (userRecord, title) => fillTemplate(SCRIPT_USER_PROMPT, {
            "{userName}": userRecord?.brandName ?? "",
            "{targetAudience}": userRecord?.targetAudience ?? "",
            "{competitors}": formatCompetitorUrls(userRecord?.competitors),
            "{niche}": userRecord?.niche ?? "",
            "{websiteContent}": userRecord?.websiteContent ?? "",
            "{title}": title,
        });
        this.getPaginatedUsersIdeas = async ({ userId, limit, cursor, filters, }) => {
            const docs = await this.repo.getIdeas({
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
        };
        // Step 1 of the pipeline: IDEA generation (phase 2). Produces researched
        // video concepts — headline optimization happens post-script at the Title
        // step, never here. Research signals are an enhancer: their failure
        // degrades to channel-context-only generation, it never blocks.
        this.generateIdeas = async (userId, countTowardStats = true, override) => {
            const [similarTitles, userRecord] = await Promise.all([
                getClusteredTitles(userId, this.repo),
                this.userRepo.get(userId),
            ]);
            if (!userRecord && !override) {
                throw NotFound("User not found");
            }
            // Instant-first-idea (3.3): an optional, not-yet-persisted context (from the
            // onboarding prefill, possibly user-edited) is merged over the stored record
            // so a user can see their first ideas before onboarding is saved. Absent →
            // behaves exactly as before (generation from the persisted record only).
            const ctx = { ...(userRecord ?? {}) };
            if (override) {
                if (override.niche !== undefined)
                    ctx.niche = override.niche;
                if (override.targetAudience !== undefined)
                    ctx.targetAudience = override.targetAudience;
                if (override.brandName !== undefined)
                    ctx.brandName = override.brandName;
                if (override.topTitles !== undefined)
                    ctx.userTitle = override.topTitles;
            }
            const researchSignals = this.researchContext
                ? await this.researchContext.getIdeaSignals(ctx.niche ?? "")
                : "";
            const userPrompt = fillTemplate(IDEA_USER_PROMPT, {
                "{niche}": ctx.niche ?? "",
                "{website}": ctx.website ?? "",
                "{websiteContent}": ctx.websiteContent ?? "",
                "{competitors}": formatCompetitorUrls(ctx.competitors),
                "{targetAudience}": ctx.targetAudience ?? "",
                "{userName}": ctx.brandName ?? "",
                "{researchSignals}": researchSignals,
            });
            const text = formatCreatorsData(ctx, similarTitles.flat());
            const result = await generateContent(IDEA_SYSTEM_PROMPT, userPrompt, GENERATION_CONFIG_IDEAS, "text/plain", text);
            let accumulatedRes = "";
            for await (const chunk of result.stream) {
                const part = chunk.text();
                if (part) {
                    accumulatedRes += part;
                }
            }
            const parsedRes = JSON.parse(accumulatedRes);
            const ideas = (Array.isArray(parsedRes) ? parsedRes : []).filter((idea) => idea?.workingTitle?.trim() && idea?.concept?.trim());
            if (ideas.length === 0) {
                throw new Error("Unable to generate ideas at the moment");
            }
            if (countTowardStats) {
                // Lifetime idea counter (stats.ideas); the P5 metering plan builds on it.
                this.userRepo.update(userId, {
                    "stats.ideas": firebase.firestore.FieldValue.increment(ideas.length),
                });
            }
            return ideas;
        };
        this.saveBatchIdeas = async (data) => {
            return this.repo.batchSaveIdeas(data);
        };
        this.editIdeas = async (titleId, userId, resBody) => {
            const idea = await this.repo.getIdea(titleId);
            if (!idea)
                throw NotFound("Idea not found");
            if (idea.createdBy !== userId)
                throw Forbidden();
            // Whitelist: only `title` is client-editable. Never let the client touch
            // server-owned fields (archived, videoProjectId, embedding, isScriptGenerated, createdBy, batchId).
            const updates = {};
            if (typeof resBody.title === "string")
                updates.title = resBody.title;
            if (Object.keys(updates).length === 0) {
                throw BadRequest("No editable fields provided (allowed: title)");
            }
            await this.repo.updateIdea(titleId, updates);
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
                const project = await vps.getById(projectId, userId);
                // Idempotent start: if a script already exists, replay it instead of
                // generating again — auto-starting clients can never double-generate.
                // A fresh generation is only reachable via the explicit regenerate endpoint.
                if (project.scriptId) {
                    const existing = await this.repo.getScriptById(project.scriptId);
                    if (existing) {
                        openSseStream(res);
                        res.write(`data: ${JSON.stringify(existing.script)}\n\n`);
                        res.write(`data: [DONE]\n\n`);
                        res.end();
                        return existing.script;
                    }
                }
                // In-flight lock: a second stream while one is generating (second tab,
                // remount mid-generation) would mint a duplicate script doc. startedAt
                // older than the Gemini timeout means a crashed run — let it retry.
                // ponytail: ~ms read-then-start race remains; move to a transaction if
                // concurrent tabs become a real pattern.
                const scriptStep = project.pipeline.script;
                const startedMs = scriptStep.startedAt?.toMillis() ?? 0;
                if (scriptStep.status === "in_progress" && Date.now() - startedMs < 180000) {
                    throw Conflict("Script generation already in progress for this project");
                }
                const [userRecord, idea] = await Promise.all([
                    this.userRepo.get(userId),
                    this.repo.getIdea(project.ideaId),
                ]);
                if (!idea) {
                    throw NotFound("Idea not found");
                }
                // Reuse the existing script id on regenerate — minting a new uuid when
                // project.scriptId is set would orphan the old script doc.
                const scriptId = project.scriptId ?? randomUUID();
                const userPrompt = this.buildScriptUserPrompt(userRecord, idea.title);
                const systemPrompt = SCRIPT_SYSTEM_PROMPT.replace("{videoFormatStyle}", SCRIPT_FORMAT_STYLE[resolveVideoFormat(userRecord?.format)]);
                try {
                    await vps.startStep(projectId, "script", userId);
                }
                catch (stepError) {
                    console.error(JSON.stringify({ event: "pipeline_start_failed", step: "script", projectId, userId, message: stepError?.message }));
                }
                // Flush headers BEFORE connecting to Gemini: the client is attached to the
                // stream immediately, so an upstream stall can never leave the EventSource
                // hanging in CONNECTING with no data and no error. Any failure past this
                // point terminates via the [DONE] in finally.
                openSseStream(res);
                let accumulatedRes = "";
                try {
                    const result = await generateStreamingContent(systemPrompt, userPrompt, GENERATION_CONFIG_SCRIPTS);
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
                // Nothing generated (Gemini error/timeout): don't persist an empty script
                // or complete the step — the client sees an empty [DONE] and offers retry.
                // Roll the step back so the retry isn't blocked by the in-flight lock.
                if (!accumulatedRes) {
                    console.error(JSON.stringify({ event: "script_stream_empty", projectId, userId }));
                    await vps.abandonStep(projectId, "script");
                    return accumulatedRes;
                }
                try {
                    const formattedData = formatGeneratedScript(idea.title, scriptId, project.ideaId, projectId, accumulatedRes, userId);
                    await this.repo.saveScript(scriptId, formattedData);
                    await this.repo.updateIdea(project.ideaId, {
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
            const activeIdeas = await this.repo.getActiveBatch(userId);
            // Fan out the stale cascade to ALL projects on each active idea — a idea
            // can back multiple video projects, so keying off idea.videoProjectId alone
            // would only reach one of them.
            for (const idea of activeIdeas) {
                let projects = [];
                try {
                    projects = await this.videoProjectService.getProjectsByIdea(idea.id, userId);
                }
                catch (err) {
                    console.error(JSON.stringify({ event: "stale_cascade_lookup_failed", from: "research", ideaId: idea.id, userId, message: err?.message }));
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
            // Archive current active batch
            await this.repo.archiveUserIdeas(userId);
            // Generate a fresh idea batch
            const ideas = await this.generateIdeas(userId);
            const batchId = randomUUID();
            const formattedResults = await Promise.allSettled(ideas.map((idea) => formatGeneratedIdea(idea, userId, batchId)));
            const formatted = formattedResults
                .filter((r) => r.status === "fulfilled")
                .map((r) => r.value);
            return this.saveBatchIdeas(formatted);
        };
        this.regenerateOne = async (userId, ideaId) => {
            const idea = await this.repo.getIdea(ideaId);
            if (!idea) {
                throw NotFound("Idea not found");
            }
            if (idea.createdBy !== userId) {
                throw Forbidden();
            }
            // Suppress the batch-length stats increment — regenerating a single slot
            // keeps only ideas[0], so a full +batch.length here would 10x-inflate stats.ideas.
            const ideas = await this.generateIdeas(userId, false);
            // Regenerate into the same slot type when the old doc had one.
            const preferredType = idea.ideaType;
            const newIdea = (preferredType && ideas.find((idea) => idea.type === preferredType)) ||
                ideas[0];
            const formatted = await formatGeneratedIdea(newIdea, userId, idea.batchId ?? undefined);
            await this.repo.updateIdea(ideaId, {
                title: formatted.title,
                concept: formatted.concept,
                ideaType: formatted.ideaType,
                evidence: formatted.evidence,
                embedding: formatted.embedding,
                isScriptGenerated: false,
                videoProjectId: null,
                userFeedback: null,
            });
            // One idea regenerated -> count exactly one toward stats.
            await this.userRepo.update(userId, {
                "stats.ideas": firebase.firestore.FieldValue.increment(1),
            });
            return { ...formatted, id: ideaId };
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
            if (scriptDoc.videoProjectId) {
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
        this.exportIdeas = async (userId) => {
            const activeIdeas = await this.repo.getActiveBatch(userId);
            const sorted = [...activeIdeas].sort((a, b) => {
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
                `Video Ideas — ${today}`,
                "──────────────────────────────────",
                ...sorted.map((t, i) => {
                    const label = t.ideaType === "short" ? " [Shorts]" : "";
                    const concept = t.concept ? `\n   ${t.concept}` : "";
                    return `${i + 1}. ${t.title}${label}${concept}`;
                }),
            ];
            return { text: lines.join("\n"), count: sorted.length };
        };
        this.repo = repo;
        this.userRepo = userRepo;
    }
}
export default ContentService;
