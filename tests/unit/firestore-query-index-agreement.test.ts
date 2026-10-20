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
 * no detector anywhere. It is not a hypothetical: the sibling suite's own
 * docstring recounts `/v1/ideas` 500ing for every user and taking hours to
 * rebuild. It happened again, by hand, in `sharing.repository.ts`: three
 * equality filters (`accountId`, `email`, `status`) with only 2-field indexes
 * deployed for any pair of them — caught by eye, not by this file, because this
 * file never drove `invites` at all and only ever index-checked a query that
 * ALSO sorted.
 *
 * HOW THE QUERIES GET HERE, AND WHY THAT CHANGED. This file used to declare the
 * queries by hand and cross-check the declaration by counting literal
 * `.orderBy("field")` calls in the repositories. Two holes followed from that:
 *
 *   1. Only the ORDERING was ever compared against the source. Change an equality
 *      filter — `where("archived")` → `where("isScriptGenerated")`, or drop one —
 *      and the ordering is untouched, so the count matched, the declaration was
 *      believed, and the index it claimed to have verified no longer serves the
 *      query the code sends.
 *   2. The index matcher compared field PATHS and ignored `order`. An index whose
 *      sort field is ASCENDING does not serve a `desc` query, and every list
 *      endpoint in this app sorts descending.
 *
 * Both are fixed by not hand-parsing: the repositories are RUN against a
 * recording Firestore double, so `equality`, `range`, `orderBy` and direction are
 * whatever the code really sends. The declaration below stays — as the pinned
 * expectation of that recording, which is what makes adding or changing a query a
 * deliberate two-file act — but it is now compared against the full shape, not
 * the sort field.
 *
 * A composite index is required whenever a query touches MORE THAN ONE distinct
 * field across its equality filters, its range/inequality filter (if any) and
 * its `orderBy` clauses — sorted or not. A query touching exactly one field is
 * served by the automatic single-field index, which is why `findByIdeaId`,
 * `getActiveBatch`, `countForAccount` and friends need nothing, and why an
 * equality-only query that GAINS a second filter or an ordering immediately
 * demands one.
 */

import fs from "fs";
import path from "path";

type Order = { field: string; dir: "asc" | "desc" };
type Range = { field: string; op: string };
type Recorded = { collection: string; equality: string[]; range?: Range; orders: Order[] };

const recorded: Recorded[] = [];

/**
 * Doc paths seeded for the two transactional `invites` queries below, which sit
 * behind an account-membership / owner check that a blank "doesn't exist" doc
 * can't clear. Keyed `"<collection>/<id>"`. Nothing else in this file reads from
 * Firestore, so an empty map is the correct default for every other query.
 */
const seeded = new Map<string, Record<string, unknown>>();

/**
 * A Firestore double that answers nothing (beyond what's seeded) and remembers
 * every query.
 *
 * Deliberately NOT `tests/helpers/fake-firestore`: that fake exists to evaluate
 * filters against seeded documents, and says in its own docstring that it knows
 * nothing about indexes. This one is the opposite — it keeps almost no data and
 * records the query, which is the only thing an index question is about. The
 * `seeded` doc lookups exist only to clear the membership/owner guards that gate
 * two of the `invites` queries; they do not make this a second `fake-firestore`.
 */
