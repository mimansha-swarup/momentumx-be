import {
  HOOKS_SYSTEM_PROMPT,
  GENERATE_HOOKS_PROMPT,
} from "../constants/prompt.js";
import { GENERATION_CONFIG_HOOKS } from "../constants/firebase.js";
import { collectJson, generateStreamingContent } from "../utlils/ai.js";
import { fillTemplate } from "../utlils/prompt-blocks.js";
import HooksRepository from "../repository/hooks.repository.js";
import VideoProjectService from "./video-project.service.js";
import StepRunner from "./step-runner.js";
import AccountService from "./account.service.js";
import ContextService from "./context.service.js";
import { IHooksBatch } from "../types/routes/hooks.js";
import { BadRequest, Conflict, Forbidden, NotFound, ServiceUnavailable } from "../utlils/errors.js";

// The schema requires exactly 5 non-empty strings, but a schema is a request to
// the model, not a guarantee from it — a blocked or truncated generation can still
// resolve to a shape the rest of this file indexes into. Assert before persisting
// so a bad batch never reaches Firestore, rather than surfacing later as an empty
// hooks screen. Not a repair: it refuses, it doesn't reshape.
const assertHooks = (parsed: { hooks?: unknown }): void => {
  const ok =
    Array.isArray(parsed?.hooks) &&
    parsed.hooks.length > 0 &&
    parsed.hooks.every((h) => typeof h === "string" && h.trim().length > 0);
  if (!ok) {
    console.error(JSON.stringify({ event: "ai_shape_invalid", label: "hooks" }));
    throw ServiceUnavailable(
      "Couldn't generate hooks — the response was incomplete. Please try again."
    );
  }
};

class HooksService {
  constructor(
    private repo: HooksRepository,
    private videoProjectService: VideoProjectService,
    private contextService: ContextService | undefined,
    // REQUIRED, deliberately. An optional runner would mean a missing wire
    // silently skips the lock and (from Phase 08) the debit — failing open on
    // exactly the concern the seam exists to guarantee. A missing argument
    // should be a compile error, not a quiet downgrade.
    private steps: StepRunner,
    private accountService: AccountService
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
    // Idempotent replay stays OUTSIDE the seam: returning an existing batch is
    // not a generation. It must not take the lock and must not spend a credit.
    const project = await this.videoProjectService.getById(videoProjectId, userId);
    if (project.hooksId) {
      const existing = await this.repo.findById(project.hooksId);
      if (existing) return existing;
    }

    const resolvedScript = await this.resolveScript(userId, videoProjectId, script);
    const userPrompt = fillTemplate(GENERATE_HOOKS_PROMPT, { "{script}": resolvedScript });

    // Everything the old body hand-rolled — the script precondition, the
    // read-then-write "lock" that wasn't atomic, the swallowed startStep, and the
    // abandon-on-failure block — now lives in the seam. `REQUIRES.hooks` carries
    // the precondition; `acquireStep` enforces it inside the transaction that
    // takes the lock; `releaseStep` restores prior state on failure (and, unlike
    // the old abandon, does not clear a stale marker).
    const hooksBatch = await this.steps.run(
      { actor: { userId }, kind: "hooks", projectId: videoProjectId },
      async () => {
        const result = await generateStreamingContent(
          HOOKS_SYSTEM_PROMPT,
          userPrompt,
          GENERATION_CONFIG_HOOKS
        );

        const parsed = await collectJson<{ hooks: string[] }>(result, "hooks");
        assertHooks(parsed);

        return this.repo.save({
          videoProjectId,
          createdBy: userId,
          accountId: await this.accountService.ensureDefaultAccount(userId),
          hooks: parsed.hooks,
          hookFeedback: {},
        });
      }
    );

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

    // `mode: "regenerate"` — telemetry and (from Phase 08) metering, but NO step
    // lock and NO precondition.
    //
    // An earlier version of this wrapped regenerate identically to generate, on
    // the theory that it "gains the lock it never had". That broke the primary
    // regenerate flow: hooks stays `in_progress` from generate until the user
    // selects one, so the ordinary "try again" click 409'd for three minutes —
    // and a successful regenerate calls `clearSelectedHook`, which sets the step
    // back to `in_progress` and re-arms it for the next attempt. The precondition
    // was wrong for the same reason: after an upstream regen marks `script`
    // stale, regenerating hooks is exactly what the user needs and it would 400.
    const parsed = await this.steps.run(
      {
        actor: { userId },
        kind: "hooks",
        projectId: hooksBatch.videoProjectId,
        mode: "regenerate",
      },
      async () => {
        const result = await generateStreamingContent(
          HOOKS_SYSTEM_PROMPT,
          userPrompt,
          GENERATION_CONFIG_HOOKS
        );

        const output = await collectJson<{ hooks: string[] }>(result, "hooks");
        assertHooks(output);
        return output;
      }
    );

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

  // Read a saved batch. Without this the hooks existed only in the browser's
  // memory: after a refresh the creator could see "Hook 3 was selected" but never
  // the hook itself, and had no way to change the pick.
  getById = async (userId: string, hooksId: string): Promise<IHooksBatch> => {
    const hooksBatch = await this.repo.findById(hooksId);
    if (!hooksBatch) {
      throw NotFound("Hooks batch not found");
    }
    if (hooksBatch.createdBy !== userId) {
      throw Forbidden();
    }
    return hooksBatch;
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
