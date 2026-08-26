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
import { makeTestAccountService, TEST_ACCOUNT_ID } from "../helpers/account";

jest.mock("../../src/repository/packaging.repository");
jest.mock("../../src/utlils/ai", () => ({
  generateStreamingContent: jest.fn(),
  // collectJson stays REAL: it is the empty/malformed-JSON guard, and the fake
  // streams below are exactly what should be driving it.
  collectJson: jest.requireActual("../../src/utlils/ai").collectJson,
}));

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
        videoProjectId: null, ideaId: null, workingTitle: null,
        script: null, selectedHook: null, packagingId: null, ...session,
      },
    }),
  } as any;
}

function makeVp() {
  return {
    getById: jest.fn().mockResolvedValue({}),
    createFromTitle: jest.fn().mockResolvedValue({ id: "shallow-proj" }),
    linkResource: jest.fn().mockResolvedValue(undefined),
    startStep: jest.fn().mockResolvedValue(undefined),
    completeStep: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue({}),
  } as any;
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
    service = new PackagingService(mockRepo, makeVp(), makeContextService(), makeTestAccountService());
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
  let mockVp: {
    getById: jest.Mock;
    refreshPackagingStep: jest.Mock;
    setThumbnailHint: jest.Mock;
    reopenTitleStep: jest.Mock;
    startStep: jest.Mock;
    completeStep: jest.Mock;
  };

  const SHORTS_JSON = JSON.stringify({
    segments: [{ startTime: "0:00", endTime: "0:05", content: "x", type: "hook" }],
    totalDuration: "0:60",
  });

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
      reopenTitleStep: jest.fn().mockResolvedValue(undefined),
      startStep: jest.fn().mockResolvedValue(undefined),
      completeStep: jest.fn().mockResolvedValue(undefined),
    };
    service = new PackagingService(mockRepo, mockVp as any, makeContextService(), makeTestAccountService());
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

  // The selected title is also the PROJECT'S NAME. Keeping the old index meant the
  // header and dashboard showed a title absent from the new list, and "Continue"
  // later renamed the project to whatever landed at that index.
  it("clears selectedTitleIndex and reopens the title step when titles are regenerated", async () => {
    mockGenerate.mockResolvedValue(makeStream(JSON.stringify({ titles: [{ title: "Fresh", characterCount: 5 }] })));
    mockRepo.get = jest.fn().mockResolvedValue(
      linkedPkg({ title: "completed", description: "completed", thumbnail: "completed", shorts: "completed" })
    );

    await service.regenerateItem("user-1", "pkg-1", "title", "script");

    const written = (mockRepo.update as jest.Mock).mock.calls[0][1];
    expect(written.selectedTitleIndex).toBeNull();
    expect(mockVp.reopenTitleStep).toHaveBeenCalledWith("proj-1", "user-1");
    expect(mockVp.completeStep).not.toHaveBeenCalled();
  });

  // Regenerating the item that FAILED is how a creator recovers from a partial
  // generation. refreshPackagingStep only un-stales, so the step used to sit at
  // in_progress forever with all three items present.
  it("completes the packaging step when a regenerate fills the last missing item", async () => {
    mockGenerate.mockResolvedValue(makeStream(SHORTS_JSON));
    mockRepo.get = jest.fn().mockResolvedValue(
      linkedPkg({ title: "completed", description: "completed", thumbnail: "completed", shorts: "not_started" })
    );

    await service.regenerateItem("user-1", "pkg-1", "shorts", "script", undefined, 60);

    expect(mockVp.startStep).toHaveBeenCalledWith("proj-1", "packaging", "user-1");
    expect(mockVp.completeStep).toHaveBeenCalledWith("proj-1", "packaging", "user-1");
  });

  it("does NOT complete the packaging step while another item is still missing", async () => {
    mockGenerate.mockResolvedValue(makeStream(SHORTS_JSON));
    mockRepo.get = jest.fn().mockResolvedValue(
      linkedPkg({ title: "completed", description: "not_started", thumbnail: "completed", shorts: "not_started" })
    );

    await service.regenerateItem("user-1", "pkg-1", "shorts", "script", undefined, 60);

    expect(mockVp.completeStep).not.toHaveBeenCalled();
  });

  it("resets selectedThumbnailIndex when thumbnails are regenerated (old index points at a gone brief)", async () => {
    mockGenerate.mockResolvedValue(makeStream('{"descriptions":["Fresh one","Fresh two"]}'));
    mockRepo.get = jest.fn().mockResolvedValue(
      linkedPkg({ title: "completed", description: "completed", thumbnail: "completed", shorts: "completed" })
    );

    await service.regenerateItem("user-1", "pkg-1", "thumbnail", "script", "My Title");

    const written = (mockRepo.update as jest.Mock).mock.calls[0][1];
    expect(written.selectedThumbnailIndex).toBe(0);
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

describe("PackagingService — savePackaging with videoProjectId", () => {
  let service: PackagingService;
  let mockRepo: jest.Mocked<PackagingRepository>;
  let mockVp: ReturnType<typeof makeVp>;

  beforeEach(() => {
    mockRepo = new MockPackagingRepo() as jest.Mocked<PackagingRepository>;
    mockVp = makeVp();
    service = new PackagingService(mockRepo, mockVp, makeContextService(), makeTestAccountService());
    // Phase 05a: creates go to doc(videoProjectId), so the id IS the project id.
    mockRepo.saveWithId = jest.fn(async (id: string, _data: Record<string, unknown>) => ({ id }));
    // savePackaging upserts by project: no existing doc -> create path.
    mockRepo.get = jest.fn().mockResolvedValue(null);
  });

  it("saves videoProjectId on the document when provided", async () => {
    await service.savePackaging("user-1", { title: "t" }, "proj-1");
    const packagingData = (mockRepo.saveWithId as jest.Mock).mock.calls[0][1];
    expect(packagingData).toMatchObject({ videoProjectId: "proj-1" });
  });

  it("stamps BOTH owner fields server-side, overriding anything the body sent", async () => {
    // Both land AFTER the body spread. Field order isn't the guarantee —
    // packagingSaveSchema strips these keys first — but if that schema is ever
    // loosened, this is what still has to hold.
    await service.savePackaging(
      "user-1",
      { title: "t", createdBy: "attacker", accountId: "attacker-account" } as never,
      "proj-1"
    );
    const packagingData = (mockRepo.saveWithId as jest.Mock).mock.calls[0][1];
    expect(packagingData.createdBy).toBe("user-1");
    expect(packagingData.accountId).toBe(TEST_ACCOUNT_ID);
  });

  it("never persists script/hooks snapshots from the body (server-resolved, unread)", async () => {
    await service.savePackaging(
      "user-1",
      { title: "t", script: "full script text", hooks: ["h1", "h2"] },
      "proj-1"
    );
    const packagingData = (mockRepo.saveWithId as jest.Mock).mock.calls[0][1];
    expect(packagingData).not.toHaveProperty("script");
    expect(packagingData).not.toHaveProperty("hooks");
  });

  // Door model (6A.3): saving with no project must NOT create a standalone doc —
  // it lazily spins up a shallow project from the packaged title and binds to it.
  it("creates a shallow project from the packaged title and binds packaging to it", async () => {
    await service.savePackaging("user-1", {
      titles: [{ title: "My Title", characterCount: 8 }],
    });
    expect(mockVp.createFromTitle).toHaveBeenCalledWith("user-1", "My Title");
    const [keyedOn, packagingData] = (mockRepo.saveWithId as jest.Mock).mock.calls[0];
    expect(packagingData).toMatchObject({ videoProjectId: "shallow-proj" });
    // Phase 05a: the packaging document id IS the videoProjectId, on both
    // creation paths — which is what retired the locate query entirely.
    expect(keyedOn).toBe("shallow-proj");
    expect(mockVp.linkResource).toHaveBeenCalledWith("shallow-proj", "packaging", "shallow-proj", "user-1");
    // ...but a title-only package has NOT finished the packaging step. Completion is
    // earned by content (description + thumbnail + shorts), never by the act of
    // saving — the Title screen auto-saves through this same endpoint, and
    // completing here marked whole projects done with nothing generated.
    expect(mockVp.completeStep).not.toHaveBeenCalled();
  });

  it("completes the packaging step once all three packaging items are present", async () => {
    await service.savePackaging("user-1", {
      titles: [{ title: "My Title", characterCount: 8 }],
      description: "An SEO description.",
      thumbnail: ["Brief one", "Brief two"],
      shorts: { segments: [{ startTime: "0:00", endTime: "0:05", content: "Hook", type: "hook" }] },
    });
    // A fresh project's packaging is not_started, which completeStep rejects — so
    // it must be started first.
    expect(mockVp.startStep).toHaveBeenCalledWith("shallow-proj", "packaging", "user-1");
    expect(mockVp.completeStep).toHaveBeenCalledWith("shallow-proj", "packaging", "user-1");
  });

  it("falls back to a placeholder working title when the package has no title (e.g. thumbnail-only door)", async () => {
    await service.savePackaging("user-1", { thumbnail: ["Brief one"] });
    expect(mockVp.createFromTitle).toHaveBeenCalledWith("user-1", "Untitled video");
  });

  it("coerces wrapper-shaped item fields to the canonical stored shape", async () => {
    await service.savePackaging("user-1", {
      titles: { titles: [{ title: "A", characterCount: 30 }] },
      description: { description: "Desc text" },
      thumbnail: { descriptions: ["Brief one", "Brief two"] },
      shorts: { segments: [{ startTime: "0:00", endTime: "0:05", content: "Hook", type: "hook" }], totalDuration: "1:00" },
    });
    const packagingData = (mockRepo.saveWithId as jest.Mock).mock.calls[0][1];
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
    const packagingData = (mockRepo.saveWithId as jest.Mock).mock.calls[0][1];
    expect(packagingData.titles).toEqual([{ title: "A", characterCount: 30 }]);
    expect(packagingData.thumbnail).toEqual(["Brief one"]);
  });

  it("rejects with 400 when a content field has a malformed shape", async () => {
    const err = await service.savePackaging("user-1", { titles: 42 }).catch((e) => e);
    expect(err.statusCode).toBe(400);
    expect(mockRepo.saveWithId).not.toHaveBeenCalled();
  });

  it("sets stale flags fresh on create (no existing doc)", async () => {
    mockRepo.get = jest.fn().mockResolvedValue(null);
    await service.savePackaging("user-1", { title: "t" }, "proj-1");
    const saved = (mockRepo.saveWithId as jest.Mock).mock.calls[0][1];
    expect(saved).toMatchObject({ isStale: false, staleReason: null, staleSince: null });
  });

  it("does NOT touch stale flags on update (re-save must not un-stale)", async () => {
    mockRepo.get = jest.fn().mockResolvedValue({ id: "pkg-1" });
    mockRepo.update = jest.fn().mockResolvedValue({ id: "pkg-1" });
    await service.savePackaging("user-1", { title: "t" }, "proj-1");
    expect(mockRepo.saveWithId).not.toHaveBeenCalled();
    const updatePayload = (mockRepo.update as jest.Mock).mock.calls[0][1];
    expect(updatePayload).not.toHaveProperty("isStale");
    expect(updatePayload).not.toHaveProperty("staleReason");
    expect(updatePayload).not.toHaveProperty("staleSince");
  });

  // A save carries EDITS. Auto-save fires on every committed edit and every
  // thumbnail click, so anything it rewrites beyond those edits gets rewritten
  // constantly — these three all silently destroyed stale state.
  describe("does not rewrite state the save doesn't own", () => {
    const storedShorts = {
      segments: [{ startTime: "0:00", endTime: "0:05", content: "Hook", type: "hook" }],
    };
    const staleDoc = {
      id: "pkg-1",
      createdBy: "user-1",
      videoProjectId: "proj-1",
      titles: [{ title: "Stored", characterCount: 6 }],
      description: "Stored description.",
      thumbnail: ["Stored brief"],
      shorts: storedShorts,
      itemStatuses: { title: "completed", description: "stale", thumbnail: "stale", shorts: "stale" },
      isStale: true,
      staleReason: "hooks_regenerated",
    };

    beforeEach(() => {
      mockRepo.get = jest.fn().mockResolvedValue(staleDoc);
      mockRepo.update = jest.fn().mockResolvedValue({ id: "pkg-1" });
    });

    it("leaves itemStatuses alone on update, so an edit can't un-stale items", async () => {
      await service.savePackaging("user-1", { description: "Edited." }, "proj-1");
      const written = (mockRepo.update as jest.Mock).mock.calls[0][1];
      expect(written).not.toHaveProperty("itemStatuses");
      expect(written).toMatchObject({ description: "Edited." });
    });

    it("does not complete the pipeline step while the package is stale", async () => {
      await service.savePackaging("user-1", { description: "Edited." }, "proj-1");
      expect(mockVp.startStep).not.toHaveBeenCalled();
      expect(mockVp.completeStep).not.toHaveBeenCalled();
    });

    it("drops empty content fields so an unhydrated client can't wipe generated content", async () => {
      await service.savePackaging(
        "user-1",
        {
          titles: [{ title: "Edited title", characterCount: 12 }],
          description: "",
          thumbnail: [],
          shorts: { segments: [] },
        },
        "proj-1"
      );
      const written = (mockRepo.update as jest.Mock).mock.calls[0][1];
      expect(written).not.toHaveProperty("description");
      expect(written).not.toHaveProperty("thumbnail");
      expect(written).not.toHaveProperty("shorts");
      expect(written.titles).toEqual([{ title: "Edited title", characterCount: 12 }]);
    });
  });
});

describe("PackagingService — selectTitle (title continuity §7.3)", () => {
  let service: PackagingService;
  let mockRepo: jest.Mocked<PackagingRepository>;
  let mockVp: ReturnType<typeof makeVp>;

  beforeEach(() => {
    mockRepo = new MockPackagingRepo() as jest.Mocked<PackagingRepository>;
    mockVp = makeVp();
    service = new PackagingService(mockRepo, mockVp, makeContextService(), makeTestAccountService());
    mockRepo.get = jest.fn().mockResolvedValue({
      id: "pkg-1",
      createdBy: "user-1",
      videoProjectId: "proj-1",
      titles: [{ title: "First" }, { title: "Second" }],
    });
    mockRepo.update = jest.fn().mockResolvedValue({});
  });

  it("persists the choice and promotes the chosen title to the project", async () => {
    const res = await service.selectTitle("user-1", "pkg-1", 1);
    expect(mockRepo.update).toHaveBeenCalledWith("pkg-1", { selectedTitleIndex: 1 });
    expect(mockVp.update).toHaveBeenCalledWith("proj-1", "user-1", { title: "Second" });
    expect(res).toMatchObject({ selectedTitleIndex: 1, title: "Second" });
  });

  it("rejects an out-of-range index with 400 (no writes)", async () => {
    const err = await service.selectTitle("user-1", "pkg-1", 5).catch((e) => e);
    expect(err.statusCode).toBe(400);
    expect(mockRepo.update).not.toHaveBeenCalled();
    expect(mockVp.update).not.toHaveBeenCalled();
  });

  it("throws 403 for another user's package", async () => {
    mockRepo.get = jest.fn().mockResolvedValue({
      id: "pkg-1",
      createdBy: "other-user",
      videoProjectId: "proj-1",
      titles: [{ title: "First" }],
    });
    const err = await service.selectTitle("user-1", "pkg-1", 0).catch((e) => e);
    expect(err.statusCode).toBe(403);
  });

  it("rejects with 400 (not a 500 crash) when the package has no titles", async () => {
    mockRepo.get = jest.fn().mockResolvedValue({
      id: "pkg-1",
      createdBy: "user-1",
      videoProjectId: "proj-1",
      thumbnail: ["Brief"], // thumbnail-only door doc — no titles field
    });
    const err = await service.selectTitle("user-1", "pkg-1", 0).catch((e) => e);
    expect(err.statusCode).toBe(400);
    expect(mockRepo.update).not.toHaveBeenCalled();
  });
});

describe("PackagingService — generation persists + drives the right step", () => {
  let service: PackagingService;
  let mockRepo: jest.Mocked<PackagingRepository>;
  const allNotStarted = { title: "not_started", description: "not_started", thumbnail: "not_started", shorts: "not_started" };
  const shortsJson = JSON.stringify({ segments: [{ startTime: "0:00", endTime: "0:05", content: "x", type: "hook" }], totalDuration: "0:60" });

  beforeEach(() => {
    mockRepo = new MockPackagingRepo() as jest.Mocked<PackagingRepository>;
  });

  it("title generation drives the TITLE step (never completes packaging) + injects the hook", async () => {
    const fakeTitles = [{ title: "Title A", characterCount: 55 }];
    mockGenerate.mockResolvedValue(makeStream(JSON.stringify({ titles: fakeTitles })));
    const ctx = makeContextService({ selectedHook: "my hook opener" });
    const vp = makeVp();
    service = new PackagingService(mockRepo, vp, ctx, makeTestAccountService());
    mockRepo.upsertGeneratedItem = jest.fn().mockResolvedValue({ packagingId: "proj-1", created: false, statuses: { ...allNotStarted, title: "completed" } });

    const result = await service.generateTitle("user-1", "script text", "proj-1");

    expect(ctx.assemble).toHaveBeenCalledWith("user-1", { videoProjectId: "proj-1" });
    expect(mockGenerate.mock.calls[0][1] as string).toContain("my hook opener");
    expect(mockRepo.upsertGeneratedItem).toHaveBeenCalledWith(
      "proj-1",
      // Phase 03: an owner object, not two positional strings — both ids are
      // strings, so a positional accountId could take the wrong value silently.
      { userId: "user-1", accountId: TEST_ACCOUNT_ID },
      "titles",
      "title",
      fakeTitles
    );
    // Title is its own step: generating STARTS it; completion happens on select.
    expect(vp.startStep).toHaveBeenCalledWith("proj-1", "title", "user-1");
    expect(vp.completeStep).not.toHaveBeenCalled();
    expect(result).toEqual({ titles: fakeTitles, packagingId: "proj-1" });
  });

  it("links the doc only when the upsert reports it was created", async () => {
    mockGenerate.mockResolvedValue(makeStream(JSON.stringify({ titles: [{ title: "T", characterCount: 1 }] })));
    const vp = makeVp();
    service = new PackagingService(mockRepo, vp, makeContextService({ selectedHook: "h" }), makeTestAccountService());
    mockRepo.upsertGeneratedItem = jest.fn().mockResolvedValue({ packagingId: "proj-1", created: true, statuses: { ...allNotStarted, title: "completed" } });

    await service.generateTitle("user-1", "script text", "proj-1");

    expect(vp.linkResource).toHaveBeenCalledWith("proj-1", "packaging", "proj-1", "user-1");
  });

  it("completes the PACKAGING step once its three items exist", async () => {
    mockGenerate.mockResolvedValue(makeStream(shortsJson));
    const vp = makeVp();
    service = new PackagingService(mockRepo, vp, makeContextService(), makeTestAccountService());
    mockRepo.upsertGeneratedItem = jest.fn().mockResolvedValue({ packagingId: "proj-1", created: false, statuses: { title: "completed", description: "completed", thumbnail: "completed", shorts: "completed" } });

    await service.generateShorts("user-1", "script text", 60, "proj-1");

    expect(vp.startStep).toHaveBeenCalledWith("proj-1", "packaging", "user-1");
    expect(vp.completeStep).toHaveBeenCalledWith("proj-1", "packaging", "user-1");
  });

  it("does NOT complete packaging while an item is missing", async () => {
    mockGenerate.mockResolvedValue(makeStream(shortsJson));
    const vp = makeVp();
    service = new PackagingService(mockRepo, vp, makeContextService(), makeTestAccountService());
    mockRepo.upsertGeneratedItem = jest.fn().mockResolvedValue({ packagingId: "proj-1", created: false, statuses: { title: "completed", description: "not_started", thumbnail: "completed", shorts: "completed" } });

    await service.generateShorts("user-1", "script text", 60, "proj-1");

    expect(vp.startStep).toHaveBeenCalledWith("proj-1", "packaging", "user-1");
    expect(vp.completeStep).not.toHaveBeenCalled();
  });

  it("is a stateless preview without a videoProjectId (no persist)", async () => {
    const fakeTitles = [{ title: "Title B", characterCount: 50 }];
    mockGenerate.mockResolvedValue(makeStream(JSON.stringify({ titles: fakeTitles })));
    const ctx = makeContextService();
    service = new PackagingService(mockRepo, makeVp(), ctx, makeTestAccountService());
    mockRepo.upsertGeneratedItem = jest.fn();

    const result = await service.generateTitle("user-1", "script text");

    expect(ctx.assemble).toHaveBeenCalledWith("user-1", {});
    expect(mockRepo.upsertGeneratedItem).not.toHaveBeenCalled();
    expect(result).toEqual({ titles: fakeTitles });
  });
});

describe("PackagingService — exportPackaging", () => {
  let service: PackagingService;
  let mockRepo: jest.Mocked<PackagingRepository>;

  beforeEach(() => {
    mockRepo = new MockPackagingRepo() as jest.Mocked<PackagingRepository>;
    service = new PackagingService(mockRepo, makeVp(), makeContextService(), makeTestAccountService());
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

  // The export is what gets pasted into YouTube. An unmarked list of three makes
  // the creator choose a second time, having already chosen on screen.
  it("marks the selected title and thumbnail brief", async () => {
    mockRepo.get = jest.fn().mockResolvedValue({
      ...mockPkg,
      titles: [{ title: "First" }, { title: "Chosen" }, { title: "Third" }],
      selectedTitleIndex: 1,
      thumbnail: ["Brief one", "Brief two", "Brief three"],
      selectedThumbnailIndex: 2,
    });

    const result = await service.exportPackaging("user-1", "pkg-1");

    expect(result.text).toContain("2. Chosen  ← selected");
    expect(result.text).toContain("3. Brief three  ← selected");
    expect(result.text).toContain("1. First\n");
    expect(result.text).not.toContain("1. Brief one  ← selected");
  });

  it("defaults the thumbnail marker to the first brief when nothing was selected", async () => {
    mockRepo.get = jest.fn().mockResolvedValue({
      ...mockPkg,
      titles: [{ title: "Only" }],
      thumbnail: ["Brief one", "Brief two"],
    });

    const result = await service.exportPackaging("user-1", "pkg-1");

    expect(result.text).toContain("1. Brief one  ← selected");
    // No title selected yet -> no title is marked.
    expect(result.text).toContain("1. Only\n");
  });
});
