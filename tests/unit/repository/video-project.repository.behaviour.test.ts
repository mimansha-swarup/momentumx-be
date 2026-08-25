// Behaviour tests for VideoProjectRepository, derived from the documented
// contract (not the implementation) in:
//   - docs/features/video-project/api.md (GET /v1/video-projects pagination)
//   - docs/product/pipeline-spec.md      (pipeline state machine, step shape)
//   - .claude/rules/firestore-conventions.md (userId-first queries, server
//     timestamps)
//
// Mocking follows tests/unit/packaging.repository.test.ts: mock
// ../../src/config/firebase only. `FieldPath` is imported by the repository
// straight from the real "firebase-admin/firestore" package — that import is
// a pure static helper with no credentials/network involved (verified: it
// does not touch initializeApp), so it is safe to leave un-mocked and use the
// same import in assertions.

const getMock = jest.fn();
const docGet = jest.fn();
const docSetMock = jest.fn();
const docUpdateMock = jest.fn();

const docFn = jest.fn((id?: string) => ({ id, get: docGet, set: docSetMock, update: docUpdateMock }));

const chain: Record<string, jest.Mock> = {};
chain.where = jest.fn(() => chain);
chain.orderBy = jest.fn(() => chain);
chain.startAfter = jest.fn(() => chain);
chain.limit = jest.fn(() => chain);
chain.get = getMock as unknown as jest.Mock;

const collectionFn = jest.fn(() => ({ ...chain, doc: docFn }));

jest.mock("../../../src/config/firebase", () => ({
  db: { collection: collectionFn },
  firebase: {
    firestore: { FieldValue: { serverTimestamp: jest.fn(() => "SERVER_TS") } },
  },
}));

import { FieldPath } from "firebase-admin/firestore";
import VideoProjectRepository from "../../../src/repository/video-project.repository";

describe("VideoProjectRepository.list — query scoping and pagination", () => {
  let repo: VideoProjectRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new VideoProjectRepository();
  });

  it("filters by createdBy before isDeleted — security invariant", async () => {
    getMock.mockResolvedValue({ docs: [] });

    await repo.list("user-1", { limit: 20 });

    expect(chain.where.mock.calls[0]).toEqual(["createdBy", "==", "user-1"]);
    expect(chain.where.mock.calls[1]).toEqual(["isDeleted", "==", false]);
  });

  it("orders page 1 and a cursor page identically", async () => {
    getMock.mockResolvedValue({ docs: [] });

    await repo.list("user-1", { limit: 20 });
    const page1Order = [...chain.orderBy.mock.calls];
    chain.orderBy.mockClear();

    docGet.mockResolvedValueOnce({ exists: true, id: "last-doc" });
    await repo.list("user-1", { limit: 20, cursor: "last-doc" });
    const page2Order = [...chain.orderBy.mock.calls];

    expect(page2Order).toEqual(page1Order);
    expect(page1Order).toEqual([
      ["updatedAt", "desc"],
      [FieldPath.documentId(), "desc"],
    ]);
  });

  it("throws a 400 when the cursor document does not exist", async () => {
    docGet.mockResolvedValueOnce({ exists: false });

    await expect(repo.list("user-1", { limit: 20, cursor: "missing-doc" })).rejects.toMatchObject({
      message: "Invalid cursor",
      statusCode: 400,
    });
  });

  it("advances strictly past the cursor doc, so 'load more' neither repeats nor skips records", async () => {
    const cursorSnap = { exists: true, id: "last-seen" };
    docGet.mockResolvedValueOnce(cursorSnap);
    getMock.mockResolvedValue({ docs: [] });

    await repo.list("user-1", { limit: 20, cursor: "last-seen" });

    expect(chain.startAfter).toHaveBeenCalledWith(cursorSnap);
  });

  it("does not call startAfter for an un-cursored (page 1) request", async () => {
    getMock.mockResolvedValue({ docs: [] });

    await repo.list("user-1", { limit: 20 });

    expect(chain.startAfter).not.toHaveBeenCalled();
  });

  it("fetches one extra doc to compute hasMore, and trims it from the returned page", async () => {
    const docs = Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, data: () => ({ id: `p${i}` }) }));
    getMock.mockResolvedValue({ docs });

    const result = await repo.list("user-1", { limit: 3 });

    expect(chain.limit).toHaveBeenCalledWith(4); // limit + 1
    expect(result.projects).toHaveLength(3);
    expect(result.hasMore).toBe(true);
    // nextCursor is the last item of the TRIMMED page, not the extra lookahead doc.
    expect(result.nextCursor).toBe("p2");
  });

  it("reports hasMore: false and nextCursor: null when there is no extra page", async () => {
    const docs = Array.from({ length: 2 }, (_, i) => ({ id: `p${i}`, data: () => ({ id: `p${i}` }) }));
    getMock.mockResolvedValue({ docs });

    const result = await repo.list("user-1", { limit: 3 });

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
});

describe("VideoProjectRepository.findById", () => {
  let repo: VideoProjectRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new VideoProjectRepository();
  });

  it("returns null for a missing project (point read)", async () => {
    docGet.mockResolvedValueOnce({ exists: false });

    const result = await repo.findById("missing-id");

    expect(result).toBeNull();
  });

  it("back-fills a missing pipeline.title step for legacy projects on read", async () => {
    docGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ id: "proj-1", pipeline: { script: { status: "completed" } } }),
    });

    const result = await repo.findById("proj-1");

    expect(result?.pipeline.title).toEqual({
      status: "not_started",
      startedAt: null,
      completedAt: null,
    });
  });
});

describe("VideoProjectRepository.update — server-side timestamps", () => {
  let repo: VideoProjectRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new VideoProjectRepository();
  });

  it("stamps updatedAt from FieldValue.serverTimestamp, never a client-side Date", async () => {
    await repo.update("proj-1", { currentStep: "hooks" });

    expect(docUpdateMock).toHaveBeenCalledWith({ currentStep: "hooks", updatedAt: "SERVER_TS" });
  });
});

describe("VideoProjectRepository.findByScriptId / findByIdeaId — ownership scoping", () => {
  let repo: VideoProjectRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new VideoProjectRepository();
  });

  it("findByScriptId scopes the query by createdBy, not scriptId alone", async () => {
    getMock.mockResolvedValue({ empty: true, docs: [] });

    await repo.findByScriptId("script-1", "user-1");

    const whereFields = chain.where.mock.calls.map((call) => call[0]);
    expect(whereFields).toContain("createdBy");
    expect(whereFields).toContain("scriptId");
  });

  it("findByIdeaId scopes the query by createdBy, not ideaId alone", async () => {
    getMock.mockResolvedValue({ empty: true, docs: [] });

    await repo.findByIdeaId("idea-1", "user-1");

    const whereFields = chain.where.mock.calls.map((call) => call[0]);
    expect(whereFields).toContain("createdBy");
    expect(whereFields).toContain("ideaId");
  });
});
