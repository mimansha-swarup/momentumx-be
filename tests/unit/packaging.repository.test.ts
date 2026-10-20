// Persistence behaviour for PackagingRepository, against the contract in
// `.claude/rules/firestore-conventions.md`:
//
//   - the document id is DETERMINISTIC and equals videoProjectId, on BOTH
//     creation paths (persist-on-generate and the save path);
//   - reads are POINT READS — `repo.get(videoProjectId)`. There is no locate
//     query left in either direction: `findByVideoProject` is deleted and must
//     not be reintroduced;
//   - the transaction exists for the `itemStatuses` read-modify-write and the
//     "all four done?" check, NOT for finding the document.
//
// REWRITTEN 2026-09-27. This suite used to stub `runTransaction` with jest.fn()s
// and assert which SDK methods were called (`expect(txnSet).toHaveBeenCalled()`,
// `expect(docFn).toHaveBeenCalledWith("proj-1")`). That proves a method was
// invoked, not that one document exists with the right contents. It now runs
// against the shared in-memory Firestore and asserts the STORED DOCUMENTS.
jest.mock("../../src/config/firebase", () =>
  require("../helpers/fake-firestore").mockFirebase()
);

import PackagingRepository from "../../src/repository/packaging.repository";
import { OTHER_ACCOUNT_ID, TEST_ACCOUNT_ID, testOwner } from "../helpers/account";
import { fakeTimestamp, isServerTimestamp } from "../helpers/fake-firestore";

const store = require("../../src/config/firebase").__db;

const PROJECT = "proj-1";
const owner = testOwner("uid-1");
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

const packaging = (over: Record<string, unknown> = {}) => ({
  id: PROJECT,
  videoProjectId: PROJECT,
  accountId: TEST_ACCOUNT_ID,
  createdBy: "uid-1",
  titles: [],
  description: "",
  thumbnail: [],
  shorts: { segments: [], totalDuration: "" },
  selectedTitleIndex: null,
  selectedThumbnailIndex: 0,
  isStale: false,
  staleReason: null,
  staleSince: null,
  itemStatuses: {
    title: "not_started",
    description: "not_started",
    thumbnail: "not_started",
    shorts: "not_started",
  },
  createdAt: fakeTimestamp(T0),
  ...over,
});

const stored = (id = PROJECT) => store.col("packaging").get(id);

let repo: PackagingRepository;

beforeEach(() => {
  store.data.clear();
  jest.restoreAllMocks();
  repo = new PackagingRepository();
});

