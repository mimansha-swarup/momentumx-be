// Behaviour tests for the Hooks step flow, derived from the documented
// contract (not the implementation) in:
//   - docs/features/hooks/spec.md   (Step 3 requires a completed Script step;
//     completion mechanic is selection; stale on script regen; cascades to
//     packaging on hooks regen)
//   - docs/features/hooks/api.md    (select/regenerate resolve videoProjectId
//     from the STORED batch, never the client)
//   - docs/product/pipeline-spec.md (stale cascade table)
//
// Most individual call-shape behaviour is already covered by
// tests/unit/hooks.service.iteration.test.ts (which mocks VideoProjectService
// wholesale). These tests add: (1) the "script must be completed" gate that
// isn't covered there, and (2) real cross-service wiring — a REAL
// VideoProjectService + a REAL PackagingRepository-shaped stale cascade —
// underneath HooksService, so the documented cascade table is exercised
// end-to-end rather than asserted only as "the mock was called".

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

jest.mock("../../../src/utlils/ai", () => ({
  generateStreamingContent: jest.fn(),
  collectJson: jest.requireActual("../../../src/utlils/ai").collectJson,
}));

import HooksService from "../../../src/service/hooks.service";
import VideoProjectService from "../../../src/service/video-project.service";
import HooksRepository from "../../../src/repository/hooks.repository";
import VideoProjectRepository from "../../../src/repository/video-project.repository";
import ContentRepository from "../../../src/repository/content.repository";
import PackagingRepository from "../../../src/repository/packaging.repository";
import { generateStreamingContent } from "../../../src/utlils/ai";
import { IVideoProject } from "../../../src/types/routes/video-project";

import { makeTestAccountService, TEST_ACCOUNT_ID, testOwner, OTHER_ACCOUNT_ID } from "../../helpers/account";
const mockGenerate = generateStreamingContent as jest.MockedFunction<typeof generateStreamingContent>;

function makeStream(text: string) {
  return { stream: (async function* () { yield { text: () => text }; })() } as any;
}

const HOOKS_JSON = '{"hooks":["h1","h2","h3","h4","h5"]}';

function makeProject(overrides: Partial<IVideoProject> = {}): IVideoProject {
  return {
    id: "proj-1",
    createdBy: "user-1",
    accountId: TEST_ACCOUNT_ID,
    title: "My Video",
    ideaId: "idea-1",
    scriptId: "script-1",
    hooksId: null,
    selectedHookIndex: null,
    packagingId: null,
    thumbnailHint: null,
    overallStatus: "in_progress",
    currentStep: "script",
    isDeleted: false,
    deletedAt: null,
    pipeline: {
      research: { status: "completed", startedAt: null, completedAt: null },
      script: { status: "completed", startedAt: null, completedAt: null },
      hooks: { status: "not_started", startedAt: null, completedAt: null },
      title: { status: "not_started", startedAt: null, completedAt: null },
      packaging: { status: "not_started", startedAt: null, completedAt: null },
    },
    createdAt: null as any,
    updatedAt: null as any,
    ...overrides,
  };
}

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

import { makeTestStepRunner } from "../../helpers/step-runner";

// The script precondition, the in-flight lock and the failure rollback moved into
// the generation seam (Phase 01b) — they are no longer inside HooksService. The
// BEHAVIOUR these tests assert is unchanged, so each service is built with a
// runner that enforces the same guard, reading the project from the same mock the
// service reads so per-test setup still drives it.
// Some suites below drive a REAL VideoProjectService, whose getById legitimately
// throws for the placeholder ids used here. Those tests are about the cascade,
// not the guard, so fall back to a project that satisfies it. The precondition
// tests pass an explicit project and therefore still exercise it for real.
const PERMISSIVE_PROJECT = {
  createdBy: "user-1",
  accountId: TEST_ACCOUNT_ID,
  isDeleted: false,
  currentStep: "script",
  pipeline: {
    script: { status: "completed", startedAt: null, completedAt: null },
    hooks: { status: "not_started", startedAt: null, completedAt: null },
  },
} as never;

