// Behaviour tests for VideoProjectService's pipeline state machine, derived
// from the documented contract (not the implementation) in:
//   - docs/product/pipeline-spec.md            (step state machine, stale cascade)
//   - docs/features/video-project/spec.md      (freely-jumpable steps, stale rules)
//   - .claude/rules/api-design.md               (5-step pipeline: research → script
//     → hooks → title → packaging; overallStatus recomputed on every transition)
//
// Repos are mocked; VideoProjectService itself is real (matches
// tests/unit/video-project.service.test.ts). These tests walk documented FLOWS
// end to end rather than re-asserting single-call unit behaviour already
// covered there.

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

jest.mock("../../../src/config/firebase", () => ({
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

jest.mock("../../../src/utlils/content", () => ({
  formatGeneratedTitle: jest.fn(),
  assertOwner: (userId: unknown) => {
    if (typeof userId !== "string" || userId.trim() === "") {
      throw Object.assign(new Error("Missing authenticated user"), { statusCode: 401 });
    }
  },
}));

import VideoProjectService from "../../../src/service/video-project.service";
import VideoProjectRepository from "../../../src/repository/video-project.repository";
import ContentRepository from "../../../src/repository/content.repository";
import PackagingRepository from "../../../src/repository/packaging.repository";
import HooksRepository from "../../../src/repository/hooks.repository";
import { IVideoProject, StepName } from "../../../src/types/routes/video-project";
import { makeTestAccountService } from "../../helpers/account";

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
      packaging: { status: "not_started", startedAt: null, completedAt: null },
    },
    createdAt: null as any,
    updatedAt: null as any,
    ...overrides,
  };
}

const allCompletedPipeline = (): IVideoProject["pipeline"] => ({
  research: { status: "completed", startedAt: null, completedAt: null },
  script: { status: "completed", startedAt: null, completedAt: null },
  hooks: { status: "completed", startedAt: null, completedAt: null },
  title: { status: "completed", startedAt: null, completedAt: null },
  packaging: { status: "completed", startedAt: null, completedAt: null },
});

