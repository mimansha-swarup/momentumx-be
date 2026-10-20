import fs from "fs";
import path from "path";

/**
 * `firestore.indexes.json` is a deploy artifact with a multi-hour failure mode,
 * so the rules governing it get a test rather than a paragraph.
 *
 * This project has already had one production outage from this file: a
 * collection rename left it pointing at a name that no longer existed, and
 * `/v1/ideas` returned 500 to every user until the indexes rebuilt. A missing
 * index does not fail at deploy time — it fails at RUNTIME, for the user, with
 * FAILED_PRECONDITION, and building one takes minutes to hours.
 *
 * The invariant that matters during the multi-account migration (Phase 02 → 10)
 * is COEXISTENCE: every `createdBy` index keeps a `accountId` twin and NEITHER
 * is removed until Phase 10. A search-and-replace of `createdBy` → `accountId`
 * looks like the obvious edit and is the one thing that must not happen — it
 * deletes the rollback path, so rolling the code back leaves it querying indexes
 * that no longer exist.
 */

const FILE = path.join(process.cwd(), "firestore.indexes.json");

type Field = { fieldPath: string; order?: string; arrayConfig?: string };
type Index = { collectionGroup: string; queryScope: string; fields: Field[] };
type Override = { collectionGroup: string; fieldPath: string; indexes: unknown[] };

const config: { indexes: Index[]; fieldOverrides: Override[] } = JSON.parse(
  fs.readFileSync(FILE, "utf8")
);

/**
 * An index's identity, ignoring which tenancy field it keys on.
 *
 * `queryScope` is part of the shape, not incidental: a `createdBy` twin
 * rebuilt as `COLLECTION_GROUP` would serve a different class of query than
 * its `accountId` original, and comparing field lists alone would call that
 * a match.
 */
const shapeWithout = (index: Index, tenancyField: string): string =>
  [
    index.collectionGroup,
    index.queryScope,
    index.fields
      .filter((f) => f.fieldPath !== tenancyField)
      .map((f) => `${f.fieldPath}:${f.order ?? f.arrayConfig}`)
      .join("|"),
  ].join(" ");

describe("firestore.indexes.json — the migration coexistence window", () => {
  const byTenancy = (field: string) =>
    config.indexes.filter((i) => i.fields.some((f) => f.fieldPath === field));

  it("still has every legacy createdBy index — they ARE the rollback path", () => {
    expect(byTenancy("createdBy").length).toBeGreaterThan(0);
  });

  it("pairs each accountId index with a createdBy index of the same shape", () => {
    const legacyShapes = new Set(byTenancy("createdBy").map((i) => shapeWithout(i, "createdBy")));

    // `invites` is Phase-09-new: there are no pre-migration `createdBy` documents
    // for it to coexist with, so it needs no rollback twin. The exemption is tied
    // to that REASON — asserted below — rather than being an unconditional skip
    // that would silently cover any future `invites` index shape.
    const orphans = byTenancy("accountId").filter(i => i.collectionGroup !== "invites")
      .map((i) => shapeWithout(i, "accountId"))
      .filter((shape) => !legacyShapes.has(shape));

    // An accountId index with no createdBy twin means the twin was REPLACED
    // rather than added — the exact edit that removes the rollback path.
    expect(orphans).toEqual([]);
  });

  it("justifies the invites exemption: it has no legacy createdBy shape at all", () => {
    // If an `invites` index on `createdBy` ever appears, the collection is no
    // longer purely post-migration and the exemption above stops being free.
    expect(byTenancy("createdBy").filter((i) => i.collectionGroup === "invites")).toEqual([]);
  });

  it("gives every queried legacy index an accountId twin, so Phase 06 has an index to switch to", () => {
    const newShapes = new Set(byTenancy("accountId").map((i) => shapeWithout(i, "accountId")));

    const untwinned = byTenancy("createdBy")
      .map((i) => shapeWithout(i, "createdBy"))
      .filter((shape) => !newShapes.has(shape))
      // `ideas createdBy,createdAt ASC` matches no query in the codebase: every
      // ideas query also filters `archived` and orders createdAt DESCENDING.
      // Deliberately NOT twinned; deleted in Phase 10.
      .filter((shape) => shape !== "ideas COLLECTION createdAt:ASCENDING");

    expect(untwinned).toEqual([]);
  });

  it("never keys one index on both tenancy fields", () => {
    const both = config.indexes.filter(
      (i) =>
        i.fields.some((f) => f.fieldPath === "createdBy") &&
        i.fields.some((f) => f.fieldPath === "accountId")
    );

    expect(both).toEqual([]);
  });

});

