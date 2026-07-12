import {
  HOOKS_SYSTEM_PROMPT,
  GENERATE_HOOKS_PROMPT,
} from "../constants/prompt.js";
import { GENERATION_CONFIG_PACKAGING } from "../constants/firebase.js";
import { generateStreamingContent } from "../utlils/ai.js";
import { fillTemplate } from "../utlils/prompt-blocks.js";
import HooksRepository from "../repository/hooks.repository.js";
import VideoProjectService from "./video-project.service.js";
import ContextService from "./context.service.js";
import { IHooksBatch } from "../types/routes/hooks.js";
import { BadRequest, Forbidden, NotFound } from "../utlils/errors.js";

class HooksService {
  constructor(
    private repo: HooksRepository,
    private videoProjectService: VideoProjectService,
    private contextService?: ContextService
  ) {}

  // Body script (if sent) wins; otherwise resolve the project's stored script
  // server-side (phases 1D). Hooks are script-native — no script anywhere is a 400.
  private resolveScript = async (
    userId: string,
    videoProjectId: string,
    explicitScript?: string
  ): Promise<string> => {
    if (explicitScript?.trim()) {
      return explicitScript;
    }
    if (this.contextService) {
      const ctx = await this.contextService.assemble(userId, { videoProjectId });
      if (ctx.sessionContext.script) {
        return ctx.sessionContext.script;
      }
    }
    throw BadRequest("script is required — none found on this project");
  };

  generate = async (
    userId: string,
    videoProjectId: string,
    script?: string
  ): Promise<IHooksBatch> => {
    const project = await this.videoProjectService.getById(videoProjectId, userId);

    if (project.pipeline.script.status !== "completed") {
      throw BadRequest("Script must be completed before generating hooks");
    }

    const resolvedScript = await this.resolveScript(userId, videoProjectId, script);
    const userPrompt = fillTemplate(GENERATE_HOOKS_PROMPT, { "{script}": resolvedScript });

    const result = await generateStreamingContent(
      HOOKS_SYSTEM_PROMPT,
      userPrompt,
      GENERATION_CONFIG_PACKAGING
    );

    let accumulatedRes = "";
    for await (const chunk of result.stream) {
      const part = chunk.text();
      if (part) {
        accumulatedRes += part;
      }
    }

    const parsed = JSON.parse(accumulatedRes) as { hooks: string[] };

    const hooksBatch = await this.repo.save({
      videoProjectId,
      createdBy: userId,
      hooks: parsed.hooks,
      hookFeedback: {},
    });

    try {
      await this.videoProjectService.linkResource(videoProjectId, "hooks", hooksBatch.id, userId);
    } catch (linkError) {
      console.error(JSON.stringify({ event: "pipeline_link_failed", step: "hooks", projectId: videoProjectId, hooksId: hooksBatch.id, userId, message: (linkError as Error)?.message }));
    }

    return hooksBatch;
  };

  select = async (
    userId: string,
    hooksId: string,
    hookIndex: number
  ): Promise<{ id: string; hooksId: string; selectedHookIndex: number }> => {
    const hooksBatch = await this.repo.findById(hooksId);
    if (!hooksBatch) {
      throw NotFound("Hooks batch not found");
    }
    if (hooksBatch.createdBy !== userId) {
      throw Forbidden();
    }
    if (hookIndex < 0 || hookIndex >= hooksBatch.hooks.length) {
      throw BadRequest(`hookIndex out of range. Must be 0–${hooksBatch.hooks.length - 1}`);
    }

    // Resolve the project from the STORED batch — never trust a client-supplied id
    // (mirrors regenerate; closes DA5: binding a batch to a non-origin project).
    const videoProjectId = hooksBatch.videoProjectId;
    if (!videoProjectId) {
      throw BadRequest("Hooks batch is not linked to a video project");
    }

    const result = await this.videoProjectService.setSelectedHook(videoProjectId, hooksId, hookIndex, userId);
    try {
      await this.videoProjectService.completeStep(videoProjectId, "hooks", userId);
    } catch (stepError) {
      console.error(JSON.stringify({ event: "pipeline_transition_failed", step: "hooks", projectId: videoProjectId, userId, message: (stepError as Error)?.message }));
    }
    return result;
  };

  regenerate = async (
    userId: string,
    hooksId: string,
    script?: string
  ): Promise<{ id: string; hooks: string[]; hookFeedback: Record<string, never> }> => {
    const hooksBatch = await this.repo.findById(hooksId);
    if (!hooksBatch) {
      throw NotFound("Hooks batch not found");
    }
    if (hooksBatch.createdBy !== userId) {
      throw Forbidden();
    }
    if (!script && !hooksBatch.videoProjectId) {
      throw BadRequest("script is required");
    }

    const resolvedScript = script?.trim()
      ? script
      : await this.resolveScript(userId, hooksBatch.videoProjectId, script);
    const userPrompt = fillTemplate(GENERATE_HOOKS_PROMPT, { "{script}": resolvedScript });
    const result = await generateStreamingContent(
      HOOKS_SYSTEM_PROMPT,
      userPrompt,
      GENERATION_CONFIG_PACKAGING
    );

    let accumulatedRes = "";
    for await (const chunk of result.stream) {
      const part = chunk.text();
      if (part) accumulatedRes += part;
    }

    const parsed = JSON.parse(accumulatedRes) as { hooks: string[] };
    await this.repo.update(hooksId, { hooks: parsed.hooks, hookFeedback: {} });
    try {
      await this.videoProjectService.clearSelectedHook(hooksBatch.videoProjectId, userId);
      await this.videoProjectService.markStale(hooksBatch.videoProjectId, "hooks");
      await this.videoProjectService.markPackagingDocumentStale(hooksBatch.videoProjectId, "hooks_regenerated");
    } catch (cascadeError) {
      console.error(JSON.stringify({ event: "stale_cascade_failed", from: "hooks", projectId: hooksBatch.videoProjectId, userId, message: (cascadeError as Error)?.message }));
    }

    return { id: hooksId, hooks: parsed.hooks, hookFeedback: {} };
  };

  exportHooks = async (
    userId: string,
    hooksId: string
  ): Promise<{ text: string; count: number }> => {
    const hooksBatch = await this.repo.findById(hooksId);
    if (!hooksBatch) {
      throw NotFound("Hooks batch not found");
    }
    if (hooksBatch.createdBy !== userId) {
      throw Forbidden();
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

export default HooksService;