describe("PackagingRepository — the deterministic document id", () => {
  // HARM: with an auto-id on one path, a project ends up with TWO packaging
  // documents — the generate endpoints write one, the save path writes the other,
  // and the creator sees a package that is missing half its items.
  it("keys a first generation on videoProjectId, not on an auto-id", async () => {
    const res = await repo.upsertGeneratedItem(PROJECT, owner, "titles", "title", [
      { title: "A" },
    ]);

    expect([...store.col("packaging").keys()]).toEqual([PROJECT]);
    expect(res).toMatchObject({ packagingId: PROJECT, created: true });
    expect(stored()).toMatchObject({ id: PROJECT, videoProjectId: PROJECT });
  });

  it("keys the save path on the same id", async () => {
    const saved = await repo.saveWithId(PROJECT, { accountId: TEST_ACCOUNT_ID, description: "d" });

    expect([...store.col("packaging").keys()]).toEqual([PROJECT]);
    expect(saved).toMatchObject({ id: PROJECT });
  });

  // HARM: the exact regression Phase 05a closed. Generate first, then save edits
  // (or the reverse) and either order must land on ONE document.
  it("converges both creation paths on ONE document, in either order", async () => {
    await repo.upsertGeneratedItem(PROJECT, owner, "titles", "title", [{ title: "A" }]);
    await repo.saveWithId(PROJECT, { description: "user edit" });

    expect(store.col("packaging").size).toBe(1);
    // merge:true — the save must not blow away what the generation persisted.
    expect(stored()).toMatchObject({
      titles: [{ title: "A" }],
      description: "user edit",
      itemStatuses: expect.objectContaining({ title: "completed" }),
    });

    store.data.clear();

    await repo.saveWithId(PROJECT, { accountId: TEST_ACCOUNT_ID, description: "user edit" });
    await repo.upsertGeneratedItem(PROJECT, owner, "titles", "title", [{ title: "A" }]);

    expect(store.col("packaging").size).toBe(1);
    expect(stored()).toMatchObject({ titles: [{ title: "A" }], description: "user edit" });
  });

  // HARM: persist-on-generate fires round 1 (title + shorts) concurrently. Two
  // auto-id creates would race into two documents; a deterministic key makes them
  // converge regardless of who wins.
  //
  // NOTE: the fake serializes transactions and cannot model contention (see its
  // header), so what is asserted here is the part the deterministic id alone
  // guarantees — ONE document, under the project's id — not which item survives.
  it("converges four concurrent first-generations on ONE document", async () => {
    await Promise.all([
      repo.upsertGeneratedItem(PROJECT, owner, "titles", "title", [{ title: "A" }]),
      repo.upsertGeneratedItem(PROJECT, owner, "shorts", "shorts", { segments: [] }),
      repo.upsertGeneratedItem(PROJECT, owner, "description", "description", "d"),
      repo.upsertGeneratedItem(PROJECT, owner, "thumbnail", "thumbnail", ["t"]),
    ]);

    expect([...store.col("packaging").keys()]).toEqual([PROJECT]);
  });

  // HARM: reintroducing a `where("videoProjectId", "==", …)` locate query brings
  // back the two-id world this phase deleted. A document whose id is NOT the
  // project id is not this project's packaging, however its fields read — so it
  // must neither be found by `get` nor updated in place by a generation.
  it("point-reads only: a doc carrying videoProjectId under another id is not this project's", async () => {
    store.seed("packaging", [packaging({ id: "auto-legacy-id", videoProjectId: PROJECT })]);

    expect(await repo.get(PROJECT)).toBeNull();

    const res = await repo.upsertGeneratedItem(PROJECT, owner, "titles", "title", [
      { title: "A" },
    ]);

    expect(res).toMatchObject({ packagingId: PROJECT, created: true });
    expect(store.col("packaging").size).toBe(2);
    expect(stored("auto-legacy-id").titles).toEqual([]);
  });
});

