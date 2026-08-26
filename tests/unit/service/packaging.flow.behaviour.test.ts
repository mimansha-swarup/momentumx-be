// Behaviour tests for the Packaging generation → pipeline-step flow, derived
// from the documented contract (not the implementation) in:
//   - docs/features/packaging/spec.md   (persist-on-generate, per-item status,
//     stale tracking/clearing, "what a save is allowed to change")
//   - docs/features/packaging/api.md    (select-title completes the Title step)
//   - docs/product/pipeline-spec.md     (packaging auto-advances to completed
//     once description+thumbnail+shorts all exist; title completes on select)
//   - .claude/rules/api-design.md       ("door" save creates exactly one project
//     when no videoProjectId is supplied)
//
// Unlike tests/unit/packaging.service.iteration.test.ts (which mocks
// VideoProjectService wholesale and asserts isolated calls), these tests wire
// a REAL VideoProjectService underneath PackagingService — only the Firestore
// repositories are mocked — so the actual cross-service pipeline wiring
// (persist-on-generate → startStep/completeStep, stale cascade → clear) is
// exercised end to end, the way it runs in production.

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
  // collectJson stays REAL — it's the malformed/empty JSON guard, and the fake
  // streams below are exactly what should be driving it.
  collectJson: jest.requireActual("../../../src/utlils/ai").collectJson,
}));

import PackagingService from "../../../src/service/packaging.service";
import VideoProjectService from "../../../src/service/video-project.service";
import PackagingRepository from "../../../src/repository/packaging.repository";
import VideoProjectRepository from "../../../src/repository/video-project.repository";
import ContentRepository from "../../../src/repository/content.repository";
import HooksRepository from "../../../src/repository/hooks.repository";
import { generateStreamingContent } from "../../../src/utlils/ai";
import { IVideoProject } from "../../../src/types/routes/video-project";
import { makeTestAccountService } from "../../helpers/account";

const mockGenerate = generateStreamingContent as jest.MockedFunction<typeof generateStreamingContent>;

function makeStream(text: string) {
  return { stream: (async function* () { yield { text: () => text }; })() } as any;
}

function makeContextService(session: Record<string, unknown> = {}) {
  return {
    assemble: jest.fn().mockResolvedValue({
      channelContext: {
        format: "talking_head", niche: null, targetAudience: null, brandName: null,
        website: null, websiteContent: null, channelDescription: null,
        topTitles: [], competitorUrls: [], competitorTitles: [],
      },
      sessionContext: {
        videoProjectId: null, ideaId: null, workingTitle: null,
        script: "a script", selectedHook: null, packagingId: null, ...session,
      },
    }),
  } as any;
}

