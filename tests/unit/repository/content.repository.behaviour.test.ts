// Behaviour tests for ContentRepository, derived from the documented contract
// (not the implementation) in:
//   - docs/features/research/api.md          (GET /v1/ideas pagination + ordering)
//   - docs/product/pipeline-spec.md          (Regenerate All / archive semantics)
//   - .claude/rules/firestore-conventions.md (accountId-first queries, batch
//     writes, server-side timestamps)
//   - .claude/rules/ai-generation-patterns.md (the KMeans input guards)
//
// REWRITTEN 2026-09-27. This suite used to mock `db.collection()` with a single
// shared chainable jest.fn object and assert which SDK METHODS were called —
// `expect(chain.orderBy).toHaveBeenCalledWith("title")`. That cannot establish
// what was stored or what came back. The sharpest case was
// "orders by title AND document id so duplicate titles are not skipped", whose
// entire assertion was two `orderBy` call counts: `orderBy("title")` followed by
// `orderBy("createdAt")` satisfied it, no duplicate titles were ever supplied,
// and no returned page was inspected.
//
// Now every test seeds real documents into the shared in-memory Firestore
// (`tests/helpers/fake-firestore.ts` — which actually applies `where`, `orderBy`,
// `limit`, `select` and the range bounds) runs the real repository method, and
// asserts the RESULT.
jest.mock("../../../src/config/firebase", () =>
  require("../../helpers/fake-firestore").mockFirebase()
);

import ContentRepository from "../../../src/repository/content.repository";
import { IIdeaCursor, IIdeaFilters } from "../../../src/types/repository/content";
import { OTHER_ACCOUNT_ID, TEST_ACCOUNT_ID } from "../../helpers/account";
import { fakeTimestamp, isServerTimestamp } from "../../helpers/fake-firestore";

const store = require("../../../src/config/firebase").__db;

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

/** A stored idea. Defaults are the shape `batchSaveIdeas` actually writes. */
const idea = (over: Record<string, unknown> = {}) => ({
  id: "idea-1",
  title: "How to cook rice",
  concept: "a concept",
  ideaType: "tutorial",
  accountId: TEST_ACCOUNT_ID,
  createdBy: "uid-1",
  archived: false,
  isScriptGenerated: false,
  batchId: "batch-1",
  embedding: [0.1, 0.2, 0.3],
  videoProjectId: null,
  createdAt: fakeTimestamp(T0),
  ...over,
});

const script = (over: Record<string, unknown> = {}) => ({
  id: "script-1",
  title: "A script",
  script: "body",
  accountId: TEST_ACCOUNT_ID,
  createdBy: "uid-1",
  createdAt: fakeTimestamp(T0),
  ...over,
});

let repo: ContentRepository;

beforeEach(() => {
  store.data.clear();
  jest.restoreAllMocks();
  repo = new ContentRepository();
});

/**
 * Walk every page exactly the way the service does — `content.service`
 * `getPaginatedUsersIdeas` derives the next cursor from the LAST ROW of the page
 * it just handed out (`{title, docId}` under a search, `{createdAt, docId}`
 * otherwise). Paging through the repository with any other cursor would be
 * testing a client nobody ships.
 */
const collectEveryPage = async (filters: IIdeaFilters, limit: number) => {
  const seen: string[] = [];
  let cursor: IIdeaCursor = {};
  for (let page = 0; page < 12; page++) {
    const rows = await repo.getIdeas({ accountId: TEST_ACCOUNT_ID, limit, cursor, filters });
    if (rows.length === 0) return seen;
    rows.forEach((row) => seen.push(String(row.id)));
    const last = rows[rows.length - 1];
    cursor = filters.searchText
      ? { title: String(last.title), docId: String(last.id) }
      : { createdAt: last.createdAt.toDate().toISOString(), docId: String(last.id) };
  }
  throw new Error(`paging never terminated; saw ${seen.join(",")}`);
};

