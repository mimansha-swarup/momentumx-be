jest.mock("firebase-admin", () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(jest.fn().mockReturnValue({}), {
    FieldValue: { serverTimestamp: jest.fn() },
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
      FieldValue: { serverTimestamp: jest.fn() },
      FieldPath: { documentId: jest.fn() },
    },
  },
}));

import HooksService from "../../src/service/hooks.service";
import HooksRepository from "../../src/repository/hooks.repository";
import VideoProjectService from "../../src/service/video-project.service";
import { generateStreamingContent } from "../../src/utlils/ai";

import { makeTestAccountService, testOwner, TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID, fakeAccountRepo } from "../helpers/account";
jest.mock("../../src/repository/hooks.repository");
jest.mock("../../src/service/video-project.service");
jest.mock("../../src/utlils/ai", () => ({
  generateStreamingContent: jest.fn(),
  // collectJson stays REAL: it is the empty/malformed-JSON guard, and the fake
  // streams below are exactly what should be driving it.
  collectJson: jest.requireActual("../../src/utlils/ai").collectJson,
}));

const MockHooksRepo = HooksRepository as jest.MockedClass<typeof HooksRepository>;
const MockVideoProjectService = VideoProjectService as jest.MockedClass<typeof VideoProjectService>;
const mockGenerate = generateStreamingContent as jest.MockedFunction<typeof generateStreamingContent>;

const HOOKS_JSON = '{"hooks":["h1","h2","h3","h4","h5"]}';

function makeStream(text: string) {
  return {
    stream: (async function* () { yield { text: () => text }; })(),
  } as any;
}

const mockBatch = {
  id: "hooks-1",
  videoProjectId: "proj-1",
  createdBy: "user-1",
  accountId: TEST_ACCOUNT_ID,
  hooks: ["h1", "h2", "h3", "h4", "h5"],
  hookFeedback: {},
  createdAt: {} as any,
};

// The lock and preconditions are the seam's job and are tested in
// tests/unit/service/hooks.flow.behaviour.test.ts and the repository suite. Here
// a pass-through runner keeps these tests focused on hook iteration itself.
import { makeTestStepRunner } from "../helpers/step-runner";

const passThroughRunner = () =>
  ({ run: (_spec: unknown, generate: () => unknown) => generate() }) as never;

describe("HooksService — regenerate", () => {
  let service: HooksService;
  let mockRepo: jest.Mocked<HooksRepository>;
  let mockVpService: jest.Mocked<VideoProjectService>;

  beforeEach(() => {
    mockRepo = new MockHooksRepo() as jest.Mocked<HooksRepository>;
    mockVpService = new MockVideoProjectService(null as any, null as any, null as any, null as any, {} as never) as jest.Mocked<VideoProjectService>;
    service = new HooksService(mockRepo, mockVpService, undefined, passThroughRunner(), fakeAccountRepo());
    mockGenerate.mockResolvedValue(makeStream(HOOKS_JSON));
  });

  it("throws 404 if batch not found", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(null);
    const err = await service.regenerate(testOwner("user-1"), "hooks-1", "script text").catch(e => e);
    expect(err.statusCode).toBe(404);
  });

  it("throws 403 if not owner", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue({ ...mockBatch, createdBy: "other", accountId: OTHER_ACCOUNT_ID });
    const err = await service.regenerate(testOwner("user-1"), "hooks-1", "script text").catch(e => e);
    expect(err.statusCode).toBe(403);
  });

  it("throws 400 if script is empty", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch);
    const err = await service.regenerate(testOwner("user-1"), "hooks-1", "").catch(e => e);
    expect(err.statusCode).toBe(400);
  });

  it("happy path: calls AI, updates repo, clears selected hook, marks stale, returns new hooks", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch);
    mockRepo.update = jest.fn().mockResolvedValue(undefined);
    mockVpService.clearSelectedHook = jest.fn().mockResolvedValue(undefined);
    mockVpService.markStale = jest.fn().mockResolvedValue(undefined);
    mockVpService.markPackagingDocumentStale = jest.fn().mockResolvedValue(undefined);

    const result = await service.regenerate(testOwner("user-1"), "hooks-1", "my script");

    expect(mockRepo.update).toHaveBeenCalledWith("hooks-1", {
      hooks: ["h1", "h2", "h3", "h4", "h5"],
      hookFeedback: {},
    });
    expect(mockVpService.clearSelectedHook).toHaveBeenCalledWith("proj-1", testOwner("user-1"));
    expect(mockVpService.markStale).toHaveBeenCalledWith("proj-1", "hooks");
    expect(mockVpService.markPackagingDocumentStale).toHaveBeenCalledWith("proj-1", "hooks_regenerated");
    expect(result).toEqual({ id: "hooks-1", hooks: ["h1", "h2", "h3", "h4", "h5"], hookFeedback: {} });
  });
});

