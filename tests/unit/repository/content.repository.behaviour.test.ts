// Behaviour tests for ContentRepository, derived from the documented contract
// (not the implementation) in:
//   - docs/features/research/api.md  (GET /v1/ideas pagination + ordering)
//   - docs/product/pipeline-spec.md  (Regenerate All / archive semantics)
//   - .claude/rules/firestore-conventions.md (userId-first queries, batch
//     writes, server-side timestamps)
//
// Mocking follows tests/unit/packaging.repository.test.ts: mock
// ../../src/config/firebase (never firebase-admin directly), and expose the
// query-chain methods as jest.fn()s so call order/args can be asserted.

const getMock = jest.fn();
const docGet = jest.fn();
const docSet = jest.fn();

// One shared chainable query object. Every chain method returns the same
// object (mirrors the Firestore SDK), so calling repo methods records calls
// on chain.where / chain.orderBy / etc. in the order the source code makes them.
const chain: Record<string, jest.Mock> = {};
chain.where = jest.fn(() => chain);
chain.orderBy = jest.fn(() => chain);
chain.startAt = jest.fn(() => chain);
chain.endAt = jest.fn(() => chain);
chain.startAfter = jest.fn(() => chain);
chain.limit = jest.fn(() => chain);
chain.select = jest.fn(() => chain);
chain.get = getMock as unknown as jest.Mock;

const docFn = jest.fn((id?: string) => ({ id: id ?? "auto-id", get: docGet, set: docSet }));

const batchSet = jest.fn();
const batchUpdate = jest.fn();
const batchCommit = jest.fn().mockResolvedValue(undefined);
const batchFn = jest.fn(() => ({ set: batchSet, update: batchUpdate, commit: batchCommit }));

const collectionFn = jest.fn(() => ({ ...chain, doc: docFn }));

jest.mock("../../../src/config/firebase", () => ({
  db: {
    collection: collectionFn,
    batch: batchFn,
  },
  firebase: {
    firestore: {
      FieldValue: { serverTimestamp: jest.fn(() => "SERVER_TS") },
      FieldPath: { documentId: jest.fn(() => "__name__") },
      Timestamp: { fromDate: (d: Date) => ({ __ts: d.toISOString() }) },
    },
  },
}));

import ContentRepository from "../../../src/repository/content.repository";
import { TEST_ACCOUNT_ID, testOwner } from "../../helpers/account";

describe("ContentRepository.getIdeas — query scoping and pagination", () => {
  let repo: ContentRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new ContentRepository();
  });

  it("filters by accountId first — security + index invariant", async () => {
    getMock.mockResolvedValue({ docs: [] });

    await repo.getIdeas({
      accountId: TEST_ACCOUNT_ID,
      limit: 9,
      cursor: { createdAt: "", docId: "" },
      filters: {},
    });

    expect(chain.where.mock.calls[0]).toEqual(["accountId", "==", TEST_ACCOUNT_ID]);
  });

  it("orders page 1 and a cursor page identically, so 'load more' can't skip or repeat", async () => {
    getMock.mockResolvedValue({ docs: [] });

    await repo.getIdeas({
      accountId: TEST_ACCOUNT_ID,
      limit: 9,
      cursor: { createdAt: "", docId: "" },
      filters: {},
    });
    const page1Order = [...chain.orderBy.mock.calls];
    chain.orderBy.mockClear();

    await repo.getIdeas({
      accountId: TEST_ACCOUNT_ID,
      limit: 9,
      cursor: { createdAt: "2026-01-01T00:00:00.000Z", docId: "doc-9" },
      filters: {},
    });
    const page2Order = [...chain.orderBy.mock.calls];

    expect(page2Order).toEqual(page1Order);
    expect(page1Order).toEqual([
      ["createdAt", "desc"],
      ["__name__", "desc"],
    ]);
  });

  it("advances strictly past the cursor (timestamp + docId), never re-fetching from the top", async () => {
    getMock.mockResolvedValue({ docs: [] });

    await repo.getIdeas({
      accountId: TEST_ACCOUNT_ID,
      limit: 9,
      cursor: { createdAt: "2026-01-01T00:00:00.000Z", docId: "doc-9" },
      filters: {},
    });

    expect(chain.startAfter).toHaveBeenCalledWith({ __ts: "2026-01-01T00:00:00.000Z" }, "doc-9");
  });

  // FIXED 2026-08-25. Was a known defect: this branch ignored the cursor entirely
  // and re-returned page 1 forever. The cause was a shape mismatch — it orders by
  // `title`, and it was being handed a `(createdAt, docId)` cursor it could not
  // apply, so it applied none.
  it("advances past the previous page under an active search", async () => {
    getMock.mockResolvedValueOnce({
      docs: [{ data: () => ({ id: "1", title: "Apple video" }) }],
    });
    await repo.getIdeas({
      accountId: TEST_ACCOUNT_ID,
      limit: 9,
      cursor: {},
      filters: { searchText: "a" },
    });

    // Page 1 bounds the prefix from the search text itself.
    expect(chain.startAt).toHaveBeenCalledWith("a");
    expect(chain.startAfter).not.toHaveBeenCalled();

    jest.clearAllMocks();
    getMock.mockResolvedValueOnce({
      docs: [{ data: () => ({ id: "2", title: "Avocado video" }) }],
    });
    await repo.getIdeas({
      accountId: TEST_ACCOUNT_ID,
      limit: 9,
      // The shape the service emits for a search page — echoed back by the client.
      cursor: { title: "Apple video", docId: "1" },
      filters: { searchText: "a" },
    });

    // Page 2 starts after the previous page's last row, and STILL bounds the
    // prefix — drop the endAt and "load more" would walk out of the search.
    expect(chain.startAfter).toHaveBeenCalledWith("Apple video", "1");
    expect(chain.startAt).not.toHaveBeenCalled();
    expect(chain.endAt).toHaveBeenCalled();
  });

  // Two ideas can share a title. Without the docId tiebreaker in the ordering,
  // startAfter(title) would skip every duplicate after the first.
  it("orders by title AND document id so duplicate titles are not skipped", async () => {
    getMock.mockResolvedValueOnce({ docs: [] });

    await repo.getIdeas({
      accountId: TEST_ACCOUNT_ID,
      limit: 9,
      cursor: {},
      filters: { searchText: "a" },
    });

    expect(chain.orderBy).toHaveBeenCalledWith("title");
    expect(chain.orderBy).toHaveBeenCalledTimes(2);
  });
});

