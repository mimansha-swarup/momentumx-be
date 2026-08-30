import { firebase } from "../config/firebase.js";
import ContentRepository from "../repository/content.repository.js";
import HooksRepository from "../repository/hooks.repository.js";
import PackagingRepository from "../repository/packaging.repository.js";
import VideoProjectRepository from "../repository/video-project.repository.js";
import {
  IVideoProject,
  IVideoProjectPipeline,
  OverallStatus,
  StaleReason,
  StepName,
  StepState,
} from "../types/routes/video-project.js";
import { IPackaging } from "../types/routes/packaging.js";
import { RecordOwner } from "../utlils/content.js";
import { STEP_ORDER, STEP_LOCK_MS, downstreamOf } from "../constants/pipeline.js";
import { BadRequest, Forbidden, NotFound } from "../utlils/errors.js";
import { forbidCrossAccount } from "./account.service.js";
import AccountRepository from "../repository/account.repository.js";
import { assertOwner, formatGeneratedTitle } from "../utlils/content.js";

const VALID_MUTABLE_STEPS = ["script", "hooks", "title", "packaging"];

// STEP_ORDER, downstreamOf (was the hand-written STALE_CASCADE map) and
// STEP_LOCK_MS all live in constants/pipeline.ts now. Re-exported so the existing
// importers of STEP_LOCK_MS don't all have to change in the same commit.
export { STEP_LOCK_MS };

// Single source of the overall-status arithmetic, shared by reconcileView (read path)
// and refreshPackagingStep (write path) so the two can never drift.
const computeOverallStatus = (pipeline: IVideoProjectPipeline): OverallStatus => {
  const statuses = STEP_ORDER.map((st) => pipeline[st].status);
  return statuses.includes("stale")
    ? "stale"
    : statuses.every((x) => x === "completed")
      ? "completed"
      : "in_progress";
};

class VideoProjectService {
  constructor(
    private repo: VideoProjectRepository,
    private contentRepo: ContentRepository,
    private packagingRepo: PackagingRepository,
    private hooksRepo: HooksRepository,
    private accounts: AccountRepository
  ) {}

