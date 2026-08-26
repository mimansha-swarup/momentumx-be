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
  // Everything REAL except the one function this suite needs to stub out.
  // `assertOwner` in particular must be the real guard: it used to be a
  // hand-written copy here, and the 401 assertion below passed with the real
  // implementation's throw deleted — it was testing the copy.
  ...jest.requireActual("../../src/utlils/content"),
  formatGeneratedTitle: jest.fn(),
}));

import VideoProjectService from "../../src/service/video-project.service";
import VideoProjectRepository from "../../src/repository/video-project.repository";
import ContentRepository from "../../src/repository/content.repository";
import PackagingRepository from "../../src/repository/packaging.repository";
import HooksRepository from "../../src/repository/hooks.repository";
import { IVideoProject } from "../../src/types/routes/video-project";
import { IIdea } from "../../src/types/routes/content";
import { formatGeneratedTitle } from "../../src/utlils/content";
import { makeTestAccountService, TEST_ACCOUNT_ID } from "../helpers/account";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<IVideoProject> = {}): IVideoProject {
  return {
    id: "proj-1",
    createdBy: "user-1",
    title: "My Video",
    ideaId: "idea-1",
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
      title: { status: "not_started", startedAt: null, completedAt: null },
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

function makeIdea(overrides: Partial<IIdea> = {}): IIdea {
  return {
    id: "idea-1",
    title: "My Idea",
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
    findByIdeaId: jest.fn(),
    list: jest.fn(),
    update: jest.fn(),
  } as unknown as jest.Mocked<VideoProjectRepository>;
}

function makeMockContentRepo(): jest.Mocked<ContentRepository> {
  return {
    getIdea: jest.fn(),
    updateIdea: jest.fn(),
    batchSaveIdeas: jest.fn(),
    getScriptById: jest.fn(),
  } as unknown as jest.Mocked<ContentRepository>;
}

function makeMockPackagingRepo(): jest.Mocked<PackagingRepository> {
  return { get: jest.fn(), clearStale: jest.fn() } as unknown as jest.Mocked<PackagingRepository>;
}

function makeMockHooksRepo(): jest.Mocked<HooksRepository> {
  return { findById: jest.fn() } as unknown as jest.Mocked<HooksRepository>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VideoProjectService", () => {
  let service: VideoProjectService;
  let repo: jest.Mocked<VideoProjectRepository>;
  let contentRepo: jest.Mocked<ContentRepository>;
  let packagingRepo: jest.Mocked<PackagingRepository>;
  let hooksRepo: jest.Mocked<HooksRepository>;

  beforeEach(() => {
    repo = makeMockRepo();
    contentRepo = makeMockContentRepo();
    packagingRepo = makeMockPackagingRepo();
    hooksRepo = makeMockHooksRepo();
    service = new VideoProjectService(repo, contentRepo, packagingRepo, hooksRepo, makeTestAccountService());
  });

  // --------------------------------------------------------------------------
  // create
  // --------------------------------------------------------------------------

  describe("create(userId, ideaId)", () => {
    it("returns project when idea exists and belongs to the user", async () => {
      contentRepo.getIdea.mockResolvedValue(makeIdea({ title: "My Idea", createdBy: "user-1" }));
      repo.create.mockResolvedValue(makeProject());

      const result = await service.create("user-1", "idea-1");

      expect(result).toBeDefined();
      expect(contentRepo.getIdea).toHaveBeenCalledWith("idea-1");
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it("stamps BOTH createdBy and accountId on the project document", async () => {
      // The project document itself, not the idea it was built from. The
      // createFromTitle test below asserts the owner reaching formatGeneratedTitle,
      // which is a different write — dropping this stamp left that test green.
      contentRepo.getIdea.mockResolvedValue(makeIdea({ title: "My Idea", createdBy: "user-1" }));
      repo.create.mockResolvedValue(makeProject());

      await service.create("user-1", "idea-1");

      const [projectData] = repo.create.mock.calls[0] as [Record<string, unknown>];
      expect(projectData.createdBy).toBe("user-1");
      expect(projectData.accountId).toBe(TEST_ACCOUNT_ID);
      expect(projectData.accountId).not.toBe("user-1");
    });

    it("throws 404 when idea is not found", async () => {
      contentRepo.getIdea.mockResolvedValue(null as any);

      await expect(service.create("user-1", "idea-1")).rejects.toMatchObject({
        message: "Idea not found",
        statusCode: 404,
      });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it("throws 404 when idea is undefined", async () => {
      contentRepo.getIdea.mockResolvedValue(undefined as any);

      await expect(service.create("user-1", "idea-1")).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("throws 403 when idea belongs to a different user", async () => {
      contentRepo.getIdea.mockResolvedValue(makeIdea({ title: "Their Idea", createdBy: "other-user" }));

      await expect(service.create("user-1", "idea-1")).rejects.toMatchObject({
        message: "Forbidden",
        statusCode: 403,
      });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it("passes correct initial pipeline state to repo.create", async () => {
      contentRepo.getIdea.mockResolvedValue(makeIdea({ title: "My Idea", createdBy: "user-1" }));
      repo.create.mockResolvedValue(makeProject());

      await service.create("user-1", "idea-1");

      const payload = repo.create.mock.calls[0][0] as any;
      expect(payload.pipeline.research.status).toBe("completed");
      expect(payload.pipeline.script.status).toBe("not_started");
      expect(payload.pipeline.hooks.status).toBe("not_started");
      expect(payload.pipeline.packaging.status).toBe("not_started");
    });

    it("sets overallStatus 'in_progress' and currentStep 'research' at creation", async () => {
      contentRepo.getIdea.mockResolvedValue(makeIdea({ title: "My Idea", createdBy: "user-1" }));
      repo.create.mockResolvedValue(makeProject());

      await service.create("user-1", "idea-1");

      const payload = repo.create.mock.calls[0][0] as any;
      expect(payload.overallStatus).toBe("in_progress");
      expect(payload.currentStep).toBe("research");
    });
  });

  // --------------------------------------------------------------------------
  // createFromTitle (add-your-own-idea)
  // --------------------------------------------------------------------------

  describe("createFromTitle(userId, title)", () => {
    it("creates a idea from the title, then a project from the saved idea id", async () => {
      (formatGeneratedTitle as jest.Mock).mockResolvedValue({ title: "My Idea", createdBy: "user-1" });
      contentRepo.batchSaveIdeas.mockResolvedValue([{ id: "idea-x", title: "My Idea", createdBy: "user-1" }] as any);
      contentRepo.getIdea.mockResolvedValue(makeIdea({ title: "My Idea", createdBy: "user-1" }));
      repo.create.mockResolvedValue(makeProject({ ideaId: "idea-x" }));

      const result = await service.createFromTitle("user-1", "My Idea");

      // Phase 03: the owner is one object, so a bare userId cannot be passed
      // where an accountId belongs.
      expect(formatGeneratedTitle).toHaveBeenCalledWith("My Idea", {
        userId: "user-1",
        accountId: TEST_ACCOUNT_ID,
      });
      expect(contentRepo.batchSaveIdeas).toHaveBeenCalledTimes(1);
      // create() was reused with the saved idea id
      expect(contentRepo.getIdea).toHaveBeenCalledWith("idea-x");
      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(result).toBeDefined();
    });

    it("throws 400 on a blank/whitespace title and does not create anything", async () => {
      await expect(service.createFromTitle("user-1", "   ")).rejects.toMatchObject({ statusCode: 400 });
      expect(formatGeneratedTitle).not.toHaveBeenCalled();
      expect(contentRepo.batchSaveIdeas).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    // Phase 01 item 1: an empty owner is a real value that every orphaned record
    // would share, so it must be refused before anything is written.
    it("refuses an empty userId before writing anything", async () => {
      await expect(service.createFromTitle("", "My Idea")).rejects.toMatchObject({ statusCode: 401 });
      expect(formatGeneratedTitle).not.toHaveBeenCalled();
      expect(contentRepo.batchSaveIdeas).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // getProjectsByIdea (Regenerate-All stale fan-out support)
  // --------------------------------------------------------------------------

  describe("getProjectsByIdea(ideaId, userId)", () => {
    it("delegates to repo.findByIdeaId and returns all matching projects", async () => {
      repo.findByIdeaId.mockResolvedValue([makeProject(), makeProject({ id: "proj-2" })]);

      const result = await service.getProjectsByIdea("idea-1", "user-1");

      expect(repo.findByIdeaId).toHaveBeenCalledWith("idea-1", "user-1");
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
            title: { status: "not_started", startedAt: null, completedAt: null },
            packaging: { status: "not_started", startedAt: null, completedAt: null },
          },
        })
      );

      const result = await service.getReconciledById("proj-1", "user-1");

      expect(result.pipeline.script.status).toBe("completed"); // scriptId set
      expect(result.pipeline.hooks.status).toBe("completed"); // selectedHookIndex set
      expect(result.pipeline.packaging.status).toBe("not_started"); // no packagingId
      expect(result.recommendedNextStep).toBe("title"); // first non-completed (title precedes packaging)
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
            title: { status: "stale", startedAt: null, completedAt: null },
            packaging: { status: "stale", startedAt: null, completedAt: null },
          },
        })
      );

      const result = await service.getReconciledById("proj-1", "user-1");

      expect(result.pipeline.hooks.status).toBe("stale");
      expect(result.overallStatus).toBe("stale");
      expect(result.recommendedNextStep).toBe("hooks"); // stale surfaces as next action
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("recommendedNextStep is null when every step is completed", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          scriptId: "script-1",
          selectedHookIndex: 0,
          packagingId: "pkg-1",
          pipeline: {
            research: { status: "completed", startedAt: null, completedAt: null },
            script: { status: "completed", startedAt: null, completedAt: null },
            hooks: { status: "completed", startedAt: null, completedAt: null },
            title: { status: "completed", startedAt: null, completedAt: null },
            packaging: { status: "completed", startedAt: null, completedAt: null },
          },
        })
      );

      const result = await service.getReconciledById("proj-1", "user-1");

      expect(result.recommendedNextStep).toBeNull();
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
          title: { status: "completed", startedAt: null, completedAt: null },
          packaging: { status: "stale", startedAt: null, completedAt: null },
          ...overrides,
        },
      });

    it("clears the stale packaging step and recomputes overallStatus to completed when all else is done", async () => {
      repo.findById.mockResolvedValue(staleProject());

      await service.refreshPackagingStep("proj-1", "user-1");

      expect(repo.update).toHaveBeenCalledWith("proj-1", {
        "pipeline.packaging.status": "completed",
        // The reason it went stale no longer applies once it's fresh again.
        "pipeline.packaging.staleReason": null,
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
        "pipeline.packaging.staleReason": null,
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

    it("refreshes startedAt (lock heartbeat) when step is already in_progress", async () => {
      repo.findById.mockResolvedValue(
        makeProject({ currentStep: "script", pipeline: { ...makeProject().pipeline, script: { status: "in_progress", startedAt: null, completedAt: null } } })
      );

      const result = await service.startStep("proj-1", "script", "user-1");

      expect(result).toEqual({ id: "proj-1", currentStep: expect.any(String) });
      // The refresh keeps the in-flight lock honest: only startedAt is touched.
      expect(repo.update).toHaveBeenCalledTimes(1);
      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ "pipeline.script.startedAt": expect.anything() })
      );
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

    it("auto-advances currentStep: hooks -> title", async () => {
      repo.findById.mockResolvedValue(
        makeProject({ currentStep: "hooks", pipeline: { ...makeProject().pipeline, hooks: { status: "in_progress", startedAt: null, completedAt: null } } })
      );
      repo.update.mockResolvedValue(undefined);

      const result = await service.completeStep("proj-1", "hooks", "user-1");

      expect(result.currentStep).toBe("title");
    });

    it("auto-advances currentStep: title -> packaging", async () => {
      repo.findById.mockResolvedValue(
        makeProject({ currentStep: "title", pipeline: { ...makeProject().pipeline, title: { status: "in_progress", startedAt: null, completedAt: null } } })
      );
      repo.update.mockResolvedValue(undefined);

      const result = await service.completeStep("proj-1", "title", "user-1");

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
        title: { status: "completed", startedAt: null, completedAt: null },
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
      expect(callArg.overallStatus).toBe("in_progress");
    });

    // Completing a STALE step ("Keep as-is") used to leave overallStatus at "stale",
    // so the dashboard kept its "Needs Update" badge on a project with nothing stale
    // left in it — and the only way to clear it was to regenerate after all.
    it("recomputes overallStatus so completing the last stale step clears the badge", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          overallStatus: "stale",
          packagingId: "pkg-abc",
          pipeline: { ...makeProject().pipeline, packaging: { status: "stale", startedAt: null, completedAt: null } },
        })
      );
      repo.update.mockResolvedValue(undefined);

      await service.completeStep("proj-1", "packaging", "user-1");

      const callArg = repo.update.mock.calls[0][1] as any;
      expect(callArg.overallStatus).not.toBe("stale");
    });

    // The client patches its cached project from this response; a partial body made
    // its reducer throw on `payload.pipeline`, so every "Keep as-is" toasted success
    // and changed nothing on screen.
    it("returns the updated pipeline and overallStatus, not just {id,currentStep}", async () => {
      repo.findById.mockResolvedValue(
        makeProject({ pipeline: { ...makeProject().pipeline, script: { status: "in_progress", startedAt: null, completedAt: null } } })
      );
      repo.update.mockResolvedValue(undefined);

      const result = await service.completeStep("proj-1", "script", "user-1");

      expect(result.pipeline).toBeDefined();
      expect(result.pipeline.script.status).toBe("completed");
      expect(result.overallStatus).toBe("in_progress");
    });

    it("returns the same full shape on the idempotent already-completed path", async () => {
      repo.findById.mockResolvedValue(makeProject()); // research is completed at creation

      const result = await service.completeStep("proj-1", "research", "user-1").catch((e) => e);

      // research isn't a mutable step, so use a genuinely completed mutable one:
      repo.findById.mockResolvedValue(
        makeProject({ pipeline: { ...makeProject().pipeline, script: { status: "completed", startedAt: null, completedAt: null } } })
      );
      const done = await service.completeStep("proj-1", "script", "user-1");

      expect(done.pipeline).toBeDefined();
      expect(done.overallStatus).toBeDefined();
      expect(result).toBeInstanceOf(Error); // guard: research is rejected as immutable
    });

    // "Keep as-is" on the stale banner. The step goes completed, but the packaging
    // DOCUMENT carries its own stale markers and the per-card "Outdated" chips read
    // from those — without this they outlive the banner the creator just dismissed.
    it("clears the packaging document's stale markers when completing a STALE packaging step", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          packagingId: "pkg-abc",
          pipeline: { ...makeProject().pipeline, packaging: { status: "stale", startedAt: null, completedAt: null } },
        })
      );
      repo.update.mockResolvedValue(undefined);

      await service.completeStep("proj-1", "packaging", "user-1");

      expect(packagingRepo.clearStale).toHaveBeenCalledWith("pkg-abc");
    });

    it("does NOT clear stale markers when the packaging step wasn't stale", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          packagingId: "pkg-abc",
          pipeline: { ...makeProject().pipeline, packaging: { status: "in_progress", startedAt: null, completedAt: null } },
        })
      );
      repo.update.mockResolvedValue(undefined);

      await service.completeStep("proj-1", "packaging", "user-1");

      expect(packagingRepo.clearStale).not.toHaveBeenCalled();
    });

    it("still completes the step when clearing the document's stale markers fails", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          packagingId: "pkg-abc",
          pipeline: { ...makeProject().pipeline, packaging: { status: "stale", startedAt: null, completedAt: null } },
        })
      );
      repo.update.mockResolvedValue(undefined);
      (packagingRepo.clearStale as jest.Mock).mockRejectedValue(new Error("firestore down"));

      await expect(service.completeStep("proj-1", "packaging", "user-1")).resolves.toMatchObject({
        id: "proj-1",
      });
      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ "pipeline.packaging.status": "completed" })
      );
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
      contentRepo.getScriptById.mockResolvedValue({ createdBy: "user-1" } as any);

      await service.linkResource("proj-1", "script", "script-abc", "user-1");

      expect(repo.update).toHaveBeenCalledWith("proj-1", expect.objectContaining({ scriptId: "script-abc" }));
    });

    it("sets hooksId for resourceType 'hooks'", async () => {
      repo.findById.mockResolvedValue(makeProject());
      repo.update.mockResolvedValue(undefined);
      hooksRepo.findById.mockResolvedValue({ createdBy: "user-1" } as any);

      await service.linkResource("proj-1", "hooks", "hooks-abc", "user-1");

      expect(repo.update).toHaveBeenCalledWith("proj-1", expect.objectContaining({ hooksId: "hooks-abc" }));
    });

    // ------------------------------------------------------------------------
    // Ownership of the RESOURCE, not just the project (Phase 01 item 6).
    // The project was always checked; the resource id came straight from the body.
    // One assertion per type, because each leaks something different: packaging
    // copies the selected thumbnail brief onto the project, script comes back
    // near-verbatim via generate-shorts, and hooks feed five generation paths.
    // ------------------------------------------------------------------------
    it("throws 403 when the script belongs to another user", async () => {
      repo.findById.mockResolvedValue(makeProject());
      contentRepo.getScriptById.mockResolvedValue({ createdBy: "someone-else" } as any);

      await expect(
        service.linkResource("proj-1", "script", "script-abc", "user-1")
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("throws 403 when the hooks batch belongs to another user", async () => {
      repo.findById.mockResolvedValue(makeProject());
      hooksRepo.findById.mockResolvedValue({ createdBy: "someone-else" } as any);

      await expect(
        service.linkResource("proj-1", "hooks", "hooks-abc", "user-1")
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("throws 403 when the packaging doc belongs to another user", async () => {
      repo.findById.mockResolvedValue(makeProject());
      packagingRepo.get.mockResolvedValue({
        createdBy: "someone-else",
        thumbnail: ["Leaked brief"],
      } as any);

      await expect(
        service.linkResource("proj-1", "packaging", "pkg-abc", "user-1")
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("sets packagingId AND extracts thumbnailHint (defaults to the first brief)", async () => {
      repo.findById.mockResolvedValue(makeProject());
      repo.update.mockResolvedValue(undefined);
      packagingRepo.get.mockResolvedValue({
        createdBy: "user-1",
        thumbnail: ["Bold text here", "Second option", "Third option"],
      } as any);

      await service.linkResource("proj-1", "packaging", "pkg-abc", "user-1");

      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ packagingId: "pkg-abc", thumbnailHint: "Bold text here" })
      );
    });

    // The dashboard card renders thumbnailHint. Pinning it to brief #1 made the
    // creator's pick invisible everywhere outside the packaging screen.
    it("uses the SELECTED brief for thumbnailHint, not the first", async () => {
      repo.findById.mockResolvedValue(makeProject());
      repo.update.mockResolvedValue(undefined);
      packagingRepo.get.mockResolvedValue({
        createdBy: "user-1",
        thumbnail: ["Bold text here", "Second option", "Third option"],
        selectedThumbnailIndex: 2,
      } as any);

      await service.linkResource("proj-1", "packaging", "pkg-abc", "user-1");

      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ thumbnailHint: "Third option" })
      );
    });

    it("falls back to the first brief when the stored selection is out of range", async () => {
      repo.findById.mockResolvedValue(makeProject());
      repo.update.mockResolvedValue(undefined);
      packagingRepo.get.mockResolvedValue({
        createdBy: "user-1",
        thumbnail: ["Only brief"],
        selectedThumbnailIndex: 5,
      } as any);

      await service.linkResource("proj-1", "packaging", "pkg-abc", "user-1");

      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ thumbnailHint: "Only brief" })
      );
    });

    it("sets thumbnailHint to null when packaging doc has no thumbnail", async () => {
      repo.findById.mockResolvedValue(makeProject());
      repo.update.mockResolvedValue(undefined);
      packagingRepo.get.mockResolvedValue({ createdBy: "user-1" } as any);

      await service.linkResource("proj-1", "packaging", "pkg-abc", "user-1");

      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ thumbnailHint: null })
      );
    });

    // Previously a missing resource linked successfully with no thumbnailHint.
    // Linking a document that doesn't exist is never correct, and tolerating it
    // is what let an unowned id through unnoticed.
    it("throws 404 when the resource does not exist", async () => {
      repo.findById.mockResolvedValue(makeProject());
      packagingRepo.get.mockResolvedValue(null as any);

      await expect(
        service.linkResource("proj-1", "packaging", "pkg-abc", "user-1")
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  // Deleting a project is the documented way to undo a wrong idea pick. Leaving
  // `videoProjectId` on the idea left its card stuck on "View Project" pointing at
  // a deleted project, with no way to start over from that idea.
  describe("delete(projectId, userId) — idea release", () => {
    it("clears videoProjectId on the source idea", async () => {
      repo.findById.mockResolvedValue(makeProject({ ideaId: "idea-9" }));
      repo.update.mockResolvedValue(undefined);
      contentRepo.updateIdea.mockResolvedValue(undefined as never);

      await service.delete("proj-1", "user-1");

      expect(contentRepo.updateIdea).toHaveBeenCalledWith("idea-9", { videoProjectId: null });
    });

    it("still deletes the project when releasing the idea fails", async () => {
      repo.findById.mockResolvedValue(makeProject({ ideaId: "idea-9" }));
      repo.update.mockResolvedValue(undefined);
      (contentRepo.updateIdea as jest.Mock).mockRejectedValue(new Error("firestore down"));

      await expect(service.delete("proj-1", "user-1")).resolves.toMatchObject({ isDeleted: true });
      expect(repo.update).toHaveBeenCalledWith("proj-1", expect.objectContaining({ isDeleted: true }));
    });

    it("does not re-delete an already deleted project", async () => {
      repo.findById.mockResolvedValue(makeProject({ isDeleted: true, ideaId: "idea-9" }));

      await service.delete("proj-1", "user-1");

      expect(contentRepo.updateIdea).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  // A title regeneration invalidates the previous pick — and the project is still
  // NAMED after it. The step must reopen so the creator is asked to choose again.
  describe("reopenTitleStep(projectId, userId)", () => {
    it("moves the title step back to in_progress and clears completedAt", async () => {
      repo.findById.mockResolvedValue(makeProject());
      repo.update.mockResolvedValue(undefined);

      await service.reopenTitleStep("proj-1", "user-1");

      expect(repo.update).toHaveBeenCalledWith("proj-1", {
        "pipeline.title.status": "in_progress",
        "pipeline.title.completedAt": null,
      });
    });

    it("refuses to touch another user's project", async () => {
      repo.findById.mockResolvedValue(makeProject({ createdBy: "someone-else" }));

      await expect(service.reopenTitleStep("proj-1", "user-1")).rejects.toMatchObject({ statusCode: 403 });
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // markStale
  // --------------------------------------------------------------------------

  describe("markStale(projectId, fromStep)", () => {
    // The screens had no source for the cause, so two of them hardcoded
    // "the script has been regenerated" — a false statement for every cascade
    // that started anywhere else.
    it("records WHICH upstream step invalidated each downstream step", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          pipeline: {
            research: { status: "completed", startedAt: null, completedAt: null },
            script: { status: "completed", startedAt: null, completedAt: null },
            hooks: { status: "completed", startedAt: null, completedAt: null },
            title: { status: "completed", startedAt: null, completedAt: null },
            packaging: { status: "completed", startedAt: null, completedAt: null },
          },
        })
      );
      repo.update.mockResolvedValue(undefined);

      await service.markStale("proj-1", "hooks");

      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          "pipeline.title.staleReason": "hooks_regenerated",
          "pipeline.packaging.staleReason": "hooks_regenerated",
        })
      );
      // Upstream of the change is untouched — the script didn't become stale.
      const written = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(written["pipeline.script.staleReason"]).toBeUndefined();
    });

    it("marks downstream non-not_started steps as stale (script cascade)", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          pipeline: {
            research: { status: "completed", startedAt: null, completedAt: null },
            script: { status: "completed", startedAt: null, completedAt: null },
            hooks: { status: "completed", startedAt: null, completedAt: null },
            title: { status: "completed", startedAt: null, completedAt: null },
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
          "pipeline.title.status": "stale",
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
            title: { status: "not_started", startedAt: null, completedAt: null },
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
            title: { status: "completed", startedAt: null, completedAt: null },
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
            title: { status: "not_started", startedAt: null, completedAt: null },
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
            title: { status: "not_started", startedAt: null, completedAt: null },
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
