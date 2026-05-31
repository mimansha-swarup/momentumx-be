import { firebase } from "../config/firebase.js";
import ContentRepository from "../repository/content.repository.js";
import PackagingRepository from "../repository/packaging.repository.js";
import VideoProjectRepository from "../repository/video-project.repository.js";
import {
  IVideoProject,
  OverallStatus,
  StaleReason,
  StepName,
  StepState,
} from "../types/routes/video-project.js";
import { BadRequest, Forbidden, NotFound } from "../utlils/errors.js";

const STEP_ORDER: StepName[] = ["research", "script", "hooks", "packaging"];
const NEXT_STEP: Record<string, StepName> = {
  script: "hooks",
  hooks: "packaging",
  packaging: "packaging",
};
const STALE_CASCADE: Record<string, StepName[]> = {
  research: ["script", "hooks", "packaging"],
  script: ["hooks", "packaging"],
  hooks: ["packaging"],
};
const VALID_MUTABLE_STEPS = ["script", "hooks", "packaging"];

class VideoProjectService {
  constructor(
    private repo: VideoProjectRepository,
    private contentRepo: ContentRepository,
    private packagingRepo: PackagingRepository
  ) {}

  create = async (userId: string, topicId: string): Promise<IVideoProject> => {
    const topic = await this.contentRepo.getTopic(topicId);
    if (!topic) {
      throw NotFound("Topic not found");
    }
    if (topic.createdBy !== userId) {
      throw Forbidden();
    }

    const now = firebase.firestore.FieldValue.serverTimestamp();
    const projectData = {
      createdBy: userId,
      title: topic.title as string,
      topicId,
      scriptId: null,
      hooksId: null,
      selectedHookIndex: null,
      packagingId: null,
      thumbnailHint: null,
      pipeline: {
        research: { status: "completed", startedAt: null, completedAt: now },
        script: { status: "not_started", startedAt: null, completedAt: null },
        hooks: { status: "not_started", startedAt: null, completedAt: null },
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
    await this.contentRepo.updateTopic(topicId, { videoProjectId: project.id });
    return project;
  };

  list = async (
    userId: string,
    { status, limit = 20, cursor }: { status?: OverallStatus; limit?: number; cursor?: string }
  ) => {
    const validStatuses: OverallStatus[] = ["in_progress", "completed", "stale"];
    if (status && !validStatuses.includes(status)) {
      throw BadRequest("Invalid status value");
    }

    const { projects, hasMore, nextCursor } = await this.repo.list(userId, {
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

  getById = async (projectId: string, userId: string): Promise<IVideoProject> => {
    const project = await this.repo.findById(projectId);
    if (!project || project.isDeleted) {
      throw NotFound();
    }
    if (project.createdBy !== userId) {
      throw Forbidden();
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
      packaging: project.packagingId != null,
    };
    const pipeline = { ...project.pipeline };
    (["script", "hooks", "packaging"] as StepName[]).forEach((step) => {
      const s = pipeline[step];
      if (linked[step] && (s.status === "not_started" || s.status === "in_progress")) {
        pipeline[step] = { ...s, status: "completed" };
      }
    });
    const statuses = STEP_ORDER.map((st) => pipeline[st].status);
    const overallStatus: OverallStatus = statuses.includes("stale")
      ? "stale"
      : statuses.every((x) => x === "completed")
        ? "completed"
        : "in_progress";
    return { ...project, pipeline, overallStatus };
  };

  getReconciledById = async (projectId: string, userId: string): Promise<IVideoProject> => {
    const project = await this.getById(projectId, userId);
    return this.reconcileView(project);
  };

  update = async (
    projectId: string,
    userId: string,
    data: { title?: string }
  ) => {
    await this.getById(projectId, userId);

    if (!data.title || typeof data.title !== "string" || data.title.trim() === "") {
      throw BadRequest("title is required");
    }

    await this.repo.update(projectId, { title: data.title });
    return { title: data.title };
  };

  delete = async (projectId: string, userId: string) => {
    const project = await this.repo.findById(projectId);
    if (!project) {
      throw NotFound();
    }
    if (project.createdBy !== userId) {
      throw Forbidden();
    }
    if (project.isDeleted) {
      return project;
    }
    await this.repo.update(projectId, {
      isDeleted: true,
      deletedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    return { id: projectId, isDeleted: true };
  };

  startStep = async (projectId: string, stepName: string, userId: string) => {
    if (!VALID_MUTABLE_STEPS.includes(stepName)) {
      throw BadRequest(
        `Invalid step. Must be one of: ${VALID_MUTABLE_STEPS.join(", ")}`
      );
    }

    const project = await this.getById(projectId, userId);
    const step = stepName as StepName;
    const currentStatus = project.pipeline[step].status;

    if (currentStatus === "in_progress" || currentStatus === "completed") {
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

  completeStep = async (projectId: string, stepName: string, userId: string) => {
    if (!VALID_MUTABLE_STEPS.includes(stepName)) {
      throw BadRequest(
        `Invalid step. Must be one of: ${VALID_MUTABLE_STEPS.join(", ")}`
      );
    }

    const project = await this.getById(projectId, userId);
    const step = stepName as StepName;
    const currentStatus = project.pipeline[step].status;

    if (currentStatus === "not_started") {
      throw BadRequest("Cannot complete a step that has not been started");
    }

    if (currentStatus === "completed") {
      return { id: project.id, currentStep: project.currentStep };
    }

    const updates: Record<string, unknown> = {
      [`pipeline.${step}.status`]: "completed",
      [`pipeline.${step}.completedAt`]: firebase.firestore.FieldValue.serverTimestamp(),
    };

    // Auto-advance currentStep
    const nextStep = NEXT_STEP[step];
    updates["currentStep"] = nextStep;

    // Check if all steps are completed
    const updatedPipeline = { ...project.pipeline };
    (updatedPipeline[step] as StepState) = {
      ...updatedPipeline[step],
      status: "completed",
    };

    const allCompleted = STEP_ORDER.every(
      (s) => s === step ? true : updatedPipeline[s].status === "completed"
    );

    if (allCompleted) {
      updates["overallStatus"] = "completed";
    }

    await this.repo.update(projectId, updates);
    return { id: projectId, currentStep: nextStep };
  };

  linkResource = async (
    projectId: string,
    resourceType: string,
    resourceId: string,
    userId: string
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

    await this.getById(projectId, userId);

    const fieldMap: Record<string, string> = {
      script: "scriptId",
      hooks: "hooksId",
      packaging: "packagingId",
    };

    const updates: Record<string, unknown> = {
      [fieldMap[resourceType]]: resourceId,
    };

    if (resourceType === "packaging") {
      const packagingDoc = await this.packagingRepo.get(resourceId);
      if (packagingDoc) {
        const thumbnails = (packagingDoc as Record<string, unknown>).thumbnails as
          | Array<{ textOverlay?: string }>
          | undefined;
        updates["thumbnailHint"] = thumbnails?.[0]?.textOverlay ?? null;
      }
    }

    await this.repo.update(projectId, updates);
    return { id: projectId, ...updates };
  };

  setSelectedHook = async (
    projectId: string,
    hooksId: string,
    hookIndex: number,
    userId: string
  ): Promise<{ id: string; hooksId: string; selectedHookIndex: number }> => {
    await this.getById(projectId, userId);

    await this.repo.update(projectId, { hooksId, selectedHookIndex: hookIndex });
    return { id: projectId, hooksId, selectedHookIndex: hookIndex };
  };

  clearSelectedHook = async (projectId: string, userId: string): Promise<void> => {
    await this.getById(projectId, userId);
    await this.repo.update(projectId, { selectedHookIndex: null, hooksId: null });
  };

  getByScriptId = async (scriptId: string, userId: string): Promise<IVideoProject | null> => {
    return this.repo.findByScriptId(scriptId, userId);
  };

  markStale = async (projectId: string, fromStep: StepName): Promise<void> => {
    const project = await this.repo.findById(projectId);
    if (!project) return;

    const stepsToMark = STALE_CASCADE[fromStep] ?? [];
    const updates: Record<string, unknown> = {};

    for (const step of stepsToMark) {
      if (project.pipeline[step].status !== "not_started") {
        updates[`pipeline.${step}.status`] = "stale";
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