const recordingDb = () => {
  const query = (collection: string, state: Recorded): Record<string, unknown> => {
    const advance = (patch: Partial<Recorded>): Record<string, unknown> =>
      query(collection, {
        ...state,
        ...patch,
        equality: [...state.equality, ...(patch.equality ?? [])],
        orders: [...state.orders, ...(patch.orders ?? [])],
      });
    const fieldName = (field: unknown) =>
      typeof field === "string" ? field : "__name__";
    return {
      where: (field: unknown, op: string, _value: unknown) =>
        // Only an equality filter takes an index prefix slot alongside the
        // others; a range/inequality filter is recorded separately (below)
        // because it plays by different index rules (see `coveringIndex`).
        // array-contains would change the rules again, and nothing here uses it.
        op === "=="
          ? advance({ equality: [fieldName(field)] })
          : advance({ range: { field: fieldName(field), op } }),
      orderBy: (field: unknown, dir: "asc" | "desc" = "asc") =>
        advance({ orders: [{ field: fieldName(field), dir }] }),
      limit: () => advance({}),
      select: () => advance({}),
      startAt: () => advance({}),
      startAfter: () => advance({}),
      endAt: () => advance({}),
      endBefore: () => advance({}),
      doc: (id?: string) => docRef(collection, id ?? "auto"),
      get: async () => {
        recorded.push(state);
        return { empty: true, size: 0, docs: [] };
      },
    };
  };
  const docRef = (collection: string, id: string) => ({
    id,
    collection: (name: string): Record<string, unknown> => query(`${collection}/${id}/${name}`, { collection: `${collection}/${id}/${name}`, equality: [], orders: [] }),
    get: async () => {
      const data = seeded.get(`${collection}/${id}`);
      return { exists: data !== undefined, id, data: () => data };
    },
    update: () => undefined,
    set: () => undefined,
  });
  const tx = {
    get: (ref: { get: () => Promise<unknown> }) => ref.get(),
    update: () => undefined,
    set: () => undefined,
    create: () => undefined,
    delete: () => undefined,
  };
  return {
    collection: (name: string) => query(name, { collection: name, equality: [], orders: [] }),
    batch: () => ({ delete: () => undefined, commit: async () => undefined }),
    // `sharing.repository.ts` runs every write inside a transaction. The fake
    // just invokes the callback with the same recording `tx` every time — there
    // is nothing here to roll back, only queries to remember.
    runTransaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
};

const db = recordingDb();

jest.mock("../../src/config/firebase", () => ({
  db,
  auth: {},
  firebase: {
    firestore: {
      FieldValue: { serverTimestamp: () => "ts" },
      FieldPath: { documentId: () => ({ __name__: true }) },
      Timestamp: { fromDate: (d: Date) => d },
    },
  },
}));

import ContentRepository from "../../src/repository/content.repository";
import PackagingRepository from "../../src/repository/packaging.repository";
import VideoProjectRepository from "../../src/repository/video-project.repository";
import SharingRepository from "../../src/repository/sharing.repository";

const ACCOUNT = "acc-1";

/** A minimal live `accounts/{id}` doc where `uid` is the sole owner. */
const ownerAccount = (uid: string, extraMembers: Record<string, { role: string }> = {}) => ({
  memberUids: [uid, ...Object.keys(extraMembers)],
  members: { [uid]: { role: "owner" }, ...extraMembers },
  billingOwnerUid: uid,
  displayName: "Test Channel",
});

/**
 * Every query in the repositories that needs 2+ index slots, declared — and
 * DRIVEN, so the declaration is checked against what the code sends rather than
 * trusted. Applies equally to a query that sorts and one that doesn't: both need
 * a composite index once they touch more than one field.
 *
 * `orderBy` carries direction because an ASCENDING index does not serve a `desc`
 * query, `range` is recorded separately because a range/inequality filter
 * follows different index-slot rules than equality, and `equality` is compared
 * for real — so swapping or dropping a filter fails here instead of silently
 * invalidating the index this file blesses.
 */
const QUERIES: {
  where: string;
  collection: string;
  equality: string[];
  range?: Range;
  orderBy: Order[];
  drive: () => Promise<unknown>;
}[] = [
  {
    where: "content.repository.ts → getIdeas (default branch)",
    collection: "ideas",
    equality: ["accountId", "archived"],
    orderBy: [
      { field: "createdAt", dir: "desc" },
      { field: "__name__", dir: "desc" },
    ],
    drive: () => new ContentRepository().getIdeas({ accountId: ACCOUNT, filters: {} } as never),
  },
  {
    where: "content.repository.ts → getIdeas (+ isScriptGenerated filter)",
    collection: "ideas",
    equality: ["accountId", "archived", "isScriptGenerated"],
    orderBy: [
      { field: "createdAt", dir: "desc" },
      { field: "__name__", dir: "desc" },
    ],
    drive: () =>
      new ContentRepository().getIdeas({
        accountId: ACCOUNT,
        filters: { isScriptGenerated: true },
      } as never),
  },
  {
    where: "content.repository.ts → getIdeas (search branch)",
    collection: "ideas",
    equality: ["accountId", "archived"],
    range: { field: "title", op: "<=" },
    // Ascending, and the docId tie-break with it: `startAfter(title, docId)` is
    // the prefix-search cursor, and it only pages correctly on this ordering.
    orderBy: [
      { field: "title", dir: "asc" },
      { field: "__name__", dir: "asc" },
    ],
    drive: () =>
      new ContentRepository().getIdeas({
        accountId: ACCOUNT,
        filters: { searchText: "cook" },
      } as never),
  },
  {
    where: "content.repository.ts → getIdeas (search + isScriptGenerated)",
    collection: "ideas",
    equality: ["accountId", "archived", "isScriptGenerated"],
    range: { field: "title", op: "<=" },
    orderBy: [
      { field: "title", dir: "asc" },
      { field: "__name__", dir: "asc" },
    ],
    drive: () =>
      new ContentRepository().getIdeas({
        accountId: ACCOUNT,
        filters: { searchText: "cook", isScriptGenerated: false },
      } as never),
  },
  {
    where: "content.repository.ts → getScripts",
    collection: "scripts",
    equality: ["accountId"],
    orderBy: [{ field: "createdAt", dir: "desc" }],
    drive: () => new ContentRepository().getScripts(ACCOUNT),
  },
  {
    where: "packaging.repository.ts → getByAccountId",
    collection: "packaging",
    equality: ["accountId"],
    orderBy: [{ field: "createdAt", dir: "desc" }],
    drive: () => new PackagingRepository().getByAccountId(ACCOUNT),
  },
  {
    where: "video-project.repository.ts → list",
    collection: "videoProjects",
    equality: ["accountId", "isDeleted"],
    orderBy: [
      { field: "updatedAt", dir: "desc" },
      { field: "__name__", dir: "desc" },
    ],
    drive: () => new VideoProjectRepository().list(ACCOUNT, { limit: 20 }),
  },
  {
    where: "video-project.repository.ts → list (+ status filter)",
    collection: "videoProjects",
    equality: ["accountId", "isDeleted", "overallStatus"],
    orderBy: [
      { field: "updatedAt", dir: "desc" },
      { field: "__name__", dir: "desc" },
    ],
    drive: () =>
      new VideoProjectRepository().list(ACCOUNT, { limit: 20, status: "completed" }),
  },
  {
    where: "content.repository.ts → getIdeasForClustering",
    collection: "ideas",
    equality: ["accountId", "archived"],
    orderBy: [],
    drive: () => new ContentRepository().getIdeasForClustering(ACCOUNT),
  },
  {
    // ~line 207. Bounded inbox read: two equality filters plus a range filter on
    // expiry, no explicit order — Firestore sorts ascending by the range field
    // by default.
    where: "sharing.repository.ts → pending",
    collection: "invites",
    equality: ["email", "status"],
    range: { field: "expiresAt", op: ">" },
    orderBy: [],
    drive: () => new SharingRepository().pending("owner@example.com", true),
  },
  {
    // ~line 219. Same shape as `pending`, scoped to a channel instead of an
    // inbox. Gated by an owner-only membership check on the account doc.
    where: "sharing.repository.ts → list",
    collection: "invites",
    equality: ["accountId", "status"],
    range: { field: "expiresAt", op: ">" },
    orderBy: [],
    drive: () => {
      seeded.set("accounts/acc-list", ownerAccount("owner-1"));
      return new SharingRepository().list("acc-list", "owner-1");
    },
  },
  {
    // ~line 165, inside `create`'s transaction: the one-live-invite-per-address
    // supersede check. Three equality filters, no range, no order — the exact
    // shape that shipped with only 2-field indexes deployed for any pair of
    // its fields (verified against live Firestore) and would have 500'd on
    // first use.
    where: "sharing.repository.ts → create (supersede check)",
    collection: "invites",
    equality: ["accountId", "email", "status"],
    orderBy: [],
    drive: () => {
      seeded.set("accounts/acc-create", ownerAccount("owner-2"));
      return new SharingRepository().create("acc-create", "owner-2", "new-member@example.com", "editor");
    },
  },
  {
    // ~line 74, inside `change`'s transaction: revoking a member's outstanding
    // invites on every membership edit. Same 3-equality shape as the supersede
    // check above, from a different call site — both need the same index, and
    // both are driven because a shared private helper is invisible to a check
    // that only ever calls the public method it happens to be reached from.
    where: "sharing.repository.ts → change (revokePendingInvites)",
    collection: "invites",
    equality: ["accountId", "email", "status"],
    orderBy: [],
    drive: () => {
      seeded.set("accounts/acc-change", ownerAccount("owner-3", { "member-1": { role: "editor" } }));
      seeded.set("users/member-1", { email: "member@example.com" });
      return new SharingRepository().change("acc-change", "owner-3", "member-1", "viewer");
    },
  },
];

type IndexField = { fieldPath: string; order?: string; arrayConfig?: string };

const config = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "firestore.indexes.json"), "utf8")
) as {
  indexes: { collectionGroup: string; queryScope: string; fields: IndexField[] }[];
};

