// The module imports src/config/firebase, which throws without real service
// account credentials.
const docSet = jest.fn();
const docUpdate = jest.fn();
const docFn = jest.fn((id: string) => ({ id, set: docSet, update: docUpdate }));

jest.mock("../../src/config/firebase", () => ({
  db: { collection: jest.fn(() => ({ doc: docFn })) },
  auth: {},
  firebase: {
    firestore: {
      FieldValue: {
        serverTimestamp: jest.fn().mockReturnValue("ts"),
        increment: jest.fn((n: number) => ({ __increment: n })),
      },
    },
  },
}));

import UserRepository, { expandFieldPaths } from "../../src/repository/user.repository";

// Phase 01 item 2. `UserRepository.update` moved from `.update()` to
// `set(..., { merge: true })` so a missing user record self-heals instead of
// throwing. The two methods disagree on dotted keys — `update()` reads them as a
// nested PATH, `set()` as a literal field name — so the counter writes in
// content.service.ts would silently produce a top-level field called
// "stats.ideas" and orphan the real counter.
describe("expandFieldPaths", () => {
  it("expands a dotted key into a nested object", () => {
    expect(expandFieldPaths({ "stats.ideas": 1 })).toEqual({ stats: { ideas: 1 } });
  });

  it("leaves plain keys untouched", () => {
    expect(expandFieldPaths({ niche: "finance", updatedAt: "ts" })).toEqual({
      niche: "finance",
      updatedAt: "ts",
    });
  });

  it("merges sibling counters under one parent instead of overwriting", () => {
    expect(
      expandFieldPaths({ "stats.ideas": 1, "stats.scripts": 2 })
    ).toEqual({ stats: { ideas: 1, scripts: 2 } });
  });

  it("preserves a FieldValue sentinel by reference", () => {
    const sentinel = { __sentinel: "increment" };
    const out = expandFieldPaths({ "stats.ideas": sentinel });
    expect((out.stats as Record<string, unknown>).ideas).toBe(sentinel);
  });

  it("handles the real counter payload shape", () => {
    const inc = { __op: "increment", by: 3 };
    const ts = { __op: "serverTimestamp" };

    expect(expandFieldPaths({ "stats.ideas": inc, updatedAt: ts })).toEqual({
      stats: { ideas: inc },
      updatedAt: ts,
    });
  });

  it("supports deeper paths", () => {
    expect(expandFieldPaths({ "usage.daily.ideas": 5 })).toEqual({
      usage: { daily: { ideas: 5 } },
    });
  });

  it("does not descend into a non-object already at the path", () => {
    // `a` is set to a scalar first, then `a.b` needs a container. The scalar is
    // replaced rather than the code throwing on a property write to a primitive.
    const out = expandFieldPaths({ a: 1, "a.b": 2 });
    expect(out).toEqual({ a: { b: 2 } });
  });
});

// The helper above is pure and well covered, but nothing exercised `update`
// itself — so the actual fix (swapping `.update()` for `set(merge)`, which is
// what makes a missing record self-heal) was unverified. These pin the two
// halves that have to hold together: it must call `set`, and what it passes must
// already have the dotted paths expanded.
describe("UserRepository.update — a counter write on a missing user must not throw", () => {
  let repo: UserRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new UserRepository();
  });

  it("uses set(merge), never update() — update() throws when the doc is absent", async () => {
    await repo.update("user-1", { niche: "AI tools" });

    expect(docFn).toHaveBeenCalledWith("user-1");
    expect(docSet).toHaveBeenCalled();
    expect(docUpdate).not.toHaveBeenCalled();
    expect(docSet.mock.calls[0][1]).toEqual({ merge: true });
  });

  it("expands a dotted counter path, so the increment lands on stats.ideas and not a field named 'stats.ideas'", async () => {
    await repo.update("user-1", { "stats.ideas": { __increment: 1 } });

    const written = docSet.mock.calls[0][0];
    expect(written).toMatchObject({ stats: { ideas: { __increment: 1 } } });
    // The exact silent-orphan failure the swap to set() would otherwise cause.
    expect(written).not.toHaveProperty(["stats.ideas"]);
  });

  it("stamps updatedAt server-side on every write", async () => {
    await repo.update("user-1", { niche: "n" });

    expect(docSet.mock.calls[0][0].updatedAt).toBe("ts");
  });

  it("refuses an empty userId rather than writing to a document keyed on nothing", async () => {
    await expect(repo.update("", { niche: "n" })).rejects.toThrow(/userId is required/);
    expect(docSet).not.toHaveBeenCalled();
  });
});