// Regression guard. The generation seam once wrapped `regenerate` exactly like
// `generate`, which took the step lock and enforced REQUIRES.hooks. Both are
// wrong for regeneration, and both broke the primary user flow:
//
//  - hooks stays `in_progress` from generate until the user SELECTS one, so the
//    ordinary "try again" click 409'd for the full 3-minute lock window;
//  - a successful regenerate calls clearSelectedHook, which sets the step back to
//    `in_progress`, re-arming the false lock for the next attempt;
//  - after an upstream regen marks `script` stale, regenerating hooks is exactly
//    what the user needs, and the precondition would 400 it.
//
// `pipeline.<step>.status` means "the user is working on this step", not "a
// generation is in flight". Do not reuse it as a lock.
describe("HooksService — regenerate is not blocked by step state", () => {
  let service: HooksService;
  let mockRepo: jest.Mocked<HooksRepository>;
  let mockVpService: jest.Mocked<VideoProjectService>;

  const setup = (project: Record<string, unknown>) => {
    mockRepo = new MockHooksRepo() as jest.Mocked<HooksRepository>;
    mockVpService = new MockVideoProjectService(null as any, null as any, null as any, null as any, {} as never) as jest.Mocked<VideoProjectService>;
    service = new HooksService(
      mockRepo,
      mockVpService,
      undefined,
      makeTestStepRunner({ project: project as never }),
      fakeAccountRepo()
    );
    mockGenerate.mockResolvedValue(makeStream(HOOKS_JSON));
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch);
    mockRepo.update = jest.fn().mockResolvedValue(undefined);
    mockVpService.clearSelectedHook = jest.fn().mockResolvedValue(undefined);
    mockVpService.markStale = jest.fn().mockResolvedValue(undefined);
    mockVpService.markPackagingDocumentStale = jest.fn().mockResolvedValue(undefined);
  };

  it("succeeds while the hooks step is still in_progress (the ordinary retry)", async () => {
    setup({
      createdBy: "user-1",
      accountId: TEST_ACCOUNT_ID,
      pipeline: {
        script: { status: "completed", startedAt: null },
        hooks: { status: "in_progress", startedAt: { toMillis: () => Date.now() } },
      },
    });

    const result = await service.regenerate(testOwner("user-1"), "hooks-1", "my script");

    expect(result.hooks).toHaveLength(5);
    expect(mockGenerate).toHaveBeenCalled();
  });

  it("succeeds while the script step is stale (upstream regen cascaded down)", async () => {
    setup({
      createdBy: "user-1",
      accountId: TEST_ACCOUNT_ID,
      pipeline: {
        script: { status: "stale", startedAt: null },
        hooks: { status: "stale", startedAt: null },
      },
    });

    const result = await service.regenerate(testOwner("user-1"), "hooks-1", "my script");

    expect(result.hooks).toHaveLength(5);
    expect(mockGenerate).toHaveBeenCalled();
  });
});

