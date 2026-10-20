/** Handler tests use a storage double; real SDK registration is checked separately. */
const records = new Map<string, Record<string, unknown>>();
const create = jest.fn();
const doc = jest.fn((uid: string) => ({ create: (value: Record<string, unknown>) => create(uid, value) }));
const collection = jest.fn(() => ({ doc }));
jest.mock(require.resolve("firebase-functions/v2/identity", { paths: [__dirname + "/../../../functions"] }), () => ({
  IS_NOT_TENANT: "__no_tenant__",
  onUserCreated: (_options: unknown, handler: unknown) => handler,
  onUserDeleted: (_options: unknown, handler: unknown) => handler,
}));
jest.mock(require.resolve("firebase-admin", { paths: [__dirname + "/../../../functions"] }), () => ({
  initializeApp: jest.fn(),
  firestore: Object.assign(() => ({ collection }), {
    FieldValue: { serverTimestamp: () => "server-ts" },
  }),
}));
import { onCreateUserV2 } from "../../../functions/src/index";
const invoke = onCreateUserV2 as unknown as (event: unknown) => Promise<void>;
const user = { uid: "uid-123", displayName: "Ada", email: "ada@example.com", photoURL: "https://img/ada.png" };
const event = (data: unknown) => ({ id: "event-1", type: "google.firebase.auth.user.v2.created", data });
beforeEach(() => {
  records.clear();
  create.mockReset().mockImplementation(async (uid: string, value: Record<string, unknown>) => {
    if (records.has(uid)) throw Object.assign(new Error("exists"), { code: 6 });
    records.set(uid, value);
  });
});
it("creates the default profile from the v2 event data and auth uid", async () => {
  await invoke(event(user));
  expect(collection).toHaveBeenCalledWith("users");
  expect(doc).toHaveBeenCalledWith(user.uid);
  expect(records.get(user.uid)).toEqual({ uid: user.uid, name: "Ada", email: user.email, photoURL: user.photoURL,
    stats: { ideas: 0, scripts: 0, credits: 0 }, createdAt: "server-ts" });
});
it("uses defined defaults for anonymous users", async () => {
  await invoke(event({ uid: "anonymous" }));
  expect(records.get("anonymous")).toMatchObject({ name: "Anonymous", email: "", photoURL: "" });
});
it("preserves onboarding, counters and creation time on duplicate delivery or existing profiles", async () => {
  await invoke(event(user));
  const existing = { ...records.get(user.uid), name: "Custom name", niche: "science", stats: { ideas: 7, scripts: 3, credits: 20 }, createdAt: "original" };
  records.set(user.uid, existing);
  await invoke(event(user));
  await invoke({ ...event(user), id: "redelivery" });
  expect(records.get(user.uid)).toEqual(existing);
});
it("awaits the create operation", async () => {
  let completed = false;
  create.mockImplementation(() => new Promise(resolve => setImmediate(() => { completed = true; resolve(undefined); })));
  await invoke(event(user));
  expect(completed).toBe(true);
});
it("rejects storage failures and succeeds on a later retry", async () => {
  const error = Object.assign(new Error("unavailable"), { code: 14 });
  create.mockRejectedValueOnce(error);
  const log = jest.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await expect(invoke(event(user))).rejects.toBe(error);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("user_record_create_failed"));
    await invoke(event(user));
    expect(records.has(user.uid)).toBe(true);
  } finally { log.mockRestore(); }
});
it.each([undefined, {}, { data: null }, { data: {} }, { data: { uid: "" } }, { data: { uid: 42 } }, { data: { uid: "bad/path" } }])(
  "rejects malformed input before accessing storage: %p", async input => {
    await expect(invoke(input)).rejects.toThrow();
    expect(collection).not.toHaveBeenCalled();
  }
);