  create = async (owner: RecordOwner, ideaId: string): Promise<IVideoProject> => {
    const idea = await this.contentRepo.getIdea(ideaId);
    if (!idea) {
      throw NotFound("Idea not found");
    }
    if (idea.accountId !== owner.accountId) {
      await forbidCrossAccount(this.accounts, idea.accountId, owner);
    }

    const now = firebase.firestore.FieldValue.serverTimestamp();
    const projectData = {
      createdBy: owner.userId,
      accountId: owner.accountId,
      title: idea.title,
      ideaId,
      scriptId: null,
      hooksId: null,
      selectedHookIndex: null,
      packagingId: null,
      thumbnailHint: null,
      pipeline: {
        research: { status: "completed", startedAt: null, completedAt: now },
        script: { status: "not_started", startedAt: null, completedAt: null },
        hooks: { status: "not_started", startedAt: null, completedAt: null },
        title: { status: "not_started", startedAt: null, completedAt: null },
        packaging: {
          status: "not_started",
          startedAt: null,
          completedAt: null,
        },
      },
      overallStatus: "in_progress" as const,
      currentStep: "research" as const,
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const project = await this.repo.create(projectData);
    await this.contentRepo.updateIdea(ideaId, { videoProjectId: project.id });
    return project;
  };

  createFromTitle = async (owner: RecordOwner, title: string): Promise<IVideoProject> => {
    assertOwner(owner.userId);
    if (!title || !title.trim()) {
      throw BadRequest("title is required");
    }
    const formatted = await formatGeneratedTitle(title.trim(), owner);
    const [saved] = await this.contentRepo.batchSaveIdeas([formatted]);
    return this.create(owner, saved.id);
  };

  getProjectsByIdea = async (ideaId: string, owner: RecordOwner): Promise<IVideoProject[]> => {
    return this.repo.findByIdeaId(ideaId, owner.accountId);
  };

  list = async (
    owner: RecordOwner,
    { status, limit = 20, cursor }: { status?: OverallStatus; limit?: number; cursor?: string }
  ) => {
    const validStatuses: OverallStatus[] = ["in_progress", "completed", "stale"];
    if (status && !validStatuses.includes(status)) {
      throw BadRequest("Invalid status value");
    }

    const { projects, hasMore, nextCursor } = await this.repo.list(owner.accountId, {
      status,
      limit,
      cursor,
    });

    const mapped = projects.map((p) => ({
      id: p.id,
      title: p.title,
      currentStep: p.currentStep,
      overallStatus: p.overallStatus,
      updatedAt: p.updatedAt,
      createdAt: p.createdAt,
      thumbnailHint: p.thumbnailHint,
    }));

    return { projects: mapped, hasMore, nextCursor };
  };

  getById = async (projectId: string, owner: RecordOwner): Promise<IVideoProject> => {
    const project = await this.repo.findById(projectId);
    if (!project || project.isDeleted) {
      throw NotFound();
    }
    if (project.accountId !== owner.accountId) {
      await forbidCrossAccount(this.accounts, project.accountId, owner);
    }
    return project;
  };

  /**
   * Read-time safety net (computed, NOT persisted): if a step's linking resource
   * exists but the step is still not_started/in_progress, present it as completed.
   * Never touches `stale` or already-`completed` steps. Used only on the client read path,
   * so the shared getById (used by mutators) keeps returning the raw stored doc.
   */
  private reconcileView = (project: IVideoProject): IVideoProject => {
    const linked: Record<string, boolean> = {
      script: project.scriptId != null,
      hooks: project.selectedHookIndex != null,
    };
    const pipeline = { ...project.pipeline };
    // packaging is NOT inferred from packagingId: persist-on-generate creates the
    // packaging doc on the FIRST item (title), so packagingId is set mid-pipeline.
    // packaging + title completion is authoritative from the stored step status
    // (title completes on select, packaging auto-completes when its 3 items exist).
    (["script", "hooks"] as StepName[]).forEach((step) => {
      const s = pipeline[step];
      if (linked[step] && (s.status === "not_started" || s.status === "in_progress")) {
        pipeline[step] = { ...s, status: "completed" };
      }
    });
    // Guided next-step CTA (6A.4 / §5): the first step not yet completed — covers
    // jumping (finds the real gap), stale (stale ≠ completed → surface it), and the
    // terminal case (all completed → null). FE renders the "continue" CTA from this
    // instead of re-deriving the pipeline order.
    const recommendedNextStep =
      STEP_ORDER.find((s) => pipeline[s].status !== "completed") ?? null;
    return {
      ...project,
      pipeline,
      overallStatus: computeOverallStatus(pipeline),
      recommendedNextStep,
    };
  };

  getReconciledById = async (projectId: string, owner: RecordOwner): Promise<IVideoProject> => {
    const project = await this.getById(projectId, owner);
    return this.reconcileView(project);
  };

  /**
   * Clear the project's stale packaging step after the last stale packaging item is
   * regenerated, then recompute overallStatus. Only ever flips `stale -> completed`
   * (so it can't throw like completeStep on a not_started step) and is a no-op when
   * the step isn't stale. overallStatus stays "stale" if script/hooks are still stale.
   * Caller must gate on "no packaging item remains stale".
   */
  refreshPackagingStep = async (projectId: string, owner: RecordOwner): Promise<void> => {
    const project = await this.getById(projectId, owner);
    if (project.pipeline.packaging.status !== "stale") return;

    const updatedPipeline: IVideoProjectPipeline = {
      ...project.pipeline,
      packaging: { ...project.pipeline.packaging, status: "completed" },
    };

    await this.repo.update(projectId, {
      "pipeline.packaging.status": "completed",
      "pipeline.packaging.staleReason": null,
      overallStatus: computeOverallStatus(updatedPipeline),
    });
  };

  // Keep the dashboard thumbnailHint in sync when the thumbnail is regenerated
  // (it is otherwise only set at save-time via linkResource, so a regen would leave it stale).
  setThumbnailHint = async (projectId: string, hint: string | null, owner: RecordOwner): Promise<void> => {
    await this.getById(projectId, owner);
    await this.repo.update(projectId, { thumbnailHint: hint });
  };

  update = async (
    projectId: string,
    owner: RecordOwner,
    data: { title?: string }
  ) => {
    await this.getById(projectId, owner);

    if (!data.title || typeof data.title !== "string" || data.title.trim() === "") {
      throw BadRequest("title is required");
    }

    await this.repo.update(projectId, { title: data.title });
    return { title: data.title };
  };

  delete = async (projectId: string, owner: RecordOwner) => {
    const project = await this.repo.findById(projectId);
    if (!project) {
      throw NotFound();
    }
    if (project.accountId !== owner.accountId) {
      await forbidCrossAccount(this.accounts, project.accountId, owner);
    }
    if (project.isDeleted) {
      return project;
    }
    await this.repo.update(projectId, {
      isDeleted: true,
      deletedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    // Release the source idea. It keeps `videoProjectId` otherwise, so the idea
    // card stays stuck on "View Project" pointing at a deleted project forever —
    // deleting a project is the documented way to undo a wrong pick, and it was
    // burning the idea instead of freeing it. Best-effort: the delete already
    // succeeded and must not fail on this.
    if (project.ideaId) {
      try {
        await this.contentRepo.updateIdea(project.ideaId, { videoProjectId: null });
      } catch (unlinkError) {
        console.error(JSON.stringify({ event: "idea_unlink_failed", projectId, ideaId: project.ideaId, message: (unlinkError as Error)?.message }));
      }
    }

    return { id: projectId, isDeleted: true };
  };

  startStep = async (projectId: string, stepName: string, owner: RecordOwner) => {
    if (!VALID_MUTABLE_STEPS.includes(stepName)) {
      throw BadRequest(
        `Invalid step. Must be one of: ${VALID_MUTABLE_STEPS.join(", ")}`
      );
    }

    const project = await this.getById(projectId, owner);
    const step = stepName as StepName;
    const currentStatus = project.pipeline[step].status;

    if (currentStatus === "completed") {
      return { id: project.id, currentStep: project.currentStep };
    }

    // Re-starting an in_progress step refreshes startedAt: it doubles as the
    // in-flight-lock heartbeat (script streaming), so a retry after a crashed
    // run must re-arm the lock rather than run under the stale timestamp.
    if (currentStatus === "in_progress") {
      await this.repo.update(projectId, {
        [`pipeline.${step}.startedAt`]: firebase.firestore.FieldValue.serverTimestamp(),
      });
      return { id: project.id, currentStep: project.currentStep };
    }

    const updates: Record<string, unknown> = {
      [`pipeline.${step}.status`]: "in_progress",
      [`pipeline.${step}.startedAt`]: firebase.firestore.FieldValue.serverTimestamp(),
    };

    // Advance currentStep only if stepName is ahead of current
    const currentStepIndex = STEP_ORDER.indexOf(project.currentStep);
    const newStepIndex = STEP_ORDER.indexOf(step);
    if (newStepIndex > currentStepIndex) {
      updates["currentStep"] = step;
    }

    await this.repo.update(projectId, updates);
    return { id: projectId, currentStep: step };
  };

  // Internal (no route): roll back an in_progress step that produced nothing,
  // so the client can retry immediately instead of waiting out the in-flight lock.
  abandonStep = async (projectId: string, stepName: StepName) => {
    await this.repo.update(projectId, {
      [`pipeline.${stepName}.status`]: "not_started",
      [`pipeline.${stepName}.startedAt`]: null,
    });
  };

  completeStep = async (projectId: string, stepName: string, owner: RecordOwner) => {
    if (!VALID_MUTABLE_STEPS.includes(stepName)) {
      throw BadRequest(
        `Invalid step. Must be one of: ${VALID_MUTABLE_STEPS.join(", ")}`
      );
    }

    const project = await this.getById(projectId, owner);
    const step = stepName as StepName;
    const currentStatus = project.pipeline[step].status;

    if (currentStatus === "not_started") {
      throw BadRequest("Cannot complete a step that has not been started");
    }

    // Idempotent no-op, but it must still answer with the full shape the client
    // patches from — a partial body here crashes the same reducer.
    if (currentStatus === "completed") {
      return {
        id: project.id,
        currentStep: project.currentStep,
        pipeline: project.pipeline,
        overallStatus: project.overallStatus,
      };
    }

    const updates: Record<string, unknown> = {
      [`pipeline.${step}.status`]: "completed",
      [`pipeline.${step}.completedAt`]: firebase.firestore.FieldValue.serverTimestamp(),
      // The step is accepted as current again, so the reason it went stale no
      // longer applies — leaving it would resurface on the next cascade.
      [`pipeline.${step}.staleReason`]: null,
    };

    // Auto-advance currentStep to the next in STEP_ORDER (terminal step stays put).
    const nextStep = STEP_ORDER[STEP_ORDER.indexOf(step) + 1] ?? step;
    updates["currentStep"] = nextStep;

    // Check if all steps are completed
    const updatedPipeline = { ...project.pipeline };
    (updatedPipeline[step] as StepState) = {
      ...updatedPipeline[step],
      status: "completed",
    };

    // Recompute unconditionally, not just on "all completed". Completing a STALE
    // step ("Keep as-is") used to leave overallStatus at "stale", so the dashboard
    // kept its "Needs Update" badge for a project with nothing stale left in it.
    const newOverallStatus = computeOverallStatus(updatedPipeline);
    updates["overallStatus"] = newOverallStatus;

    await this.repo.update(projectId, updates);

    // "Keep as-is" completes a STALE packaging step without regenerating anything.
    // The packaging document carries its own stale markers, and the per-card
    // "Outdated" chips read from those — so without this they'd outlive the banner
    // the creator just dismissed. Best-effort: the step transition above is the
    // part that must not fail.
    if (step === "packaging" && currentStatus === "stale" && project.packagingId) {
      try {
        await this.packagingRepo.clearStale(project.packagingId);
      } catch (clearError) {
        console.error(JSON.stringify({ event: "packaging_stale_clear_failed", projectId, packagingId: project.packagingId, message: (clearError as Error)?.message }));
      }
    }

    // The client patches its cached project from this response. Returning only
    // {id,currentStep} left its reducer reading `payload.pipeline.…` on undefined,
    // which threw and aborted the whole state update — so every "Keep as-is" click
    // toasted success while the stale banner stayed exactly where it was.
    return {
      id: projectId,
      currentStep: nextStep,
      pipeline: updatedPipeline,
      overallStatus: newOverallStatus,
    };
  };

  linkResource = async (
    projectId: string,
    resourceType: string,
    resourceId: string,
    owner: RecordOwner
  ) => {
    const validTypes = ["script", "hooks", "packaging"];
    if (!validTypes.includes(resourceType)) {
      throw BadRequest(
        `Invalid resourceType. Must be one of: ${validTypes.join(", ")}`
      );
    }

    if (!resourceId || resourceId.trim() === "") {
      throw BadRequest("resourceId is required");
    }

    await this.getById(projectId, owner);

    // Validating the PROJECT is not enough — the resource id comes straight from the
    // request body. Without this, anyone holding a leaked scriptId/hooksId/packagingId
    // could attach it to their own project and read it back: `packaging` copies the
    // selected thumbnail brief onto the project, `script` is returned near-verbatim by
    // generate-shorts, and `hooks` feeds five separate generation paths. Becomes routine
    // after sharing ships — a removed member still knows every id in the channel.
    const resource =
      resourceType === "script"
        ? await this.contentRepo.getScriptById(resourceId)
        : resourceType === "hooks"
          ? await this.hooksRepo.findById(resourceId)
          : await this.packagingRepo.get(resourceId);

    if (!resource) {
      throw NotFound(`${resourceType} not found`);
    }
    if (resource.accountId !== owner.accountId) {
      await forbidCrossAccount(this.accounts, resource.accountId, owner);
    }

    const fieldMap: Record<string, string> = {
      script: "scriptId",
      hooks: "hooksId",
      packaging: "packagingId",
    };

    const updates: Record<string, unknown> = {
      [fieldMap[resourceType]]: resourceId,
    };

    if (resourceType === "packaging") {
      // Canonical `thumbnail` is a string[] of design briefs. The hint is the
      // brief the user SELECTED — picking variation 3 and seeing variation 1 on
      // the dashboard made the selection look inert. Falls back to the first.
      const packagingDoc = resource as IPackaging;
      const briefs = packagingDoc.thumbnail;
      const picked = packagingDoc.selectedThumbnailIndex ?? 0;
      updates["thumbnailHint"] = briefs?.[picked] ?? briefs?.[0] ?? null;
    }

    await this.repo.update(projectId, updates);
    return { id: projectId, ...updates };
  };

  setSelectedHook = async (
    projectId: string,
    hooksId: string,
    hookIndex: number,
    owner: RecordOwner
  ): Promise<{ id: string; hooksId: string; selectedHookIndex: number }> => {
    await this.getById(projectId, owner);

    await this.repo.update(projectId, { hooksId, selectedHookIndex: hookIndex });
    return { id: projectId, hooksId, selectedHookIndex: hookIndex };
  };

  // Title regeneration invalidates the previous pick the same way a hooks
  // regeneration does: the variations the creator chose from no longer exist, and
  // the project is still NAMED after one of them. Move the step back to
  // "needs a pick" so the UI prompts instead of showing a green step over a title
  // that isn't in the list any more.
  reopenTitleStep = async (projectId: string, owner: RecordOwner): Promise<void> => {
    await this.getById(projectId, owner);
    await this.repo.update(projectId, {
      "pipeline.title.status": "in_progress",
      "pipeline.title.completedAt": null,
    });
  };

  clearSelectedHook = async (projectId: string, owner: RecordOwner): Promise<void> => {
    await this.getById(projectId, owner);
    // Regenerating hooks invalidates the prior selection but NOT the batch
    // itself — the batch doc is updated in place, so hooksId still points at a
    // valid (newer) batch and must be kept. Clear only the selection and move
    // the step back to in_progress so it reads as "needs re-selection" instead
    // of staying "completed" with nothing selected.
    await this.repo.update(projectId, {
      selectedHookIndex: null,
      "pipeline.hooks.status": "in_progress",
      "pipeline.hooks.completedAt": null,
    });
  };

  getByScriptId = async (scriptId: string, owner: RecordOwner): Promise<IVideoProject | null> => {
    return this.repo.findByScriptId(scriptId, owner.accountId);
  };

  markStale = async (projectId: string, fromStep: StepName): Promise<void> => {
    const project = await this.repo.findById(projectId);
    if (!project) return;

    // Derived, not written down: everything after `fromStep` in STEP_ORDER.
    const stepsToMark = downstreamOf(fromStep as StepName);
    const updates: Record<string, unknown> = {};

    // Record WHAT invalidated each step alongside the flag. The screens had no
    // source for this, so they hardcoded "the script has been regenerated" — which
    // is wrong for every cascade that didn't start at the script.
    const reason = `${fromStep}_regenerated` as StaleReason;

    for (const step of stepsToMark) {
      if (project.pipeline[step].status !== "not_started") {
        updates[`pipeline.${step}.status`] = "stale";
        updates[`pipeline.${step}.staleReason`] = reason;
      }
    }

    if (Object.keys(updates).length === 0) return;

    // A stale downstream step makes the whole project stale until it's re-completed.
    updates["overallStatus"] = "stale";

    await this.repo.update(projectId, updates);
  };

  markPackagingDocumentStale = async (projectId: string, reason: StaleReason): Promise<void> => {
    const project = await this.repo.findById(projectId);
    if (!project || !project.packagingId) return;

    await this.packagingRepo.markStale(project.packagingId, reason);
  };
}

export default VideoProjectService;
