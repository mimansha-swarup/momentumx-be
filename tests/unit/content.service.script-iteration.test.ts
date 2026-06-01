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

jest.mock("../../src/utlils/ai", () => ({
  generateContent: jest.fn(),
  generateStreamingContent: jest.fn(),
}));

import ContentService from "../../src/service/content.service";
import ContentRepository from "../../src/repository/content.repository";
import UserRepository from "../../src/repository/user.repository";
import { generateStreamingContent } from "../../src/utlils/ai";

jest.mock("../../src/repository/content.repository");
jest.mock("../../src/repository/user.repository");

const mockGenerateStreaming = generateStreamingContent as jest.MockedFunction<typeof generateStreamingContent>;

function makeScriptStream(text: string) {
  return {
    stream: (async function* () { yield { text: () => text }; })(),
  } as any;
}

const MockContentRepo = ContentRepository as jest.MockedClass<typeof ContentRepository>;
const MockUserRepo = UserRepository as jest.MockedClass<typeof UserRepository>;

describe("ContentService — updateScriptFeedback", () => {
  let service: ContentService;
  let mockContentRepo: jest.Mocked<ContentRepository>;
  let mockUserRepo: jest.Mocked<UserRepository>;

  beforeEach(() => {
    mockContentRepo = new MockContentRepo() as jest.Mocked<ContentRepository>;
    mockUserRepo = new MockUserRepo() as jest.Mocked<UserRepository>;
    service = new ContentService(mockContentRepo, mockUserRepo);
  });

  it("throws 404 if script not found", async () => {
    mockContentRepo.getScriptById = jest.fn().mockResolvedValue(null);
    const err = await service.updateScriptFeedback("user-1", "script-1", "like").catch(e => e);
    expect(err.statusCode).toBe(404);
    expect(err.message).toMatch(/not found/i);
  });

  it("throws 403 if script belongs to another user", async () => {
    mockContentRepo.getScriptById = jest.fn().mockResolvedValue({ id: "script-1", createdBy: "other-user", title: "T", script: "S" });
    const err = await service.updateScriptFeedback("user-1", "script-1", "like").catch(e => e);
    expect(err.statusCode).toBe(403);
  });

  it("throws 400 for invalid feedback value", async () => {
    mockContentRepo.getScriptById = jest.fn().mockResolvedValue({ id: "script-1", createdBy: "user-1", title: "T", script: "S" });
    mockContentRepo.editScript = jest.fn();
    const err = await service.updateScriptFeedback("user-1", "script-1", "invalid" as any).catch(e => e);
    expect(err.statusCode).toBe(400);
  });

  it("happy path: saves feedback and returns { id, userFeedback }", async () => {
    mockContentRepo.getScriptById = jest.fn().mockResolvedValue({ id: "script-1", createdBy: "user-1", title: "T", script: "S" });
    mockContentRepo.editScript = jest.fn().mockResolvedValue(undefined);
    const result = await service.updateScriptFeedback("user-1", "script-1", "like");
    expect(mockContentRepo.editScript).toHaveBeenCalledWith("script-1", { userFeedback: "like" });
    expect(result).toEqual({ id: "script-1", userFeedback: "like" });
  });

  it("happy path: clearing feedback with null", async () => {
    mockContentRepo.getScriptById = jest.fn().mockResolvedValue({ id: "script-1", createdBy: "user-1", title: "T", script: "S" });
    mockContentRepo.editScript = jest.fn().mockResolvedValue(undefined);
    const result = await service.updateScriptFeedback("user-1", "script-1", null);
    expect(mockContentRepo.editScript).toHaveBeenCalledWith("script-1", { userFeedback: null });
    expect(result).toEqual({ id: "script-1", userFeedback: null });
  });
});

