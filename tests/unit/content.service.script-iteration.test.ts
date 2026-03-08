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

import ContentService from "../../src/service/content.service";
import ContentRepository from "../../src/repository/content.repository";
import UserRepository from "../../src/repository/user.repository";

jest.mock("../../src/repository/content.repository");
jest.mock("../../src/repository/user.repository");

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
