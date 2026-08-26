// The account write itself, against the Firestore transaction API.
//
// The service suite mocks this repository, so its "writes account, context and
// pointer" assertions are about the service's intent. Two things must hold HERE.
//
// One: the three writes land together — a half-built account (membership with no
// context) reads to the generation path as a channel with no niche, no
// competitors and no website, which produces plausible, silently wrong output.
//
// Two: the pointer is re-read INSIDE the transaction. `ensureDefaultAccount` is
// read-then-create, so two concurrent first-requests for one fresh user would
// otherwise mint two accounts and split that user's records between them —
// invisible until Phase 06 switches reads and half their content disappears.

const txnSet = jest.fn();
const txnGet = jest.fn();

// The pointer snapshot the transaction reads. `.get(field)` is the Firestore
// DocumentSnapshot accessor, not the query `.get()`.
const pointerSnap = (accountId?: string) => ({
  get: (field: string) => (field === "lastActiveAccountId" ? accountId : undefined),
});

const runTransaction = jest.fn(async (fn: (txn: unknown) => unknown) =>
  fn({ get: txnGet, set: txnSet })
);

const contextDoc = jest.fn((id: string) => ({ __contextDoc: id }));
const subCollection = jest.fn((name: string) => ({ __sub: name, doc: contextDoc }));
const accountDoc = jest.fn((id: string) => ({
  __accountDoc: id,
  collection: subCollection,
}));

const userDoc = jest.fn((uid: string) => ({ __userDoc: uid }));
const whereFn = jest.fn();
const getFn = jest.fn();

const collection = jest.fn((name: string) =>
  name === "users"
    ? { doc: userDoc }
    : { doc: accountDoc, where: whereFn, get: getFn }
);

jest.mock("../../../src/config/firebase", () => ({
  db: { collection, runTransaction },
  firebase: { firestore: { FieldValue: { serverTimestamp: () => "server-ts" } } },
}));

import AccountRepository from "../../../src/repository/account.repository";

const ACCOUNT = {
  id: "acc-1",
  displayName: "Ada TV",
  handle: "@adatv",
  memberUids: ["uid-1"],
  ownerUids: ["uid-1"],
  members: { "uid-1": { role: "owner" as const, addedAt: "server-ts" as never } },
  billingOwnerUid: "uid-1",
  deletedAt: null,
};

const CONTEXT = { niche: "AI tools", websiteContent: "scraped" } as never;

describe("AccountRepository.createWithContext", () => {
  let repo: AccountRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    txnGet.mockResolvedValue(pointerSnap(undefined)); // no account yet
    repo = new AccountRepository();
  });

  it("writes account, context and pointer in ONE transaction", async () => {
    await repo.createWithContext(ACCOUNT, CONTEXT);

    expect(runTransaction).toHaveBeenCalledTimes(1);
    expect(txnSet).toHaveBeenCalledTimes(3);
  });

  it("keys the account on its own id and the context on a subcollection", async () => {
    await repo.createWithContext(ACCOUNT, CONTEXT);

    expect(accountDoc).toHaveBeenCalledWith("acc-1");
    expect(subCollection).toHaveBeenCalledWith("context");
    expect(contextDoc).toHaveBeenCalledWith("channel");
  });

  it("keeps the scraped blob OUT of the account document", async () => {
    await repo.createWithContext(ACCOUNT, CONTEXT);

    const [[, accountWritten], [, contextWritten]] = txnSet.mock.calls;
    // The account doc is read on every authenticated request from Phase 05.
    // An uncapped scrape on it makes membership writes fail at the 1 MiB limit,
    // and the error names the member, not the website.
    expect(accountWritten).not.toHaveProperty("websiteContent");
    expect(contextWritten.websiteContent).toBe("scraped");
  });

  it("points the user at the account it just created, merging so the profile survives", async () => {
    await repo.createWithContext(ACCOUNT, CONTEXT);

    expect(userDoc).toHaveBeenCalledWith("uid-1");
    const pointerWrite = txnSet.mock.calls.find(
      (c) => (c[0] as { __userDoc?: string }).__userDoc
    );
    expect(pointerWrite![1]).toEqual({ lastActiveAccountId: "acc-1" });
    // Without merge this would erase the user's whole profile.
    expect(pointerWrite![2]).toEqual({ merge: true });
  });

  it("stamps createdAt and updatedAt server-side", async () => {
    await repo.createWithContext(ACCOUNT, CONTEXT);

    const [, accountWritten] = txnSet.mock.calls[0];
    expect(accountWritten.createdAt).toBe("server-ts");
    expect(accountWritten.updatedAt).toBe("server-ts");
  });

  it("returns the id it minted when the claim is free", async () => {
    expect(await repo.createWithContext(ACCOUNT, CONTEXT)).toBe("acc-1");
  });

  // The race: a concurrent first request for the same fresh user already
  // committed. Minting a second account here splits one user's records across
  // two accounts, which stays invisible until Phase 06.
  it("adopts the winner's account and writes NOTHING when the pointer is already claimed", async () => {
    txnGet.mockResolvedValue(pointerSnap("acc-winner"));

    expect(await repo.createWithContext(ACCOUNT, CONTEXT)).toBe("acc-winner");
    expect(txnSet).not.toHaveBeenCalled();
  });

  it("reads the pointer inside the transaction, not before it", async () => {
    // Reading outside is what makes the check worthless — the value can change
    // between the read and the commit.
    await repo.createWithContext(ACCOUNT, CONTEXT);

    expect(txnGet).toHaveBeenCalledWith(expect.objectContaining({ __userDoc: "uid-1" }));
  });
});

describe("AccountRepository.findByMember", () => {
  let repo: AccountRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new AccountRepository();
  });

  it("queries memberUids with array-contains, the only shape Firestore can index", async () => {
    // Firestore cannot query inside the `members` map — that is precisely why
    // the flat array exists next to it.
    whereFn.mockReturnValue({ get: jest.fn().mockResolvedValue({ docs: [] }) });

    await repo.findByMember("uid-1");

    expect(whereFn).toHaveBeenCalledWith("memberUids", "array-contains", "uid-1");
  });

  it("returns every account the user belongs to", async () => {
    whereFn.mockReturnValue({
      get: jest.fn().mockResolvedValue({
        docs: [{ data: () => ({ id: "acc-1" }) }, { data: () => ({ id: "acc-2" }) }],
      }),
    });

    expect(await repo.findByMember("uid-1")).toEqual([{ id: "acc-1" }, { id: "acc-2" }]);
  });
});
