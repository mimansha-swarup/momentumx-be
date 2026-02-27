import { firebase } from "../config/firebase.js";
import ContentRepository from "../repository/content.repository.js";
import PackagingRepository from "../repository/packaging.repository.js";
import VideoProjectRepository from "../repository/video-project.repository.js";
import {
  IVideoProject,
  OverallStatus,
  StepName,
  StepState,
} from "../types/routes/video-project.js";

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
      const err = new Error("Topic not found") as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    if (topic.createdBy !== userId) {
      const err = new Error("Forbidden") as Error & { statusCode: number };
      err.statusCode = 403;
      throw err;
    }

    const now = firebase.firestore.FieldValue.serverTimestamp();
    const projectData = {
      userId,
      workingTitle: topic.title as string,
      topicId,
      scriptId: null,
      hooksId: null,
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
          items: {
            titles: "not_started",
            description: "not_started",
            thumbnail: "not_started",
            shorts: "not_started",
          },
        },
      },
      overallStatus: "in_progress" as const,
      currentStep: "research" as const,
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      lastUpdatedAt: now,
    };

    return this.repo.create(projectData);
  };

  list = async (
    userId: string,
    { status, limit = 20, cursor }: { status?: OverallStatus; limit?: number; cursor?: string }
  ) => {
    const validStatuses: OverallStatus[] = ["in_progress", "completed", "stale"];
    if (status && !validStatuses.includes(status)) {
      const err = new Error("Invalid status value") as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }

    const { projects, hasMore, nextCursor } = await this.repo.list(userId, {
      status,
      limit,
      cursor,
    });

    const mapped = projects.map((p) => ({
      id: p.id,
      workingTitle: p.workingTitle,
      currentStep: p.currentStep,
      overallStatus: p.overallStatus,
      lastUpdatedAt: p.lastUpdatedAt,
      createdAt: p.createdAt,
      thumbnailHint: p.thumbnailHint,
    }));

    return { projects: mapped, hasMore, nextCursor };
  };

  getById = async (projectId: string, userId: string): Promise<IVideoProject> => {
    const project = await this.repo.findById(projectId);
    if (!project || project.isDeleted) {
      const err = new Error("Not found") as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    if (project.userId !== userId) {
      const err = new Error("Forbidden") as Error & { statusCode: number };
      err.statusCode = 403;
      throw err;
    }
    return project;
  };

  update = async (
    projectId: string,
    userId: string,
    data: { workingTitle?: string }
  ) => {
    await this.getById(projectId, userId);

    if (!data.workingTitle || typeof data.workingTitle !== "string" || data.workingTitle.trim() === "") {
      const err = new Error("workingTitle is required") as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }

    await this.repo.update(projectId, { workingTitle: data.workingTitle });
    return { workingTitle: data.workingTitle };
  };

  delete = async (projectId: string, userId: string) => {
    const project = await this.repo.findById(projectId);
    if (!project) {
      const err = new Error("Not found") as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    if (project.userId !== userId) {
      const err = new Error("Forbidden") as Error & { statusCode: number };
      err.statusCode = 403;
      throw err;
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
      const err = new Error(
        `Invalid step. Must be one of: ${VALID_MUTABLE_STEPS.join(", ")}`
      ) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
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
      const err = new Error(
        `Invalid step. Must be one of: ${VALID_MUTABLE_STEPS.join(", ")}`
      ) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }

    const project = await this.getById(projectId, userId);
    const step = stepName as StepName;
    const currentStatus = project.pipeline[step].status;

    if (currentStatus === "not_started") {
      const err = new Error("Cannot complete a step that has not been started") as Error & {
        statusCode: number;
      };
      err.statusCode = 400;
      throw err;
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
      const err = new Error(
        `Invalid resourceType. Must be one of: ${validTypes.join(", ")}`
      ) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }

    if (!resourceId || resourceId.trim() === "") {
      const err = new Error("resourceId is required") as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
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

    if (project.overallStatus === "completed") {
      updates["overallStatus"] = "in_progress";
    }

    await this.repo.update(projectId, updates);
  };
}

export default VideoProjectService;