function makeProject(overrides: Partial<IVideoProject> = {}): IVideoProject {
  return {
    id: "proj-1",
    createdBy: "user-1",
    title: "My Video",
    ideaId: "idea-1",
    scriptId: "script-1",
    hooksId: "hooks-1",
    selectedHookIndex: 0,
    packagingId: null,
    thumbnailHint: null,
    overallStatus: "in_progress",
    currentStep: "hooks",
    isDeleted: false,
    deletedAt: null,
    pipeline: {
      research: { status: "completed", startedAt: null, completedAt: null },
      script: { status: "completed", startedAt: null, completedAt: null },
      hooks: { status: "completed", startedAt: null, completedAt: null },
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

// ---------------------------------------------------------------------------
// Real cross-service wiring: PackagingService + a REAL VideoProjectService
// ---------------------------------------------------------------------------
function makeWiredServices(initialProject: IVideoProject) {
  let state = initialProject;

  const vpRepo = {
    create: jest.fn(),
    findById: jest.fn(async () => state),
    findByIdeaId: jest.fn(),
    findByScriptId: jest.fn(),
    list: jest.fn(),
    update: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
      state = applyDottedPatch(state, patch);
    }),
  } as unknown as jest.Mocked<VideoProjectRepository>;

  const contentRepo = {
    getIdea: jest.fn(),
    updateIdea: jest.fn(),
    batchSaveIdeas: jest.fn(),
    getScriptById: jest.fn().mockResolvedValue({ createdBy: "user-1" }),
  } as unknown as jest.Mocked<ContentRepository>;

  const hooksRepoForVp = {
    findById: jest.fn().mockResolvedValue({ createdBy: "user-1" }),
  } as unknown as jest.Mocked<HooksRepository>;

  // Stateful fake: tracks per-item statuses across sequential generate-* calls,
  // exactly like the real transaction does across concurrent/sequential writes.
  const itemStatuses: Record<string, string> = {
    title: "not_started", description: "not_started", thumbnail: "not_started", shorts: "not_started",
  };
  let packagingCreated = false;

  const packagingRepo = {
    get: jest.fn().mockResolvedValue({ createdBy: "user-1", thumbnail: [] }),
    clearStale: jest.fn().mockResolvedValue(undefined),
    upsertGeneratedItem: jest.fn(async (videoProjectId: string, _userId: string, _field: string, item: string) => {
      itemStatuses[item] = "completed";
      const created = !packagingCreated;
      packagingCreated = true;
      return { packagingId: videoProjectId, created, statuses: { ...itemStatuses } };
    }),
  } as unknown as jest.Mocked<PackagingRepository>;

  const vpService = new VideoProjectService(vpRepo, contentRepo, packagingRepo, hooksRepoForVp, makeTestAccountService());
  const packagingService = new PackagingService(packagingRepo, vpService, makeContextService(), makeTestAccountService());

  return { vpRepo, packagingRepo, vpService, packagingService, getState: () => state };
}

describe("Packaging generation flow — persist-on-generate drives the pipeline (real VideoProjectService)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("generating title starts the TITLE step but never completes packaging or title", async () => {
    mockGenerate.mockResolvedValue(makeStream(JSON.stringify({ titles: [{ title: "T1", characterCount: 10 }] })));
    const { packagingService, getState } = makeWiredServices(makeProject());

    await packagingService.generateTitle("user-1", "a script", "proj-1");

    expect(getState().pipeline.title.status).toBe("in_progress");
    expect(getState().pipeline.packaging.status).toBe("not_started");
  });

  it("packaging only auto-completes once description, thumbnail AND shorts all exist — not on title, and not on any partial subset", async () => {
    const { packagingService, getState } = makeWiredServices(makeProject());

    mockGenerate.mockResolvedValueOnce(makeStream(JSON.stringify({ titles: [{ title: "T1", characterCount: 10 }] })));
    await packagingService.generateTitle("user-1", "a script", "proj-1");
    expect(getState().pipeline.packaging.status).toBe("not_started");

    mockGenerate.mockResolvedValueOnce(makeStream(JSON.stringify({ description: "An SEO description." })));
    await packagingService.generateDescription("user-1", "a script", "T1", "proj-1");
    expect(getState().pipeline.packaging.status).toBe("in_progress"); // started, but not all 3 present yet

    mockGenerate.mockResolvedValueOnce(makeStream(JSON.stringify({ descriptions: ["Brief one"] })));
    await packagingService.generateThumbnail("user-1", "a script", "T1", "proj-1");
    expect(getState().pipeline.packaging.status).toBe("in_progress"); // shorts still missing

    mockGenerate.mockResolvedValueOnce(
      makeStream(JSON.stringify({ segments: [{ startTime: "0:00", endTime: "0:05", content: "x", type: "hook" }], totalDuration: "0:60" }))
    );
    await packagingService.generateShorts("user-1", "a script", 60, "proj-1");

    // The THIRD of {description, thumbnail, shorts} to land completes packaging.
    expect(getState().pipeline.packaging.status).toBe("completed");
    // Title never auto-completes through generation — only through selectTitle.
    expect(getState().pipeline.title.status).toBe("in_progress");
  });

  it("the packaging doc is linked to the project on the FIRST generated item only (subsequent items reuse it)", async () => {
    const { packagingService, vpRepo } = makeWiredServices(makeProject());
    mockGenerate
      .mockResolvedValueOnce(makeStream(JSON.stringify({ titles: [{ title: "T1", characterCount: 10 }] })))
      .mockResolvedValueOnce(makeStream(JSON.stringify({ description: "desc" })));

    await packagingService.generateTitle("user-1", "a script", "proj-1");
    await packagingService.generateDescription("user-1", "a script", "T1", "proj-1");

    const linkCalls = (vpRepo.update as jest.Mock).mock.calls.filter(
      ([, patch]) => (patch as Record<string, unknown>).packagingId
    );
    expect(linkCalls).toHaveLength(1);
  });
});