describe("ContentService — regenerateScript", () => {
  let service: ContentService;
  let mockContentRepo: jest.Mocked<ContentRepository>;
  let mockUserRepo: jest.Mocked<UserRepository>;
  const mockVpService = {
    getById: jest.fn(),
    markStale: jest.fn(),
    markPackagingDocumentStale: jest.fn(),
  };

  const scriptDoc = { id: "script-1", createdBy: "user-1", title: "My Title", videoProjectId: "proj-1" };
  const userRecord = { brandName: "BrandX", targetAudience: "devs", competitors: ["A"], niche: "tech", websiteContent: "content" };

  beforeEach(() => {
    mockContentRepo = new MockContentRepo() as jest.Mocked<ContentRepository>;
    mockUserRepo = new MockUserRepo() as jest.Mocked<UserRepository>;
    service = new ContentService(mockContentRepo, mockUserRepo, mockVpService as any);
    mockContentRepo.getScriptById = jest.fn().mockResolvedValue(scriptDoc);
    mockUserRepo.get = jest.fn().mockResolvedValue(userRecord);
    mockContentRepo.editScript = jest.fn().mockResolvedValue(undefined);
    mockGenerateStreaming.mockResolvedValue(makeScriptStream("Generated script text."));
    mockVpService.getById.mockResolvedValue({ id: "proj-1" });
    mockVpService.markStale.mockResolvedValue(undefined);
    mockVpService.markPackagingDocumentStale.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("throws 404 if script not found", async () => {
    mockContentRepo.getScriptById = jest.fn().mockResolvedValue(null);
    const err = await service.regenerateScript("user-1", "script-1").catch(e => e);
    expect(err.statusCode).toBe(404);
    expect(mockContentRepo.getScriptById).toHaveBeenCalledWith("script-1");
  });

  it("throws 403 if script belongs to another user", async () => {
    mockContentRepo.getScriptById = jest.fn().mockResolvedValue({ ...scriptDoc, createdBy: "other-user" });
    const err = await service.regenerateScript("user-1", "script-1").catch(e => e);
    expect(err.statusCode).toBe(403);
  });

  it("happy path: returns { id, title, script } and calls editScript", async () => {
    const result = await service.regenerateScript("user-1", "script-1");
    expect(mockContentRepo.editScript).toHaveBeenCalledWith("script-1", { script: "Generated script text." });
    expect(result).toEqual({ id: "script-1", title: "My Title", script: "Generated script text." });
  });

  it("fires stale cascade when linked project found", async () => {
    await service.regenerateScript("user-1", "script-1");
    // fire-and-forget — flush microtask queue
    await new Promise(r => setTimeout(r, 0));
    expect(mockVpService.markStale).toHaveBeenCalledWith("proj-1", "script");
  });

  it("does not throw if no linked project", async () => {
    mockContentRepo.getScriptById = jest.fn().mockResolvedValue({ ...scriptDoc, videoProjectId: null });
    const result = await service.regenerateScript("user-1", "script-1");
    await new Promise(r => setTimeout(r, 0));
    expect(result.id).toBe("script-1");
    expect(mockVpService.markStale).not.toHaveBeenCalled();
  });
});

describe("ContentService — exportScript", () => {
  let service: ContentService;
  let mockContentRepo: jest.Mocked<ContentRepository>;
  let mockUserRepo: jest.Mocked<UserRepository>;

  beforeEach(() => {
    mockContentRepo = new MockContentRepo() as jest.Mocked<ContentRepository>;
    mockUserRepo = new MockUserRepo() as jest.Mocked<UserRepository>;
    service = new ContentService(mockContentRepo, mockUserRepo);
  });

  it("throws 404 if script not found", async () => {
    mockContentRepo.getScriptById = jest.fn().mockResolvedValue(null);
    const err = await service.exportScript("user-1", "script-1").catch(e => e);
    expect(err.statusCode).toBe(404);
  });

  it("throws 403 if script belongs to another user", async () => {
    mockContentRepo.getScriptById = jest.fn().mockResolvedValue({ id: "script-1", createdBy: "other-user", title: "T", script: "S" });
    const err = await service.exportScript("user-1", "script-1").catch(e => e);
    expect(err.statusCode).toBe(403);
  });

  it("returns { title, text } matching the script document fields", async () => {
    mockContentRepo.getScriptById = jest.fn().mockResolvedValue({
      id: "script-1",
      createdBy: "user-1",
      title: "My Title",
      script: "Full script text here.",
    });
    const result = await service.exportScript("user-1", "script-1");
    expect(result).toEqual({ title: "My Title", text: "Full script text here." });
  });
});

describe("ContentService — edit whitelist & SSE ownership guard", () => {
  let service: ContentService;
  let mockContentRepo: jest.Mocked<ContentRepository>;
  let mockUserRepo: jest.Mocked<UserRepository>;

  beforeEach(() => {
    mockContentRepo = new MockContentRepo() as jest.Mocked<ContentRepository>;
    mockUserRepo = new MockUserRepo() as jest.Mocked<UserRepository>;
    service = new ContentService(mockContentRepo, mockUserRepo);
  });

  afterEach(() => jest.clearAllMocks());

  it("editTopics ignores non-whitelisted fields (only title persisted)", async () => {
    mockContentRepo.getTopic = jest.fn().mockResolvedValue({ id: "t-1", createdBy: "user-1" });
    mockContentRepo.updateTopic = jest.fn().mockResolvedValue(undefined);
    const result = await service.editTopics("t-1", "user-1", {
      title: "New Title",
      archived: "false",
      videoProjectId: "evil",
      embedding: "[1,2,3]",
      createdBy: "victim",
    } as any);
    expect(mockContentRepo.updateTopic).toHaveBeenCalledWith("t-1", { title: "New Title" });
    expect(result).toEqual({ title: "New Title" });
  });

  it("editTopics throws 400 when no editable field is provided", async () => {
    mockContentRepo.getTopic = jest.fn().mockResolvedValue({ id: "t-1", createdBy: "user-1" });
    mockContentRepo.updateTopic = jest.fn();
    const err = await service.editTopics("t-1", "user-1", { archived: "false" } as any).catch((e) => e);
    expect(err.statusCode).toBe(400);
    expect(mockContentRepo.updateTopic).not.toHaveBeenCalled();
  });

  it("editScript persists only script and title", async () => {
    mockContentRepo.getScriptById = jest.fn().mockResolvedValue({ id: "s-1", createdBy: "user-1" });
    mockContentRepo.editScript = jest.fn().mockResolvedValue(undefined);
    const result = await service.editScript("s-1", "user-1", {
      script: "new body",
      title: "new title",
      createdBy: "victim",
      videoProjectId: "evil",
    } as any);
    expect(mockContentRepo.editScript).toHaveBeenCalledWith("s-1", { script: "new body", title: "new title" });
    expect(result).toEqual({ script: "new body", title: "new title" });
  });

  it("generateScripts throws 403 and does not stream when the project belongs to another user", async () => {
    // Project ownership is now enforced by videoProjectService.getById, which
    // throws Forbidden for a project the user doesn't own.
    const { Forbidden } = await import("../../src/utlils/errors");
    const mockVp = {
      getById: jest.fn().mockRejectedValue(Forbidden()),
      startStep: jest.fn(),
      completeStep: jest.fn(),
      linkResource: jest.fn(),
    };
    service = new ContentService(mockContentRepo, mockUserRepo, mockVp as any);
    mockUserRepo.get = jest.fn().mockResolvedValue({});
    const res = { setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), end: jest.fn() };
    const err = await service.generateScripts("user-1", "proj-1", res as any).catch((e) => e);
    expect(err.statusCode).toBe(403);
    expect(res.flushHeaders).not.toHaveBeenCalled();
    expect(mockGenerateStreaming).not.toHaveBeenCalled();
  });
});

describe("ContentService — generateScripts project-scoped script id & FKs", () => {
  let service: ContentService;
  let mockContentRepo: jest.Mocked<ContentRepository>;
  let mockUserRepo: jest.Mocked<UserRepository>;
  let mockVp: {
    getById: jest.Mock;
    startStep: jest.Mock;
    completeStep: jest.Mock;
    linkResource: jest.Mock;
  };

  const makeRes = () => ({ setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), end: jest.fn() });

  beforeEach(() => {
    mockContentRepo = new MockContentRepo() as jest.Mocked<ContentRepository>;
    mockUserRepo = new MockUserRepo() as jest.Mocked<UserRepository>;
    mockVp = {
      getById: jest.fn(),
      startStep: jest.fn().mockResolvedValue(undefined),
      completeStep: jest.fn().mockResolvedValue(undefined),
      linkResource: jest.fn().mockResolvedValue(undefined),
    };
    service = new ContentService(mockContentRepo, mockUserRepo, mockVp as any);
    mockUserRepo.get = jest.fn().mockResolvedValue({ brandName: "B", targetAudience: "a", competitors: [], niche: "n", websiteContent: "c" });
    mockUserRepo.update = jest.fn().mockResolvedValue(undefined);
    mockContentRepo.getTopic = jest.fn().mockResolvedValue({ id: "topic-1", createdBy: "user-1", title: "My Topic" });
    mockContentRepo.saveScript = jest.fn().mockResolvedValue(undefined);
    mockContentRepo.updateTopic = jest.fn().mockResolvedValue(undefined);
    mockGenerateStreaming.mockResolvedValue(makeScriptStream("Streamed script body."));
  });

  afterEach(() => jest.clearAllMocks());

  it("saves a script whose id !== topicId and carries topicId + videoProjectId FKs (first generation)", async () => {
    mockVp.getById.mockResolvedValue({ id: "proj-1", topicId: "topic-1", scriptId: null });
    await service.generateScripts("user-1", "proj-1", makeRes() as any);

    expect(mockContentRepo.saveScript).toHaveBeenCalledTimes(1);
    const [savedId, savedDoc] = mockContentRepo.saveScript.mock.calls[0] as [string, Record<string, unknown>];
    expect(savedId).not.toBe("topic-1");
    expect(typeof savedId).toBe("string");
    expect(savedDoc.topicId).toBe("topic-1");
    expect(savedDoc.videoProjectId).toBe("proj-1");
    // FK on the saved doc matches the document id it was stored under
    expect(savedDoc.id).toBe(savedId);
    // pipeline linked the same id
    expect(mockVp.linkResource).toHaveBeenCalledWith("proj-1", "script", savedId, "user-1");
  });

  it("reuses project.scriptId on regenerate (no new id minted)", async () => {
    mockVp.getById.mockResolvedValue({ id: "proj-1", topicId: "topic-1", scriptId: "existing-script-id" });
    await service.generateScripts("user-1", "proj-1", makeRes() as any);

    const [savedId] = mockContentRepo.saveScript.mock.calls[0];
    expect(savedId).toBe("existing-script-id");
    expect(mockVp.linkResource).toHaveBeenCalledWith("proj-1", "script", "existing-script-id", "user-1");
  });
});
