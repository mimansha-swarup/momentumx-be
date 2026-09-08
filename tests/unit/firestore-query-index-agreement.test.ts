/**
 * Do the queries the code actually runs have indexes?
 *
 * `firestore-indexes.behaviour.test.ts` validates `firestore.indexes.json`
 * against ITSELF — createdBy/accountId twinning, no dual-keyed index, the field
 * exemptions. It never opens a file in `src/repository`. And the in-memory fake
 * says so outright: "knows nothing about indexes, so it cannot tell you a
 * composite index is missing."
 *
 * So the one failure mode the index file exists to prevent — a query Firestore
 * rejects with FAILED_PRECONDITION, in production, for every user at once — had
 * no detector anywhere in 995 tests. It is not a hypothetical: the sibling
 * suite's own docstring recounts `/v1/ideas` 500ing for every user and taking
 * hours to rebuild.
 *
 * A composite index is required when a query combines equality filters with an
 * `orderBy` on a different field. Equality-only queries are served by the
 * automatic single-field indexes, which is why `findByIdeaId`, `getActiveBatch`,
 * `countForAccount` and friends are absent below and correctly need nothing.
 */

import fs from "fs";
import path from "path";

const REPO_DIR = path.join(process.cwd(), "src", "repository");
const config = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "firestore.indexes.json"), "utf8")
) as { indexes: { collectionGroup: string; fields: { fieldPath: string; order?: string }[] }[] };

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

/**
 * Every sorted query in the repositories, declared.
 *
 * Hand-written on purpose. Reconstructing a query from source means following
 * `let query = ...; query = query.where(...)` across branches, and a regex that
 * silently mis-parses one chain would report "all indexed" while missing the
 * one that matters. Declaring them makes adding a sorted query a deliberate,
 * two-file act — and the count check below makes it impossible to add one and
 * forget this list.
 */
const SORTED_QUERIES: {
  where: string;
  collection: string;
  equality: string[];
  orderBy: string;
}[] = [
  {
    where: "content.repository.ts → getIdeas (default branch)",
    collection: "ideas",
    equality: ["accountId", "archived"],
    orderBy: "createdAt",
  },
  {
    where: "content.repository.ts → getIdeas (+ isScriptGenerated filter)",
    collection: "ideas",
    equality: ["accountId", "archived", "isScriptGenerated"],
    orderBy: "createdAt",
  },
  {
    where: "content.repository.ts → getIdeas (search branch)",
    collection: "ideas",
    equality: ["accountId", "archived"],
    orderBy: "title",
  },
  {
    where: "content.repository.ts → getIdeas (search + isScriptGenerated)",
    collection: "ideas",
    equality: ["accountId", "archived", "isScriptGenerated"],
    orderBy: "title",
  },
  {
    where: "content.repository.ts → getScripts",
    collection: "scripts",
    equality: ["accountId"],
    orderBy: "createdAt",
  },
  {
    where: "packaging.repository.ts → getByAccountId",
    collection: "packaging",
    equality: ["accountId"],
    orderBy: "createdAt",
  },
  {
    where: "video-project.repository.ts → list",
    collection: "videoProjects",
    equality: ["accountId", "isDeleted"],
    orderBy: "updatedAt",
  },
  {
    where: "video-project.repository.ts → list (+ status filter)",
    collection: "videoProjects",
    equality: ["accountId", "isDeleted", "overallStatus"],
    orderBy: "updatedAt",
  },
];

/**
 * How many literal `.orderBy("field")` calls exist across the repositories.
 *
 * Five, not eight: `getIdeas` builds its branches from one `.orderBy` per
 * ordering, and the four ideas rows above are the *filter combinations* over
 * those two orderings. Pinned as a number so that ADDING a sorted query fails
 * here even when its (file, field) pair already appears — which is the case the
 * set comparison alone cannot see.
 */
const EXPECTED_ORDERBY_SITES = 5;

describe("every sorted query has an index Firestore will accept", () => {
  it.each(SORTED_QUERIES.map((q) => [q.where, q] as const))("%s", (_label, query) => {
    const covered = config.indexes.some((index) => {
      if (index.collectionGroup !== query.collection) return false;

      const paths = index.fields.map((f) => f.fieldPath);
      // Equality fields may appear in any order — Firestore does not care, and
      // the declaration order in the file is a style choice.
      // The equality fields must be a CONTIGUOUS PREFIX, then the sort field.
      // Merely "all present, sort somewhere after" accepts
      // [accountId, archived, somethingElse, createdAt], which Firestore will
      // NOT use to serve where(accountId).where(archived).orderBy(createdAt).
      const prefix = paths.slice(0, query.equality.length);
      const equalityIsPrefix =
        prefix.length === query.equality.length &&
        query.equality.every((field) => prefix.includes(field));

      return equalityIsPrefix && paths[query.equality.length] === query.orderBy;
    });

    expect(covered).toBe(true);
  });

  /**
   * The list above cannot be allowed to go stale.
   *
   * `orderBy` with a string literal is the exact thing that needs a composite
   * index; `orderBy(FieldPath.documentId())` is the implicit `__name__` tie-break
   * that rides along on the same index and needs no declaration. So: count the
   * literal ones in the repositories and require the list to account for all of
   * them. Adding a sorted query without touching this file fails here.
   */
  it("accounts for every literal orderBy in the repositories", () => {
    const found: string[] = [];

    for (const file of fs.readdirSync(REPO_DIR).filter((f) => f.endsWith(".ts"))) {
      const source = stripComments(fs.readFileSync(path.join(REPO_DIR, file), "utf8"));
      for (const match of source.matchAll(/\.orderBy\(\s*["'`](\w+)["'`]/g)) {
        found.push(`${file}:${match[1]}`);
      }
    }

    // Distinct (file, field) pairs — `getIdeas` sorts by `createdAt` in one
    // branch and `title` in another, and the four ideas entries above collapse
    // to those two pairs.
    const declared = new Set(
      SORTED_QUERIES.map((q) => `${q.where.split(" ")[0]}:${q.orderBy}`)
    );

    expect([...new Set(found)].sort()).toEqual([...declared].sort());

    // …and the COUNT, because the set above collapses duplicates. A second
    // `createdAt`-sorted query added to `content.repository.ts` — say
    // `where(accountId).where(videoProjectId).orderBy(createdAt)` — produces a
    // pair that is already in `declared`, so the set comparison passes while no
    // index exists for that shape. Firestore answers FAILED_PRECONDITION for
    // every user on that endpoint, which is the outage this file exists for.
    expect(found.length).toBe(EXPECTED_ORDERBY_SITES);
  });
});