const DIR: Record<string, string> = { asc: "ASCENDING", desc: "DESCENDING" };

/**
 * Does any declared index serve this query?
 *
 * Firestore's rules, cited from "Order and limit data with Cloud Firestore"
 * (firebase.google.com/docs/firestore/query-data/order-limit-data) and "Index
 * a query that uses a range or inequality filter" — the two hold together:
 *
 *   - Equality-filter fields are a CONTIGUOUS PREFIX, in any order among
 *     themselves (their own index direction is irrelevant to an `==` filter).
 *   - A range/inequality filter's field comes immediately after that prefix,
 *     and doubles as the query's own FIRST ordering: the client SDK requires
 *     any explicit `orderBy()` to start with that same field ("if you have a
 *     range filter... your first orderBy() clause must be on the same field"),
 *     and the server defaults to ASCENDING on it when the query names no
 *     explicit order at all.
 *   - Whatever ordered fields remain follow, in order, WITH MATCHING DIRECTION
 *     — an ASCENDING index does not serve a `desc` query.
 *   - A composite index implicitly ends with `__name__ ASCENDING`. An index
 *     that declares no `__name__` still serves a query whose document-id
 *     tie-break is ascending, while a `desc` tie-break has to be declared.
 *   - A query that names NO ordering at all (no range, no orderBy) is served
 *     by any index whose declared fields start with its equality prefix,
 *     REGARDLESS of what follows in that index. This is the same leftmost-
 *     prefix rule every B-tree composite index gets its efficiency from: an
 *     equality-only seek on the first N columns doesn't care what's indexed
 *     after them, because the query never asked for a particular order among
 *     the matches. This is what lets `getIdeasForClustering`'s two-equality,
 *     unordered read share the four-field `ideas` index instead of needing a
 *     bespoke one — and it does NOT apply once the query itself specifies any
 *     ordering, where the match stays exact (see the next point).
 *
 * Every query recorded here comes from `db.collection(...)`, never
 * `db.collectionGroup(...)`, so only a `COLLECTION`-scoped index can serve it —
 * a `COLLECTION_GROUP` index answers a collection-group query, not this one,
 * even when its field list is identical. And whenever the query DOES specify an
 * ordering (an explicit `orderBy`, or an implicit one via a range filter with no
 * explicit order), an index with unexplained EXTRA trailing fields is rejected —
 * that strictness is deliberate, because a wrong trailing field there really is
 * a different query shape, unlike the no-ordering-at-all case above.
 *
 * A field's MODE matters as much as its name: `arrayConfig` (array-contains)
 * and `order` (equality/range/sort) are different capabilities on the same
 * fieldPath. An equality, range or orderBy field that lands on an `arrayConfig`
 * slot is not served by it — and a missing `order` is exactly that case, never
 * a silent ASCENDING default.
 */
