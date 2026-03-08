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

jest.mock("../../src/repository/hooks.repository");
jest.mock("../../src/service/video-project.service");
jest.mock("../../src/utlils/ai", () => ({ generateStreamingContent: jest.fn() }));

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
  hooks: ["h1", "h2", "h3", "h4", "h5"],
  hookFeedback: {},
  createdAt: {} as any,
};

describe("HooksService — regenerate", () => {
  let service: HooksService;
  let mockRepo: jest.Mocked<HooksRepository>;
  let mockVpService: jest.Mocked<VideoProjectService>;

  beforeEach(() => {
    mockRepo = new MockHooksRepo() as jest.Mocked<HooksRepository>;
    mockVpService = new MockVideoProjectService(null as any, null as any, null as any) as jest.Mocked<VideoProjectService>;
    service = new HooksService(mockRepo, mockVpService);
    mockGenerate.mockResolvedValue(makeStream(HOOKS_JSON));
  });

  it("throws 404 if batch not found", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(null);
    const err = await service.regenerate("user-1", "hooks-1", "script text").catch(e => e);
    expect(err.statusCode).toBe(404);
  });

  it("throws 403 if not owner", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue({ ...mockBatch, createdBy: "other" });
    const err = await service.regenerate("user-1", "hooks-1", "script text").catch(e => e);
    expect(err.statusCode).toBe(403);
  });

  it("throws 400 if script is empty", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch);
    const err = await service.regenerate("user-1", "hooks-1", "").catch(e => e);
    expect(err.statusCode).toBe(400);
  });

  it("happy path: calls AI, updates repo, clears selected hook, marks stale, returns new hooks", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch);
    mockRepo.update = jest.fn().mockResolvedValue(undefined);
    mockVpService.clearSelectedHook = jest.fn().mockResolvedValue(undefined);
    mockVpService.markStale = jest.fn().mockResolvedValue(undefined);

    const result = await service.regenerate("user-1", "hooks-1", "my script");

    expect(mockRepo.update).toHaveBeenCalledWith("hooks-1", {
      hooks: ["h1", "h2", "h3", "h4", "h5"],
      hookFeedback: {},
    });
    expect(mockVpService.clearSelectedHook).toHaveBeenCalledWith("proj-1", "user-1");
    expect(mockVpService.markStale).toHaveBeenCalledWith("proj-1", "hooks");
    expect(result).toEqual({ id: "hooks-1", hooks: ["h1", "h2", "h3", "h4", "h5"], hookFeedback: {} });
  });
});

describe("HooksService — updateFeedback", () => {
  let service: HooksService;
  let mockRepo: jest.Mocked<HooksRepository>;
  let mockVpService: jest.Mocked<VideoProjectService>;

  beforeEach(() => {
    mockRepo = new MockHooksRepo() as jest.Mocked<HooksRepository>;
    mockVpService = new MockVideoProjectService(null as any, null as any, null as any) as jest.Mocked<VideoProjectService>;
    service = new HooksService(mockRepo, mockVpService);
  });

  it("throws 404 if batch not found", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(null);
    const err = await service.updateFeedback("user-1", "hooks-1", 0, "like").catch(e => e);
    expect(err.statusCode).toBe(404);
  });

  it("throws 403 if not owner", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue({ ...mockBatch, createdBy: "other" });
    const err = await service.updateFeedback("user-1", "hooks-1", 0, "like").catch(e => e);
    expect(err.statusCode).toBe(403);
  });

  it("throws 400 if hookIndex is negative", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch);
    const err = await service.updateFeedback("user-1", "hooks-1", -1, "like").catch(e => e);
    expect(err.statusCode).toBe(400);
  });

  it("throws 400 if hookIndex is >= hooks.length", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch);
    const err = await service.updateFeedback("user-1", "hooks-1", 5, "like").catch(e => e);
    expect(err.statusCode).toBe(400);
  });

  it("throws 400 if feedback is invalid", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch);
    const err = await service.updateFeedback("user-1", "hooks-1", 0, "invalid" as any).catch(e => e);
    expect(err.statusCode).toBe(400);
  });

  it("happy path: updates hookFeedback map and returns { id, hookIndex, feedback }", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch);
    mockRepo.update = jest.fn().mockResolvedValue(undefined);

    const result = await service.updateFeedback("user-1", "hooks-1", 2, "like");

    expect(mockRepo.update).toHaveBeenCalledWith("hooks-1", { "hookFeedback.2": "like" });
    expect(result).toEqual({ id: "hooks-1", hookIndex: 2, feedback: "like" });
  });

  it("happy path: hookIndex 0 and null feedback both work", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch);
    mockRepo.update = jest.fn().mockResolvedValue(undefined);

    const result = await service.updateFeedback("user-1", "hooks-1", 0, null);
    expect(result).toEqual({ id: "hooks-1", hookIndex: 0, feedback: null });
  });
});

describe("HooksService — exportHooks", () => {
  let service: HooksService;
  let mockRepo: jest.Mocked<HooksRepository>;
  let mockVpService: jest.Mocked<VideoProjectService>;

  beforeEach(() => {
    mockRepo = new MockHooksRepo() as jest.Mocked<HooksRepository>;
    mockVpService = new MockVideoProjectService(null as any, null as any, null as any) as jest.Mocked<VideoProjectService>;
    service = new HooksService(mockRepo, mockVpService);
  });

  it("throws 404 if batch not found", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(null);
    const err = await service.exportHooks("user-1", "hooks-1").catch(e => e);
    expect(err.statusCode).toBe(404);
  });

  it("throws 403 if not owner", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue({ ...mockBatch, createdBy: "other" });
    const err = await service.exportHooks("user-1", "hooks-1").catch(e => e);
    expect(err.statusCode).toBe(403);
  });

  it("returns { text, count } with all hooks in numbered list", async () => {
    mockRepo.findById = jest.fn().mockResolvedValue(mockBatch);

    const result = await service.exportHooks("user-1", "hooks-1");

    expect(result.count).toBe(5);
    expect(result.text).toContain("Hooks —");
    expect(result.text).toContain("1. h1");
    expect(result.text).toContain("5. h5");
  });
});