describe("HooksService — select", () => {
  let service: HooksService;
  let mockRepo: jest.Mocked<HooksRepository>;
  let mockVpService: jest.Mocked<VideoProjectService>;

  beforeEach(() => {
    mockRepo = new MockHooksRepo() as jest.Mocked<HooksRepository>;
    mockVpService = new MockVideoProjectService(null as any, null as any, null as any, null as any, {} as never) as jest.Mocked<VideoProjectService>;
    service = new HooksService(mockRepo, mockVpService, undefined, passThroughRunner(), fakeAccountRepo());
  });

  it("binds the hook to the STORED project (videoProjectId from the batch, never the client) and completes the step", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch); // videoProjectId: "proj-1"
    mockVpService.setSelectedHook = jest.fn().mockResolvedValue({ id: "proj-1", hooksId: "hooks-1", selectedHookIndex: 2 });
    mockVpService.completeStep = jest.fn().mockResolvedValue(undefined);

    const result = await service.select(testOwner("user-1"), "hooks-1", 2);

    // proj-1 comes from the stored batch — select takes no project id from the caller.
    expect(mockVpService.setSelectedHook).toHaveBeenCalledWith("proj-1", "hooks-1", 2, testOwner("user-1"));
    expect(mockVpService.completeStep).toHaveBeenCalledWith("proj-1", "hooks", testOwner("user-1"));
    expect(result).toEqual({ id: "proj-1", hooksId: "hooks-1", selectedHookIndex: 2 });
  });

  it("throws 404 when the batch is not found (no binding attempted)", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(null);
    mockVpService.setSelectedHook = jest.fn();
    const err = await service.select(testOwner("user-1"), "hooks-1", 0).catch((e) => e);
    expect(err.statusCode).toBe(404);
    expect(mockVpService.setSelectedHook).not.toHaveBeenCalled();
  });

  it("throws 403 when the batch is not owned by the user", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue({ ...mockBatch, createdBy: "other", accountId: OTHER_ACCOUNT_ID });
    mockVpService.setSelectedHook = jest.fn();
    const err = await service.select(testOwner("user-1"), "hooks-1", 0).catch((e) => e);
    expect(err.statusCode).toBe(403);
    expect(mockVpService.setSelectedHook).not.toHaveBeenCalled();
  });

  it("throws 400 when hookIndex is out of range", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch);
    mockVpService.setSelectedHook = jest.fn();
    const high = await service.select(testOwner("user-1"), "hooks-1", 5).catch((e) => e);
    const low = await service.select(testOwner("user-1"), "hooks-1", -1).catch((e) => e);
    expect(high.statusCode).toBe(400);
    expect(low.statusCode).toBe(400);
    expect(mockVpService.setSelectedHook).not.toHaveBeenCalled();
  });

  it("throws 400 when the stored batch has no videoProjectId (cannot bind)", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue({ ...mockBatch, videoProjectId: undefined });
    mockVpService.setSelectedHook = jest.fn();
    const err = await service.select(testOwner("user-1"), "hooks-1", 0).catch((e) => e);
    expect(err.statusCode).toBe(400);
    expect(mockVpService.setSelectedHook).not.toHaveBeenCalled();
  });

  it("still resolves when completeStep fails (best-effort step transition)", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch);
    mockVpService.setSelectedHook = jest.fn().mockResolvedValue({ id: "proj-1", hooksId: "hooks-1", selectedHookIndex: 1 });
    mockVpService.completeStep = jest.fn().mockRejectedValue(new Error("step boom"));

    const result = await service.select(testOwner("user-1"), "hooks-1", 1);

    expect(result).toEqual({ id: "proj-1", hooksId: "hooks-1", selectedHookIndex: 1 });
  });

  it("propagates a setSelectedHook failure and does NOT complete the step (binding is fatal, not best-effort)", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch);
    mockVpService.setSelectedHook = jest.fn().mockRejectedValue(new Error("bind boom"));
    mockVpService.completeStep = jest.fn();

    const err = await service.select(testOwner("user-1"), "hooks-1", 1).catch((e) => e);

    expect(err.message).toBe("bind boom");
    expect(mockVpService.completeStep).not.toHaveBeenCalled();
  });
});

describe("HooksService — exportHooks", () => {
  let service: HooksService;
  let mockRepo: jest.Mocked<HooksRepository>;
  let mockVpService: jest.Mocked<VideoProjectService>;

  beforeEach(() => {
    mockRepo = new MockHooksRepo() as jest.Mocked<HooksRepository>;
    mockVpService = new MockVideoProjectService(null as any, null as any, null as any, null as any, {} as never) as jest.Mocked<VideoProjectService>;
    service = new HooksService(mockRepo, mockVpService, undefined, passThroughRunner(), fakeAccountRepo());
  });

  it("throws 404 if batch not found", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(null);
    const err = await service.exportHooks(testOwner("user-1"), "hooks-1").catch(e => e);
    expect(err.statusCode).toBe(404);
  });

  it("throws 403 if not owner", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue({ ...mockBatch, createdBy: "other", accountId: OTHER_ACCOUNT_ID });
    const err = await service.exportHooks(testOwner("user-1"), "hooks-1").catch(e => e);
    expect(err.statusCode).toBe(403);
  });

  it("returns { text, count } with all hooks in numbered list", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch);

    const result = await service.exportHooks(testOwner("user-1"), "hooks-1");

    expect(result.count).toBe(5);
    expect(result.text).toContain("Hooks —");
    expect(result.text).toContain("1. h1");
    expect(result.text).toContain("5. h5");
  });
});