const seamFor = (
  vpService: { getById?: (...a: unknown[]) => unknown },
  acquired?: string[]
) =>
  makeTestStepRunner({
    project: async () => {
      try {
        return ((await vpService.getById?.("proj-1", "user-1")) ??
          PERMISSIVE_PROJECT) as never;
      } catch {
        return PERMISSIVE_PROJECT;
      }
    },
    onAcquire: (step) => acquired?.push(step),
  });

describe("HooksService.generate — requires a completed Script step (docs/features/hooks/spec.md 'Requires')", () => {
  beforeEach(() => jest.clearAllMocks());

  // WHERE THIS RULE IS ACTUALLY TESTED: `tests/unit/repository/step-lock.behaviour.test.ts`
  // ("400s when a required upstream step is not completed"), against the real
  // transaction. It cannot be tested here: `HooksService.generate` contains no
  // precondition logic at all any more — the seam owns it. An earlier version of
  // this block asserted `statusCode === 400` and passed with the real check
  // deleted from `acquireStep`, because the 400 came from the test's own fake.
  //
  // What IS this service's job, and what is asserted here: refuse to spend a
  // generation when the seam says no.
  it.each(["not_started", "in_progress", "stale"] as const)(
    "does not reach the model when the seam refuses because script is '%s'",
    async (scriptStatus) => {
      const vpService = {
        getById: jest.fn().mockResolvedValue(
          makeProject({ pipeline: { ...makeProject().pipeline, script: { status: scriptStatus, startedAt: null, completedAt: null } } })
        ),
      } as any;
      const hooksRepo = { findById: jest.fn(), save: jest.fn() } as unknown as jest.Mocked<HooksRepository>;
      const service = new HooksService(hooksRepo, vpService, undefined, seamFor(vpService));

      await service.generate(testOwner("user-1"), "proj-1", "a script").catch(() => undefined);

      expect(mockGenerate).not.toHaveBeenCalled();
      expect(hooksRepo.save).not.toHaveBeenCalled();
    }
  );

  it("allows generation once the script step is 'completed'", async () => {
    mockGenerate.mockResolvedValue(makeStream(HOOKS_JSON));
    const vpService = {
      getById: jest.fn().mockResolvedValue(makeProject()), // script: completed
      startStep: jest.fn().mockResolvedValue(undefined),
      linkResource: jest.fn().mockResolvedValue(undefined),
    } as any;
    const hooksRepo = {
      findById: jest.fn(),
      save: jest.fn().mockResolvedValue({ id: "hooks-1", videoProjectId: "proj-1", createdBy: "user-1", accountId: TEST_ACCOUNT_ID, hooks: ["h1", "h2", "h3", "h4", "h5"], hookFeedback: {} }),
    } as unknown as jest.Mocked<HooksRepository>;
    const acquired: string[] = [];
    const service = new HooksService(hooksRepo, vpService, undefined, seamFor(vpService, acquired));

    const result = await service.generate(testOwner("user-1"), "proj-1", "a script");

    expect(result.hooks).toHaveLength(5);
    // startStep is gone: the seam takes the step transactionally via acquireStep,
    // which is what replaced the swallowed startStep call.
    expect(acquired).toEqual(["hooks"]);

    // Phase 03 dual-write: both owner fields on the created batch, and the
    // account is NOT the uid.
    const [saved] = hooksRepo.save.mock.calls[0];
    expect(saved.createdBy).toBe("user-1");
    expect(saved.accountId).toBe(TEST_ACCOUNT_ID);
    expect(saved.accountId).not.toBe("user-1");
  });
});

