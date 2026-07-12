import { randomUUID } from "crypto";
import { DocumentData } from "firebase-admin/firestore";
import { Response } from "express";
import {
  SCRIPT_SYSTEM_PROMPT,
  SCRIPT_USER_PROMPT,
  IDEA_SYSTEM_PROMPT,
  IDEA_USER_PROMPT,
} from "../constants/prompt.js";

import ContentRepository from "../repository/content.repository.js";
import UserRepository from "../repository/user.repository.js";
import VideoProjectService from "./video-project.service.js";
import ResearchContextService from "./research-context.service.js";
import { generateContent, generateStreamingContent } from "../utlils/ai.js";
import { SCRIPT_FORMAT_STYLE, fillTemplate, resolveVideoFormat } from "../utlils/prompt-blocks.js";
import {
  formatCreatorsData,
  formatGeneratedScript,
  formatGeneratedIdea,
  getClusteredTitles,
} from "../utlils/content.js";
import {
  GENERATION_CONFIG_SCRIPTS,
  GENERATION_CONFIG_IDEAS,
} from "../constants/firebase.js";
import { IGetIdeaByUserIdArgs } from "../types/repository/content.js";
import { IGeneratedIdea, IIdeaContextOverride } from "../types/routes/content.js";
import { firebase } from "../config/firebase.js";
import { BadRequest, Forbidden, NotFound } from "../utlils/errors.js";

//  createOnboardingData
function formatCompetitorUrls(competitors: unknown): string {
  if (!Array.isArray(competitors)) return "";
  return competitors
    .map((c) => (typeof c === "string" ? c : c?.url))
    .filter(Boolean)
    .join(", ");
}

class ContentService {
  private repo: ContentRepository;
  private userRepo: UserRepository;
  constructor(
    repo: ContentRepository,
    userRepo: UserRepository,
    private videoProjectService: VideoProjectService,
    private researchContext?: ResearchContextService,
  ) {
    this.repo = repo;
    this.userRepo = userRepo;
  }

  // Builds the script user prompt from the creator's profile + a title.
  // Shared by generateScripts (SSE) and regenerateScript so the placeholder
  // replacement chain lives in one place.
  private buildScriptUserPrompt = (
    userRecord: DocumentData | undefined,
    title: string,
  ): string =>
    fillTemplate(SCRIPT_USER_PROMPT, {
      "{userName}": userRecord?.brandName ?? "",
      "{targetAudience}": userRecord?.targetAudience ?? "",
      "{competitors}": formatCompetitorUrls(userRecord?.competitors),
      "{niche}": userRecord?.niche ?? "",
      "{websiteContent}": userRecord?.websiteContent ?? "",
      "{title}": title,
    });

