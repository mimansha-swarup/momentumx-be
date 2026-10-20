/** Real published SDK wrappers; storage alone is mocked. No emulator/platform claims. */
const create = jest.fn().mockResolvedValue(undefined);
const get = jest.fn().mockResolvedValue({ docs: [] });
const where = jest.fn(() => ({ get }));
const collection = jest.fn(() => ({ doc: () => ({ create }), where }));
jest.mock(require.resolve("firebase-admin", { paths: [__dirname + "/../../../functions"] }), () => ({
  initializeApp: jest.fn(),
  firestore: Object.assign(() => ({ collection }), { FieldValue: { serverTimestamp: () => "now" } }),
}));
import * as functions from "../../../functions/src/index";
const raw = (type: string, data: unknown, extra = {}) => ({
  id: "sdk-event", specversion: "1.0", type: `google.firebase.auth.user.v2.${type}`,
  source: "//identitytoolkit.googleapis.com/projects/demo-offline", time: "2026-10-18T00:00:00Z", data, ...extra,
});
it("registers real gen2 event endpoints without a blocking trigger", () => {
  expect(Object.keys(functions).sort()).toEqual(["onCreateUserV2", "onDeleteUserV2"]);
  for (const [handler, type] of [[functions.onCreateUserV2, "created"], [functions.onDeleteUserV2, "deleted"]] as const) {
    expect(handler.__endpoint).toMatchObject({ platform: "gcfv2", region: ["us-central1"], concurrency: 1,
      eventTrigger: { eventType: `google.firebase.auth.user.v2.${type}`, region: "global", retry: false } });
    expect(handler.__endpoint.blockingTrigger).toBeUndefined();
  }
});
it("normalizes the real creation envelope and photoUrl field", async () => {
  await functions.onCreateUserV2(raw("created", { value: { uid: "created", displayName: "Ada", photoUrl: "https://img/ada.png", metadata: { createTime: "2026-10-18T00:00:00Z" } } }) as any);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ uid: "created", name: "Ada", photoURL: "https://img/ada.png" }));
});
it.each(["oldValue", "old_value"])("normalizes the real deletion envelope %s", async key => {
  await functions.onDeleteUserV2(raw("deleted", { [key]: { uid: "deleted" } }) as any);
  expect(where).toHaveBeenCalledWith("memberUids", "array-contains", "deleted");
});
it.each(["created", "deleted"])("ignores tenant events for %s", async type => {
  const handler = type === "created" ? functions.onCreateUserV2 : functions.onDeleteUserV2;
  await handler(raw(type, { [type === "created" ? "value" : "oldValue"]: { uid: "tenant-user" } }, { tenantid: "tenant-1" }) as any);
  expect(collection).not.toHaveBeenCalled();
});
it.each([null, {}, { value: null }, { value: { uid: "" } }])("rejects malformed raw creation data without writes: %p", async data => {
  await expect(Promise.resolve().then(() => functions.onCreateUserV2(raw("created", data) as any))).rejects.toThrow();
  expect(collection).not.toHaveBeenCalled();
});