describe("PackagingRepository.upsertGeneratedItem — what the document holds", () => {
  // HARM: each generation overwriting the document blanks the items already
  // generated, so the creator watches the title disappear when the shorts land.
  it("accumulates all four items on one document across four generations", async () => {
    const first = await repo.upsertGeneratedItem(PROJECT, owner, "titles", "title", [
      { title: "A" },
    ]);
    await repo.upsertGeneratedItem(PROJECT, owner, "description", "description", "desc");
    await repo.upsertGeneratedItem(PROJECT, owner, "thumbnail", "thumbnail", ["brief"]);
    const last = await repo.upsertGeneratedItem(PROJECT, owner, "shorts", "shorts", {
      segments: [{ text: "s" }],
      totalDuration: "30s",
    });

    expect(first.created).toBe(true);
    expect(last.created).toBe(false);
    expect(store.col("packaging").size).toBe(1);
    expect(stored()).toMatchObject({
      titles: [{ title: "A" }],
      description: "desc",
      thumbnail: ["brief"],
      shorts: { segments: [{ text: "s" }], totalDuration: "30s" },
      itemStatuses: {
        title: "completed",
        description: "completed",
        thumbnail: "completed",
        shorts: "completed",
      },
    });
    // The returned snapshot is what the service drives step completion from — it
    // must agree with what was stored, or the packaging step never auto-completes.
    expect(last.statuses).toEqual(stored().itemStatuses);
  });

  // HARM: a generation that stamps its own clock reorders against server-written
  // records. `createdAt` is a STORED field, so it comes from the server.
  it("stamps createdAt from the server, never a client clock", async () => {
    await repo.upsertGeneratedItem(PROJECT, owner, "titles", "title", [{ title: "A" }]);

    expect(isServerTimestamp(stored().createdAt)).toBe(true);
    expect(stored().createdAt).not.toBeInstanceOf(Date);
  });

  // HARM: a packaging document with no accountId is unreachable by every
  // account-scoped list query — the creator's package silently vanishes.
  it("stamps the owning channel and the author on the document it creates", async () => {
    await repo.upsertGeneratedItem(PROJECT, owner, "titles", "title", [{ title: "A" }]);

    expect(stored()).toMatchObject({ accountId: TEST_ACCOUNT_ID, createdBy: "uid-1" });
  });

  // HARM: a stateless preview (no persist) is not what this is — the item must be
  // readable back through the point read the client is handed.
  it("is readable back through the point read on the returned packagingId", async () => {
    const { packagingId } = await repo.upsertGeneratedItem(PROJECT, owner, "titles", "title", [
      { title: "A" },
    ]);

    await expect(repo.get(packagingId)).resolves.toMatchObject({ titles: [{ title: "A" }] });
  });

  // HARM (Phase 01 item 3): Firestore REJECTS a read issued after the first write
  // in a transaction, so a read-modify-write that writes first throws at runtime
  // — on every generation. The fake enforces the same ordering.
  it("issues its read before any write inside the transaction", async () => {
    store.seed("packaging", [packaging()]);

    await expect(
      repo.upsertGeneratedItem(PROJECT, owner, "titles", "title", [{ title: "A" }])
    ).resolves.toMatchObject({ created: false });
    expect(stored().titles).toEqual([{ title: "A" }]);
  });
});

// The stale cascade. Regenerating an upstream step marks the packaging stale;
// "Keep as-is" clears it.
describe("PackagingRepository.markStale", () => {
  // HARM: a script regenerated after packaging leaves the creator exporting a
  // description written for the old script, with nothing flagging it.
  it("flags the document and flips only the COMPLETED items to stale", async () => {
    store.seed("packaging", [
      packaging({
        itemStatuses: {
          title: "completed",
          description: "not_started",
          thumbnail: "completed",
          shorts: "stale",
        },
      }),
    ]);

    await repo.markStale(PROJECT, "script_regenerated");

    expect(stored()).toMatchObject({
      isStale: true,
      staleReason: "script_regenerated",
      itemStatuses: {
        title: "stale",
        // Untouched: an item that was never generated does not become stale, and
        // one already stale does not change.
        description: "not_started",
        thumbnail: "stale",
        shorts: "stale",
      },
    });
    // staleSince is a stored timestamp → server-side.
    expect(isServerTimestamp(stored().staleSince)).toBe(true);
  });

  it("is a no-op when the project has no packaging yet", async () => {
    await expect(repo.markStale("missing", "script_regenerated")).resolves.toBeUndefined();
    expect(store.col("packaging").size).toBe(0);
  });
});