describe("Hooks selection completes the Hooks step (real VideoProjectService)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("selecting a hook stores selectedHookIndex AND completes the hooks step in one flow", async () => {
    let state = makeProject({
      hooksId: "hooks-1",
      pipeline: { ...makeProject().pipeline, hooks: { status: "in_progress", startedAt: null, completedAt: null } },
    });

    const vpRepo = {
      findById: jest.fn(async () => state),
      update: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
        state = applyDottedPatch(state, patch);
      }),
    } as unknown as jest.Mocked<VideoProjectRepository>;
    const contentRepo = {} as unknown as jest.Mocked<ContentRepository>;
    const packagingRepo = { get: jest.fn(), clearStale: jest.fn() } as unknown as jest.Mocked<PackagingRepository>;
    const hooksRepoForVp = { findById: jest.fn() } as unknown as jest.Mocked<HooksRepository>;
    const vpService = new VideoProjectService(vpRepo, contentRepo, packagingRepo, hooksRepoForVp);

    const hooksBatchRepo = {
      findById: jest.fn().mockResolvedValue({ id: "hooks-1", videoProjectId: "proj-1", createdBy: "user-1", accountId: TEST_ACCOUNT_ID, hooks: ["h1", "h2", "h3", "h4", "h5"], hookFeedback: {} }),
    } as unknown as jest.Mocked<HooksRepository>;
    const hooksService = new HooksService(hooksBatchRepo, vpService, undefined, seamFor(vpService));

    await hooksService.select(testOwner("user-1"), "hooks-1", 2);

    expect(state.selectedHookIndex).toBe(2);
    expect(state.hooksId).toBe("hooks-1");
    expect(state.pipeline.hooks.status).toBe("completed");
  });
});

describe("Hooks regenerate — stale cascade matches the documented table (real VideoProjectService + PackagingRepository)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("cascades stale to exactly title + packaging (never script or hooks itself) and records staleReason 'hooks_regenerated' on both the project AND the packaging document", async () => {
    let state = makeProject({
      packagingId: "pkg-1",
      hooksId: "hooks-1",
      selectedHookIndex: 1,
      pipeline: {
        research: { status: "completed", startedAt: null, completedAt: null },
        script: { status: "completed", startedAt: null, completedAt: null },
        hooks: { status: "completed", startedAt: null, completedAt: null },
        title: { status: "completed", startedAt: null, completedAt: null },
        packaging: { status: "completed", startedAt: null, completedAt: null },
      },
    });

    const vpRepo = {
      findById: jest.fn(async () => state),
      update: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
        state = applyDottedPatch(state, patch);
      }),
    } as unknown as jest.Mocked<VideoProjectRepository>;
    const contentRepo = {} as unknown as jest.Mocked<ContentRepository>;
    const packagingRepo = {
      get: jest.fn(),
      clearStale: jest.fn(),
      markStale: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<PackagingRepository>;
    const hooksRepoForVp = { findById: jest.fn() } as unknown as jest.Mocked<HooksRepository>;
    const vpService = new VideoProjectService(vpRepo, contentRepo, packagingRepo, hooksRepoForVp);

    mockGenerate.mockResolvedValue(makeStream(HOOKS_JSON));
    const hooksBatchRepo = {
      findById: jest.fn().mockResolvedValue({ id: "hooks-1", videoProjectId: "proj-1", createdBy: "user-1", accountId: TEST_ACCOUNT_ID, hooks: ["a", "b", "c", "d", "e"], hookFeedback: {} }),
      update: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<HooksRepository>;
    const hooksService = new HooksService(hooksBatchRepo, vpService, undefined, seamFor(vpService));

    await hooksService.regenerate(testOwner("user-1"), "hooks-1", "an updated script");

    // Project-level cascade: title + packaging staled; script and hooks itself untouched.
    expect(state.pipeline.title.status).toBe("stale");
    expect(state.pipeline.title.staleReason).toBe("hooks_regenerated");
    expect(state.pipeline.packaging.status).toBe("stale");
    expect(state.pipeline.packaging.staleReason).toBe("hooks_regenerated");
    expect(state.pipeline.script.status).toBe("completed"); // upstream of hooks — never touched
    expect(state.overallStatus).toBe("stale");

    // Selection is cleared (the picked hook no longer exists in the fresh batch)
    // and the hooks step itself reopens rather than staying "completed".
    expect(state.selectedHookIndex).toBeNull();
    expect(state.pipeline.hooks.status).toBe("in_progress");

    // Document-level cascade: the packaging document itself is flagged too.
    expect(packagingRepo.markStale).toHaveBeenCalledWith("pkg-1", "hooks_regenerated");
  });

  it("does not cascade at all when nothing downstream was ever started (hooks step alone, no title/packaging yet)", async () => {
    let state = makeProject({
      hooksId: "hooks-1",
      pipeline: {
        research: { status: "completed", startedAt: null, completedAt: null },
        script: { status: "completed", startedAt: null, completedAt: null },
        hooks: { status: "completed", startedAt: null, completedAt: null },
        title: { status: "not_started", startedAt: null, completedAt: null },
        packaging: { status: "not_started", startedAt: null, completedAt: null },
      },
    });

    const vpRepo = {
      findById: jest.fn(async () => state),
      update: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
        state = applyDottedPatch(state, patch);
      }),
    } as unknown as jest.Mocked<VideoProjectRepository>;
    const contentRepo = {} as unknown as jest.Mocked<ContentRepository>;
    const packagingRepo = { get: jest.fn(), clearStale: jest.fn(), markStale: jest.fn() } as unknown as jest.Mocked<PackagingRepository>;
    const hooksRepoForVp = { findById: jest.fn() } as unknown as jest.Mocked<HooksRepository>;
    const vpService = new VideoProjectService(vpRepo, contentRepo, packagingRepo, hooksRepoForVp);

    mockGenerate.mockResolvedValue(makeStream(HOOKS_JSON));
    const hooksBatchRepo = {
      findById: jest.fn().mockResolvedValue({ id: "hooks-1", videoProjectId: "proj-1", createdBy: "user-1", accountId: TEST_ACCOUNT_ID, hooks: ["a", "b", "c", "d", "e"], hookFeedback: {} }),
      update: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<HooksRepository>;
    const hooksService = new HooksService(hooksBatchRepo, vpService, undefined, seamFor(vpService));

    await hooksService.regenerate(testOwner("user-1"), "hooks-1", "an updated script");

    expect(state.pipeline.title.status).toBe("not_started");
    expect(state.pipeline.packaging.status).toBe("not_started");
    // No project-level pipeline write happened for the (no-op) cascade — the
    // only writes are the selection clear.
    expect(state.overallStatus).not.toBe("stale");
  });
});

