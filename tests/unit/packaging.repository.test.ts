// Branch-logic coverage for the atomic persist-on-generate write. Firestore's
// own transaction serialization guarantees the concurrency safety; here we
// verify the decision logic inside the transaction: create vs update on the
// deterministic id, and the consistent-snapshot "all four done?" computation.

const txnSet = jest.fn();
const txnUpdate = jest.fn();

const txnGet = jest.fn(); // result of txn.get(docRef)

// Any query at all is now a regression. `upsertGeneratedItem` point-reads
// `doc(videoProjectId)`; it used to locate the document with a
// `where("videoProjectId", ...)` query, which existed solely to find the
// auto-ID documents the old save path wrote. There are none.
const outsideTxnGet = jest.fn(async () => {
  throw new Error("upsertGeneratedItem must point-read doc(videoProjectId), not query");
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

const txnGetDispatch = jest.fn(async (arg: Record<string, unknown>) => {
  // Inside the transaction too — a query here is the same regression, just
  // wearing the Phase 01 item 3 fix as cover.
  if (arg?.__isQuery) {
    throw new Error("upsertGeneratedItem must point-read doc(videoProjectId), not query");
  }
  return txnGet();
});
const runTransaction = jest.fn(async (fn: (txn: unknown) => unknown) =>
  fn({ get: txnGetDispatch, set: txnSet, update: txnUpdate })
);

jest.mock("../../src/config/firebase", () => ({
  db: { collection: collectionFn, runTransaction },
  firebase: { firestore: { FieldValue: { serverTimestamp: () => "ts" } } },
}));

import PackagingRepository from "../../src/repository/packaging.repository";
import { TEST_ACCOUNT_ID } from "../helpers/account";

describe("PackagingRepository.upsertGeneratedItem", () => {
  let repo: PackagingRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new PackagingRepository();
  });

  it("creates a doc keyed on videoProjectId when none exists (first generation)", async () => {
    txnGet.mockResolvedValue({ exists: false });

    const res = await repo.upsertGeneratedItem("proj-1", { userId: "user-1", accountId: TEST_ACCOUNT_ID }, "titles", "title", [{ title: "A" }]);

    expect(docFn).toHaveBeenCalledWith("proj-1"); // DETERMINISTIC id, not auto-id
    expect(txnSet).toHaveBeenCalled();
    const written = txnSet.mock.calls[0][1];
    expect(written.titles).toEqual([{ title: "A" }]);
    expect(written.itemStatuses).toMatchObject({ title: "completed", shorts: "not_started" });
    expect(res).toMatchObject({ packagingId: "proj-1", created: true });
    expect(res.statuses).toMatchObject({ title: "completed" });
    // Phase 03 dual-write, on the doc this call CREATES.
    expect(written.createdBy).toBe("user-1");
    expect(written.accountId).toBe(TEST_ACCOUNT_ID);
  });

  it("updates the existing doc in place, never creating a second one", async () => {
    // The second item of a package lands here. Writing rather than updating
    // would blank the item the first generation already stored.
    txnGet.mockResolvedValue({
      exists: true,
      data: () => ({ itemStatuses: { title: "not_started" } }),
    });

    const res = await repo.upsertGeneratedItem("proj-1", { userId: "user-1", accountId: TEST_ACCOUNT_ID }, "shorts", "shorts", { segments: [] });

    expect(docFn).toHaveBeenCalledWith("proj-1"); // the only id it can be
    expect(txnSet).not.toHaveBeenCalled();
    expect(txnUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "proj-1" }),
      expect.objectContaining({ shorts: { segments: [] }, "itemStatuses.shorts": "completed" })
    );
    expect(res).toMatchObject({ packagingId: "proj-1", created: false });
  });

  it("returns the merged status snapshot with the written item marked completed", async () => {
    txnGet.mockResolvedValue({
      exists: true,
      data: () => ({
        itemStatuses: {
          title: "completed",
          description: "completed",
          thumbnail: "completed",
          shorts: "not_started",
        },
      }),
    });

    const res = await repo.upsertGeneratedItem("proj-1", { userId: "user-1", accountId: TEST_ACCOUNT_ID }, "shorts", "shorts", { segments: [] });

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
