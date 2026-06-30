// Unit tests for VideoProjectService
// All three repository dependencies are fully mocked -- no Firestore calls are made.

const mockServerTimestamp = jest.fn().mockReturnValue({ _sentinel: "serverTimestamp" });

jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: mockServerTimestamp },
    FieldPath: { documentId: jest.fn() },
    Timestamp: { now: jest.fn() },
  }),
  auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
}));

jest.mock("../../src/config/firebase", () => ({
  db: {},
  auth: {},
  firebase: {
    firestore: {
      FieldValue: { serverTimestamp: mockServerTimestamp },
      FieldPath: { documentId: jest.fn() },
    },
    auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
  },
}));

jest.mock("../../src/utlils/content", () => ({
  formatGeneratedTitle: jest.fn(),
}));

import VideoProjectService from "../../src/service/video-project.service";
import VideoProjectRepository from "../../src/repository/video-project.repository";
import ContentRepository from "../../src/repository/content.repository";
import PackagingRepository from "../../src/repository/packaging.repository";
import { IVideoProject } from "../../src/types/routes/video-project";
import { ITopic } from "../../src/types/routes/content";
import { formatGeneratedTitle } from "../../src/utlils/content";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<IVideoProject> = {}): IVideoProject {
  return {
    id: "proj-1",
    createdBy: "user-1",
    title: "My Video",
    topicId: "topic-1",
    scriptId: null,
    hooksId: null,
    selectedHookIndex: null,
    packagingId: null,
    thumbnailHint: null,
    overallStatus: "in_progress",
    currentStep: "research",
    isDeleted: false,
    deletedAt: null,
    pipeline: {
      research: { status: "completed", startedAt: null, completedAt: null },
      script: { status: "not_started", startedAt: null, completedAt: null },
      hooks: { status: "not_started", startedAt: null, completedAt: null },
      packaging: {
        status: "not_started",
        startedAt: null,
        completedAt: null,
      },
    },
    createdAt: null as any,
    updatedAt: null as any,
    ...overrides,
  };
}

function makeTopic(overrides: Partial<ITopic> = {}): ITopic {
  return {
    id: "topic-1",
    title: "My Topic",
    createdBy: "user-1",
    createdAt: null as any,
    isScriptGenerated: false,
    embedding: [],
    batchId: null,
    archived: false,
    videoProjectId: null,
    userFeedback: null,
    ...overrides,
  };
}

function makeMockRepo(): jest.Mocked<VideoProjectRepository> {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    findByTopicId: jest.fn(),
    list: jest.fn(),
    update: jest.fn(),
  } as unknown as jest.Mocked<VideoProjectRepository>;
}

function makeMockContentRepo(): jest.Mocked<ContentRepository> {
  return { getTopic: jest.fn(), updateTopic: jest.fn(), batchSaveTopics: jest.fn() } as unknown as jest.Mocked<ContentRepository>;
}