  getPaginatedUsersIdeas = async ({
    userId,
    limit,
    cursor,
    filters,
  }: IGetIdeaByUserIdArgs) => {
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
        createdAt:
          typeof doc.createdAt === "string"
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
  generateIdeas = async (
    userId: string,
    countTowardStats = true,
    override?: IIdeaContextOverride
  ): Promise<IGeneratedIdea[]> => {
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
    const ctx: DocumentData = { ...(userRecord ?? {}) };
    if (override) {
      if (override.niche !== undefined) ctx.niche = override.niche;
      if (override.targetAudience !== undefined)
        ctx.targetAudience = override.targetAudience;
      if (override.brandName !== undefined) ctx.brandName = override.brandName;
      if (override.topTitles !== undefined) ctx.userTitle = override.topTitles;
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

    const result = await generateContent(
      IDEA_SYSTEM_PROMPT,
      userPrompt,
      GENERATION_CONFIG_IDEAS,
      "text/plain",
      text,
    );

    let accumulatedRes = "";
    for await (const chunk of result.stream) {
      const part = chunk.text();
      if (part) {
        accumulatedRes += part;
      }
    }

    const parsedRes = JSON.parse(accumulatedRes) as IGeneratedIdea[];
    const ideas = (Array.isArray(parsedRes) ? parsedRes : []).filter(
      (idea) => idea?.workingTitle?.trim() && idea?.concept?.trim()
    );
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

  saveBatchIdeas = async (data: unknown[]) => {
    return this.repo.batchSaveIdeas(data);
  };

  editIdeas = async (titleId: string, userId: string, resBody: Record<string, string>) => {
    const idea = await this.repo.getIdea(titleId);
    if (!idea) throw NotFound("Idea not found");
    if (idea.createdBy !== userId) throw Forbidden();
    // Whitelist: only `title` is client-editable. Never let the client touch
    // server-owned fields (archived, videoProjectId, embedding, isScriptGenerated, createdBy, batchId).
    const updates: Record<string, string> = {};
    if (typeof resBody.title === "string") updates.title = resBody.title;
    if (Object.keys(updates).length === 0) {
      throw BadRequest("No editable fields provided (allowed: title)");
    }
    await this.repo.updateIdea(titleId, updates);
    return updates;
  };

  editScript = async (scriptId: string, userId: string, resBody: Record<string, string>) => {
    const script = await this.repo.getScriptById(scriptId);
    if (!script) throw NotFound("Script not found");
    if (script.createdBy !== userId) throw Forbidden();
    // Whitelist: only `script` and `title` are client-editable.
    const updates: Record<string, string> = {};
    if (typeof resBody.script === "string") updates.script = resBody.script;
    if (typeof resBody.title === "string") updates.title = resBody.title;
    if (Object.keys(updates).length === 0) {
      throw BadRequest("No editable fields provided (allowed: script, title)");
    }
    await this.repo.editScript(scriptId, updates);
    return updates;
  };

  generateScripts = async (userId: string, projectId: string, res: Response) => {
    try {
      // Project is mandatory now — load it first (throws NotFound/Forbidden).
      const vps = this.videoProjectService;
      const project = await vps.getById(projectId, userId);

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
      const systemPrompt = SCRIPT_SYSTEM_PROMPT.replace(
        "{videoFormatStyle}",
        SCRIPT_FORMAT_STYLE[resolveVideoFormat(userRecord?.format)]
      );

      const result = await generateStreamingContent(
        systemPrompt,
        userPrompt,
        GENERATION_CONFIG_SCRIPTS,
      );

      let accumulatedRes = "";

      try {
        await vps.startStep(projectId, "script", userId);
      } catch (stepError) {
        console.error(JSON.stringify({ event: "pipeline_start_failed", step: "script", projectId, userId, message: (stepError as Error)?.message }));
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
      } catch (streamError) {
        console.error("SSE stream error", streamError);
      } finally {
        res.write(`data: [DONE]\n\n`);
        res.end();
      }

      try {
        const formattedData = formatGeneratedScript(
          idea.title,
          scriptId,
          project.ideaId,
          projectId,
          accumulatedRes,
          userId,
        );
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
        } catch (pipelineError) {
          console.error(JSON.stringify({ event: "pipeline_transition_failed", step: "script", projectId, scriptId, userId, message: (pipelineError as Error)?.message }));
        }

        // Non-critical stats counter, last so a failure here can't skip the pipeline.
        await this.userRepo.update(userId, {
          "stats.scripts": firebase.firestore.FieldValue.increment(1),
        });
      } catch (saveError) {
        console.error("Post-stream save error", saveError);
      }

      return accumulatedRes;
    } catch (error) {
      console.error("Script generation error", error);
      throw error;
    }
  };

  getUsersScript = async (userId: string) => {
    return this.repo.getScripts(userId);
  };

  getScriptById = async (scriptId: string, userId: string) => {
    const doc = await this.repo.getScriptById(scriptId);
    if (!doc) return null;
    if (doc.createdBy !== userId) throw Forbidden();
    return doc;
  };

  regenerateAll = async (userId: string) => {
    const activeIdeas = await this.repo.getActiveBatch(userId);

    // Fan out the stale cascade to ALL projects on each active idea — a idea
    // can back multiple video projects, so keying off idea.videoProjectId alone
    // would only reach one of them.
    for (const idea of activeIdeas) {
      let projects: Awaited<ReturnType<VideoProjectService["getProjectsByIdea"]>> = [];
      try {
        projects = await this.videoProjectService.getProjectsByIdea(idea.id, userId);
      } catch (err) {
        console.error(JSON.stringify({ event: "stale_cascade_lookup_failed", from: "research", ideaId: idea.id, userId, message: (err as Error)?.message }));
        continue;
      }
      for (const project of projects) {
        try {
          await this.videoProjectService.markStale(project.id, "research");
          await this.videoProjectService.markPackagingDocumentStale(project.id, "research_regenerated");
        } catch (err) {
          console.error(JSON.stringify({ event: "stale_cascade_failed", from: "research", projectId: project.id, userId, message: (err as Error)?.message }));
        }
      }
    }

    // Archive current active batch
    await this.repo.archiveUserIdeas(userId);

    // Generate a fresh idea batch
    const ideas = await this.generateIdeas(userId);

    const batchId = randomUUID();
    const formattedResults = await Promise.allSettled(
      ideas.map((idea) => formatGeneratedIdea(idea, userId, batchId)),
    );
    const formatted = formattedResults
      .filter((r) => r.status === "fulfilled")
      .map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof formatGeneratedIdea>>>).value);

    return this.saveBatchIdeas(formatted);
  };

