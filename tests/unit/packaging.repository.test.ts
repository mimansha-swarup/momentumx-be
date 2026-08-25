// Branch-logic coverage for the atomic persist-on-generate write. Firestore's
// own transaction serialization guarantees the concurrency safety; here we
// verify the decision logic inside the transaction: deterministic-id create vs
// legacy-doc update, and the consistent-snapshot "all four done?" computation.

const txnSet = jest.fn();
const txnUpdate = jest.fn();

// Both the locate-query and the document read now happen INSIDE the transaction
// (Phase 01 item 3), so one `txn.get` serves both. Dispatch on the marker so the
// individual tests can keep setting the two results independently.
const findGet = jest.fn(); // result of txn.get(query)
const txnGet = jest.fn(); // result of txn.get(docRef)

// The locate-query's OWN `.get()` is a separate spy from the transaction's.
// Previously both were `findGet`, so this suite could not tell whether the
// repository located the doc INSIDE the transaction (`txn.get(query)` — the
// Phase 01 item 3 fix) or outside it (`query.get()` — the bug that fix removed).
// Reverting the pre-read would have left every test here green.
const outsideTxnGet = jest.fn(async () => {
  throw new Error(
    "locate query ran OUTSIDE the transaction — the read must be txn.get(query)"
  );
});
const whereChain: Record<string, unknown> = {
  __isQuery: true,
  where: () => whereChain,
  limit: () => whereChain,
  get: outsideTxnGet,
};
const docGet = jest.fn();
const docUpdate = jest.fn();
const docFn = jest.fn((id: string) => ({ id, get: docGet, update: docUpdate }));
const collectionFn = jest.fn(() => ({ ...whereChain, doc: docFn }));

const txnGetDispatch = jest.fn(async (arg: Record<string, unknown>) =>
  arg?.__isQuery ? findGet() : txnGet()
);
const runTransaction = jest.fn(async (fn: (txn: unknown) => unknown) =>
  fn({ get: txnGetDispatch, set: txnSet, update: txnUpdate })
);

jest.mock("../../src/config/firebase", () => ({
  db: { collection: collectionFn, runTransaction },
  firebase: { firestore: { FieldValue: { serverTimestamp: () => "ts" } } },
}));

import PackagingRepository from "../../src/repository/packaging.repository";

describe("PackagingRepository.upsertGeneratedItem", () => {
  let repo: PackagingRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new PackagingRepository();
  });

  it("creates a doc keyed on videoProjectId when none exists (first generation)", async () => {
    findGet.mockResolvedValue({ empty: true, docs: [] }); // findByVideoProject → null
    txnGet.mockResolvedValue({ exists: false });

    const res = await repo.upsertGeneratedItem("proj-1", "user-1", "titles", "title", [{ title: "A" }]);

    expect(docFn).toHaveBeenCalledWith("proj-1"); // DETERMINISTIC id, not auto-id
    expect(txnSet).toHaveBeenCalled();
    const written = txnSet.mock.calls[0][1];
    expect(written.titles).toEqual([{ title: "A" }]);
    expect(written.itemStatuses).toMatchObject({ title: "completed", shorts: "not_started" });
    expect(res).toMatchObject({ packagingId: "proj-1", created: true });
    expect(res.statuses).toMatchObject({ title: "completed" });
  });

  it("updates the existing (legacy auto-id) doc in place, not a second doc", async () => {
    // The located document IS the snapshot now — no second read for it.
    findGet.mockResolvedValue({
      empty: false,
      docs: [
        {
          id: "legacy-1",
          ref: { id: "legacy-1" },
          exists: true,
          data: () => ({ itemStatuses: { title: "not_started" } }),
        },
      ],
    });

    const res = await repo.upsertGeneratedItem("proj-1", "user-1", "shorts", "shorts", { segments: [] });

    expect(docFn).not.toHaveBeenCalled(); // reused the located ref, no duplicate
    expect(txnSet).not.toHaveBeenCalled();
    expect(txnUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "legacy-1" }),
      expect.objectContaining({ shorts: { segments: [] }, "itemStatuses.shorts": "completed" })
    );
    expect(res).toMatchObject({ packagingId: "legacy-1", created: false });
  });

  it("returns the merged status snapshot with the written item marked completed", async () => {
    findGet.mockResolvedValue({
      empty: false,
      docs: [
        {
          id: "pkg-1",
          ref: { id: "pkg-1" },
          exists: true,
          data: () => ({
            itemStatuses: {
              title: "completed",
              description: "completed",
              thumbnail: "completed",
              shorts: "not_started",
            },
          }),
        },
      ],
    });

    const res = await repo.upsertGeneratedItem("proj-1", "user-1", "shorts", "shorts", { segments: [] });

    // Consistent in-transaction snapshot: this write flips shorts; the service
    // decides step completion (packaging = its 3 items) from this.
    expect(res.statuses).toMatchObject({
      description: "completed", thumbnail: "completed", shorts: "completed",
    });
  });
});

