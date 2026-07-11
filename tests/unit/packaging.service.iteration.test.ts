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

// Channel/script/hook resolution lives in ContextService (tested separately).
// Packaging only consumes its assembled output, so we mock it wholesale.
function makeContextService(session: Record<string, unknown> = {}) {
  return {
    assemble: jest.fn().mockResolvedValue({
      channelContext: {
        format: "talking_head", niche: null, targetAudience: null, brandName: null,
        website: null, websiteContent: null, channelDescription: null,
        topTitles: [], competitorUrls: [], competitorTitles: [],
      },
      sessionContext: {
        videoProjectId: null, topicId: null, workingTitle: null,
        script: null, selectedHook: null, packagingId: null, ...session,
      },
    }),
  } as any;
}

function makeVp() {
  return { getById: jest.fn().mockResolvedValue({}) } as any;
}

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
    service = new PackagingService(mockRepo, makeVp(), makeContextService());
    // Real generator shape for titles: { titles: [{ title, characterCount }] }
    mockGenerate.mockResolvedValue(makeStream('{"titles":[{"title":"New A","characterCount":40},{"title":"New B","characterCount":42},{"title":"New C","characterCount":44}]}'));
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

    // Canonical: the wrapper is unwrapped to the inner titles ARRAY before storing.
    const canonicalTitles = [
      { title: "New A", characterCount: 40 },
      { title: "New B", characterCount: 42 },
      { title: "New C", characterCount: 44 },
    ];
    expect(mockRepo.update).toHaveBeenCalledWith("pkg-1", expect.objectContaining({ titles: canonicalTitles }));
    expect(result.id).toBe("pkg-1");
    expect(result.item).toBe("title");
    // response data is the canonical shape — identical to what GET/export returns
    expect(result.data).toEqual(canonicalTitles);
  });

  it("happy path description: stores the unwrapped string", async () => {
    mockGenerate.mockResolvedValue(makeStream('{"description":"New SEO desc"}'));
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);
    mockRepo.update = jest.fn().mockResolvedValue(undefined);

    const result = await service.regenerateItem("user-1", "pkg-1", "description", "script", "My Title");

    expect(mockRepo.update).toHaveBeenCalledWith("pkg-1", expect.objectContaining({ description: "New SEO desc" }));
    expect(result.item).toBe("description");
    expect(result.data).toBe("New SEO desc");
  });

  it("happy path thumbnail: stores the unwrapped descriptions array", async () => {
    mockGenerate.mockResolvedValue(makeStream('{"descriptions":["Brief one","Brief two","Brief three"]}'));
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);
    mockRepo.update = jest.fn().mockResolvedValue(undefined);

    const result = await service.regenerateItem("user-1", "pkg-1", "thumbnail", "script", "My Title");

    expect(mockRepo.update).toHaveBeenCalledWith("pkg-1", expect.objectContaining({
      thumbnail: ["Brief one", "Brief two", "Brief three"],
    }));
    expect(result.item).toBe("thumbnail");
    expect(result.data).toEqual(["Brief one", "Brief two", "Brief three"]);
  });

  it("happy path shorts: stores the { segments, totalDuration } object", async () => {
    mockGenerate.mockResolvedValue(makeStream('{"segments":[{"startTime":"0:00","endTime":"0:05","content":"Hook","type":"hook"}],"totalDuration":"1:00"}'));
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);
    mockRepo.update = jest.fn().mockResolvedValue(undefined);

    const result = await service.regenerateItem("user-1", "pkg-1", "shorts", "script", undefined, 60);

    const canonicalShorts = { segments: [{ startTime: "0:00", endTime: "0:05", content: "Hook", type: "hook" }], totalDuration: "1:00" };
    expect(mockRepo.update).toHaveBeenCalledWith("pkg-1", expect.objectContaining({ shorts: canonicalShorts }));
    expect(result.item).toBe("shorts");
    expect(result.data).toEqual(canonicalShorts);
  });

  it("rejects with 400 when the generated content has a malformed shape", async () => {
    mockGenerate.mockResolvedValue(makeStream('{"wrong":"shape"}'));
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);
    mockRepo.update = jest.fn().mockResolvedValue(undefined);

    const err = await service.regenerateItem("user-1", "pkg-1", "title", "script text").catch((e) => e);

    expect(err.statusCode).toBe(400);
    // Invariant (independent of HOW the code rejects it): malformed content is
    // never persisted, and the item is never marked "completed".
    expect(mockRepo.update).not.toHaveBeenCalledWith("pkg-1", expect.objectContaining({ titles: expect.anything() }));
    expect(mockRepo.update).not.toHaveBeenCalledWith("pkg-1", expect.objectContaining({ "itemStatuses.title": "completed" }));
  });
});

