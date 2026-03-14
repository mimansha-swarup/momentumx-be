import { firebase } from "../config/firebase.js";
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
                const err = new Error("Topic not found");
                err.statusCode = 404;
                throw err;
            }
            if (topic.createdBy !== userId) {
                const err = new Error("Forbidden");
                err.statusCode = 403;
                throw err;
            }
            const now = firebase.firestore.FieldValue.serverTimestamp();
            const projectData = {
                userId,
                workingTitle: topic.title,
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
                lastUpdatedAt: now,
            };
            const project = await this.repo.create(projectData);
            await this.contentRepo.updateTopic(topicId, { videoProjectId: project.id });
            return project;
        };
        this.list = async (userId, { status, limit = 20, cursor }) => {
            const validStatuses = ["in_progress", "completed", "stale"];
            if (status && !validStatuses.includes(status)) {
                const err = new Error("Invalid status value");
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
        this.getById = async (projectId, userId) => {
            const project = await this.repo.findById(projectId);
            if (!project || project.isDeleted) {
                const err = new Error("Not found");
                err.statusCode = 404;
                throw err;
            }
            if (project.userId !== userId) {
                const err = new Error("Forbidden");
                err.statusCode = 403;
                throw err;
            }
            return project;
        };
        this.update = async (projectId, userId, data) => {
            await this.getById(projectId, userId);
            if (!data.workingTitle || typeof data.workingTitle !== "string" || data.workingTitle.trim() === "") {
                const err = new Error("workingTitle is required");
                err.statusCode = 400;
                throw err;
            }
            await this.repo.update(projectId, { workingTitle: data.workingTitle });
            return { workingTitle: data.workingTitle };
        };
        this.delete = async (projectId, userId) => {
            const project = await this.repo.findById(projectId);
            if (!project) {
                const err = new Error("Not found");
                err.statusCode = 404;
                throw err;
            }
            if (project.userId !== userId) {
                const err = new Error("Forbidden");
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
        this.startStep = async (projectId, stepName, userId) => {
            if (!VALID_MUTABLE_STEPS.includes(stepName)) {
                const err = new Error(`Invalid step. Must be one of: ${VALID_MUTABLE_STEPS.join(", ")}`);
                err.statusCode = 400;
                throw err;
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
                const err = new Error(`Invalid step. Must be one of: ${VALID_MUTABLE_STEPS.join(", ")}`);
                err.statusCode = 400;
                throw err;
            }
            const project = await this.getById(projectId, userId);
            const step = stepName;
            const currentStatus = project.pipeline[step].status;
            if (currentStatus === "not_started") {
                const err = new Error("Cannot complete a step that has not been started");
                err.statusCode = 400;
                throw err;
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
                const err = new Error(`Invalid resourceType. Must be one of: ${validTypes.join(", ")}`);
                err.statusCode = 400;
                throw err;
            }
            if (!resourceId || resourceId.trim() === "") {
                const err = new Error("resourceId is required");
                err.statusCode = 400;
                throw err;
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
            if (project.overallStatus === "completed") {
                updates["overallStatus"] = "in_progress";
            }
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