const coveringIndex = (query: { collection: string; equality: string[]; range?: Range; orderBy: Order[] }) =>
  config.indexes.find((index) => {
    if (index.collectionGroup !== query.collection) return false;
    if (index.queryScope !== "COLLECTION") return false;

    const prefix = index.fields.slice(0, query.equality.length);
    if (prefix.length !== query.equality.length) return false;
    if (
      !query.equality.every((field) =>
        prefix.some((f) => f.fieldPath === field && f.order !== undefined)
      )
    )
      return false;

    let cursor = query.equality.length;
    let explicit = query.orderBy.filter((o) => o.field !== "__name__");
    const byName = query.orderBy.find((o) => o.field === "__name__");

    if (query.range) {
      const field = index.fields[cursor];
      if (!field || field.fieldPath !== query.range.field || field.order === undefined) return false;
      const rangeDir: "asc" | "desc" = field.order === "DESCENDING" ? "desc" : "asc";
      if (explicit.length > 0) {
        // The range field IS the query's first explicit ordering (SDK-enforced).
        if (explicit[0].field !== query.range.field || explicit[0].dir !== rangeDir) return false;
        explicit = explicit.slice(1);
      } else if (rangeDir !== "asc") {
        return false; // no explicit order on it → Firestore implies ASCENDING
      }
      cursor += 1;
    }

    const tail = index.fields.slice(cursor);

    // No ordering asked for at all (beyond a range filter's own implicit one,
    // already validated above): a leftmost-prefix match is enough, whatever
    // follows in the index.
    if (explicit.length === 0 && !byName) return true;

    if (tail.length < explicit.length) return false;
    for (let i = 0; i < explicit.length; i++) {
      if (tail[i].fieldPath !== explicit[i].field) return false;
      if (tail[i].order === undefined) return false;
      if (tail[i].order !== DIR[explicit[i].dir]) return false;
    }

    const rest = tail.slice(explicit.length);
    // Nothing declared after the sort: the implicit `__name__ ASCENDING`.
    if (rest.length === 0) return !byName || DIR[byName.dir] === "ASCENDING";
    if (rest.length === 1 && rest[0].fieldPath === "__name__") {
      return !byName || (rest[0].order ?? "ASCENDING") === DIR[byName.dir];
    }
    // Any other trailing field means this index is for a different query.
    return false;
  });