describe("PackagingService — regenerateItem project sync (DA6 stale clear)", () => {
  let service: PackagingService;
  let mockRepo: jest.Mocked<PackagingRepository>;
  let mockVp: { getById: jest.Mock; refreshPackagingStep: jest.Mock; setThumbnailHint: jest.Mock };

  // pkg linked to a project, with only `title` stale and the rest completed.
  const linkedPkg = (itemStatuses: Record<string, string>) => ({
    ...mockPkg,
    videoProjectId: "proj-1",
    itemStatuses,
  });

  beforeEach(() => {
    mockRepo = new MockPackagingRepo() as jest.Mocked<PackagingRepository>;
    mockVp = {
      getById: jest.fn().mockResolvedValue({}), // no selected hook -> resolves to ""
      refreshPackagingStep: jest.fn().mockResolvedValue(undefined),
      setThumbnailHint: jest.fn().mockResolvedValue(undefined),
    };
    service = new PackagingService(mockRepo, mockVp as any, makeContextService());
    mockGenerate.mockResolvedValue(makeStream('{"titles":[{"title":"New A","characterCount":40}]}'));
    mockRepo.update = jest.fn().mockResolvedValue(undefined);
  });

  it("calls refreshPackagingStep when the LAST stale item is regenerated", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(
      linkedPkg({ title: "stale", description: "completed", thumbnail: "completed", shorts: "completed" })
    );

    await service.regenerateItem("user-1", "pkg-1", "title", "script text");

    expect(mockRepo.update).toHaveBeenCalledWith("pkg-1", expect.objectContaining({ isStale: false }));
    expect(mockVp.refreshPackagingStep).toHaveBeenCalledWith("proj-1", "user-1");
  });

  it("does NOT call refreshPackagingStep on a partial regen (another item still stale)", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(
      linkedPkg({ title: "stale", description: "stale", thumbnail: "completed", shorts: "completed" })
    );

    await service.regenerateItem("user-1", "pkg-1", "title", "script text");

    expect(mockRepo.update).not.toHaveBeenCalledWith("pkg-1", expect.objectContaining({ isStale: false }));
    expect(mockVp.refreshPackagingStep).not.toHaveBeenCalled();
  });

  it("does NOT call refreshPackagingStep when the packaging has no videoProjectId", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(
      { ...mockPkg, itemStatuses: { title: "stale", description: "completed", thumbnail: "completed", shorts: "completed" } }
    );

    await service.regenerateItem("user-1", "pkg-1", "title", "script text");

    expect(mockVp.refreshPackagingStep).not.toHaveBeenCalled();
  });

  it("still resolves the regeneration when the project sync fails (best-effort)", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(
      linkedPkg({ title: "stale", description: "completed", thumbnail: "completed", shorts: "completed" })
    );
    mockVp.refreshPackagingStep.mockRejectedValue(new Error("sync boom"));

    const result = await service.regenerateItem("user-1", "pkg-1", "title", "script text");

    expect(result.id).toBe("pkg-1");
    expect(mockVp.refreshPackagingStep).toHaveBeenCalled();
  });

  it("refreshes the project thumbnailHint with the new first brief when the thumbnail is regenerated", async () => {
    mockGenerate.mockResolvedValue(makeStream('{"descriptions":["Fresh brief one","Fresh brief two"]}'));
    mockRepo.get = jest.fn().mockResolvedValue(
      linkedPkg({ title: "completed", description: "completed", thumbnail: "completed", shorts: "completed" })
    );

    await service.regenerateItem("user-1", "pkg-1", "thumbnail", "script", "My Title");

    expect(mockVp.setThumbnailHint).toHaveBeenCalledWith("proj-1", "Fresh brief one", "user-1");
  });

  it("does NOT touch thumbnailHint when a non-thumbnail item is regenerated", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(
      linkedPkg({ title: "completed", description: "completed", thumbnail: "completed", shorts: "completed" })
    );

    await service.regenerateItem("user-1", "pkg-1", "title", "script text");

    expect(mockVp.setThumbnailHint).not.toHaveBeenCalled();
  });

  it("sets thumbnailHint to null when the regenerated thumbnail has no briefs", async () => {
    mockGenerate.mockResolvedValue(makeStream('{"descriptions":[]}'));
    mockRepo.get = jest.fn().mockResolvedValue(
      linkedPkg({ title: "completed", description: "completed", thumbnail: "completed", shorts: "completed" })
    );

    await service.regenerateItem("user-1", "pkg-1", "thumbnail", "script", "My Title");

    expect(mockVp.setThumbnailHint).toHaveBeenCalledWith("proj-1", null, "user-1");
  });

  it("still resolves the regeneration when the thumbnailHint refresh fails (best-effort)", async () => {
    mockGenerate.mockResolvedValue(makeStream('{"descriptions":["Fresh brief one"]}'));
    mockRepo.get = jest.fn().mockResolvedValue(
      linkedPkg({ title: "completed", description: "completed", thumbnail: "completed", shorts: "completed" })
    );
    mockVp.setThumbnailHint.mockRejectedValue(new Error("hint boom"));

    const result = await service.regenerateItem("user-1", "pkg-1", "thumbnail", "script", "My Title");

    expect(result.id).toBe("pkg-1");
    expect(mockVp.setThumbnailHint).toHaveBeenCalled();
  });
});