describe("Title continuity — the Title step completes on selection, never on generation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("selectTitle (not generateTitle) is what completes the title step and renames the project", async () => {
    mockGenerate.mockResolvedValue(makeStream(JSON.stringify({ titles: [{ title: "Chosen Title", characterCount: 12 }] })));
    const { packagingService, packagingRepo, getState } = makeWiredServices(makeProject());

    const { packagingId } = (await packagingService.generateTitle("user-1", "a script", "proj-1")) as { packagingId: string };
    expect(getState().pipeline.title.status).toBe("in_progress"); // started, not completed

    (packagingRepo.get as jest.Mock).mockResolvedValue({
      id: packagingId,
      createdBy: "user-1",
      videoProjectId: "proj-1",
      titles: [{ title: "Chosen Title", characterCount: 12 }],
    });
    packagingRepo.update = jest.fn().mockResolvedValue({});

    await packagingService.selectTitle("user-1", packagingId, 0);

    expect(getState().pipeline.title.status).toBe("completed");
    expect(getState().title).toBe("Chosen Title");
  });
});

describe("Door flow — a save with no videoProjectId creates exactly one project", () => {
  beforeEach(() => jest.clearAllMocks());

  it("a single door save creates exactly one project (not zero, not more than one)", async () => {
    const project = makeProject({ id: "shallow-1" });
    const { packagingService, vpRepo } = makeWiredServices(project);
    const createSpy = vpRepo.create as jest.Mock;
    createSpy.mockResolvedValue(project);
    (vpRepo.update as jest.Mock).mockResolvedValue(undefined);

    const packagingRepoForSave = {
      // Phase 05a: creates are keyed on the project id.
      saveWithId: jest.fn(async (id: string, _data: Record<string, unknown>) => ({ id })),
      findByVideoProject: jest.fn().mockResolvedValue(null),
      // No packaging doc exists yet for a brand-new door project.
      get: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    } as unknown as PackagingRepository;

    const contentRepo = {
      getIdea: jest.fn().mockResolvedValue({ id: "idea-shallow", createdBy: "user-1", title: "My Title" }),
      updateIdea: jest.fn(),
      batchSaveIdeas: jest.fn().mockResolvedValue([{ id: "idea-shallow", title: "My Title", createdBy: "user-1" }]),
      getScriptById: jest.fn(),
    } as unknown as ContentRepository;

    const { formatGeneratedTitle } = jest.requireMock("../../../src/utlils/content") as { formatGeneratedTitle: jest.Mock };
    formatGeneratedTitle.mockResolvedValue({ title: "My Title", createdBy: "user-1" });

    const vpService = new VideoProjectService(vpRepo, contentRepo, packagingRepoForSave as any, {} as any, makeTestAccountService());
    const service = new PackagingService(packagingRepoForSave as any, vpService, makeContextService(), makeTestAccountService());

    await service.savePackaging("user-1", { titles: [{ title: "My Title", characterCount: 8 }] });

    // Exactly one project created for this door save.
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("a second save carrying the adopted videoProjectId reuses it — no second project is created", async () => {
    const project = makeProject({ id: "shallow-1" });
    const { vpRepo } = makeWiredServices(project);
    (vpRepo.update as jest.Mock).mockResolvedValue(undefined);

    const packagingRepoForSave = {
      saveWithId: jest.fn(async (id: string, _data: Record<string, unknown>) => ({ id })),
      findByVideoProject: jest.fn().mockResolvedValue(null),
      get: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ id: "shallow-1" }),
    } as unknown as PackagingRepository;

    const contentRepo = { getIdea: jest.fn(), updateIdea: jest.fn(), batchSaveIdeas: jest.fn(), getScriptById: jest.fn() } as unknown as ContentRepository;
    const vpService = new VideoProjectService(vpRepo, contentRepo, packagingRepoForSave as any, {} as any, makeTestAccountService());
    const service = new PackagingService(packagingRepoForSave as any, vpService, makeContextService(), makeTestAccountService());
    const createSpy = vpRepo.create as jest.Mock;

    // Client adopts the id from the first save and passes it explicitly this time.
    // Post-05a the packaging id IS the project id, so this is a point read hit.
    (packagingRepoForSave.get as jest.Mock).mockResolvedValue({ id: "shallow-1" });
    await service.savePackaging("user-1", { description: "edit" }, "shallow-1");

    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("Stale lifecycle — a plain save never clears stale; only regenerate does", () => {
  beforeEach(() => jest.clearAllMocks());

  it("full cycle: hooks regenerate marks packaging stale → a re-save does NOT clear it → regenerateItem does", async () => {
    const staleProject = makeProject({
      packagingId: "pkg-1",
      pipeline: {
        research: { status: "completed", startedAt: null, completedAt: null },
        script: { status: "completed", startedAt: null, completedAt: null },
        hooks: { status: "completed", startedAt: null, completedAt: null },
        title: { status: "completed", startedAt: null, completedAt: null },
        packaging: { status: "completed", startedAt: null, completedAt: null },
      },
    });
    const { vpService, vpRepo } = makeWiredServices(staleProject);

    // Step 1: hooks regenerated -> cascades stale to title + packaging (real VP logic).
    await vpService.markStale("proj-1", "hooks");
    expect(vpRepo.update).toHaveBeenCalledWith(
      "proj-1",
      expect.objectContaining({ "pipeline.packaging.status": "stale", "pipeline.packaging.staleReason": "hooks_regenerated" })
    );

    // Step 2: a plain edit-save must NOT clear the packaging document's stale
    // markers or complete the step (docs/features/packaging/spec.md — "A stale
    // package stays stale through a save"). All three content items are
    // already present (so "packagingComplete" would be true by content alone)
    // — the ONLY thing standing between this save and an accidental
    // un-staling is the explicit `!existing?.isStale` guard.
    const packagingRepoForSave = {
      save: jest.fn(),
      findByVideoProject: jest.fn().mockResolvedValue({
        id: "pkg-1",
        createdBy: "user-1",
        videoProjectId: "proj-1",
        isStale: true,
        staleReason: "hooks_regenerated",
        description: "Stored description.",
        thumbnail: ["Stored brief"],
        shorts: { segments: [{ startTime: "0:00", endTime: "0:05", content: "x", type: "hook" }] },
        itemStatuses: { title: "stale", description: "stale", thumbnail: "stale", shorts: "stale" },
      }),
      get: jest.fn().mockResolvedValue({ createdBy: "user-1", thumbnail: [] }),
      update: jest.fn().mockResolvedValue({ id: "pkg-1" }),
      clearStale: jest.fn(),
    } as unknown as PackagingRepository;

    const saveService = new PackagingService(packagingRepoForSave as any, vpService, makeContextService(), makeTestAccountService());
    await saveService.savePackaging("user-1", { description: "Edited text" }, "proj-1");

    const savedPatch = (packagingRepoForSave.update as jest.Mock).mock.calls[0][1];
    expect(savedPatch).not.toHaveProperty("isStale");
    expect(savedPatch).not.toHaveProperty("itemStatuses");
    expect(vpRepo.update).not.toHaveBeenCalledWith("proj-1", expect.objectContaining({ "pipeline.packaging.status": "completed" }));
  });
});

describe("Ownership — generation on a project owned by another user is rejected", () => {
  beforeEach(() => jest.clearAllMocks());

  it("generateTitle with a videoProjectId owned by someone else throws 403 and never persists", async () => {
    mockGenerate.mockResolvedValue(makeStream(JSON.stringify({ titles: [{ title: "T", characterCount: 1 }] })));
    const { packagingService, packagingRepo } = makeWiredServices(makeProject({ createdBy: "someone-else" }));

    const err: any = await packagingService.generateTitle("user-1", "a script", "proj-1").catch((e: any) => e);

    expect(err.statusCode).toBe(403);
    expect(packagingRepo.upsertGeneratedItem).not.toHaveBeenCalled();
  });
});