describe("ContentRepository.archiveUserIdeas", () => {
  let repo: ContentRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new ContentRepository();
  });

  it("archives every active idea and stamps updatedAt from FieldValue.serverTimestamp, never a client Date", async () => {
    getMock.mockResolvedValueOnce({
      empty: false,
      size: 2,
      docs: [
        { data: () => ({ batchId: "old" }), ref: { id: "d1" } },
        { data: () => ({ batchId: "old" }), ref: { id: "d2" } },
      ],
    });

    await repo.archiveUserIdeas(TEST_ACCOUNT_ID);

    expect(batchUpdate).toHaveBeenCalledTimes(2);
    expect(batchUpdate).toHaveBeenCalledWith({ id: "d1" }, { archived: true, updatedAt: "SERVER_TS" });
    expect(batchUpdate).toHaveBeenCalledWith({ id: "d2" }, { archived: true, updatedAt: "SERVER_TS" });
    expect(batchCommit).toHaveBeenCalledTimes(1);
  });

  it("respects excludeBatchId — the excluded batch is left active", async () => {
    getMock.mockResolvedValueOnce({
      empty: false,
      size: 2,
      docs: [
        { data: () => ({ batchId: "keep-me" }), ref: { id: "d1" } },
        { data: () => ({ batchId: "old" }), ref: { id: "d2" } },
      ],
    });

    await repo.archiveUserIdeas(TEST_ACCOUNT_ID, "keep-me");

    expect(batchUpdate).toHaveBeenCalledTimes(1);
    expect(batchUpdate).toHaveBeenCalledWith({ id: "d2" }, expect.objectContaining({ archived: true }));
  });

  it("re-queries per chunk, so an idea created mid-run is picked up by a later pass", async () => {
    // Pass 1 sees a full CHUNK_SIZE (450) page — the loop must query again.
    const fullPage = Array.from({ length: 450 }, (_, i) => ({
      data: () => ({ batchId: "old" }),
      ref: { id: `full-${i}` },
    }));
    // Pass 2 sees one record that didn't exist when pass 1 started.
    const midRunPage = [{ data: () => ({ batchId: "old" }), ref: { id: "mid-run-doc" } }];

    getMock
      .mockResolvedValueOnce({ empty: false, size: 450, docs: fullPage })
      .mockResolvedValueOnce({ empty: false, size: 1, docs: midRunPage });

    await repo.archiveUserIdeas(TEST_ACCOUNT_ID);

    expect(getMock).toHaveBeenCalledTimes(2);
    expect(batchUpdate).toHaveBeenCalledWith({ id: "mid-run-doc" }, expect.objectContaining({ archived: true }));
    expect(batchCommit).toHaveBeenCalledTimes(2);
  });
});

describe("ContentRepository.batchSaveIdeas — batch writes", () => {
  let repo: ContentRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new ContentRepository();
  });

  it("writes every idea in a single batch commit, not one write per document", async () => {
    const ideas = [
      { id: "i1", title: "A" },
      { id: "i2", title: "B" },
      { id: "i3", title: "C" },
    ];

    await repo.batchSaveIdeas(ideas);

    expect(batchFn).toHaveBeenCalledTimes(1);
    expect(batchSet).toHaveBeenCalledTimes(3);
    expect(batchCommit).toHaveBeenCalledTimes(1);
  });
});

