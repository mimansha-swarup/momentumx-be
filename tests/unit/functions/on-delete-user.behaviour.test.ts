const update = jest.fn();
const set = jest.fn();
const accountRef = { collection: (name: string) => ({ doc: (uid: string) => `${name}/${uid}` }) };
let current: any;
const get = jest.fn();
const transaction = jest.fn();
const where = jest.fn(() => ({ get }));
const collection = jest.fn(() => ({ where }));
const db = { collection, runTransaction: transaction };
jest.mock(require.resolve("firebase-functions/v2/identity", { paths: [__dirname + "/../../../functions"] }), () => ({
  IS_NOT_TENANT: "__no_tenant__",
  onUserCreated: (_options: unknown, handler: unknown) => handler,
  onUserDeleted: (_options: unknown, handler: unknown) => handler,
}));
jest.mock(require.resolve("firebase-admin", { paths: [__dirname + "/../../../functions"] }), () => ({ initializeApp: jest.fn(), firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => "now" } }) }));
import { onDeleteUserV2 } from "../../../functions/src/index";
const invoke = onDeleteUserV2 as unknown as (event: unknown) => Promise<void>;
const event = (uid: string) => ({ id: "delete-event", type: "google.firebase.auth.user.v2.deleted", data: { uid } });
beforeEach(() => {
  update.mockReset().mockImplementation((_ref: unknown, value: unknown) => Object.assign(current, value));
  set.mockReset();
  get.mockReset().mockResolvedValue({ docs: [{ ref: accountRef }] });
  transaction.mockReset().mockImplementation(async (fn: any) => fn({ get: async () => ({ data: () => current }), update, set }));
  current = { memberUids: ["owner", "editor"], ownerUids: ["owner"], members: { owner: { role: "owner" }, editor: { role: "editor" } }, billingOwnerUid: "owner", deletedAt: null };
});
it("removes ordinary membership and writes a revocation marker in the transaction", async () => {
  await invoke(event("editor"));
  expect(collection).toHaveBeenCalledWith("accounts");
  expect(where).toHaveBeenCalledWith("memberUids", "array-contains", "editor");
  expect(set).toHaveBeenCalledWith("membershipChanges/editor", { changedAt: "now" });
  expect(update).toHaveBeenCalledWith(accountRef, { members: { owner: { role: "owner" } }, memberUids: ["owner"], ownerUids: ["owner"], updatedAt: "now" });
});
it("marks loss of payer or last owner as orphaned without deleting content", async () => {
  current.content = "kept";
  await invoke(event("owner"));
  expect(current).toMatchObject({ content: "kept", memberUids: ["editor"], ownerUids: [], orphanedAt: "now", orphanedReason: "billing_owner_deleted" });
});
it("selects the alphabetically first surviving owner and freezes payer deletion", async () => {
  current.members = { owner: { role: "owner" }, zed: { role: "owner" }, amy: { role: "owner" } };
  current.memberUids = ["owner", "zed", "amy"];
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await invoke(event("owner"));
    expect(current).toMatchObject({ ownerUids: ["zed", "amy"], billingOwnerUid: "amy", orphanedReason: "billing_owner_deleted" });
  } finally { warn.mockRestore(); }
});
it("distinguishes deletion of the last owner from deletion of the payer", async () => {
  current.billingOwnerUid = "other";
  await invoke(event("owner"));
  expect(current.orphanedReason).toBe("last_owner_deleted");
});
it("does not rewrite the marker or account on repeated delivery", async () => {
  await invoke(event("editor"));
  await invoke(event("editor"));
  expect(update).toHaveBeenCalledTimes(1);
  expect(set).toHaveBeenCalledTimes(1);
});
it.each([undefined, { deletedAt: "yesterday", memberUids: ["editor"] }, { memberUids: ["other"] }])(
  "ignores removed, tombstoned or no-longer-matching accounts: %p", async value => {
    current = value;
    await invoke(event("editor"));
    expect(update).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  }
);
it("rejects query and transaction failures so invocation failure is visible", async () => {
  const error = new Error("storage unavailable");
  get.mockRejectedValueOnce(error);
  await expect(invoke(event("editor"))).rejects.toBe(error);
  expect(transaction).not.toHaveBeenCalled();
  transaction.mockRejectedValueOnce(error);
  await expect(invoke(event("editor"))).rejects.toBe(error);
  await invoke(event("editor"));
  expect(current.memberUids).toEqual(["owner"]);
});
it("awaits the transaction before completing", async () => {
  let finished = false;
  transaction.mockImplementation(() => new Promise(resolve => setImmediate(() => { finished = true; resolve(undefined); })));
  await invoke(event("editor"));
  expect(finished).toBe(true);
});
it.each([undefined, {}, { data: null }, { data: {} }, { data: { uid: "" } }, { data: { uid: 42 } }, { data: { uid: "bad/path" } }])(
  "rejects malformed input before querying accounts: %p", async input => {
    await expect(invoke(input)).rejects.toThrow();
    expect(collection).not.toHaveBeenCalled();
  }
);