describe("PackagingService — updateFeedback", () => {
  let service: PackagingService;
  let mockRepo: jest.Mocked<PackagingRepository>;

  beforeEach(() => {
    mockRepo = new MockPackagingRepo() as jest.Mocked<PackagingRepository>;
    service = new PackagingService(mockRepo, makeVp(), makeContextService());
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

describe("PackagingService — savePackaging with videoProjectId", () => {
  let service: PackagingService;
  let mockRepo: jest.Mocked<PackagingRepository>;

  beforeEach(() => {
    mockRepo = new MockPackagingRepo() as jest.Mocked<PackagingRepository>;
    service = new PackagingService(mockRepo, makeVp(), makeContextService());
    mockRepo.save = jest.fn().mockResolvedValue({ id: "pkg-new" });
    // savePackaging upserts by project: no existing doc -> save path
    mockRepo.findByVideoProject = jest.fn().mockResolvedValue(null);
  });

  it("saves videoProjectId on the document when provided", async () => {
    await service.savePackaging("user-1", { title: "t" }, "proj-1");
    const packagingData = (mockRepo.save as jest.Mock).mock.calls[0][0];
    expect(packagingData).toMatchObject({ videoProjectId: "proj-1" });
  });

  it("does not include videoProjectId when not provided", async () => {
    await service.savePackaging("user-1", { title: "t" });
    const packagingData = (mockRepo.save as jest.Mock).mock.calls[0][0];
    expect(packagingData).not.toHaveProperty("videoProjectId");
  });

  it("coerces wrapper-shaped item fields to the canonical stored shape", async () => {
    await service.savePackaging("user-1", {
      titles: { titles: [{ title: "A", characterCount: 30 }] },
      description: { description: "Desc text" },
      thumbnail: { descriptions: ["Brief one", "Brief two"] },
      shorts: { segments: [{ startTime: "0:00", endTime: "0:05", content: "Hook", type: "hook" }], totalDuration: "1:00" },
    });
    const packagingData = (mockRepo.save as jest.Mock).mock.calls[0][0];
    expect(packagingData.titles).toEqual([{ title: "A", characterCount: 30 }]);
    expect(packagingData.description).toBe("Desc text");
    expect(packagingData.thumbnail).toEqual(["Brief one", "Brief two"]);
    expect(packagingData.shorts).toEqual({ segments: [{ startTime: "0:00", endTime: "0:05", content: "Hook", type: "hook" }], totalDuration: "1:00" });
    expect(packagingData.itemStatuses).toEqual({ title: "completed", description: "completed", thumbnail: "completed", shorts: "completed" });
  });

  it("accepts already-canonical (bare) item fields unchanged", async () => {
    await service.savePackaging("user-1", {
      titles: [{ title: "A", characterCount: 30 }],
      thumbnail: ["Brief one"],
    });
    const packagingData = (mockRepo.save as jest.Mock).mock.calls[0][0];
    expect(packagingData.titles).toEqual([{ title: "A", characterCount: 30 }]);
    expect(packagingData.thumbnail).toEqual(["Brief one"]);
  });

  it("rejects with 400 when a content field has a malformed shape", async () => {
    const err = await service.savePackaging("user-1", { titles: 42 }).catch((e) => e);
    expect(err.statusCode).toBe(400);
    expect(mockRepo.save).not.toHaveBeenCalled();
  });

  it("sets stale flags fresh on create (no existing doc)", async () => {
    mockRepo.findByVideoProject = jest.fn().mockResolvedValue(null);
    await service.savePackaging("user-1", { title: "t" }, "proj-1");
    const saved = (mockRepo.save as jest.Mock).mock.calls[0][0];
    expect(saved).toMatchObject({ isStale: false, staleReason: null, staleSince: null });
  });

  it("does NOT touch stale flags on update (re-save must not un-stale)", async () => {
    mockRepo.findByVideoProject = jest.fn().mockResolvedValue({ id: "pkg-1" });
    mockRepo.update = jest.fn().mockResolvedValue({ id: "pkg-1" });
    await service.savePackaging("user-1", { title: "t" }, "proj-1");
    expect(mockRepo.save).not.toHaveBeenCalled();
    const updatePayload = (mockRepo.update as jest.Mock).mock.calls[0][1];
    expect(updatePayload).not.toHaveProperty("isStale");
    expect(updatePayload).not.toHaveProperty("staleReason");
    expect(updatePayload).not.toHaveProperty("staleSince");
  });
});

describe("PackagingService — generateTitle injects the assembled context", () => {
  let service: PackagingService;
  let mockRepo: jest.Mocked<PackagingRepository>;

  beforeEach(() => {
    mockRepo = new MockPackagingRepo() as jest.Mocked<PackagingRepository>;
  });

  it("injects the hook resolved by ContextService into the prompt", async () => {
    const fakeTitles = [{ title: "Title A", characterCount: 55 }];
    mockGenerate.mockResolvedValue(makeStream(JSON.stringify({ titles: fakeTitles })));
    const ctx = makeContextService({ selectedHook: "my hook opener" });
    service = new PackagingService(mockRepo, makeVp(), ctx);

    const result = await service.generateTitle("user-1", "script text", "proj-1");

    // Context is assembled for the target project; the resolved hook reaches the prompt.
    expect(ctx.assemble).toHaveBeenCalledWith("user-1", { videoProjectId: "proj-1" });
    const userPromptArg = mockGenerate.mock.calls[0][1] as string;
    expect(userPromptArg).toContain("my hook opener");
    expect(result).toEqual({ titles: fakeTitles });
  });

  it("works without a videoProjectId (empty session, no project lookup)", async () => {
    const fakeTitles = [{ title: "Title B", characterCount: 50 }];
    mockGenerate.mockResolvedValue(makeStream(JSON.stringify({ titles: fakeTitles })));
    const ctx = makeContextService();
    service = new PackagingService(mockRepo, makeVp(), ctx);

    const result = await service.generateTitle("user-1", "script text");

    expect(ctx.assemble).toHaveBeenCalledWith("user-1", {});
    expect(result).toEqual({ titles: fakeTitles });
  });
});

describe("PackagingService — exportPackaging", () => {
  let service: PackagingService;
  let mockRepo: jest.Mocked<PackagingRepository>;

  beforeEach(() => {
    mockRepo = new MockPackagingRepo() as jest.Mocked<PackagingRepository>;
    service = new PackagingService(mockRepo, makeVp(), makeContextService());
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

  it("renders legacy/string-shaped fields readably (backward tolerance)", async () => {
    // mockPkg uses the pre-canonical shapes (titles as plain strings, thumbnail/shorts as strings).
    // Export must still render them as readable content, not drop them.
    mockRepo.get = jest.fn().mockResolvedValue(mockPkg);

    const result = await service.exportPackaging("user-1", "pkg-1");

    expect(result.text).toContain("TITLES");
    expect(result.text).toContain("1. Title A"); // string titles -> numbered list
    expect(result.text).toContain("SEO description.");
    expect(result.text).toContain("Bold text on bright background."); // string thumbnail rendered
    expect(result.text).toContain("Hook: Did you know?"); // string shorts rendered
  });

  it("renders canonical shapes as readable text, never JSON blobs", async () => {
    mockRepo.get = jest.fn().mockResolvedValue({
      ...mockPkg,
      titles: [{ title: "My Great Title", characterCount: 14 }],
      description: "Plain description text.",
      thumbnail: ["Bold red PRODUCTIVITY text on left", "Minimalist 10X center"],
      shorts: { segments: [{ startTime: "0:00", endTime: "0:05", content: "Stop. This changes everything.", type: "hook" }], totalDuration: "1:00" },
    });

    const result = await service.exportPackaging("user-1", "pkg-1");

    // titles render as plain text (the .title field), not the {title,characterCount} object
    expect(result.text).toContain("1. My Great Title");
    expect(result.text).not.toContain('{"title"');
    // thumbnail briefs render as a numbered list
    expect(result.text).toContain("1. Bold red PRODUCTIVITY text on left");
    expect(result.text).toContain("2. Minimalist 10X center");
    // shorts render readably (segment content + total), not a JSON blob
    expect(result.text).toContain("Stop. This changes everything.");
    expect(result.text).toContain("Total: 1:00");
    expect(result.text).not.toContain('{"segments"');
  });
});
