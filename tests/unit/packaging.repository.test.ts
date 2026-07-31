// Branch-logic coverage for the atomic persist-on-generate write. Firestore's
// own transaction serialization guarantees the concurrency safety; here we
// verify the decision logic inside the transaction: deterministic-id create vs
// legacy-doc update, and the consistent-snapshot "all four done?" computation.

const txnGet = jest.fn();
const txnSet = jest.fn();
const txnUpdate = jest.fn();
const findGet = jest.fn();

const whereChain: Record<string, unknown> = {
  where: () => whereChain,
  limit: () => whereChain,
  get: findGet,
};
const docFn = jest.fn((id: string) => ({ id }));
const collectionFn = jest.fn(() => ({ ...whereChain, doc: docFn }));
const runTransaction = jest.fn(async (fn: (txn: unknown) => unknown) =>
  fn({ get: txnGet, set: txnSet, update: txnUpdate })
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
    expect(res).toEqual({ packagingId: "proj-1", created: true, allDone: false });
  });

  it("updates the existing (legacy auto-id) doc in place, not a second doc", async () => {
    findGet.mockResolvedValue({ empty: false, docs: [{ id: "legacy-1", data: () => ({ videoProjectId: "proj-1" }) }] });
    txnGet.mockResolvedValue({ exists: true, data: () => ({ itemStatuses: { title: "not_started" } }) });

    const res = await repo.upsertGeneratedItem("proj-1", "user-1", "shorts", "shorts", { segments: [] });

    expect(docFn).toHaveBeenCalledWith("legacy-1"); // reused, no duplicate
    expect(txnSet).not.toHaveBeenCalled();
    expect(txnUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "legacy-1" }),
      expect.objectContaining({ shorts: { segments: [] }, "itemStatuses.shorts": "completed" })
    );
    expect(res.created).toBe(false);
  });

  it("reports allDone only when the fourth item completes (consistent snapshot)", async () => {
    findGet.mockResolvedValue({ empty: false, docs: [{ id: "pkg-1", data: () => ({}) }] });
    txnGet.mockResolvedValue({
      exists: true,
      data: () => ({ itemStatuses: { title: "completed", description: "completed", thumbnail: "completed", shorts: "not_started" } }),
    });

    const res = await repo.upsertGeneratedItem("proj-1", "user-1", "shorts", "shorts", { segments: [] });

    expect(res.allDone).toBe(true);
  });

  it("reports allDone false while items remain", async () => {
    findGet.mockResolvedValue({ empty: false, docs: [{ id: "pkg-1", data: () => ({}) }] });
    txnGet.mockResolvedValue({
      exists: true,
      data: () => ({ itemStatuses: { title: "completed", description: "not_started", thumbnail: "not_started", shorts: "not_started" } }),
    });

    const res = await repo.upsertGeneratedItem("proj-1", "user-1", "shorts", "shorts", { segments: [] });

    expect(res.allDone).toBe(false);
  });
});