describe("HooksService — generate (idempotency, lock, rollback)", () => {
  let service: HooksService;
  let mockRepo: jest.Mocked<HooksRepository>;
  let mockVpService: jest.Mocked<VideoProjectService>;

  const makeProj = (over: Record<string, unknown> = {}) => ({
    id: "proj-1",
    hooksId: null,
    pipeline: {
      script: { status: "completed" },
      hooks: { status: "not_started", startedAt: null },
    },
    ...over,
  });

  beforeEach(() => {
    mockRepo = new MockHooksRepo() as jest.Mocked<HooksRepository>;
    mockVpService = new MockVideoProjectService(null as any, null as any, null as any, null as any, {} as never) as jest.Mocked<VideoProjectService>;
    service = new HooksService(mockRepo, mockVpService, undefined, passThroughRunner(), fakeAccountRepo());
    mockGenerate.mockResolvedValue(makeStream(HOOKS_JSON));
    mockVpService.getById = jest.fn().mockResolvedValue(makeProj()) as any;
    mockVpService.startStep = jest.fn().mockResolvedValue(undefined) as any;
    mockVpService.abandonStep = jest.fn().mockResolvedValue(undefined) as any;
    mockVpService.linkResource = jest.fn().mockResolvedValue(undefined) as any;
    mockRepo.findById = jest.fn();
    mockRepo.save = jest.fn().mockResolvedValue(mockBatch);
  });

  it("returns the existing linked batch without regenerating (idempotent start)", async () => {
    mockVpService.getById = jest.fn().mockResolvedValue(makeProj({ hooksId: "hooks-1" })) as any;
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch);

    const result = await service.generate(testOwner("user-1"), "proj-1", "my script");

    expect(result).toBe(mockBatch);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockRepo.save).not.toHaveBeenCalled();
  });

  // The lock and the rollback moved into the generation seam (Phase 01b).
  //
  // The lock ITSELF is tested in `tests/unit/repository/step-lock.behaviour.test.ts`
  // against the real transaction — asserting a 409 here would only assert the
  // status code this file's own fake throws, which is what the earlier version of
  // this test did. What belongs here is the service's half of the contract: when
  // the seam refuses, nothing is generated and nothing is written.
  it("spends no generation when the seam refuses an in-flight step", async () => {
    const inFlight = makeProj({
      createdBy: "user-1",
      accountId: TEST_ACCOUNT_ID,
      pipeline: {
        script: { status: "completed" },
        hooks: { status: "in_progress", startedAt: { toMillis: () => Date.now() } },
      },
    });
    mockVpService.getById = jest.fn().mockResolvedValue(inFlight) as any;
    service = new HooksService(
      mockRepo,
      mockVpService,
      undefined,
      makeTestStepRunner({ project: inFlight as never }),
      fakeAccountRepo()
    );

    await service.generate(testOwner("user-1"), "proj-1", "my script").catch(() => undefined);

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockRepo.save).not.toHaveBeenCalled();
  });

  it("restores the step when generation fails, then rethrows", async () => {
    const project = makeProj({ createdBy: "user-1", accountId: TEST_ACCOUNT_ID });
    mockVpService.getById = jest.fn().mockResolvedValue(project) as any;
    const released: Array<{ step: string; prior: unknown }> = [];
    service = new HooksService(
      mockRepo,
      mockVpService,
      undefined,
      makeTestStepRunner({
        project: project as never,
        onRelease: (step, prior) => released.push({ step, prior }),
      }),
      fakeAccountRepo()
    );
    mockGenerate.mockResolvedValue(makeStream("not json"));

    const err = await service.generate(testOwner("user-1"), "proj-1", "my script").catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    // releaseStep restores CAPTURED prior state. The old abandonStep hardcoded
    // "not_started", which silently cleared a stale marker when the step being
    // abandoned was stale.
    expect(released).toHaveLength(1);
    expect(released[0].step).toBe("hooks");
    expect(released[0].prior).toMatchObject({ status: "not_started" });
    expect(mockRepo.save).not.toHaveBeenCalled();
  });
});