describe("firestore.indexes.json — write-cost exemptions", () => {
  const exempt = (collectionGroup: string, fieldPath: string) =>
    config.fieldOverrides.find(
      (o) => o.collectionGroup === collectionGroup && o.fieldPath === fieldPath
    );

  // Firestore auto-indexes every field including every sub-field of a map, so
  // each member's uid would become its own indexed field path — an unbounded set,
  // and pure write cost for something never queried.
  //
  // The three channel fields sit on `accounts/{id}/context/channel`, whose
  // collection group is `context`, NOT `accounts`. They were declared under
  // `accounts` — where those fields have never existed since Phase 06b moved
  // them off the account document — so all three exemptions were no-ops and the
  // 20k-character website scrape was auto-indexed on every context write. This
  // test asserted them under `accounts` too, which pinned the mistake rather
  // than catching it.
  it.each([
    ["accounts", "members"],
    ["context", "websiteContent"],
    ["context", "channelDescription"],
    ["context", "competitors"],
    ["ideas", "embedding"],
  ])("exempts %s.%s from automatic indexing", (collectionGroup, fieldPath) => {
    const override = exempt(collectionGroup, fieldPath);

    expect(override).toBeDefined();
    // An empty `indexes` array is what "exempt from all single-field indexing"
    // means to Firestore. A populated one silently re-enables the cost.
    expect(override!.indexes).toEqual([]);
  });

  /**
   * An exemption on the wrong collection group is indistinguishable from no
   * exemption — Firestore accepts it, deploys it, and indexes the field anyway.
   * Nothing above could catch that, because the file was only ever checked
   * against itself.
   *
   * So: the channel context lives in the `context` subcollection, and no field
   * it declares may be exempted under `accounts`. Reading the field list from
   * the type means moving a field between the two documents fails here rather
   * than silently un-exempting it.
   */
  it("never exempts a channel-context field under the accounts group", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "types", "routes", "account.ts"),
      "utf8"
    );
    const body = source.slice(source.indexOf("interface IChannelContext"));
    const contextFields = new Set(
      [...body.slice(0, body.indexOf("\n}")).matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1])
    );

    expect(contextFields.size).toBeGreaterThan(5);

    const misplaced = config.fieldOverrides
      .filter((o) => o.collectionGroup === "accounts" && contextFields.has(o.fieldPath))
      .map((o) => `accounts.${o.fieldPath} (lives in accounts/{id}/context/channel)`);

    expect(misplaced).toEqual([]);
  });
});

describe("firestore.indexes.json — shape", () => {
  it("references only collections that exist", () => {
    // The last outage was a rename that left this file pointing at `topics`.
    //
    // The names are READ from the enum, not restated here. A hand-copied list
    // would be a third copy of the collection names, drifting silently — which is
    // the same class of bug this test exists to catch. `const enum` is erased at
    // compile time and cannot be enumerated at runtime, so parse the source, the
    // way the auth/validation ratchets do.
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "constants", "collection.ts"),
      "utf8"
    );
    const declared = new Set(
      [...source.matchAll(/=\s*"([^"]+)"/g)].map((m) => m[1])
    );

    expect(declared.size).toBeGreaterThan(5); // the parse still works

    const unknown = [...new Set(config.indexes.map((i) => i.collectionGroup))].filter(
      (g) => !declared.has(g)
    );

    expect(unknown).toEqual([]);
  });
});