const describeQuery = (q: { collection: string; equality: string[]; range?: Range; orders?: Order[]; orderBy?: Order[] }) =>
  `${q.collection}: where(${[...q.equality].sort().join(", ")}${q.range ? `${q.equality.length ? ", " : ""}${q.range.field} ${q.range.op}` : ""})` +
  ` orderBy(${(q.orders ?? q.orderBy ?? []).map((o) => `${o.field} ${o.dir}`).join(", ") || "—"})`;

describe("every query with 2+ index slots has an index Firestore will accept", () => {
  /**
   * Each case RUNS its query and checks the index against what was recorded —
   * never against the declaration alone. Driving it is the whole point: a
   * hand-written inventory that nothing compares to the code is a second opinion,
   * not a check. Applies to a query that sorts and one that only filters — the
   * distinction that used to matter here (only sorted queries were checked) is
   * exactly the gap that let the `invites` 3-equality shape ship unindexed.
   */
  it.each(QUERIES.map((q) => [q.where, q] as const))("%s", async (_label, query) => {
    recorded.length = 0;

    await query.drive();

    // One query per driver: an extra `get()` is a second query nothing has
    // declared and nothing has index-checked.
    expect(recorded).toHaveLength(1);
    // The declaration is honest about what the code sends…
    expect(describeQuery(recorded[0])).toBe(describeQuery(query));

    const sent = { ...recorded[0], orderBy: recorded[0].orders };
    const fieldsTouched = new Set<string>([
      ...sent.equality,
      ...(sent.range ? [sent.range.field] : []),
      ...sent.orderBy.filter((o) => o.field !== "__name__").map((o) => o.field),
    ]);
    // A single field is served by Firestore's automatic per-field index —
    // there is no composite index to look for, and none should exist for it.
    if (fieldsTouched.size <= 1) return;

    // …and the index serves the RECORDED query, filters, direction and all.
    expect(
      coveringIndex(sent) ? "indexed" : `NO INDEX IN firestore.indexes.json FOR ${describeQuery(sent)}`
    ).toBe("indexed");
  });

  /**
   * The driven list cannot go stale.
   *
   * `orderBy` with a string literal is the exact thing that needs a composite
   * index when combined with a filter; `orderBy(FieldPath.documentId())` is the
   * `__name__` tie-break that rides along on the same index. A chained
   * `.where(...).where(...)` needs one whether or not it sorts (Hole 1 — see
   * file docstring). So: count the literal `orderBy` sites and require this file
   * to account for all of them, find every FILE that issues a multi-`.where()`
   * query, and require both kinds of file to be one this file DRIVES — either
   * one added to an undriven repository is invisible to the recording above,
   * which is exactly how the `invites` gap survived.
   */
  it("accounts for every literal orderBy and every multi-filter query in the repositories", () => {
    const REPO_DIR = path.join(process.cwd(), "src", "repository");
    const stripComments = (source: string): string =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");

    const found: string[] = [];
    const sortingFiles = new Set<string>();
    const multiFilterFiles = new Set<string>();
    for (const file of fs.readdirSync(REPO_DIR).filter((f) => f.endsWith(".ts"))) {
      const source = stripComments(fs.readFileSync(path.join(REPO_DIR, file), "utf8"));
      for (const match of source.matchAll(/\.orderBy\(\s*["'`](\w+)["'`]/g)) {
        found.push(`${file}:${match[1]}`);
        sortingFiles.add(file);
      }
      // Two (or more) `.where()` calls chained directly onto each other. Loose
      // on purpose — it only needs to flag that the FILE has a multi-filter
      // query somewhere, not parse which one, and it survives a value argument
      // with its own parens (e.g. `.where("email", "==", email.toLowerCase())`)
      // because the match only needs the FIRST `.where(...)` in the pair to
      // close before the next `.where(` starts.
      if (/\.where\([^)]*\)\s*\.where\(/.test(source)) multiFilterFiles.add(file);
    }

    const driven = new Set(QUERIES.map((q) => q.where.split(" ")[0]));
    expect([...sortingFiles].filter((file) => !driven.has(file))).toEqual([]);
    expect([...multiFilterFiles].filter((file) => !driven.has(file))).toEqual([]);

    // Five literal sites, not eight: `getIdeas` builds its branches from one
    // `.orderBy` per ordering, and the four ideas rows above are the FILTER
    // COMBINATIONS over those two orderings. Pinned as a number so that ADDING a
    // sorted query fails here even when its (file, field) pair already appears —
    // say `where(accountId).where(videoProjectId).orderBy(createdAt)` in
    // `content.repository.ts`, which no existing index serves. Firestore answers
    // FAILED_PRECONDITION for every user on that endpoint, which is the outage
    // this file exists for. `sharing.repository.ts`'s four multi-filter queries
    // add nothing here — none of them call `.orderBy()` — which is exactly why
    // the `multiFilterFiles` guard above exists as a second, independent count.
    expect(found.length).toBe(5);
  });
});
