import { firebase } from "../config/firebase.js";
import { BadRequest, Forbidden, NotFound } from "../utlils/errors.js";
const STEP_ORDER = ["research", "script", "hooks", "packaging"];
const NEXT_STEP = {
    script: "hooks",
    hooks: "packaging",
    packaging: "packaging",
};
const STALE_CASCADE = {
    research: ["script", "hooks", "packaging"],
    script: ["hooks", "packaging"],
    hooks: ["packaging"],
};
const VALID_MUTABLE_STEPS = ["script", "hooks", "packaging"];
class VideoProjectService {
    constructor(repo, contentRepo, packagingRepo) {
        this.repo = repo;
        this.contentRepo = contentRepo;
        this.packagingRepo = packagingRepo;
        this.create = async (userId, topicId) => {
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
                title: topic.title,
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
                overallStatus: "in_progress",
                currentStep: "research",
                isDeleted: false,
                deletedAt: null,
                createdAt: now,
                updatedAt: now,
            };
            const project = await this.repo.create(projectData);
            await this.contentRepo.updateTopic(topicId, { videoProjectId: project.id });
            return project;
        };
        this.list = async (userId, { status, limit = 20, cursor }) => {
            const validStatuses = ["in_progress", "completed", "stale"];
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
        this.getById = async (projectId, userId) => {
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
        this.reconcileView = (project) => {
            const linked = {
                script: project.scriptId != null,
                hooks: project.selectedHookIndex != null,
                packaging: project.packagingId != null,
            };
            const pipeline = { ...project.pipeline };
            ["script", "hooks", "packaging"].forEach((step) => {
                const s = pipeline[step];
                if (linked[step] && (s.status === "not_started" || s.status === "in_progress")) {
                    pipeline[step] = { ...s, status: "completed" };
                }
            });
            const statuses = STEP_ORDER.map((st) => pipeline[st].status);
            const overallStatus = statuses.includes("stale")
                ? "stale"
                : statuses.every((x) => x === "completed")
                    ? "completed"
                    : "in_progress";
            return { ...project, pipeline, overallStatus };
        };
        this.getReconciledById = async (projectId, userId) => {
            const project = await this.getById(projectId, userId);
            return this.reconcileView(project);
        };
        this.update = async (projectId, userId, data) => {
            await this.getById(projectId, userId);
            if (!data.title || typeof data.title !== "string" || data.title.trim() === "") {
                throw BadRequest("title is required");
            }
            await this.repo.update(projectId, { title: data.title });
            return { title: data.title };
        };
        this.delete = async (projectId, userId) => {
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
        this.startStep = async (projectId, stepName, userId) => {
            if (!VALID_MUTABLE_STEPS.includes(stepName)) {
                throw BadRequest(`Invalid step. Must be one of: ${VALID_MUTABLE_STEPS.join(", ")}`);
            }
            const project = await this.getById(projectId, userId);
            const step = stepName;
            const currentStatus = project.pipeline[step].status;
            if (currentStatus === "in_progress" || currentStatus === "completed") {
                return { id: project.id, currentStep: project.currentStep };
            }
            const updates = {
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
        this.completeStep = async (projectId, stepName, userId) => {
            if (!VALID_MUTABLE_STEPS.includes(stepName)) {
                throw BadRequest(`Invalid step. Must be one of: ${VALID_MUTABLE_STEPS.join(", ")}`);
            }
            const project = await this.getById(projectId, userId);
            const step = stepName;
            const currentStatus = project.pipeline[step].status;
            if (currentStatus === "not_started") {
                throw BadRequest("Cannot complete a step that has not been started");
            }
            if (currentStatus === "completed") {
                return { id: project.id, currentStep: project.currentStep };
            }
            const updates = {
                [`pipeline.${step}.status`]: "completed",
                [`pipeline.${step}.completedAt`]: firebase.firestore.FieldValue.serverTimestamp(),
            };
            // Auto-advance currentStep
            const nextStep = NEXT_STEP[step];
            updates["currentStep"] = nextStep;
            // Check if all steps are completed
            const updatedPipeline = { ...project.pipeline };
            updatedPipeline[step] = {
                ...updatedPipeline[step],
                status: "completed",
            };
            const allCompleted = STEP_ORDER.every((s) => s === step ? true : updatedPipeline[s].status === "completed");
            if (allCompleted) {
                updates["overallStatus"] = "completed";
            }
            await this.repo.update(projectId, updates);
            return { id: projectId, currentStep: nextStep };
        };
        this.linkResource = async (projectId, resourceType, resourceId, userId) => {
            const validTypes = ["script", "hooks", "packaging"];
            if (!validTypes.includes(resourceType)) {
                throw BadRequest(`Invalid resourceType. Must be one of: ${validTypes.join(", ")}`);
            }
            if (!resourceId || resourceId.trim() === "") {
                throw BadRequest("resourceId is required");
            }
            await this.getById(projectId, userId);
            const fieldMap = {
                script: "scriptId",
                hooks: "hooksId",
                packaging: "packagingId",
            };
            const updates = {
                [fieldMap[resourceType]]: resourceId,
            };
            if (resourceType === "packaging") {
                const packagingDoc = await this.packagingRepo.get(resourceId);
                if (packagingDoc) {
                    const thumbnails = packagingDoc.thumbnails;
                    updates["thumbnailHint"] = thumbnails?.[0]?.textOverlay ?? null;
                }
            }
            await this.repo.update(projectId, updates);
            return { id: projectId, ...updates };
        };
        this.setSelectedHook = async (projectId, hooksId, hookIndex, userId) => {
            await this.getById(projectId, userId);
            await this.repo.update(projectId, { hooksId, selectedHookIndex: hookIndex });
            return { id: projectId, hooksId, selectedHookIndex: hookIndex };
        };
        this.clearSelectedHook = async (projectId, userId) => {
            await this.getById(projectId, userId);
            await this.repo.update(projectId, { selectedHookIndex: null, hooksId: null });
        };
        this.getByScriptId = async (scriptId, userId) => {
            return this.repo.findByScriptId(scriptId, userId);
        };
        this.markStale = async (projectId, fromStep) => {
            const project = await this.repo.findById(projectId);
            if (!project)
                return;
            const stepsToMark = STALE_CASCADE[fromStep] ?? [];
            const updates = {};
            for (const step of stepsToMark) {
                if (project.pipeline[step].status !== "not_started") {
                    updates[`pipeline.${step}.status`] = "stale";
                }
            }
            if (Object.keys(updates).length === 0)
                return;
            // A stale downstream step makes the whole project stale until it's re-completed.
            updates["overallStatus"] = "stale";
            await this.repo.update(projectId, updates);
        };
        this.markPackagingDocumentStale = async (projectId, reason) => {
            const project = await this.repo.findById(projectId);
            if (!project || !project.packagingId)
                return;
            await this.packagingRepo.markStale(project.packagingId, reason);
        };
    }
}
export default VideoProjectService;