describe("Ownership", () => {
  beforeEach(() => jest.clearAllMocks());

  it("select rejects a caller who is not the batch owner (403), never binding to their project", async () => {
    const vpService = { setSelectedHook: jest.fn() } as any;
    const hooksRepo = {
      findById: jest.fn().mockResolvedValue({ id: "hooks-1", createdBy: "someone-else", accountId: OTHER_ACCOUNT_ID, videoProjectId: "proj-1", hooks: ["a", "b", "c", "d", "e"] }),
    } as unknown as jest.Mocked<HooksRepository>;
    const service = new HooksService(hooksRepo, vpService, undefined, seamFor(vpService));

    const err: any = await service.select(testOwner("user-1"), "hooks-1", 0).catch((e: any) => e);

    expect(err.statusCode).toBe(403);
    expect(vpService.setSelectedHook).not.toHaveBeenCalled();
  });

  it("regenerate rejects a caller who is not the batch owner (403), never calling Gemini", async () => {
    const vpService = {} as any;
    const hooksRepo = {
      findById: jest.fn().mockResolvedValue({ id: "hooks-1", createdBy: "someone-else", accountId: OTHER_ACCOUNT_ID, videoProjectId: "proj-1", hooks: ["a", "b", "c", "d", "e"] }),
    } as unknown as jest.Mocked<HooksRepository>;
    const service = new HooksService(hooksRepo, vpService, undefined, seamFor(vpService));

    const err: any = await service.regenerate(testOwner("user-1"), "hooks-1", "script").catch((e: any) => e);

    expect(err.statusCode).toBe(403);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("a nonexistent hooks batch 404s for select, regenerate, and export alike", async () => {
    const hooksRepo = { findById: jest.fn().mockResolvedValue(null) } as unknown as jest.Mocked<HooksRepository>;
    const service = new HooksService(hooksRepo, {} as any, undefined, seamFor({} as any));

    for (const call of [
      () => service.select(testOwner("user-1"), "missing", 0),
      () => service.regenerate(testOwner("user-1"), "missing", "script"),
      () => service.exportHooks(testOwner("user-1"), "missing"),
    ]) {
      const err: any = await call().catch((e: any) => e);
      expect(err.statusCode).toBe(404);
    }
  });
});