// The inverse of markStale, used by "Keep as-is": the creator accepted the content
// as-is, so the document must stop reporting stale — otherwise every card keeps an
// "Outdated" chip under a banner they already dismissed.
describe("PackagingRepository.clearStale", () => {
  let repo: PackagingRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new PackagingRepository();
  });

  it("flips only the stale items to completed and clears the document flags", async () => {
    txnGet.mockResolvedValue({
      exists: true,
      data: () => ({
        itemStatuses: {
          title: "completed",
          description: "stale",
          thumbnail: "stale",
          shorts: "not_started",
        },
      }),
    });

    await repo.clearStale("pkg-1");

    // Dotted paths, and ONLY for the two items that were actually stale. `title`
    // and `shorts` are absent from the write entirely — previously the whole map
    // was rewritten, which reverted anything that changed since the read.
    expect(txnUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pkg-1" }),
      {
        "itemStatuses.description": "completed",
        "itemStatuses.thumbnail": "completed",
        isStale: false,
        staleReason: null,
        staleSince: null,
      }
    );
  });

  it("is a no-op when the document doesn't exist", async () => {
    txnGet.mockResolvedValue({ exists: false });

    await repo.clearStale("missing");

    expect(txnUpdate).not.toHaveBeenCalled();
  });

  // The bug this fix exists for: a regenerate completing between the read and the
  // write used to be reverted, because the whole map was written back from a
  // snapshot that no longer matched.
  it("leaves an item it does not transition out of the write", async () => {
    txnGet.mockResolvedValue({
      exists: true,
      data: () => ({
        itemStatuses: {
          title: "completed",
          description: "stale",
          thumbnail: "completed",
          shorts: "completed",
        },
      }),
    });

    await repo.clearStale("pkg-1");

    // Array form: these are literal keys containing dots, not nested paths.
    const written = txnUpdate.mock.calls[0][1];
    expect(written).toHaveProperty(["itemStatuses.description"], "completed");
    expect(written).not.toHaveProperty(["itemStatuses.title"]);
    expect(written).not.toHaveProperty(["itemStatuses.thumbnail"]);
    expect(written).not.toHaveProperty(["itemStatuses.shorts"]);
  });
});

describe("PackagingRepository.markStale", () => {
  let repo: PackagingRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new PackagingRepository();
  });

  it("flips only completed items to stale and sets the document flags", async () => {
    txnGet.mockResolvedValue({
      exists: true,
      data: () => ({
        itemStatuses: {
          title: "completed",
          description: "not_started",
          thumbnail: "completed",
          shorts: "stale",
        },
      }),
    });

    await repo.markStale("pkg-1", "script_regenerated");

    expect(txnUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pkg-1" }),
      {
        "itemStatuses.title": "stale",
        "itemStatuses.thumbnail": "stale",
        isStale: true,
        staleReason: "script_regenerated",
        staleSince: "ts",
      }
    );
  });

  it("is a no-op when the document doesn't exist", async () => {
    txnGet.mockResolvedValue({ exists: false });

    await repo.markStale("missing", "script_regenerated");

    expect(txnUpdate).not.toHaveBeenCalled();
  });
});
