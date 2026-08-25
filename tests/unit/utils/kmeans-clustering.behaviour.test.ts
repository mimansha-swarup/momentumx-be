// Contract (ai-generation-patterns.md, "KMeans — Guards and Preprocessing"):
//   1. Archived ideas are filtered out, and the pool is capped at 200, BEFORE
//      clustering.
//   2. k = min(8, ceil(n/20))
//   3. Guard: `titles.length <= k` skips kmeans entirely and returns all
//      titles as a single cluster.
// These guards must never be removed — an unbounded/unguarded KMeans call is a
// timeout on Vercel.
//
// IMPORTANT DIVERGENCE FROM THE RULE DOC (see report): the rule file describes
// the archived-filter and 200-cap as guards inside `getClusteredTitles` itself
// ("All KMeans logic is in src/utlils/content.ts -> getClusteredTitles"). In
// the actual implementation, `getClusteredTitles` does not filter or cap
// anything — it delegates entirely to `repo.getIdeasForClustering(userId)`,
// and content.repository.ts is what applies `.where("archived","==",false)`
// and `.limit(200)` in the Firestore query. `getClusteredTitles` trusts
// whatever the repository returns. The tests below document BOTH: the
// delegation contract (this function does no extra filtering/capping of its
// own — it isn't a second guard), and the k-formula/skip-guard, which DOES
// live here.

const mockKmeans = jest.fn();

jest.mock("../../../src/config/firebase", () => ({
  db: {},
  auth: {},
  firebase: {
    firestore: { FieldValue: { serverTimestamp: jest.fn().mockReturnValue("SERVER_TS") } },
  },
}));

jest.mock("ml-kmeans", () => ({
  kmeans: (...args: unknown[]) => mockKmeans(...args),
}));

import { getClusteredTitles } from "../../../src/utlils/content";
import type ContentRepository from "../../../src/repository/content.repository";

type IdeaForClustering = { title: string; embedding: number[] };

function buildItems(n: number): IdeaForClustering[] {
  return Array.from({ length: n }, (_, i) => ({ title: `T${i}`, embedding: [i, i] }));
}

function makeRepo(items: IdeaForClustering[]) {
  return {
    getIdeasForClustering: jest.fn().mockResolvedValue(items),
  } as unknown as jest.Mocked<ContentRepository>;
}

describe("getClusteredTitles — repository delegation", () => {
  it("calls repo.getIdeasForClustering exactly once, scoped to the requesting user", async () => {
    const repo = makeRepo([]);

    await getClusteredTitles("user-1", repo);

    expect(repo.getIdeasForClustering).toHaveBeenCalledTimes(1);
    expect(repo.getIdeasForClustering).toHaveBeenCalledWith("user-1");
  });

  it("does not re-filter or re-cap what the repository returns — it trusts the repo's query", async () => {
    // If the repository ever returned more than 200 (or an archived) item, this
    // function performs no independent guard of its own — it clusters over
    // exactly what it was given. That is the current, intended division of
    // labor (query-level filtering), not a bug in this function; it does mean
    // the 200-cap and archived-filter are only as safe as every caller of
    // getIdeasForClustering.
    const items = buildItems(3);
    const repo = makeRepo(items);
    mockKmeans.mockReturnValue({ clusters: [0, 0, 0] });

    const result = await getClusteredTitles("user-1", repo);

    // n=3 > k=1 (min(8, ceil(3/20))=1), so clustering runs on all 3 untouched.
    expect(mockKmeans).toHaveBeenCalledWith(
      [[0, 0], [1, 1], [2, 2]],
      1,
      {}
    );
    expect(result.flat().sort()).toEqual(["T0", "T1", "T2"]);
  });
});

describe("getClusteredTitles — skip-clustering guard (titles.length <= k)", () => {
  it.each([0, 1])(
    "returns all titles as a single cluster and never calls kmeans when n=%i",
    async (n) => {
      const items = buildItems(n);
      const repo = makeRepo(items);

      const result = await getClusteredTitles("user-1", repo);

      expect(mockKmeans).not.toHaveBeenCalled();
      expect(result).toEqual([items.map((i) => i.title)]);
    }
  );
});

describe("getClusteredTitles — k = min(8, ceil(n/20))", () => {
  it.each([
    [2, 1],
    [20, 1],
    [21, 2],
    [160, 8],
    [161, 8], // ceil(161/20) = 9, capped at 8
    [200, 8],
  ])("n=%i clusters produce k=%i and are passed straight to kmeans", async (n, k) => {
    const items = buildItems(n);
    const repo = makeRepo(items);
    mockKmeans.mockReturnValue({ clusters: Array.from({ length: n }, (_, i) => i % k) });

    await getClusteredTitles("user-1", repo);

    expect(mockKmeans).toHaveBeenCalledWith(expect.any(Array), k, {});
  });

  it("k is never allowed above 8, even when n/20 would exceed it", async () => {
    const items = buildItems(200);
    const repo = makeRepo(items);
    mockKmeans.mockReturnValue({ clusters: Array(200).fill(0) });

    const result = await getClusteredTitles("user-1", repo);

    expect(mockKmeans).toHaveBeenCalledWith(expect.any(Array), 8, {});
    expect(result).toHaveLength(8);
  });
});

describe("getClusteredTitles — grouping and per-cluster top-10 cap", () => {
  it("groups titles by the cluster index kmeans assigned them, capped at 10 per cluster", async () => {
    // 25 items alternating cluster 0/1 — cluster 0 gets indices 0,2,4,...,24
    // (13 items), cluster 1 gets 1,3,5,...,23 (12 items). Both exceed the
    // top-10-per-cluster cap, so this also exercises that cap.
    const n = 25;
    const items = buildItems(n);
    const repo = makeRepo(items);
    mockKmeans.mockReturnValue({ clusters: Array.from({ length: n }, (_, i) => i % 2) });

    const result = await getClusteredTitles("user-1", repo);

    expect(result).toHaveLength(2); // k = min(8, ceil(25/20)) = 2
    expect(result[0]).toEqual(["T0", "T2", "T4", "T6", "T8", "T10", "T12", "T14", "T16", "T18"]);
    expect(result[1]).toEqual(["T1", "T3", "T5", "T7", "T9", "T11", "T13", "T15", "T17", "T19"]);
  });
});
