import { firebase } from "../config/firebase.js";
import { BadRequest, Forbidden, NotFound } from "../utlils/errors.js";
import { formatGeneratedTitle } from "../utlils/content.js";
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
// Single source of the overall-status arithmetic, shared by reconcileView (read path)
// and refreshPackagingStep (write path) so the two can never drift.
const computeOverallStatus = (pipeline) => {
    const statuses = STEP_ORDER.map((st) => pipeline[st].status);
    return statuses.includes("stale")
        ? "stale"
        : statuses.every((x) => x === "completed")
            ? "completed"
            : "in_progress";
};
class VideoProjectService {
    constructor(repo, contentRepo, packagingRepo) {
        this.repo = repo;
        this.contentRepo = contentRepo;
        this.packagingRepo = packagingRepo;
        this.create = async (userId, ideaId) => {
            const idea = await this.contentRepo.getIdea(ideaId);
            if (!idea) {
                throw NotFound("Idea not found");
            }
            if (idea.createdBy !== userId) {
                throw Forbidden();
            }
            const now = firebase.firestore.FieldValue.serverTimestamp();
            const projectData = {
                createdBy: userId,
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
            await this.contentRepo.updateIdea(ideaId, { videoProjectId: project.id });
            return project;
        };
        this.createFromTitle = async (userId, title) => {
            if (!title || !title.trim()) {
                throw BadRequest("title is required");
            }
            const formatted = await formatGeneratedTitle(title.trim(), userId);
            const [saved] = await this.contentRepo.batchSaveIdeas([formatted]);
            return this.create(userId, saved.id);
        };
        this.getProjectsByIdea = async (ideaId, userId) => {
            return this.repo.findByIdeaId(ideaId, userId);
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
            // Guided next-step CTA (6A.4 / §5): the first step not yet completed — covers
            // jumping (finds the real gap), stale (stale ≠ completed → surface it), and the
            // terminal case (all completed → null). FE renders the "continue" CTA from this
            // instead of re-deriving the pipeline order.
            const recommendedNextStep = STEP_ORDER.find((s) => pipeline[s].status !== "completed") ?? null;
            return {
                ...project,
                pipeline,
                overallStatus: computeOverallStatus(pipeline),
                recommendedNextStep,
            };
        };
        this.getReconciledById = async (projectId, userId) => {
            const project = await this.getById(projectId, userId);
            return this.reconcileView(project);
        };
        /**
         * Clear the project's stale packaging step after the last stale packaging item is
         * regenerated, then recompute overallStatus. Only ever flips `stale -> completed`
         * (so it can't throw like completeStep on a not_started step) and is a no-op when
         * the step isn't stale. overallStatus stays "stale" if script/hooks are still stale.
         * Caller must gate on "no packaging item remains stale".
         */
        this.refreshPackagingStep = async (projectId, userId) => {
            const project = await this.getById(projectId, userId);
            if (project.pipeline.packaging.status !== "stale")
                return;
            const updatedPipeline = {
                ...project.pipeline,
                packaging: { ...project.pipeline.packaging, status: "completed" },
            };
            await this.repo.update(projectId, {
                "pipeline.packaging.status": "completed",
                overallStatus: computeOverallStatus(updatedPipeline),
            });
        };
        // Keep the dashboard thumbnailHint in sync when the thumbnail is regenerated
        // (it is otherwise only set at save-time via linkResource, so a regen would leave it stale).
        this.setThumbnailHint = async (projectId, hint, userId) => {
            await this.getById(projectId, userId);
            await this.repo.update(projectId, { thumbnailHint: hint });
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
        // Internal (no route): roll back an in_progress step that produced nothing,
        // so the client can retry immediately instead of waiting out the in-flight lock.
        this.abandonStep = async (projectId, stepName) => {
            await this.repo.update(projectId, {
                [`pipeline.${stepName}.status`]: "not_started",
                [`pipeline.${stepName}.startedAt`]: null,
            });
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
                    // Canonical `thumbnail` is a string[] of design briefs; the hint is the first one.
                    updates["thumbnailHint"] = packagingDoc.thumbnail?.[0] ?? null;
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
