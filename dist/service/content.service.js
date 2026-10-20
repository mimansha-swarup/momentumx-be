import { randomUUID } from "crypto";
import { SCRIPT_SYSTEM_PROMPT, SCRIPT_USER_PROMPT, IDEA_SYSTEM_PROMPT, IDEA_USER_PROMPT, } from "../constants/prompt.js";
import { streamScript, collectJson, generateContent, generateStreamingContent, generateTextContent } from "../utlils/ai.js";
import { SCRIPT_FORMAT_STYLE, fillTemplate, resolveVideoFormat } from "../utlils/prompt-blocks.js";
import { assertOwner, logDroppedFormats, formatCreatorsData, formatGeneratedScript, formatGeneratedIdea, getClusteredTitles, } from "../utlils/content.js";
import { GENERATION_CONFIG_SCRIPTS, GENERATION_CONFIG_IDEAS, } from "../constants/firebase.js";
import { firebase } from "../config/firebase.js";
import { BadRequest, NotFound, ServiceUnavailable } from "../utlils/errors.js";
import { forbidCrossAccount } from "./account.service.js";
const openSseStream = (res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
};
// Observe the aggregate promise immediately, including when reading the stream fails.
// Text alone does not mean the provider finished a complete draft.
const scriptFinishReason = (result) => Promise.resolve(result.response).then(response => response?.candidates?.[0]?.finishReason, () => "RESPONSE_ERROR");
const requireCompleteScript = async (completion) => {
    const reason = await completion;
    // Some compatible responses omit finishReason; an explicit interruption is never success.
    if (reason && reason !== "STOP") {
        console.error(JSON.stringify({ event: "script_incomplete", finishReason: reason }));
        throw ServiceUnavailable("The script stopped before it was complete. Nothing was saved. Please try again.");
    }
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
    constructor(repo, userRepo, videoProjectService, accounts, researchContext, steps) {
        this.videoProjectService = videoProjectService;
        this.accounts = accounts;
        this.researchContext = researchContext;
        this.steps = steps;
        // Builds the script user prompt from the creator's profile + a title.
        // Shared by generateScripts (SSE) and regenerateScript so the placeholder
        // replacement chain lives in one place.
        this.buildScriptUserPrompt = (userRecord, title, idea) => fillTemplate(SCRIPT_USER_PROMPT, {
            "{userName}": userRecord?.brandName ?? "",
            "{targetAudience}": userRecord?.targetAudience ?? "",
            "{competitors}": formatCompetitorUrls(userRecord?.competitors),
            "{niche}": userRecord?.niche ?? "",
            "{websiteContent}": userRecord?.websiteContent ?? "",
            "{title}": title,
            "{channelDescription}": userRecord?.channelDescription ?? "",
            "{ideaContext}": JSON.stringify({ concept: idea?.concept ?? "", type: idea?.ideaType ?? "", evidence: idea?.evidence ?? "" }),
        });
        this.getPaginatedUsersIdeas = async (args) => {
            const { limit, filters } = args;
            // One more than the page, then discard it. `hasNextPage: limit ===
            // docs.length` was a guess: a final page that happens to be exactly `limit`
            // long claimed another page, and the "Load more" it rendered came back
            // empty. The extra row is the only way to know without a second query, and
            // `video-project.repository.list` already does exactly this.
            const fetched = await this.repo.getIdeas({ ...args, limit: limit + 1 });
            const hasNextPage = fetched.length > limit;
            const docs = hasNextPage ? fetched.slice(0, limit) : fetched;
            const lastDoc = docs[docs.length - 1];
            // The cursor must match the ORDERING the repository used, and search orders
            // by title while the default orders by createdAt. Emitting a createdAt cursor
            // for a title-ordered page is what left search paging stuck on page 1: the
            // repository was handed a cursor it could not apply, so it applied none.
            //
            // The client is opaque to this — it echoes back whatever `nextCursor` it was
            // given, so the two shapes never have to be understood on the frontend.
            const nextCursor = !lastDoc
                ? null
                : filters.searchText
                    ? { title: lastDoc.title, docId: lastDoc.id }
                    : {
                        createdAt: lastDoc.createdAt.toDate().toISOString(),
                        docId: lastDoc.id,
                    };
            return {
                meta: {
                    nextCursor,
                    hasNextPage,
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
        this.buildIdeas = async (owner, countTowardStats = true, override, progress) => {
            const { userId } = owner;
            assertOwner(owner.userId);
            // Phase 06b: the CHANNEL's niche, audience, competitors and website text —
            // the whole reason a prompt is any good. Read from the user record, ideas
            // generated in the finance channel came out about cooking, saved against the
            // right accountId, with nothing failing.
            progress?.("preparing", "Reading your channel context and previous ideas.");
            // Start research as soon as context is available; clustering is independent.
            const titlesPromise = getClusteredTitles(owner.accountId, this.repo);
            // Observe failures immediately even if the context read is slower.
            const titlesResult = titlesPromise.then(value => ({ value }), error => ({ error }));
            const channel = await this.accounts.getContext(owner.accountId);
            if (!channel && !override) {
                throw NotFound("Channel not found");
            }
            const userRecord = channel;
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
            if (this.researchContext && ctx.niche)
                progress?.("research", "Checking available research for your channel.");
            const researchSignals = this.researchContext
                ? await this.researchContext.getIdeaSignals(ctx.niche ?? "")
                : "";
            const clustered = await titlesResult;
            if ("error" in clustered)
                throw clustered.error;
            const similarTitles = clustered.value;
            progress?.("generating", researchSignals
                ? "Generating ideas using your channel context and available research."
                : "Generating ideas from your channel context; no research signals were available.");
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
            let providerWasBusy = false;
            const result = await generateContent(IDEA_SYSTEM_PROMPT, userPrompt, GENERATION_CONFIG_IDEAS, "text/plain", text, ...(progress ? [() => {
                    providerWasBusy = true;
                    progress("provider_busy", "The generation provider is busy. Retrying the connection.");
                }] : []));
            if (providerWasBusy)
                progress?.("generating", "The provider connected. Generating your ideas.");
            const parsedRes = await collectJson(result, "ideas");
            const ideas = (Array.isArray(parsedRes) ? parsedRes : []).filter((idea) => idea?.workingTitle?.trim() && idea?.concept?.trim());
            if (ideas.length === 0) {
                // Was a bare Error, so the handler masked it as "Something went wrong".
                console.error(JSON.stringify({ event: "ai_shape_invalid", label: "ideas", userId }));
                throw ServiceUnavailable("Couldn't generate ideas — nothing usable came back. Please try again.");
            }
            if (countTowardStats) {
                // Lifetime telemetry is noncritical, like the script counter. A counter
                // outage must not discard usable ideas or leave an unhandled rejection.
                await this.userRepo.update(userId, {
                    "stats.ideas": firebase.firestore.FieldValue.increment(ideas.length),
                }).catch(error => console.error(JSON.stringify({ event: "lifetime_stats_failed", userId, message: error?.message })));
            }
            return ideas;
        };
        this.formatIdeas = async (ideas, owner, progress) => {
            progress?.("checking", "Preparing ideas for saving and future similarity checks.");
            const batchId = randomUUID();
            const results = await Promise.allSettled(ideas.map(idea => formatGeneratedIdea(idea, owner, batchId)));
            logDroppedFormats("generateIdeas", owner.userId, results);
            const formatted = results.filter((r) => r.status === "fulfilled").map(r => r.value);
            if (!formatted.length)
                throw ServiceUnavailable("Couldn't generate or regenerate your ideas. Please try again.");
            return formatted;
        };
        this.generateIdeas = async (owner, countTowardStats = true, override, progress) => this.steps.run({ actor: owner, kind: "ideas" }, async (charge) => {
            const ideas = await this.buildIdeas(owner, countTowardStats, override, progress);
            const formatted = await this.formatIdeas(ideas, owner, progress);
            progress?.("saving", "Saving your ideas.");
            return this.saveBatchIdeas(formatted, charge);
        });
        this.saveBatchIdeas = async (data, charge) => {
            return this.repo.batchSaveIdeas(data, ...(charge ? [charge] : []));
        };
        this.editIdeas = async (titleId, owner, resBody) => {
            const { userId } = owner;
            const idea = await this.repo.getIdea(titleId);
            if (!idea)
                throw NotFound("Idea not found");
            if (idea.accountId !== owner.accountId)
                await forbidCrossAccount(this.accounts, idea.accountId, owner);
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
        this.editScript = async (scriptId, owner, resBody) => {
            const { userId } = owner;
            const script = await this.repo.getScriptById(scriptId);
            if (!script)
                throw NotFound("Script not found");
            if (script.accountId !== owner.accountId)
                await forbidCrossAccount(this.accounts, script.accountId, owner);
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
            // A content edit invalidates downstream hooks/packaging exactly like a
            // regenerate does (parity with regenerateScript). A title rename doesn't.
            if (typeof updates.script === "string") {
                try {
                    const project = await this.videoProjectService.getByScriptId(scriptId, owner);
                    if (project) {
                        await this.videoProjectService.markStale(project.id, "script");
                        await this.videoProjectService.markPackagingDocumentStale(project.id, "script_regenerated");
                    }
                }
                catch (cascadeError) {
                    console.error(JSON.stringify({ event: "stale_cascade_failed", from: "script", scriptId, userId, message: cascadeError?.message }));
                }
            }
            return updates;
        };
        this.generateScripts = async (owner, projectId, res) => {
            const { userId } = owner;
            assertOwner(owner.userId);
            try {
                // Project is mandatory now — load it first (throws NotFound/Forbidden).
                const vps = this.videoProjectService;
                const project = await vps.getById(projectId, owner);
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
                const [userRecord, idea] = await Promise.all([
                    this.accounts.getContext(owner.accountId),
                    this.repo.getIdea(project.ideaId),
                ]);
                if (!idea) {
                    throw NotFound("Idea not found");
                }
                if (idea.accountId !== owner.accountId)
                    await forbidCrossAccount(this.accounts, idea.accountId, owner);
                // Reuse the existing script id on regenerate — minting a new uuid when
                // project.scriptId is set would orphan the old script doc.
                const scriptId = project.scriptId ?? projectId;
                const userPrompt = this.buildScriptUserPrompt(userRecord, idea.title, idea);
                const systemPrompt = SCRIPT_SYSTEM_PROMPT.replace("{videoFormatStyle}", SCRIPT_FORMAT_STYLE[resolveVideoFormat(userRecord?.format)]);
                const generated = await this.steps.run({ actor: owner, kind: "script", projectId }, async (charge) => {
                    // Flush headers BEFORE connecting to Gemini: the client is attached to the
                    // stream immediately, so an upstream stall can never leave the EventSource
                    // hanging in CONNECTING with no data and no error. Any failure past this
                    // point terminates via the [DONE] in finally.
                    openSseStream(res);
                    let accumulatedRes = "";
                    const result = await generateStreamingContent(systemPrompt, userPrompt, GENERATION_CONFIG_SCRIPTS);
                    const completion = scriptFinishReason(result);
                    for await (const chunk of result.stream) {
                        const part = chunk.text();
                        if (part) {
                            accumulatedRes += part;
                            res.write(`data: ${JSON.stringify(part)}\n\n`);
                        }
                    }
                    await requireCompleteScript(completion);
                    // Nothing generated (Gemini error/timeout): don't persist an empty script
                    // or complete the step — the client sees an empty [DONE] and offers retry.
                    // Roll the step back so the retry isn't blocked by the in-flight lock.
                    if (!accumulatedRes.trim()) {
                        console.error(JSON.stringify({ event: "script_stream_empty", projectId, userId }));
                        throw ServiceUnavailable("Couldn't generate a script. Please try again.");
                    }
                    const formattedData = formatGeneratedScript(idea.title, scriptId, project.ideaId, projectId, accumulatedRes, owner);
                    await this.repo.saveScript(scriptId, formattedData, ...(charge ? [charge] : []));
                    await this.repo.updateIdea(project.ideaId, {
                        isScriptGenerated: true,
                    }, ...(charge ? [charge] : []));
                    // Pipeline transition (script saved -> mark step complete). Awaited so it
                    // actually runs — fire-and-forget after res.end() can be dropped on serverless —
                    // and logged with context instead of silently swallowed.
                    await vps.linkResource(projectId, "script", scriptId, owner, ...(charge ? [charge] : []));
                    try {
                        await vps.completeStep(projectId, "script", owner, ...(charge ? [charge] : []));
                    }
                    catch (pipelineError) {
                        console.error(JSON.stringify({ event: "pipeline_transition_failed", step: "script", projectId, scriptId, userId, message: pipelineError?.message }));
                    }
                    // Non-critical stats counter, last so a failure here can't skip the pipeline.
                    await this.userRepo.update(userId, {
                        "stats.scripts": firebase.firestore.FieldValue.increment(1),
                    }).catch(error => console.error(JSON.stringify({ event: "lifetime_stats_failed", userId, message: error?.message })));
                    return accumulatedRes;
                });
                res.write(`data: [DONE]\n\n`);
                res.end();
                return generated;
            }
            catch (error) {
                console.error("Script generation error", error);
                throw error;
            }
        };
        this.getUsersScript = async (owner) => {
            return this.repo.getScripts(owner.accountId);
        };
        this.getScriptById = async (scriptId, owner) => {
            const { userId } = owner;
            const doc = await this.repo.getScriptById(scriptId);
            // 404, not `200 {data: null}`. Hooks, packaging and video-projects all throw
            // here; only this one answered success with nothing in it, so a deleted or
            // mistyped script id rendered an empty editor instead of a not-found state.
            if (!doc)
                throw NotFound("Script not found");
            if (doc.accountId !== owner.accountId)
                await forbidCrossAccount(this.accounts, doc.accountId, owner);
            return doc;
        };
        // An idea's content changed underneath its projects — stale every project
        // built from it. An idea can back multiple video projects, so this fans out
        // via the project index, not idea.videoProjectId (which reaches only one).
        this.cascadeIdeaStale = async (ideaId, owner, charge) => {
            const { userId } = owner;
            let projects = [];
            try {
                projects = await this.videoProjectService.getProjectsByIdea(ideaId, owner);
            }
            catch (err) {
                console.error(JSON.stringify({ event: "stale_cascade_lookup_failed", from: "research", ideaId, userId, message: err?.message }));
                return;
            }
            for (const project of projects) {
                try {
                    await this.videoProjectService.markStale(project.id, "research", ...(charge ? [charge] : []));
                    await this.videoProjectService.markPackagingDocumentStale(project.id, "research_regenerated", ...(charge ? [charge] : []));
                }
                catch (err) {
                    console.error(JSON.stringify({ event: "stale_cascade_failed", from: "research", projectId: project.id, userId, message: err?.message }));
                }
            }
        };
        this.regenerateAll = async (owner, progress) => {
            const { userId } = owner;
            // Before the archive below — this method destroys the previous batch, so an
            // owner problem must surface while there is still something to lose.
            assertOwner(owner.userId);
            const activeIdeas = await this.repo.getActiveBatch(owner.accountId);
            return this.steps.run({ actor: owner, kind: "ideas" }, async (charge) => {
                const ideas = await this.buildIdeas(owner, true, undefined, progress);
                const formatted = await this.formatIdeas(ideas, owner, progress);
                progress?.("saving", "Saving the replacement ideas.");
                for (const idea of activeIdeas) {
                    await this.cascadeIdeaStale(idea.id, owner, ...(charge ? [charge] : []));
                }
                // Persist replacements before archiving, excluding the new batch.
                const saved = await this.saveBatchIdeas(formatted, ...(charge ? [charge] : []));
                await this.repo.archiveUserIdeas(owner.accountId, formatted[0].batchId, ...(charge ? [charge] : []));
                return saved;
            });
        };
        this.regenerateOne = async (owner, ideaId, progress) => {
            const { userId } = owner;
            assertOwner(owner.userId);
            const idea = await this.repo.getIdea(ideaId);
            if (!idea) {
                throw NotFound("Idea not found");
            }
            if (idea.accountId !== owner.accountId) {
                await forbidCrossAccount(this.accounts, idea.accountId, owner);
            }
            return this.steps.run({ actor: owner, kind: "ideas" }, async (charge) => {
                // Suppress the batch-length stats increment — regenerating a single slot
                // keeps only ideas[0], so a full +batch.length here would 10x-inflate stats.ideas.
                const ideas = await this.buildIdeas(owner, false, undefined, progress);
                // Regenerate into the same slot type when the old doc had one.
                const preferredType = idea.ideaType;
                const newIdea = (preferredType && ideas.find((idea) => idea.type === preferredType)) ||
                    ideas[0];
                progress?.("checking", "Preparing the replacement idea for saving.");
                const formatted = await formatGeneratedIdea(newIdea, owner, idea.batchId ?? undefined);
                progress?.("saving", "Saving the replacement idea.");
                await this.repo.updateIdea(ideaId, {
                    title: formatted.title,
                    concept: formatted.concept,
                    ideaType: formatted.ideaType,
                    evidence: formatted.evidence,
                    embedding: formatted.embedding,
                    isScriptGenerated: false,
                    videoProjectId: null,
                    userFeedback: null,
                }, ...(charge ? [charge] : []));
                // Same cascade as regenerateAll — this slot's content changed too.
                await this.cascadeIdeaStale(ideaId, owner, ...(charge ? [charge] : []));
                // One idea regenerated -> count exactly one toward stats.
                await this.userRepo.update(userId, {
                    "stats.ideas": firebase.firestore.FieldValue.increment(1),
                }).catch(error => console.error(JSON.stringify({ event: "lifetime_stats_failed", userId, message: error?.message })));
                return { ...formatted, id: ideaId };
            });
        };
        this.exportScript = async (owner, scriptId) => {
            const { userId } = owner;
            const script = await this.repo.getScriptById(scriptId);
            if (!script) {
                throw NotFound("Script not found");
            }
            if (script.accountId !== owner.accountId) {
                await forbidCrossAccount(this.accounts, script.accountId, owner);
            }
            return { title: script.title, text: script.script };
        };
        this.regenerateScript = async (owner, scriptId, progress, onChunk) => {
            const { userId } = owner;
            const scriptDoc = await this.repo.getScriptById(scriptId);
            if (!scriptDoc) {
                throw NotFound("Script not found");
            }
            if (scriptDoc.accountId !== owner.accountId) {
                await forbidCrossAccount(this.accounts, scriptDoc.accountId, owner);
            }
            const userRecord = (await this.accounts.getContext(owner.accountId));
            // Older scripts may have no idea link; keep their title as a conservative fallback.
            const idea = scriptDoc.ideaId ? await this.repo.getIdea(scriptDoc.ideaId) : null;
            if (idea && idea.accountId !== owner.accountId)
                await forbidCrossAccount(this.accounts, idea.accountId, owner);
            const userPrompt = this.buildScriptUserPrompt(userRecord, idea?.title ?? scriptDoc.title, idea);
            const systemPrompt = SCRIPT_SYSTEM_PROMPT.replace("{videoFormatStyle}", SCRIPT_FORMAT_STYLE[resolveVideoFormat(userRecord?.format)]);
            return this.steps.run({ actor: owner, kind: "script", projectId: scriptDoc.videoProjectId ?? undefined, mode: "regenerate" }, async (charge) => {
                let accumulatedRes;
                if (onChunk) {
                    accumulatedRes = await streamScript(systemPrompt, userPrompt, onChunk, progress);
                }
                else {
                    const result = await generateTextContent(systemPrompt, userPrompt, GENERATION_CONFIG_SCRIPTS);
                    await requireCompleteScript(Promise.resolve(result.response.candidates?.[0]?.finishReason ?? "MISSING_FINISH_REASON"));
                    accumulatedRes = result.response.text();
                }
                // Same guard the streaming path has: a safety-blocked or timed-out generation
                // returns nothing, and writing that would replace the creator's script — which
                // has no version history anywhere — with an empty string.
                if (!accumulatedRes.trim()) {
                    console.error(JSON.stringify({ event: "script_regenerate_empty", scriptId, userId }));
                    throw ServiceUnavailable("Regeneration returned nothing — your existing script is unchanged. Try again.");
                }
                progress?.("saving", "Saving your new script.");
                await this.repo.editScript(scriptId, { script: accumulatedRes }, ...(charge ? [charge] : []));
                if (scriptDoc.videoProjectId) {
                    try {
                        const proj = await this.videoProjectService.getById(scriptDoc.videoProjectId, owner);
                        if (proj) {
                            await this.videoProjectService.markStale(proj.id, "script", ...(charge ? [charge] : []));
                            await this.videoProjectService.markPackagingDocumentStale(proj.id, "script_regenerated", ...(charge ? [charge] : []));
                        }
                    }
                    catch (cascadeError) {
                        console.error(JSON.stringify({ event: "stale_cascade_failed", from: "script", scriptId, userId, message: cascadeError?.message }));
                    }
                }
                return { id: scriptId, title: scriptDoc.title, script: accumulatedRes };
            });
        };
        this.exportIdeas = async (owner) => {
            const { userId } = owner;
            const activeIdeas = await this.repo.getActiveBatch(owner.accountId);
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