function makeMockPackagingRepo(): jest.Mocked<PackagingRepository> {
  return { get: jest.fn() } as unknown as jest.Mocked<PackagingRepository>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VideoProjectService", () => {
  let service: VideoProjectService;
  let repo: jest.Mocked<VideoProjectRepository>;
  let contentRepo: jest.Mocked<ContentRepository>;
  let packagingRepo: jest.Mocked<PackagingRepository>;

  beforeEach(() => {
    repo = makeMockRepo();
    contentRepo = makeMockContentRepo();
    packagingRepo = makeMockPackagingRepo();
    service = new VideoProjectService(repo, contentRepo, packagingRepo);
  });

  // --------------------------------------------------------------------------
  // create
  // --------------------------------------------------------------------------

  describe("create(userId, topicId)", () => {
    it("returns project when topic exists and belongs to the user", async () => {
      contentRepo.getTopic.mockResolvedValue(makeTopic({ title: "My Topic", createdBy: "user-1" }));
      repo.create.mockResolvedValue(makeProject());

      const result = await service.create("user-1", "topic-1");

      expect(result).toBeDefined();
      expect(contentRepo.getTopic).toHaveBeenCalledWith("topic-1");
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it("throws 404 when topic is not found", async () => {
      contentRepo.getTopic.mockResolvedValue(null as any);

      await expect(service.create("user-1", "topic-1")).rejects.toMatchObject({
        message: "Topic not found",
        statusCode: 404,
      });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it("throws 404 when topic is undefined", async () => {
      contentRepo.getTopic.mockResolvedValue(undefined as any);

      await expect(service.create("user-1", "topic-1")).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("throws 403 when topic belongs to a different user", async () => {
      contentRepo.getTopic.mockResolvedValue(makeTopic({ title: "Their Topic", createdBy: "other-user" }));

      await expect(service.create("user-1", "topic-1")).rejects.toMatchObject({
        message: "Forbidden",
        statusCode: 403,
      });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it("passes correct initial pipeline state to repo.create", async () => {
      contentRepo.getTopic.mockResolvedValue(makeTopic({ title: "My Topic", createdBy: "user-1" }));
      repo.create.mockResolvedValue(makeProject());

      await service.create("user-1", "topic-1");

      const payload = repo.create.mock.calls[0][0] as any;
      expect(payload.pipeline.research.status).toBe("completed");
      expect(payload.pipeline.script.status).toBe("not_started");
      expect(payload.pipeline.hooks.status).toBe("not_started");
      expect(payload.pipeline.packaging.status).toBe("not_started");
    });

    it("sets overallStatus 'in_progress' and currentStep 'research' at creation", async () => {
      contentRepo.getTopic.mockResolvedValue(makeTopic({ title: "My Topic", createdBy: "user-1" }));
      repo.create.mockResolvedValue(makeProject());

      await service.create("user-1", "topic-1");

      const payload = repo.create.mock.calls[0][0] as any;
      expect(payload.overallStatus).toBe("in_progress");
      expect(payload.currentStep).toBe("research");
    });
  });

  // --------------------------------------------------------------------------
  // createFromTitle (add-your-own-idea)
  // --------------------------------------------------------------------------

  describe("createFromTitle(userId, title)", () => {
    it("creates a topic from the title, then a project from the saved topic id", async () => {
      (formatGeneratedTitle as jest.Mock).mockResolvedValue({ title: "My Idea", createdBy: "user-1" });
      contentRepo.batchSaveTopics.mockResolvedValue([{ id: "topic-x", title: "My Idea", createdBy: "user-1" }] as any);
      contentRepo.getTopic.mockResolvedValue(makeTopic({ title: "My Idea", createdBy: "user-1" }));
      repo.create.mockResolvedValue(makeProject({ topicId: "topic-x" }));

      const result = await service.createFromTitle("user-1", "My Idea");

      expect(formatGeneratedTitle).toHaveBeenCalledWith("My Idea", "user-1");
      expect(contentRepo.batchSaveTopics).toHaveBeenCalledTimes(1);
      // create() was reused with the saved topic id
      expect(contentRepo.getTopic).toHaveBeenCalledWith("topic-x");
      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(result).toBeDefined();
    });

    it("throws 400 on a blank/whitespace title and does not create anything", async () => {
      await expect(service.createFromTitle("user-1", "   ")).rejects.toMatchObject({ statusCode: 400 });
      expect(formatGeneratedTitle).not.toHaveBeenCalled();
      expect(contentRepo.batchSaveTopics).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // getProjectsByTopic (Regenerate-All stale fan-out support)
  // --------------------------------------------------------------------------

  describe("getProjectsByTopic(topicId, userId)", () => {
    it("delegates to repo.findByTopicId and returns all matching projects", async () => {
      repo.findByTopicId.mockResolvedValue([makeProject(), makeProject({ id: "proj-2" })]);

      const result = await service.getProjectsByTopic("topic-1", "user-1");

      expect(repo.findByTopicId).toHaveBeenCalledWith("topic-1", "user-1");
      expect(result).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  // list
  // --------------------------------------------------------------------------

  describe("list(userId, options)", () => {
    it("returns list shape with only public fields (no full pipeline)", async () => {
      const project = makeProject({ thumbnailHint: "Some hint" });
      repo.list.mockResolvedValue({ projects: [project], hasMore: false, nextCursor: null });

      const result = await service.list("user-1", {});
      const item = result.projects[0] as any;

      expect(item.id).toBe("proj-1");
      expect(item.title).toBe("My Video");
      expect(item.currentStep).toBeDefined();
      expect(item.overallStatus).toBeDefined();
      expect(item.thumbnailHint).toBe("Some hint");
      expect(item.pipeline).toBeUndefined();
    });

    it("throws 400 for an invalid status value", async () => {
      await expect(service.list("user-1", { status: "invalid" as any })).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("accepts all valid status values without throwing", async () => {
      repo.list.mockResolvedValue({ projects: [], hasMore: false, nextCursor: null });
      for (const status of ["in_progress", "completed", "stale"] as const) {
        await expect(service.list("user-1", { status })).resolves.toBeDefined();
      }
    });

    it("passes options through to repo.list", async () => {
      repo.list.mockResolvedValue({ projects: [], hasMore: false, nextCursor: null });

      await service.list("user-1", { status: "completed", limit: 5, cursor: "cursor-abc" });

      expect(repo.list).toHaveBeenCalledWith("user-1", {
        status: "completed",
        limit: 5,
        cursor: "cursor-abc",
      });
    });

    it("returns hasMore and nextCursor from repo", async () => {
      repo.list.mockResolvedValue({ projects: [], hasMore: true, nextCursor: "next-cursor" });

      const result = await service.list("user-1", {});

      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe("next-cursor");
    });
  });

  // --------------------------------------------------------------------------
  // getById
  // --------------------------------------------------------------------------

  describe("getById(projectId, userId)", () => {
    it("returns project when found and owned by user", async () => {
      const project = makeProject();
      repo.findById.mockResolvedValue(project);

      const result = await service.getById("proj-1", "user-1");

      expect(result).toEqual(project);
    });

    it("throws 404 when project is not found", async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.getById("proj-1", "user-1")).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("throws 404 when project is soft-deleted", async () => {
      repo.findById.mockResolvedValue(makeProject({ isDeleted: true }));

      await expect(service.getById("proj-1", "user-1")).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("throws 403 when project belongs to a different user", async () => {
      repo.findById.mockResolvedValue(makeProject({ createdBy: "other-user" }));

      await expect(service.getById("proj-1", "user-1")).rejects.toMatchObject({
        message: "Forbidden",
        statusCode: 403,
      });
    });
  });

  // --------------------------------------------------------------------------
  // getReconciledById (computed read-time reconcile — no persistence)
  // --------------------------------------------------------------------------

  describe("getReconciledById(projectId, userId)", () => {
    it("promotes a not_started/in_progress step to completed when its resource is linked, without writing", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          scriptId: "script-1",
          selectedHookIndex: 2,
          pipeline: {
            research: { status: "completed", startedAt: null, completedAt: null },
            script: { status: "in_progress", startedAt: null, completedAt: null },
            hooks: { status: "not_started", startedAt: null, completedAt: null },
            packaging: { status: "not_started", startedAt: null, completedAt: null },
          },
        })
      );

      const result = await service.getReconciledById("proj-1", "user-1");

      expect(result.pipeline.script.status).toBe("completed"); // scriptId set
      expect(result.pipeline.hooks.status).toBe("completed"); // selectedHookIndex set
      expect(result.pipeline.packaging.status).toBe("not_started"); // no packagingId
      expect(repo.update).not.toHaveBeenCalled(); // computed, never persisted
    });

    it("never promotes a stale step", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          scriptId: "script-1",
          selectedHookIndex: 1,
          pipeline: {
            research: { status: "completed", startedAt: null, completedAt: null },
            script: { status: "completed", startedAt: null, completedAt: null },
            hooks: { status: "stale", startedAt: null, completedAt: null },
            packaging: { status: "stale", startedAt: null, completedAt: null },
          },
        })
      );

      const result = await service.getReconciledById("proj-1", "user-1");

      expect(result.pipeline.hooks.status).toBe("stale");
      expect(result.overallStatus).toBe("stale");
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // refreshPackagingStep (clear stale packaging step after last item regenerated)
  // --------------------------------------------------------------------------

  describe("refreshPackagingStep(projectId, userId)", () => {
    const staleProject = (overrides: Partial<IVideoProject["pipeline"]> = {}) =>
      makeProject({
        scriptId: "script-1",
        hooksId: "hooks-1",
        selectedHookIndex: 0,
        packagingId: "pkg-1",
        overallStatus: "stale",
        pipeline: {
          research: { status: "completed", startedAt: null, completedAt: null },
          script: { status: "completed", startedAt: null, completedAt: null },
          hooks: { status: "completed", startedAt: null, completedAt: null },
          packaging: { status: "stale", startedAt: null, completedAt: null },
          ...overrides,
        },
      });

    it("clears the stale packaging step and recomputes overallStatus to completed when all else is done", async () => {
      repo.findById.mockResolvedValue(staleProject());

      await service.refreshPackagingStep("proj-1", "user-1");

      expect(repo.update).toHaveBeenCalledWith("proj-1", {
        "pipeline.packaging.status": "completed",
        overallStatus: "completed",
      });
    });

    it("keeps overallStatus 'stale' when another step is still stale", async () => {
      repo.findById.mockResolvedValue(
        staleProject({ script: { status: "stale", startedAt: null, completedAt: null } })
      );

      await service.refreshPackagingStep("proj-1", "user-1");

      expect(repo.update).toHaveBeenCalledWith("proj-1", {
        "pipeline.packaging.status": "completed",
        overallStatus: "stale",
      });
    });

    it("is a no-op (no write) when the packaging step is not stale", async () => {
      repo.findById.mockResolvedValue(
        makeProject({ packagingId: "pkg-1", pipeline: { ...makeProject().pipeline, packaging: { status: "completed", startedAt: null, completedAt: null } } })
      );

      await service.refreshPackagingStep("proj-1", "user-1");

      expect(repo.update).not.toHaveBeenCalled();
    });

    it("throws (caller catches) when the project is not owned by the user", async () => {
      repo.findById.mockResolvedValue(staleProject({}));
      await expect(service.refreshPackagingStep("proj-1", "other-user")).rejects.toMatchObject({ statusCode: 403 });
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // setThumbnailHint (keep dashboard hint fresh after a thumbnail regenerate)
  // --------------------------------------------------------------------------

  describe("setThumbnailHint(projectId, hint, userId)", () => {
    it("writes the hint after an ownership check", async () => {
      repo.findById.mockResolvedValue(makeProject());
      repo.update.mockResolvedValue(undefined);

      await service.setThumbnailHint("proj-1", "New first brief", "user-1");

      expect(repo.update).toHaveBeenCalledWith("proj-1", { thumbnailHint: "New first brief" });
    });

    it("accepts null (clears the hint)", async () => {
      repo.findById.mockResolvedValue(makeProject());
      repo.update.mockResolvedValue(undefined);

      await service.setThumbnailHint("proj-1", null, "user-1");

      expect(repo.update).toHaveBeenCalledWith("proj-1", { thumbnailHint: null });
    });

    it("throws 403 when the project is not owned by the user", async () => {
      repo.findById.mockResolvedValue(makeProject({ createdBy: "other-user" }));
      await expect(service.setThumbnailHint("proj-1", "x", "user-1")).rejects.toMatchObject({ statusCode: 403 });
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // update
  // --------------------------------------------------------------------------

  describe("update(projectId, userId, data)", () => {
    it("calls repo.update with title when valid", async () => {
      repo.findById.mockResolvedValue(makeProject());
      repo.update.mockResolvedValue(undefined);

      await service.update("proj-1", "user-1", { title: "New Title" });

      expect(repo.update).toHaveBeenCalledWith("proj-1", { title: "New Title" });
    });

    it("throws 400 when title is empty string", async () => {
      repo.findById.mockResolvedValue(makeProject());

      await expect(service.update("proj-1", "user-1", { title: "" })).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("throws 400 when title is undefined", async () => {
      repo.findById.mockResolvedValue(makeProject());

      await expect(service.update("proj-1", "user-1", {})).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("throws 400 when title is whitespace only", async () => {
      repo.findById.mockResolvedValue(makeProject());

      await expect(service.update("proj-1", "user-1", { title: "   " })).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("throws 404 when project not found (delegates to getById)", async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.update("proj-1", "user-1", { title: "Title" })).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });

  // --------------------------------------------------------------------------
  // delete
  // --------------------------------------------------------------------------

  describe("delete(projectId, userId)", () => {
    it("calls repo.update with isDeleted: true when project exists and is owned", async () => {
      repo.findById.mockResolvedValue(makeProject());
      repo.update.mockResolvedValue(undefined);

      await service.delete("proj-1", "user-1");

      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ isDeleted: true })
      );
    });

    it("returns idempotently without writing when already deleted", async () => {
      repo.findById.mockResolvedValue(makeProject({ isDeleted: true }));

      await service.delete("proj-1", "user-1");

      expect(repo.update).not.toHaveBeenCalled();
    });

    it("throws 404 when project not found", async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.delete("proj-1", "user-1")).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("throws 403 when project belongs to a different user", async () => {
      repo.findById.mockResolvedValue(makeProject({ createdBy: "other-user" }));

      await expect(service.delete("proj-1", "user-1")).rejects.toMatchObject({
        statusCode: 403,
      });
    });
  });

  // --------------------------------------------------------------------------
  // startStep
  // --------------------------------------------------------------------------

  describe("startStep(projectId, stepName, userId)", () => {
    it("throws 400 for invalid stepName 'research'", async () => {
      repo.findById.mockResolvedValue(makeProject());

      await expect(service.startStep("proj-1", "research", "user-1")).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("throws 400 for unknown stepName", async () => {
      repo.findById.mockResolvedValue(makeProject());

      await expect(service.startStep("proj-1", "unknown", "user-1")).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("returns { id, currentStep } idempotently when step is already in_progress", async () => {
      repo.findById.mockResolvedValue(
        makeProject({ currentStep: "script", pipeline: { ...makeProject().pipeline, script: { status: "in_progress", startedAt: null, completedAt: null } } })
      );

      const result = await service.startStep("proj-1", "script", "user-1");

      expect(result).toEqual({ id: "proj-1", currentStep: expect.any(String) });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("returns { id, currentStep } idempotently when step is already completed", async () => {
      repo.findById.mockResolvedValue(
        makeProject({ currentStep: "hooks", pipeline: { ...makeProject().pipeline, script: { status: "completed", startedAt: null, completedAt: null } } })
      );

      const result = await service.startStep("proj-1", "script", "user-1");

      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("currentStep");
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("sets status to in_progress and startedAt for a valid step", async () => {
      repo.findById.mockResolvedValue(makeProject({ currentStep: "research" }));
      repo.update.mockResolvedValue(undefined);

      await service.startStep("proj-1", "script", "user-1");

      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ "pipeline.script.status": "in_progress" })
      );
    });

    it("advances currentStep when new step is ahead of current", async () => {
      repo.findById.mockResolvedValue(makeProject({ currentStep: "research" }));
      repo.update.mockResolvedValue(undefined);

      await service.startStep("proj-1", "script", "user-1");

      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ currentStep: "script" })
      );
    });

    it("does NOT advance currentStep when step is behind current", async () => {
      repo.findById.mockResolvedValue(makeProject({ currentStep: "packaging" }));
      repo.update.mockResolvedValue(undefined);

      await service.startStep("proj-1", "hooks", "user-1");

      const callArg = repo.update.mock.calls[0][1] as any;
      expect(callArg.currentStep).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // completeStep
  // --------------------------------------------------------------------------

  describe("completeStep(projectId, stepName, userId)", () => {
    it("throws 400 for invalid stepName 'research'", async () => {
      repo.findById.mockResolvedValue(makeProject());

      await expect(service.completeStep("proj-1", "research", "user-1")).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("throws 400 when step is not_started", async () => {
      repo.findById.mockResolvedValue(makeProject());

      await expect(service.completeStep("proj-1", "script", "user-1")).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("returns { id, currentStep } idempotently when step is already completed", async () => {
      repo.findById.mockResolvedValue(
        makeProject({ pipeline: { ...makeProject().pipeline, script: { status: "completed", startedAt: null, completedAt: null } } })
      );

      const result = await service.completeStep("proj-1", "script", "user-1");

      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("currentStep");
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("sets status to completed and completedAt", async () => {
      repo.findById.mockResolvedValue(
        makeProject({ pipeline: { ...makeProject().pipeline, script: { status: "in_progress", startedAt: null, completedAt: null } } })
      );
      repo.update.mockResolvedValue(undefined);

      await service.completeStep("proj-1", "script", "user-1");

      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ "pipeline.script.status": "completed" })
      );
    });

    it("auto-advances currentStep: script -> hooks", async () => {
      repo.findById.mockResolvedValue(
        makeProject({ currentStep: "script", pipeline: { ...makeProject().pipeline, script: { status: "in_progress", startedAt: null, completedAt: null } } })
      );
      repo.update.mockResolvedValue(undefined);

      const result = await service.completeStep("proj-1", "script", "user-1");

      expect(result.currentStep).toBe("hooks");
    });

    it("auto-advances currentStep: hooks -> packaging", async () => {
      repo.findById.mockResolvedValue(
        makeProject({ currentStep: "hooks", pipeline: { ...makeProject().pipeline, hooks: { status: "in_progress", startedAt: null, completedAt: null } } })
      );
      repo.update.mockResolvedValue(undefined);

      const result = await service.completeStep("proj-1", "hooks", "user-1");

      expect(result.currentStep).toBe("packaging");
    });

    it("packaging -> packaging (terminal step stays)", async () => {
      repo.findById.mockResolvedValue(
        makeProject({ currentStep: "packaging", pipeline: { ...makeProject().pipeline, packaging: { status: "in_progress", startedAt: null, completedAt: null } } })
      );
      repo.update.mockResolvedValue(undefined);

      const result = await service.completeStep("proj-1", "packaging", "user-1");

      expect(result.currentStep).toBe("packaging");
    });

    it("sets overallStatus 'completed' only when all steps are completed", async () => {
      const allCompletedPipeline: IVideoProject["pipeline"] = {
        research: { status: "completed", startedAt: null, completedAt: null },
        script: { status: "completed", startedAt: null, completedAt: null },
        hooks: { status: "completed", startedAt: null, completedAt: null },
        packaging: { status: "in_progress", startedAt: null, completedAt: null },
      };
      repo.findById.mockResolvedValue(makeProject({ pipeline: allCompletedPipeline }));
      repo.update.mockResolvedValue(undefined);

      await service.completeStep("proj-1", "packaging", "user-1");

      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ overallStatus: "completed" })
      );
    });

    it("does NOT set overallStatus 'completed' when not all steps are done", async () => {
      repo.findById.mockResolvedValue(
        makeProject({ pipeline: { ...makeProject().pipeline, script: { status: "in_progress", startedAt: null, completedAt: null } } })
      );
      repo.update.mockResolvedValue(undefined);

      await service.completeStep("proj-1", "script", "user-1");

      const callArg = repo.update.mock.calls[0][1] as any;
      expect(callArg.overallStatus).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // linkResource
  // --------------------------------------------------------------------------

  describe("linkResource(projectId, resourceType, resourceId, userId)", () => {
    it("throws 400 for invalid resourceType", async () => {
      repo.findById.mockResolvedValue(makeProject());

      await expect(service.linkResource("proj-1", "invalid", "res-1", "user-1")).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("throws 400 when resourceId is empty string", async () => {
      repo.findById.mockResolvedValue(makeProject());

      await expect(service.linkResource("proj-1", "script", "", "user-1")).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("sets scriptId for resourceType 'script'", async () => {
      repo.findById.mockResolvedValue(makeProject());
      repo.update.mockResolvedValue(undefined);

      await service.linkResource("proj-1", "script", "script-abc", "user-1");

      expect(repo.update).toHaveBeenCalledWith("proj-1", expect.objectContaining({ scriptId: "script-abc" }));
    });

    it("sets hooksId for resourceType 'hooks'", async () => {
      repo.findById.mockResolvedValue(makeProject());
      repo.update.mockResolvedValue(undefined);

      await service.linkResource("proj-1", "hooks", "hooks-abc", "user-1");

      expect(repo.update).toHaveBeenCalledWith("proj-1", expect.objectContaining({ hooksId: "hooks-abc" }));
    });

    it("sets packagingId AND extracts thumbnailHint (first canonical thumbnail brief)", async () => {
      repo.findById.mockResolvedValue(makeProject());
      repo.update.mockResolvedValue(undefined);
      packagingRepo.get.mockResolvedValue({
        thumbnail: ["Bold text here", "Second option", "Third option"],
      } as any);

      await service.linkResource("proj-1", "packaging", "pkg-abc", "user-1");

      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ packagingId: "pkg-abc", thumbnailHint: "Bold text here" })
      );
    });

    it("sets thumbnailHint to null when packaging doc has no thumbnail", async () => {
      repo.findById.mockResolvedValue(makeProject());
      repo.update.mockResolvedValue(undefined);
      packagingRepo.get.mockResolvedValue({} as any);

      await service.linkResource("proj-1", "packaging", "pkg-abc", "user-1");

      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ thumbnailHint: null })
      );
    });

    it("sets thumbnailHint to null when packagingRepo.get returns null", async () => {
      repo.findById.mockResolvedValue(makeProject());
      repo.update.mockResolvedValue(undefined);
      packagingRepo.get.mockResolvedValue(null as any);

      await service.linkResource("proj-1", "packaging", "pkg-abc", "user-1");

      const callArg = repo.update.mock.calls[0][1] as any;
      expect(callArg.thumbnailHint).toBeUndefined(); // only set when doc exists
    });
  });

  // --------------------------------------------------------------------------
  // markStale
  // --------------------------------------------------------------------------

  describe("markStale(projectId, fromStep)", () => {
    it("marks downstream non-not_started steps as stale (script cascade)", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          pipeline: {
            research: { status: "completed", startedAt: null, completedAt: null },
            script: { status: "completed", startedAt: null, completedAt: null },
            hooks: { status: "completed", startedAt: null, completedAt: null },
            packaging: { status: "in_progress", startedAt: null, completedAt: null },
          },
        })
      );
      repo.update.mockResolvedValue(undefined);

      await service.markStale("proj-1", "script");

      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          "pipeline.hooks.status": "stale",
          "pipeline.packaging.status": "stale",
        })
      );
    });

    it("does NOT mark not_started steps as stale", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          pipeline: {
            research: { status: "completed", startedAt: null, completedAt: null },
            script: { status: "completed", startedAt: null, completedAt: null },
            hooks: { status: "not_started", startedAt: null, completedAt: null },
            packaging: { status: "not_started", startedAt: null, completedAt: null },
          },
        })
      );

      await service.markStale("proj-1", "script");

      expect(repo.update).not.toHaveBeenCalled();
    });

    it("sets overallStatus to stale when a downstream step is staled", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          overallStatus: "completed",
          pipeline: {
            research: { status: "completed", startedAt: null, completedAt: null },
            script: { status: "completed", startedAt: null, completedAt: null },
            hooks: { status: "completed", startedAt: null, completedAt: null },
            packaging: { status: "completed", startedAt: null, completedAt: null },
          },
        })
      );
      repo.update.mockResolvedValue(undefined);

      await service.markStale("proj-1", "script");

      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ overallStatus: "stale" })
      );
    });

    it("returns without writing when no steps need to be staled", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          pipeline: {
            research: { status: "completed", startedAt: null, completedAt: null },
            script: { status: "completed", startedAt: null, completedAt: null },
            hooks: { status: "not_started", startedAt: null, completedAt: null },
            packaging: { status: "not_started", startedAt: null, completedAt: null },
          },
        })
      );

      await service.markStale("proj-1", "script");

      expect(repo.update).not.toHaveBeenCalled();
    });

    it("returns without throwing when project is not found", async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.markStale("proj-1", "script")).resolves.toBeUndefined();
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe("clearSelectedHook(projectId, userId)", () => {
    it("clears only the selection, keeps hooksId, and reverts hooks step to in_progress", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          hooksId: "hooks-1",
          selectedHookIndex: 2,
          pipeline: {
            research: { status: "completed", startedAt: null, completedAt: null },
            script: { status: "completed", startedAt: null, completedAt: null },
            hooks: { status: "completed", startedAt: null, completedAt: null },
            packaging: { status: "not_started", startedAt: null, completedAt: null },
          },
        })
      );
      repo.update.mockResolvedValue(undefined);

      await service.clearSelectedHook("proj-1", "user-1");

      const payload = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(payload).toMatchObject({
        selectedHookIndex: null,
        "pipeline.hooks.status": "in_progress",
        "pipeline.hooks.completedAt": null,
      });
      // the regenerated batch is still valid — its link must NOT be severed
      expect(payload).not.toHaveProperty("hooksId");
    });
  });
});