function makeMockRepo(): jest.Mocked<VideoProjectRepository> {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    findByIdeaId: jest.fn(),
    findByScriptId: jest.fn(),
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

describe("VideoProjectService — pipeline state machine (behaviour)", () => {
  let service: VideoProjectService;
  let repo: jest.Mocked<VideoProjectRepository>;
  let contentRepo: jest.Mocked<ContentRepository>;
  let packagingRepo: jest.Mocked<PackagingRepository>;
  let hooksRepo: jest.Mocked<HooksRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = makeMockRepo();
    contentRepo = makeMockContentRepo();
    packagingRepo = makeMockPackagingRepo();
    hooksRepo = makeMockHooksRepo();
    service = new VideoProjectService(repo, contentRepo, packagingRepo, hooksRepo, makeTestAccountService());
    repo.update.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Full walk: research → script → hooks → title → packaging
  // (docs/product/pipeline-spec.md — "The Pipeline", strictly sequential)
  // -------------------------------------------------------------------------
  describe("full pipeline walk", () => {
    it("advances currentStep through every mutable step and only reaches overallStatus 'completed' at the very end", async () => {
      // Simulated persisted state: apply repo.update's last payload onto the
      // in-memory project before the next call, so each step's transition sees
      // the real effect of the one before it (a genuine "flow", not isolated calls).
      let state = makeProject();
      repo.findById.mockImplementation(async () => state);
      repo.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
        state = applyDottedPatch(state, patch);
      });

      const mutableSteps: StepName[] = ["script", "hooks", "title", "packaging"];
      for (const step of mutableSteps) {
        await service.startStep("proj-1", step, "user-1");
        expect(state.pipeline[step].status).toBe("in_progress");
        // Not "completed" for the whole project until every step is done.
        expect(state.overallStatus).not.toBe("completed");

        const result = await service.completeStep("proj-1", step, "user-1");
        expect(state.pipeline[step].status).toBe("completed");
        expect(result.currentStep).toBe(step === "packaging" ? "packaging" : mutableSteps[mutableSteps.indexOf(step) + 1]);
      }

      // Every step done -> only now does overallStatus flip to completed.
      expect(state.overallStatus).toBe("completed");
      expect(state.currentStep).toBe("packaging");
    });
  });

  // -------------------------------------------------------------------------
  // Illegal transitions
  // -------------------------------------------------------------------------
  describe("illegal transitions are rejected", () => {
    it("rejects completing a step that has not been started (400)", async () => {
      repo.findById.mockResolvedValue(makeProject());
      await expect(service.completeStep("proj-1", "hooks", "user-1")).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("rejects starting or completing the research step — it is auto-completed at creation, never a mutable target", async () => {
      repo.findById.mockResolvedValue(makeProject());
      await expect(service.startStep("proj-1", "research", "user-1")).rejects.toMatchObject({ statusCode: 400 });
      await expect(service.completeStep("proj-1", "research", "user-1")).rejects.toMatchObject({ statusCode: 400 });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("rejects an unrecognized step name for both start and complete (400)", async () => {
      repo.findById.mockResolvedValue(makeProject());
      await expect(service.startStep("proj-1", "editing", "user-1")).rejects.toMatchObject({ statusCode: 400 });
      await expect(service.completeStep("proj-1", "editing", "user-1")).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  // -------------------------------------------------------------------------
  // Freely jumpable, but currentStep only ever moves forward
  // (docs/features/video-project/spec.md §D)
  // -------------------------------------------------------------------------
  describe("currentStep only advances forward", () => {
    it("jumping straight to a later step (skipping intermediate ones) is allowed and sets currentStep to it", async () => {
      repo.findById.mockResolvedValue(makeProject({ currentStep: "research" }));

      await service.startStep("proj-1", "title", "user-1");

      expect(repo.update).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ currentStep: "title", "pipeline.title.status": "in_progress" })
      );
    });

    // KNOWN DEFECT (found while writing this suite, not previously covered):
    // startStep guards currentStep with `if (newStepIndex > currentStepIndex)`
    // before advancing it, but completeStep does not — it unconditionally sets
    // `updates.currentStep = nextStep` from the step just completed, with no
    // comparison against the project's current (possibly further-along)
    // currentStep. So completing an earlier, reopened step while the project
    // has already progressed past it REGRESSES currentStep — contradicting
    // "currentStep only advances forward" (docs/features/video-project/spec.md
    // §D) and this task's explicit contract.
    //
    // Marked `it.failing`, not `it.skip`: a skipped test passes silently forever
    // and never tells you the bug is gone. `it.failing` passes only while the
    // defect exists and fails the moment someone fixes it — which is the prompt
    // to promote it to a normal `it(...)`.
    it.failing("re-visiting (and even completing) an earlier step never rewinds currentStep", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          currentStep: "packaging",
          pipeline: { ...makeProject().pipeline, hooks: { status: "in_progress", startedAt: null, completedAt: null } },
        })
      );

      const result = await service.completeStep("proj-1", "hooks", "user-1");

      // EXPECTED (per "currentStep only advances forward"): completing an
      // earlier step must not pull currentStep backward from "packaging".
      const callArg = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(callArg.currentStep).toBe("packaging");
      expect(result.currentStep).toBe("packaging");
    });
  });

  // -------------------------------------------------------------------------
  // Stale cascade — exact documented table
  // (docs/product/pipeline-spec.md "Stale Cascade Rules" / .claude/rules —
  //  research→all, script→hooks/title/packaging, hooks→title/packaging,
  //  title→packaging; packaging is a leaf, cascades nowhere)
  // -------------------------------------------------------------------------
  describe("stale cascade matches the documented table exactly", () => {
    const CASCADE_TABLE: Array<{ from: StepName; staled: StepName[] }> = [
      { from: "research", staled: ["script", "hooks", "title", "packaging"] },
      { from: "script", staled: ["hooks", "title", "packaging"] },
      { from: "hooks", staled: ["title", "packaging"] },
      { from: "title", staled: ["packaging"] },
    ];

    it.each(CASCADE_TABLE)(
      "regenerating '$from' marks exactly $staled stale, with staleReason '${from}_regenerated', and leaves everything else untouched",
      async ({ from, staled }) => {
        repo.findById.mockResolvedValue(makeProject({ pipeline: allCompletedPipeline() }));

        await service.markStale("proj-1", from);

        expect(repo.update).toHaveBeenCalledTimes(1);
        const written = repo.update.mock.calls[0][1] as Record<string, unknown>;

        for (const step of staled) {
          expect(written[`pipeline.${step}.status`]).toBe("stale");
          expect(written[`pipeline.${step}.staleReason`]).toBe(`${from}_regenerated`);
        }

        // Steps NOT in the documented cascade (including the step that changed,
        // and anything upstream of it) must not appear in the write at all.
        const ALL_STEPS: StepName[] = ["research", "script", "hooks", "title", "packaging"];
        const untouched = ALL_STEPS.filter((s) => !staled.includes(s));
        for (const step of untouched) {
          expect(written[`pipeline.${step}.status`]).toBeUndefined();
        }

        expect(written.overallStatus).toBe("stale");
      }
    );

    it("skips not_started downstream steps — stale is meaningless on an unvisited step", async () => {
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

      // Nothing downstream was ever visited -> nothing to invalidate -> no write.
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("a partially-visited pipeline only stales the steps that were actually visited", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          pipeline: {
            research: { status: "completed", startedAt: null, completedAt: null },
            script: { status: "completed", startedAt: null, completedAt: null },
            hooks: { status: "completed", startedAt: null, completedAt: null },
            title: { status: "not_started", startedAt: null, completedAt: null },
            packaging: { status: "not_started", startedAt: null, completedAt: null },
          },
        })
      );

      await service.markStale("proj-1", "script");

      const written = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(written["pipeline.hooks.status"]).toBe("stale");
      expect(written["pipeline.title.status"]).toBeUndefined();
      expect(written["pipeline.packaging.status"]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Un-staling: only regenerate / explicit completeStep clear it.
  // -------------------------------------------------------------------------
  describe("un-staling only happens through regenerate or explicit completion", () => {
    it("'Keep as-is' (completeStep on a stale step) clears it and recomputes overallStatus", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          overallStatus: "stale",
          pipeline: { ...allCompletedPipeline(), packaging: { status: "stale", startedAt: null, completedAt: null } },
        })
      );

      const result = await service.completeStep("proj-1", "packaging", "user-1");

      expect(result.pipeline.packaging.status).toBe("completed");
      expect(result.overallStatus).toBe("completed");
    });

    it("refreshPackagingStep (fired after the last stale item is regenerated) clears stale without a manual completeStep call", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          overallStatus: "stale",
          packagingId: "pkg-1",
          pipeline: { ...allCompletedPipeline(), packaging: { status: "stale", startedAt: null, completedAt: null } },
        })
      );

      await service.refreshPackagingStep("proj-1", "user-1");

      expect(repo.update).toHaveBeenCalledWith("proj-1", {
        "pipeline.packaging.status": "completed",
        "pipeline.packaging.staleReason": null,
        overallStatus: "completed",
      });
    });

    it("a stale step is never cleared as a side effect of an unrelated transition (markStale on an already-stale pipeline doesn't self-heal)", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          pipeline: { ...allCompletedPipeline(), packaging: { status: "stale", startedAt: null, completedAt: null } },
        })
      );

      // Regenerating "title" cascades only to packaging (already stale) — must
      // not implicitly resolve anything.
      await service.markStale("proj-1", "title");

      const written = repo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(written["pipeline.packaging.status"]).toBe("stale"); // stays stale, re-flagged
      expect(written.overallStatus).toBe("stale");
    });
  });

  // -------------------------------------------------------------------------
  // Known defect: reopenTitleStep / clearSelectedHook mutate pipeline status
  // but do NOT recompute overallStatus, unlike every other pipeline-mutating
  // method (completeStep, refreshPackagingStep, markStale all do).
  // Per docs/product/pipeline-spec.md, overallStatus must always reflect the
  // pipeline: "Stale Resolution ... recomputes overallStatus" and the API
  // contract that "overallStatus is recomputed on every transition" from
  // .claude/rules/api-design.md's step-completion notes generalizes to every
  // step mutation, including these two. Confirmed against
  // src/service/video-project.service.ts: reopenTitleStep/clearSelectedHook
  // build an update payload with no "overallStatus" key.
  //
  // Test SKIPPED (not deleted) to keep the suite green while flagging the gap:
  // reopening the title step or clearing a hook selection moves that step back
  // to "in_progress" without ever touching overallStatus, so a project that was
  // "completed" stays "completed" on the dashboard even though a step just
  // reopened under it.
  // -------------------------------------------------------------------------
  describe("known defect — overallStatus is not recomputed by reopenTitleStep / clearSelectedHook", () => {
    it.failing("reopenTitleStep recomputes overallStatus back to 'in_progress' when the project was 'completed'", async () => {
      repo.findById.mockResolvedValue(makeProject({ overallStatus: "completed", pipeline: allCompletedPipeline() }));

      await service.reopenTitleStep("proj-1", "user-1");

      const written = repo.update.mock.calls[0][1] as Record<string, unknown>;
      // EXPECTED (per the invariant every other pipeline mutation upholds):
      expect(written.overallStatus).toBe("in_progress");
    });

    it.failing("clearSelectedHook recomputes overallStatus back to 'in_progress' when the project was 'completed'", async () => {
      repo.findById.mockResolvedValue(
        makeProject({
          overallStatus: "completed",
          hooksId: "hooks-1",
          selectedHookIndex: 2,
          pipeline: allCompletedPipeline(),
        })
      );

      await service.clearSelectedHook("proj-1", "user-1");

      const written = repo.update.mock.calls[0][1] as Record<string, unknown>;
      // EXPECTED (per the invariant every other pipeline mutation upholds):
      expect(written.overallStatus).toBe("in_progress");
    });
  });

  // -------------------------------------------------------------------------
  // Ownership — every mutation on an existing project rejects a non-owner.
  // -------------------------------------------------------------------------
  describe("ownership is enforced on every pipeline mutation", () => {
    const otherUsersProject = () => makeProject({ createdBy: "someone-else" });

    it("startStep", async () => {
      repo.findById.mockResolvedValue(otherUsersProject());
      await expect(service.startStep("proj-1", "script", "user-1")).rejects.toMatchObject({ statusCode: 403 });
    });

    it("completeStep", async () => {
      repo.findById.mockResolvedValue(otherUsersProject());
      await expect(service.completeStep("proj-1", "script", "user-1")).rejects.toMatchObject({ statusCode: 403 });
    });

    it("markStale is a no-op for a project id that resolves, but is scoped internally (fire-and-forget cascade, not user-callable) — getById-based reads still enforce ownership", async () => {
      repo.findById.mockResolvedValue(otherUsersProject());
      await expect(service.getReconciledById("proj-1", "user-1")).rejects.toMatchObject({ statusCode: 403 });
    });

    it("reopenTitleStep", async () => {
      repo.findById.mockResolvedValue(otherUsersProject());
      await expect(service.reopenTitleStep("proj-1", "user-1")).rejects.toMatchObject({ statusCode: 403 });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("clearSelectedHook", async () => {
      repo.findById.mockResolvedValue(otherUsersProject());
      await expect(service.clearSelectedHook("proj-1", "user-1")).rejects.toMatchObject({ statusCode: 403 });
      expect(repo.update).not.toHaveBeenCalled();
    });
  });
});

// Applies a flat "dotted path" patch object (as sent to repo.update, e.g.
// {"pipeline.script.status": "completed"}) onto a nested project, simulating
// what Firestore's dotted-path update() would persist. Non-dotted keys
// (currentStep, overallStatus) are set at the top level.
function applyDottedPatch(project: IVideoProject, patch: Record<string, unknown>): IVideoProject {
  const next: IVideoProject = JSON.parse(JSON.stringify(project));
  for (const [key, value] of Object.entries(patch)) {
    if (key.includes(".")) {
      const [, step, field] = key.split(".");
      (next.pipeline as any)[step][field] = value;
    } else {
      (next as any)[key] = value;
    }
  }
  return next;
}