describe("PackagingRepository.clearStale", () => {
  // HARM: "Keep as-is" that does not clear the flags leaves an "Outdated" chip on
  // every card under a banner the creator already dismissed.
  it("clears the flags and returns the stale items to completed", async () => {
    store.seed("packaging", [
      packaging({
        isStale: true,
        staleReason: "hooks_regenerated",
        staleSince: fakeTimestamp(T0),
        itemStatuses: {
          title: "completed",
          description: "stale",
          thumbnail: "stale",
          shorts: "not_started",
          // A key the repository's four-item loop knows nothing about. A
          // whole-map rewrite would drop it; the dotted-path write preserves it.
          legacyItem: "completed",
        },
      }),
    ]);

    await repo.clearStale(PROJECT);

    expect(stored()).toMatchObject({
      isStale: false,
      staleReason: null,
      staleSince: null,
      itemStatuses: {
        title: "completed",
        description: "completed",
        thumbnail: "completed",
        shorts: "not_started",
        legacyItem: "completed",
      },
    });
  });

  it("is a no-op when the document does not exist", async () => {
    await expect(repo.clearStale("missing")).resolves.toBeUndefined();
    expect(store.col("packaging").size).toBe(0);
  });

  // HARM: the cascade is reversible, so a mark → clear round trip must land the
  // document exactly where it started rather than leaving items mislabelled.
  it("round-trips with markStale", async () => {
    store.seed("packaging", [
      packaging({
        itemStatuses: {
          title: "completed",
          description: "completed",
          thumbnail: "not_started",
          shorts: "completed",
        },
      }),
    ]);

    await repo.markStale(PROJECT, "script_regenerated");
    await repo.clearStale(PROJECT);

    expect(stored()).toMatchObject({
      isStale: false,
      staleReason: null,
      staleSince: null,
      itemStatuses: {
        title: "completed",
        description: "completed",
        thumbnail: "not_started",
        shorts: "completed",
      },
    });
  });
});

describe("PackagingRepository.get", () => {
  // HARM: `GET /v1/packaging/a%2Fb` decodes to "a/b", addresses a COLLECTION and
  // renders as 500 "Something went wrong" where the answer is not-found.
  it("treats a malformed id as not found instead of throwing", async () => {
    await expect(repo.get("a/b")).resolves.toBeNull();
    await expect(repo.get("")).resolves.toBeNull();
  });

  it("returns null for a project that has no packaging", async () => {
    await expect(repo.get("nope")).resolves.toBeNull();
  });

  // HARM: a raw Firestore Timestamp reaching the client renders as `{_seconds:…}`.
  it("serializes createdAt to a Date", async () => {
    store.seed("packaging", [packaging({ createdAt: fakeTimestamp(T0) })]);

    const found = await repo.get(PROJECT);

    expect(found?.createdAt).toEqual(new Date(T0));
  });
});

describe("PackagingRepository.getByAccountId", () => {
  // HARM: `GET /v1/packaging/list` is account-scoped, not per-user. Leaking here
  // shows one channel another channel's packages.
  it("lists only the active channel's packaging, newest first, with the document id", async () => {
    store.seed("packaging", [
      packaging({ id: "older", videoProjectId: "older", createdAt: fakeTimestamp(T0) }),
      packaging({ id: "newer", videoProjectId: "newer", createdAt: fakeTimestamp(T0 + 5000) }),
      packaging({
        id: "theirs",
        accountId: OTHER_ACCOUNT_ID,
        createdAt: fakeTimestamp(T0 + 9000),
      }),
    ]);

    const rows = await repo.getByAccountId(TEST_ACCOUNT_ID);

    expect(rows.map((r) => r.id)).toEqual(["newer", "older"]);
    expect(rows[0].createdAt).toEqual(new Date(T0 + 5000));
  });

  it("returns an empty list for a channel with no packaging", async () => {
    await expect(repo.getByAccountId(TEST_ACCOUNT_ID)).resolves.toEqual([]);
  });
});

describe("PackagingRepository.update", () => {
  // HARM: a title selection that silently creates a fresh document instead of
  // updating leaves the generated items behind in the original.
  it("patches the existing document and reports what it wrote", async () => {
    store.seed("packaging", [packaging({ titles: [{ title: "A" }] })]);

    const res = await repo.update(PROJECT, { selectedTitleIndex: 0 });

    expect(res).toEqual({ id: PROJECT, selectedTitleIndex: 0 });
    expect(stored()).toMatchObject({ selectedTitleIndex: 0, titles: [{ title: "A" }] });
  });

  // HARM: an update must NOT conjure a document — a silent create would hide a
  // bad packagingId behind a half-empty package.
  it("rejects rather than creating a document that does not exist", async () => {
    await expect(repo.update("missing", { selectedTitleIndex: 0 })).rejects.toThrow();
    expect(store.col("packaging").size).toBe(0);
  });
});