describe("ContentRepository — point reads return null/undefined for missing documents", () => {
  let repo: ContentRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new ContentRepository();
  });

  it("getIdea resolves undefined when the document has no data", async () => {
    docGet.mockResolvedValueOnce({ exists: false, data: () => undefined });
    const result = await repo.getIdea("missing-id");
    expect(result).toBeUndefined();
  });

  it("getScriptById resolves null when the document does not exist", async () => {
    docGet.mockResolvedValueOnce({ exists: false });
    const result = await repo.getScriptById("missing-id");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getIdeasForClustering — where the KMeans guards ACTUALLY live.
//
// `.claude/rules/ai-generation-patterns.md` presents "filter archived ideas" and
// "cap at 200" as guards inside `getClusteredTitles`, and states "All KMeans
// logic is in src/utlils/content.ts". That is not where they are. The util
// (`src/utlils/content.ts:263`) computes `k` and applies the `titles.length <= k`
// skip-guard, but it clusters whatever this query returns, untouched.
//
// So both guards are enforced HERE, by the query, one layer below where the rule
// says to look. Nothing tested them: a change to this query alone would silently
// remove the archived filter or the 200 cap — un-bounding a KMeans run on Vercel,
// and letting archived ideas poison the "avoid repeating" list — with the util
// unchanged and the rules doc still pointing at the wrong file.
// ---------------------------------------------------------------------------
describe("ContentRepository.getIdeasForClustering — the KMeans input guards", () => {
  let repo: ContentRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new ContentRepository();
  });

  it("scopes to the caller first, then excludes archived ideas", async () => {
    getMock.mockResolvedValueOnce({ docs: [] });

    await repo.getIdeasForClustering(TEST_ACCOUNT_ID);

    // userId filter first — security and composite-index efficiency.
    expect(chain.where.mock.calls[0]).toEqual(["accountId", "==", TEST_ACCOUNT_ID]);
    // Archived ideas must never reach the clusterer.
    expect(chain.where.mock.calls).toContainEqual(["archived", "==", false]);
  });

  it("caps the read at 200 documents", async () => {
    getMock.mockResolvedValueOnce({ docs: [] });

    await repo.getIdeasForClustering(TEST_ACCOUNT_ID);

    // Non-negotiable per ai-generation-patterns.md: an uncapped KMeans run times
    // out on Vercel. The cap is a query limit, not a slice in the util.
    expect(chain.limit).toHaveBeenCalledWith(200);
  });

  it("projects only the fields clustering needs", async () => {
    getMock.mockResolvedValueOnce({ docs: [] });

    await repo.getIdeasForClustering(TEST_ACCOUNT_ID);

    expect(chain.select).toHaveBeenCalledWith("title", "embedding");
  });

  it("returns the raw documents for the clusterer to consume", async () => {
    getMock.mockResolvedValueOnce({
      docs: [
        { data: () => ({ title: "A", embedding: [0.1, 0.2] }) },
        { data: () => ({ title: "B", embedding: [0.3, 0.4] }) },
      ],
    });

    const result = await repo.getIdeasForClustering(TEST_ACCOUNT_ID);

    expect(result).toEqual([
      { title: "A", embedding: [0.1, 0.2] },
      { title: "B", embedding: [0.3, 0.4] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// isScriptGenerated is a THREE-state filter: absent / true / false.
//
// The old guard was `hasOwnProperty(...) && filters.isScriptGenerated`, which
// could not represent a deliberate `false` — combined with a controller doing
// `Boolean("false")` (which is true), asking for "ideas I haven't scripted yet"
// returned exactly the scripted ones. Fixed 2026-08-24; see the "Already fixed" table in known-defects.md.
// ---------------------------------------------------------------------------
describe("ContentRepository.getIdeas — the isScriptGenerated filter", () => {
  let repo: ContentRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new ContentRepository();
  });

  const run = (filters: Record<string, unknown>) =>
    repo.getIdeas({
      accountId: TEST_ACCOUNT_ID,
      limit: 9,
      cursor: { createdAt: "", docId: "" },
      filters: filters as never,
    });

  it("applies no filter when the flag is absent", async () => {
    getMock.mockResolvedValueOnce({ docs: [] });

    await run({});

    expect(chain.where.mock.calls).not.toContainEqual([
      "isScriptGenerated",
      "==",
      expect.anything(),
    ]);
  });

  it("filters for scripted ideas when true", async () => {
    getMock.mockResolvedValueOnce({ docs: [] });

    await run({ isScriptGenerated: true });

    expect(chain.where.mock.calls).toContainEqual(["isScriptGenerated", "==", true]);
  });

  // The case that was unreachable before: a deliberate false must reach the query
  // as false, not be dropped as falsy and not be flipped to true.
  it("filters for UNSCRIPTED ideas when false", async () => {
    getMock.mockResolvedValueOnce({ docs: [] });

    await run({ isScriptGenerated: false });

    expect(chain.where.mock.calls).toContainEqual(["isScriptGenerated", "==", false]);
  });

  it("keeps the caller scope regardless of the filter", async () => {
    getMock.mockResolvedValueOnce({ docs: [] });

    await run({ isScriptGenerated: false });

    expect(chain.where.mock.calls[0]).toEqual(["accountId", "==", TEST_ACCOUNT_ID]);
  });
});
