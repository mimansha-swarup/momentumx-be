// Behaviour tests for HooksRepository, derived from the documented contract
// (not the implementation) in:
//   - docs/features/hooks/spec.md, docs/features/hooks/api.md
//   - .claude/rules/firestore-conventions.md (server-side timestamps)
//   - .claude/rules/api-design.md ("Owning IDs — Derive From the Stored Doc")
//
// Mocking follows tests/unit/packaging.repository.test.ts: mock
// ../../src/config/firebase only.

const docGet = jest.fn();
const docSet = jest.fn();
const docUpdate = jest.fn();

const docFn = jest.fn((id?: string) => ({ id: id ?? "auto-hooks-id", get: docGet, set: docSet, update: docUpdate }));
const collectionFn = jest.fn(() => ({ doc: docFn }));

jest.mock("../../../src/config/firebase", () => ({
  db: { collection: collectionFn },
  firebase: {
    firestore: { FieldValue: { serverTimestamp: jest.fn(() => "SERVER_TS") } },
  },
}));

import HooksRepository from "../../../src/repository/hooks.repository";
import { IHooksBatch } from "../../../src/types/routes/hooks";
import { TEST_ACCOUNT_ID } from "../../helpers/account";

const baseBatch = {
  videoProjectId: "proj-1",
  createdBy: "user-1",
  accountId: TEST_ACCOUNT_ID,
  hooks: ["hook one", "hook two"],
  hookFeedback: {},
} as unknown as Omit<IHooksBatch, "id" | "createdAt">;

describe("HooksRepository.save", () => {
  let repo: HooksRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new HooksRepository();
  });

  it("stamps createdAt from FieldValue.serverTimestamp, never a client-side Date", async () => {
    const result = await repo.save(baseBatch);

    expect(docSet).toHaveBeenCalledWith(expect.objectContaining({ createdAt: "SERVER_TS" }));
    expect(result.createdAt).toBe("SERVER_TS");
  });

  it("writes the document under its own generated id — id === docRef.id", async () => {
    docFn.mockReturnValueOnce({ id: "gen-id-1", get: docGet, set: docSet, update: docUpdate });

    const result = await repo.save(baseBatch);

    expect(result.id).toBe("gen-id-1");
    expect(docSet).toHaveBeenCalledWith(expect.objectContaining({ id: "gen-id-1" }));
  });
});

describe("HooksRepository.findById — point read", () => {
  let repo: HooksRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new HooksRepository();
  });

  it("returns null for a missing hooks batch", async () => {
    docGet.mockResolvedValueOnce({ exists: false });

    const result = await repo.findById("missing-id");

    expect(result).toBeNull();
  });

  it("returns the stored batch data for an existing document", async () => {
    const stored = { id: "hooks-1", videoProjectId: "proj-1", createdBy: "user-1", accountId: TEST_ACCOUNT_ID, hooks: ["h1", "h2"] };
    docGet.mockResolvedValueOnce({ exists: true, data: () => stored });

    const result = await repo.findById("hooks-1");

    expect(result).toEqual(stored);
  });

  // HooksRepository.findById takes no userId — it is a plain point read. This
  // matches the api-design.md rule that owning IDs are derived from the
  // stored doc: callers (hooks.service/controller) compare the returned
  // batch's `createdBy` against the requester and reject with 404 on
  // mismatch. That ownership check is a service/controller-layer concern and
  // is exercised there, not here — a repo-level test can't observe it since
  // the repo has no user-scoped query to assert against.
});

describe("HooksRepository.update", () => {
  let repo: HooksRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new HooksRepository();
  });

  it("passes the given data straight through to Firestore .update, unlike save it does not inject its own timestamp", async () => {
    await repo.update("hooks-1", { hooks: ["new hook"], hookFeedback: {} });

    expect(docUpdate).toHaveBeenCalledWith({ hooks: ["new hook"], hookFeedback: {} });
  });
});