describe("ContentRepository.getIdeas — what actually comes back", () => {
  // HARM: another channel's ideas appear in this channel's list.
  it("returns only the active channel's ideas", async () => {
    store.seed("ideas", [
      idea({ id: "mine", accountId: TEST_ACCOUNT_ID }),
      idea({ id: "theirs", accountId: OTHER_ACCOUNT_ID }),
    ]);

    const rows = await repo.getIdeas({
      accountId: TEST_ACCOUNT_ID,
      limit: 8,
      cursor: {},
      filters: {},
    });

    expect(rows.map((r) => r.id)).toEqual(["mine"]);
  });

  // HARM: last week's archived ideas mix into the current batch, so "Generate
  // More" appears to return ideas the creator already rejected.
  it("excludes archived ideas from the active list", async () => {
    store.seed("ideas", [
      idea({ id: "active", archived: false }),
      idea({ id: "archived", archived: true }),
    ]);

    const rows = await repo.getIdeas({
      accountId: TEST_ACCOUNT_ID,
      limit: 8,
      cursor: {},
      filters: {},
    });

    expect(rows.map((r) => r.id)).toEqual(["active"]);
  });

  // THE TEST THIS REWRITE EXISTS FOR.
  //
  // HARM: a second search page silently drops an idea whose title ties with
  // another — `startAfter(title)` alone positions at the FIRST row with that
  // title, so every later duplicate sorts before the cursor and is skipped for
  // good. The docId tiebreaker in the ordering is the only thing preventing it.
  it("pages through DUPLICATE titles under a search, returning every idea exactly once", async () => {
    store.seed("ideas", [
      idea({ id: "b1", title: "How to cook pasta" }),
      idea({ id: "a1", title: "How to cook rice" }),
      idea({ id: "a2", title: "How to cook rice" }), // same title
      idea({ id: "a3", title: "How to cook rice" }), // same title again
      idea({ id: "out", title: "Zebra documentary" }),
      idea({ id: "archived-dupe", title: "How to cook rice", archived: true }),
      idea({ id: "other-dupe", title: "How to cook rice", accountId: OTHER_ACCOUNT_ID }),
    ]);

    // Two rows per page, so the duplicates straddle a page boundary.
    const seen = await collectEveryPage({ searchText: "How to cook" }, 2);

    // Every match, once each: no skips, no repeats. Sorted by title then docId.
    expect(seen).toEqual(["b1", "a1", "a2", "a3"]);
    // And the prefix bound held for every page — "load more" never walked out of
    // the search, and neither the archived nor the other channel's duplicate
    // leaked in.
    expect(seen).not.toContain("out");
    expect(seen).not.toContain("archived-dupe");
    expect(seen).not.toContain("other-dupe");
  });

  // HARM: the same skip, on the DEFAULT list. A generation writes 10 ideas in one
  // batch, so identical `createdAt` values are the normal case, not an edge one:
  // without the docId tiebreaker "Load more" re-shows some and loses others.
  it("pages through ideas sharing one createdAt, returning every idea exactly once", async () => {
    const sameInstant = fakeTimestamp(T0);
    store.seed("ideas", [
      idea({ id: "d1", createdAt: sameInstant }),
      idea({ id: "d2", createdAt: sameInstant }),
      idea({ id: "d3", createdAt: sameInstant }),
      idea({ id: "d4", createdAt: sameInstant }),
    ]);

    const seen = await collectEveryPage({}, 2);

    // Newest first; document id descending breaks the tie.
    expect(seen).toEqual(["d4", "d3", "d2", "d1"]);
  });

  // HARM: the list is ordered by "whatever Firestore felt like", so the newest
  // idea is not at the top of the page the creator is looking at.
  it("orders the default list newest first", async () => {
    store.seed("ideas", [
      idea({ id: "old", createdAt: fakeTimestamp(T0) }),
      idea({ id: "newest", createdAt: fakeTimestamp(T0 + 2000) }),
      idea({ id: "middle", createdAt: fakeTimestamp(T0 + 1000) }),
    ]);

    const rows = await repo.getIdeas({
      accountId: TEST_ACCOUNT_ID,
      limit: 8,
      cursor: {},
      filters: {},
    });

    expect(rows.map((r) => r.id)).toEqual(["newest", "middle", "old"]);
  });

  // HARM: "Load more" re-returns page 1 forever — the defect this branch was
  // fixed for on 2026-08-25.
  it("does not re-return page 1 from a search cursor", async () => {
    store.seed("ideas", [
      idea({ id: "s1", title: "How to bake" }),
      idea({ id: "s2", title: "How to braise" }),
    ]);

    const page2 = await repo.getIdeas({
      accountId: TEST_ACCOUNT_ID,
      limit: 8,
      cursor: { title: "How to bake", docId: "s1" },
      filters: { searchText: "How to b" },
    });

    expect(page2.map((r) => r.id)).toEqual(["s2"]);
  });

  it("honours the page size", async () => {
    store.seed(
      "ideas",
      Array.from({ length: 10 }, (_, i) =>
        idea({ id: `p${i}`, createdAt: fakeTimestamp(T0 + i * 1000) })
      )
    );

    const rows = await repo.getIdeas({
      accountId: TEST_ACCOUNT_ID,
      limit: 4,
      cursor: {},
      filters: {},
    });

    expect(rows).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// isScriptGenerated is a THREE-state filter: absent / true / false.
//
// The old guard was `hasOwnProperty(...) && filters.isScriptGenerated`, which
// could not represent a deliberate `false` — combined with a controller doing
// `Boolean("false")` (which is true), asking for "ideas I haven't scripted yet"
// returned exactly the scripted ones. Fixed 2026-08-24.
//
// HARM: the "not yet scripted" filter returns precisely the ideas that already
// have a script.
// ---------------------------------------------------------------------------
describe("ContentRepository.getIdeas — the isScriptGenerated filter", () => {
  beforeEach(() => {
    store.seed("ideas", [
      idea({ id: "scripted", isScriptGenerated: true, createdAt: fakeTimestamp(T0 + 1000) }),
      idea({ id: "unscripted", isScriptGenerated: false, createdAt: fakeTimestamp(T0) }),
    ]);
  });

  const run = (filters: IIdeaFilters) =>
    repo.getIdeas({ accountId: TEST_ACCOUNT_ID, limit: 8, cursor: {}, filters });

  it("returns both when the flag is absent", async () => {
    expect((await run({})).map((r) => r.id)).toEqual(["scripted", "unscripted"]);
  });

  it("returns only scripted ideas for true", async () => {
    expect((await run({ isScriptGenerated: true })).map((r) => r.id)).toEqual(["scripted"]);
  });

  it("returns only UNSCRIPTED ideas for false", async () => {
    expect((await run({ isScriptGenerated: false })).map((r) => r.id)).toEqual(["unscripted"]);
  });
});

// ---------------------------------------------------------------------------
// getIdeasForClustering — where the KMeans guards ACTUALLY live.
//
// `.claude/rules/ai-generation-patterns.md` is explicit that the archived filter
// and the 200 cap are enforced IN THIS QUERY, not in `utlils/content.ts`:
// `getClusteredTitles` clusters whatever this hands it, untouched, so weakening
// the query silently removes two guards with no change to the util and no type
// error. These assert by RESULT — the previous versions asserted
// `chain.limit` / `chain.select` call arguments, which a query that also dropped
// its `where` would have satisfied.
// ---------------------------------------------------------------------------
describe("ContentRepository.getIdeasForClustering — the KMeans input guards", () => {
  // HARM: archived titles poison the "don't repeat what you already have" list,
  // so generation avoids ideas the creator deleted weeks ago.
  it("never hands an archived idea to the clusterer", async () => {
    store.seed("ideas", [
      idea({ id: "active", title: "Active", archived: false }),
      idea({ id: "archived", title: "Archived", archived: true }),
    ]);

    const rows = await repo.getIdeasForClustering(TEST_ACCOUNT_ID);

    expect(rows.map((r) => r.title)).toEqual(["Active"]);
  });

  // HARM: another channel's titles steer this channel's generation.
  it("never hands another channel's idea to the clusterer", async () => {
    store.seed("ideas", [
      idea({ id: "mine", title: "Mine", accountId: TEST_ACCOUNT_ID }),
      idea({ id: "theirs", title: "Theirs", accountId: OTHER_ACCOUNT_ID }),
    ]);

    const rows = await repo.getIdeasForClustering(TEST_ACCOUNT_ID);

    expect(rows.map((r) => r.title)).toEqual(["Mine"]);
  });

  // HARM: an uncapped KMeans run times out on Vercel — the function crashes and
  // the creator gets no ideas at all, not merely worse ones.
  it("caps the read at 200 ideas even when the channel has more", async () => {
    store.seed(
      "ideas",
      Array.from({ length: 250 }, (_, i) => idea({ id: `c${i}`, title: `T${i}` }))
    );

    const rows = await repo.getIdeasForClustering(TEST_ACCOUNT_ID);

    expect(rows).toHaveLength(200);
  });

  // HARM: reading whole idea documents pulls 200 full records — concept, evidence,
  // every field — where two are needed. The projection is the bound.
  it("reads only title and embedding, never the whole idea document", async () => {
    store.seed("ideas", [idea({ id: "one", title: "Only", embedding: [0.5] })]);

    const rows = await repo.getIdeasForClustering(TEST_ACCOUNT_ID);

    expect(rows).toEqual([{ title: "Only", embedding: [0.5] }]);
    // Named explicitly: a projection that grew would still satisfy the toEqual
    // above only by accident of the seed, so state the fields that must be absent.
    expect(Object.keys(rows[0]).sort()).toEqual(["embedding", "title"]);
  });
});

describe("ContentRepository.getActiveBatch", () => {
  // HARM: export/regenerate pulls the whole active batch including a 3072-float
  // embedding per idea, which it never uses.
  it("returns the active batch without embeddings, with the document id attached", async () => {
    store.seed("ideas", [
      idea({ id: "in-batch", archived: false }),
      idea({ id: "archived", archived: true }),
      idea({ id: "other-channel", accountId: OTHER_ACCOUNT_ID }),
    ]);

    const rows = await repo.getActiveBatch(TEST_ACCOUNT_ID);

    expect(rows.map((r) => r.id)).toEqual(["in-batch"]);
    expect(Object.keys(rows[0]).sort()).toEqual([
      "concept",
      "createdAt",
      "id",
      "ideaType",
      "title",
      "videoProjectId",
    ]);
    expect(rows[0]).not.toHaveProperty("embedding");
  });
});

describe("ContentRepository.archiveUserIdeas", () => {
  const active = () => store.all("ideas").filter((d: Record<string, unknown>) => !d.archived);

  // HARM: a client clock running fast stamps an archive in the future and
  // reorders it against every server-written record.
  it("archives the channel's active ideas and stamps updatedAt from the SERVER", async () => {
    store.seed("ideas", [
      idea({ id: "a1" }),
      idea({ id: "a2" }),
      idea({ id: "other", accountId: OTHER_ACCOUNT_ID }),
    ]);

    await repo.archiveUserIdeas(TEST_ACCOUNT_ID);

    expect(active().map((d: Record<string, unknown>) => d.id)).toEqual(["other"]);
    const stamped = store.col("ideas").get("a1");
    expect(isServerTimestamp(stamped.updatedAt)).toBe(true);
    // Not a client Date / Date.now(), which is what firestore-conventions.md
    // forbids for a STORED field.
    expect(stamped.updatedAt).not.toBeInstanceOf(Date);
    expect(typeof stamped.updatedAt).not.toBe("number");
  });

  // HARM: "Generate More" archives the batch it just wrote, so the creator's
  // brand-new ideas vanish the moment they are generated.
  it("leaves the excluded batch active", async () => {
    store.seed("ideas", [
      idea({ id: "fresh", batchId: "just-written" }),
      idea({ id: "stale", batchId: "older" }),
    ]);

    await repo.archiveUserIdeas(TEST_ACCOUNT_ID, "just-written");

    expect(active().map((d: Record<string, unknown>) => d.id)).toEqual(["fresh"]);
    expect(store.col("ideas").get("stale").archived).toBe(true);
  });

  // HARM (Phase 01 item 4): a single up-front snapshot misses an idea created
  // while the archive is still running — it stays active and surfaces mixed into
  // the next batch. Re-querying per chunk is what catches it.
  it("picks up an idea created mid-run", async () => {
    store.seed(
      "ideas",
      // Exactly CHUNK_SIZE, so pass 1 is a full page and the loop must query again.
      Array.from({ length: 450 }, (_, i) => idea({ id: `bulk-${i}` }))
    );

    // A concurrent generation lands between pass 1's commit and pass 2's query.
    const realBatch = store.batch.bind(store);
    let injected = false;
    jest.spyOn(store, "batch").mockImplementation(() => {
      const batch = realBatch();
      const commit = batch.commit;
      batch.commit = async () => {
        await commit();
        if (!injected) {
          injected = true;
          store.seed("ideas", [idea({ id: "created-mid-run" })]);
        }
      };
      return batch;
    });

    await repo.archiveUserIdeas(TEST_ACCOUNT_ID);

    expect(injected).toBe(true);
    expect(store.col("ideas").get("created-mid-run").archived).toBe(true);
    expect(active()).toEqual([]);
  });

  // HARM: without the "nothing left to archive" guard the loop re-reads the same
  // full page until MAX_PASSES — 200 wasted queries on every Generate More.
  it("stops immediately when everything still active is the excluded batch", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    store.seed(
      "ideas",
      Array.from({ length: 450 }, (_, i) => idea({ id: `keep-${i}`, batchId: "keep" }))
    );

    await repo.archiveUserIdeas(TEST_ACCOUNT_ID, "keep");

    expect(active()).toHaveLength(450);
    // The max-passes warning is the observable symptom of the spin.
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("ContentRepository.batchSaveIdeas", () => {
  // HARM: the generated UUID is the id every later edit/regenerate addresses. A
  // doc stored under a different id is an idea the creator can see but not edit.
  it("stores each idea under its own id and returns what was written", async () => {
    const written = await repo.batchSaveIdeas([
      { id: "i1", title: "A" },
      { id: "i2", title: "B" },
    ]);

    expect([...store.col("ideas").keys()].sort()).toEqual(["i1", "i2"]);
    expect(store.col("ideas").get("i1")).toEqual({ id: "i1", title: "A" });
    expect(written).toEqual([
      { id: "i1", title: "A" },
      { id: "i2", title: "B" },
    ]);
  });

  // HARM: an idea saved with no id would be unaddressable — the caller needs the
  // assigned id back to link it to a project.
  it("assigns an id when none was supplied and reports it back", async () => {
    const [written] = await repo.batchSaveIdeas([{ title: "No id" }]);

    expect(typeof written.id).toBe("string");
    expect(store.col("ideas").get(written.id)).toEqual({ id: written.id, title: "No id" });
  });

  // HARM: ten ideas written as ten independent requests are not atomic — a
  // failure halfway leaves a half-batch the creator cannot regenerate away.
  // The only observable difference is the number of commits, so this one is a
  // call assertion, on the FAKE's batch rather than on a chain stub.
  it("commits all ten ideas of a generation in ONE batch", async () => {
    const commits = jest.fn();
    const realBatch = store.batch.bind(store);
    jest.spyOn(store, "batch").mockImplementation(() => {
      const batch = realBatch();
      const commit = batch.commit;
      batch.commit = async () => {
        commits();
        await commit();
      };
      return batch;
    });

    await repo.batchSaveIdeas(
      Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, title: `T${i}` }))
    );

    expect(commits).toHaveBeenCalledTimes(1);
    expect(store.col("ideas").size).toBe(10);
  });

  it("handles an empty generation without writing anything", async () => {
    await expect(repo.batchSaveIdeas([])).resolves.toEqual([]);
    expect(store.col("ideas").size).toBe(0);
  });
});

describe("ContentRepository — point reads and edits", () => {
  // HARM: `GET /v1/ideas/a%2Fb` decodes to "a/b", addresses a COLLECTION, throws
  // a bare Error and renders as 500 "Something went wrong" — where the honest
  // answer is not-found.
  it("treats a malformed idea id as not found instead of throwing", async () => {
    await expect(repo.getIdea("a/b")).resolves.toBeUndefined();
    await expect(repo.getScriptById("a/b")).resolves.toBeNull();
  });

  it("returns undefined / null for ids that do not exist", async () => {
    await expect(repo.getIdea("nope")).resolves.toBeUndefined();
    await expect(repo.getScriptById("nope")).resolves.toBeNull();
  });

  it("reads back a stored idea", async () => {
    store.seed("ideas", [idea({ id: "i1", title: "Stored" })]);
    await expect(repo.getIdea("i1")).resolves.toMatchObject({ id: "i1", title: "Stored" });
  });

  // HARM: a script's createdAt reaching the client as a raw Firestore Timestamp
  // renders as `{_seconds: …}` in the UI.
  it("serializes a script's createdAt to a Date", async () => {
    store.seed("scripts", [script({ id: "s1", createdAt: fakeTimestamp(T0) })]);

    const found = await repo.getScriptById("s1");

    expect(found?.createdAt).toEqual(new Date(T0));
  });

  // HARM: an edit written with set() and no merge blanks every field the caller
  // did not send — the embedding included, which drops the idea out of
  // clustering forever.
  it("merges an idea edit instead of replacing the document", async () => {
    store.seed("ideas", [idea({ id: "i1", title: "Before" })]);

    await repo.updateIdea("i1", { title: "After" });

    const stored = store.col("ideas").get("i1");
    expect(stored.title).toBe("After");
    expect(stored.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(stored.accountId).toBe(TEST_ACCOUNT_ID);
  });

  it("merges a script edit instead of replacing the document", async () => {
    store.seed("scripts", [script({ id: "s1", script: "Before" })]);

    await repo.editScript("s1", { script: "After" });

    const stored = store.col("scripts").get("s1");
    expect(stored.script).toBe("After");
    expect(stored.accountId).toBe(TEST_ACCOUNT_ID);
  });

  // HARM: a script saved under a new id on every regenerate leaves orphans the
  // project no longer links to.
  it("saves a script under the id it was given, creating it if absent", async () => {
    await repo.saveScript("s-new", { script: "body", accountId: TEST_ACCOUNT_ID });

    expect(store.col("scripts").get("s-new")).toMatchObject({ script: "body" });
  });
});

describe("ContentRepository.getScripts", () => {
  // HARM: another channel's scripts listed under this one.
  it("lists only the active channel's scripts, newest first, with ids and Dates", async () => {
    store.seed("scripts", [
      script({ id: "old", createdAt: fakeTimestamp(T0) }),
      script({ id: "new", createdAt: fakeTimestamp(T0 + 5000) }),
      script({ id: "theirs", accountId: OTHER_ACCOUNT_ID, createdAt: fakeTimestamp(T0 + 9000) }),
    ]);

    const rows = await repo.getScripts(TEST_ACCOUNT_ID);

    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
    expect(rows[0].createdAt).toEqual(new Date(T0 + 5000));
  });
});