  regenerateOne = async (userId: string, ideaId: string) => {
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
    const newIdea =
      (preferredType && ideas.find((idea) => idea.type === preferredType)) ||
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

  exportScript = async (userId: string, scriptId: string) => {
    const script = await this.repo.getScriptById(scriptId);
    if (!script) {
      throw NotFound("Script not found");
    }
    if (script.createdBy !== userId) {
      throw Forbidden();
    }
    return { title: script.title, text: script.script };
  };

  regenerateScript = async (userId: string, scriptId: string): Promise<{ id: string; title: string; script: string }> => {
    const scriptDoc = await this.repo.getScriptById(scriptId);
    if (!scriptDoc) {
      throw NotFound("Script not found");
    }
    if (scriptDoc.createdBy !== userId) {
      throw Forbidden();
    }

    const userRecord = await this.userRepo.get(userId);
    const userPrompt = this.buildScriptUserPrompt(userRecord, scriptDoc.title);
    const systemPrompt = SCRIPT_SYSTEM_PROMPT.replace(
      "{videoFormatStyle}",
      SCRIPT_FORMAT_STYLE[resolveVideoFormat(userRecord?.format)]
    );

    const result = await generateStreamingContent(
      systemPrompt,
      userPrompt,
      GENERATION_CONFIG_SCRIPTS,
    );

    let accumulatedRes = "";
    for await (const chunk of result.stream) {
      const part = chunk.text();
      if (part) accumulatedRes += part;
    }

    await this.repo.editScript(scriptId, { script: accumulatedRes });

    if (scriptDoc.videoProjectId) {
      try {
        const proj = await this.videoProjectService.getById(scriptDoc.videoProjectId, userId);
        if (proj) {
          await this.videoProjectService.markStale(proj.id, "script");
          await this.videoProjectService.markPackagingDocumentStale(proj.id, "script_regenerated");
        }
      } catch (cascadeError) {
        console.error(JSON.stringify({ event: "stale_cascade_failed", from: "script", scriptId, userId, message: (cascadeError as Error)?.message }));
      }
    }

    return { id: scriptId, title: scriptDoc.title, script: accumulatedRes };
  };

  exportIdeas = async (userId: string) => {
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
}

export default ContentService;
