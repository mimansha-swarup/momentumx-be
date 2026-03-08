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

import PackagingService from "../../src/service/packaging.service";
import PackagingRepository from "../../src/repository/packaging.repository";
import { generateStreamingContent } from "../../src/utlils/ai";

jest.mock("../../src/repository/packaging.repository");
jest.mock("../../src/utlils/ai", () => ({ generateStreamingContent: jest.fn() }));

const MockPackagingRepo = PackagingRepository as jest.MockedClass<typeof PackagingRepository>;
const mockGenerate = generateStreamingContent as jest.MockedFunction<typeof generateStreamingContent>;

function makeStream(text: string) {
  return {
    stream: (async function* () { yield { text: () => text }; })(),
  } as any;
}

const mockPkg = {
  id: "pkg-1",
  createdBy: "user-1",
  titles: ["Title A", "Title B", "Title C"],
  description: "SEO description.",
  thumbnail: "Bold text on bright background.",
  shorts: "Hook: Did you know? [0-5s]\nMain point [5-30s]",
};

describe("PackagingService — regenerateItem", () => {
  let service: PackagingService;
  let mockRepo: jest.Mocked<PackagingRepository>;

  beforeEach(() => {
    mockRepo = new MockPackagingRepo() as jest.Mocked<PackagingRepository>;
    service = new PackagingService(mockRepo);
    mockGenerate.mockResolvedValue(makeStream('{"titles":["New A","New B","New C"]}'));
  });

  it("throws 404 if packaging not found", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(null);
    const err = await service.regenerateItem("user-1", "pkg-1", "title", "script").catch(e => e);
    expect(err.statusCode).toBe(404);
  });

  it("throws 403 if not owner", async () => {
    mockRepo.get = jest.fn().mockResolvedValue({ ...mockPkg, createdBy: "other" });
    const err = await service.regenerateItem("user-1", "pkg-1", "title", "script").catch(e => e);
    expect(err.statusCode).toBe(403);
  });

  it("throws 400 for invalid item", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);
    const err = await service.regenerateItem("user-1", "pkg-1", "hooks", "script").catch(e => e);
    expect(err.statusCode).toBe(400);
  });

  it("throws 400 if script is missing", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);
    const err = await service.regenerateItem("user-1", "pkg-1", "title", "").catch(e => e);
    expect(err.statusCode).toBe(400);
  });

  it("throws 400 if item=description and title is missing", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);
    const err = await service.regenerateItem("user-1", "pkg-1", "description", "script").catch(e => e);
    expect(err.statusCode).toBe(400);
  });

  it("throws 400 if item=thumbnail and title is missing", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);
    const err = await service.regenerateItem("user-1", "pkg-1", "thumbnail", "script").catch(e => e);
    expect(err.statusCode).toBe(400);
  });

  it("throws 400 if item=shorts and duration is missing", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);
    const err = await service.regenerateItem("user-1", "pkg-1", "shorts", "script").catch(e => e);
    expect(err.statusCode).toBe(400);
  });

  it("happy path title: updates 'titles' field and returns { id, item, data }", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);
    mockRepo.update = jest.fn().mockResolvedValue(undefined);

    const result = await service.regenerateItem("user-1", "pkg-1", "title", "script text");

    expect(mockRepo.update).toHaveBeenCalledWith("pkg-1", expect.objectContaining({ titles: expect.any(Object) }));
    expect(result.id).toBe("pkg-1");
    expect(result.item).toBe("title");
  });

  it("happy path description: updates 'description' field", async () => {
    mockGenerate.mockResolvedValue(makeStream('{"description":"New SEO desc"}'));
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);
    mockRepo.update = jest.fn().mockResolvedValue(undefined);

    const result = await service.regenerateItem("user-1", "pkg-1", "description", "script", "My Title");

    expect(mockRepo.update).toHaveBeenCalledWith("pkg-1", expect.objectContaining({ description: expect.anything() }));
    expect(result.item).toBe("description");
  });

  it("happy path shorts: updates 'shorts' field when duration provided", async () => {
    mockGenerate.mockResolvedValue(makeStream('{"shorts":"Shorts text"}'));
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);
    mockRepo.update = jest.fn().mockResolvedValue(undefined);

    const result = await service.regenerateItem("user-1", "pkg-1", "shorts", "script", undefined, 60);

    expect(mockRepo.update).toHaveBeenCalledWith("pkg-1", expect.objectContaining({ shorts: expect.anything() }));
    expect(result.item).toBe("shorts");
  });
});

describe("PackagingService — updateFeedback", () => {
  let service: PackagingService;
  let mockRepo: jest.Mocked<PackagingRepository>;

  beforeEach(() => {
    mockRepo = new MockPackagingRepo() as jest.Mocked<PackagingRepository>;
    service = new PackagingService(mockRepo);
  });

  it("throws 404 if not found", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(null);
    const err = await service.updateFeedback("user-1", "pkg-1", "title", "like").catch(e => e);
    expect(err.statusCode).toBe(404);
  });

  it("throws 403 if not owner", async () => {
    mockRepo.get = jest.fn().mockResolvedValue({ ...mockPkg, createdBy: "other" });
    const err = await service.updateFeedback("user-1", "pkg-1", "title", "like").catch(e => e);
    expect(err.statusCode).toBe(403);
  });

  it("throws 400 for invalid item", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);
    const err = await service.updateFeedback("user-1", "pkg-1", "hooks", "like").catch(e => e);
    expect(err.statusCode).toBe(400);
  });

  it("throws 400 for invalid feedback", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);
    const err = await service.updateFeedback("user-1", "pkg-1", "title", "invalid" as any).catch(e => e);
    expect(err.statusCode).toBe(400);
  });

  it("happy path: updates feedback map and returns { id, item, feedback }", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);
    mockRepo.update = jest.fn().mockResolvedValue(undefined);

    const result = await service.updateFeedback("user-1", "pkg-1", "title", "like");

    expect(mockRepo.update).toHaveBeenCalledWith("pkg-1", { "feedback.title": "like" });
    expect(result).toEqual({ id: "pkg-1", item: "title", feedback: "like" });
  });

  it("happy path: null clears feedback for an item", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);
    mockRepo.update = jest.fn().mockResolvedValue(undefined);

    const result = await service.updateFeedback("user-1", "pkg-1", "description", null);
    expect(result).toEqual({ id: "pkg-1", item: "description", feedback: null });
  });
});

describe("PackagingService — exportPackaging", () => {
  let service: PackagingService;
  let mockRepo: jest.Mocked<PackagingRepository>;

  beforeEach(() => {
    mockRepo = new MockPackagingRepo() as jest.Mocked<PackagingRepository>;
    service = new PackagingService(mockRepo);
  });

  it("throws 404 if not found", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(null);
    const err = await service.exportPackaging("user-1", "pkg-1").catch(e => e);
    expect(err.statusCode).toBe(404);
  });

  it("throws 403 if not owner", async () => {
    mockRepo.get = jest.fn().mockResolvedValue({ ...mockPkg, createdBy: "other" });
    const err = await service.exportPackaging("user-1", "pkg-1").catch(e => e);
    expect(err.statusCode).toBe(403);
  });

  it("returns { text } containing all packaging sections", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);

    const result = await service.exportPackaging("user-1", "pkg-1");

    expect(result.text).toContain("TITLES");
    expect(result.text).toContain("DESCRIPTION");
    expect(result.text).toContain("THUMBNAIL BRIEF");
    expect(result.text).toContain("SHORTS SCRIPT");
    expect(result.text).toContain("SEO description.");
  });
});
