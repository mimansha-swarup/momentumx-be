// The auth trigger that gives every new user a profile record.
//
// `functions/` is a separate deploy artifact with its own package.json and no
// test script, and the root jest config only *discovers* tests under `tests/` —
// so nothing had ever executed this handler. All three things Phase 01 item 2
// fixed here were unverified: returning the write, merging instead of clobbering,
// and failing loudly. A regression to fire-and-forget would pass `npm test`
// silently and show up as users with no profile record.
//
// (Discovery roots are unchanged; this file lives under `tests/` and imports
// across. No jest config change was needed.)

const docSet = jest.fn();
const docFn = jest.fn((uid: string) => ({ uid, set: docSet }));
const collectionFn = jest.fn(() => ({ doc: docFn }));

let captured: ((user: unknown) => Promise<void>) | null = null;

jest.mock("firebase-functions/v1/auth", () => ({
  user: () => ({
    onCreate: (handler: (u: unknown) => Promise<void>) => {
      captured = handler;
      return handler;
    },
  }),
}));

jest.mock("firebase-admin", () => ({
  initializeApp: jest.fn(),
  firestore: Object.assign(jest.fn(() => ({ collection: collectionFn })), {
    FieldValue: { serverTimestamp: () => "server-ts" },
  }),
}));

import "../../../functions/src/index";

const USER = {
  uid: "uid-123",
  displayName: "Ada",
  email: "ada@example.com",
  photoURL: "https://img/ada.png",
};

describe("onCreateUser — a new signup always ends up with a profile record", () => {
  beforeEach(() => {
    docSet.mockReset().mockResolvedValue(undefined);
    docFn.mockClear();
    collectionFn.mockClear();
  });

  it("registers a handler at module load", () => {
    expect(captured).toBeInstanceOf(Function);
  });

  it("writes the record keyed on the auth uid", async () => {
    await captured!(USER);

    expect(collectionFn).toHaveBeenCalledWith("users");
    expect(docFn).toHaveBeenCalledWith("uid-123");
  });

  it("MERGES, so it cannot clobber a profile onboarding already wrote", async () => {
    // Onboarding can complete before this background trigger runs. A plain
    // `.set()` would erase the niche/audience the user just typed.
    await captured!(USER);

    expect(docSet.mock.calls[0][1]).toEqual({ merge: true });
  });

  it("seeds the lifetime counters, so a user who never onboards still has a stats baseline", async () => {
    await captured!(USER);

    expect(docSet.mock.calls[0][0]).toMatchObject({
      uid: "uid-123",
      name: "Ada",
      email: "ada@example.com",
      stats: { ideas: 0, scripts: 0, credits: 0 },
      createdAt: "server-ts",
    });
  });

  it("falls back for an anonymous or email-less provider rather than writing undefined", async () => {
    await captured!({ uid: "uid-456" });

    expect(docSet.mock.calls[0][0]).toMatchObject({
      name: "Anonymous",
      email: "",
      photoURL: "",
    });
  });

  // The three-in-one regression guard. In a background Cloud Function the
  // instance can be frozen the moment the handler returns, so a write that is
  // not awaited is simply dropped.
  it("AWAITS the write — a handler that resolves early loses it", async () => {
    let settled = false;
    docSet.mockImplementation(
      () => new Promise((resolve) => setImmediate(() => { settled = true; resolve(undefined); }))
    );

    await captured!(USER);

    expect(settled).toBe(true);
  });

  it("rethrows a failed write so the invocation is marked failed, not silently lost", async () => {
    docSet.mockRejectedValue(new Error("permission denied"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(captured!(USER)).rejects.toThrow("permission denied");

    // Logged structurally on the way out — a user with no profile record must not
    // look identical to a healthy one.
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0][0])).toContain("user_record_create_failed");
    errorSpy.mockRestore();
  });
});
