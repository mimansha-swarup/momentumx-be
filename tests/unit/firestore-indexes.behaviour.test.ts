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

/** An index's identity, ignoring which tenancy field it keys on. */
const shapeWithout = (index: Index, tenancyField: string): string =>
  [
    index.collectionGroup,
    index.fields
      .filter((f) => f.fieldPath !== tenancyField)
      .map((f) => `${f.fieldPath}:${f.order ?? f.arrayConfig}`)
      .join("|"),
  ].join(" ");

const positionOf = (index: Index, fieldPath: string): number =>
  index.fields.findIndex((f) => f.fieldPath === fieldPath);

describe("firestore.indexes.json — the migration coexistence window", () => {
  const byTenancy = (field: string) =>
    config.indexes.filter((i) => i.fields.some((f) => f.fieldPath === field));

  it("still has every legacy createdBy index — they ARE the rollback path", () => {
    expect(byTenancy("createdBy").length).toBeGreaterThan(0);
  });

  it("pairs each accountId index with a createdBy index of the same shape", () => {
    const legacyShapes = new Set(byTenancy("createdBy").map((i) => shapeWithout(i, "createdBy")));

    const orphans = byTenancy("accountId")
      .map((i) => shapeWithout(i, "accountId"))
      .filter((shape) => !legacyShapes.has(shape));

    // An accountId index with no createdBy twin means the twin was REPLACED
    // rather than added — the exact edit that removes the rollback path.
    expect(orphans).toEqual([]);
  });

  it("gives every queried legacy index an accountId twin, so Phase 06 has an index to switch to", () => {
    const newShapes = new Set(byTenancy("accountId").map((i) => shapeWithout(i, "accountId")));

    const untwinned = byTenancy("createdBy")
      .map((i) => shapeWithout(i, "createdBy"))
      .filter((shape) => !newShapes.has(shape))
      // `ideas createdBy,createdAt ASC` matches no query in the codebase: every
      // ideas query also filters `archived` and orders createdAt DESCENDING.
      // Deliberately NOT twinned; deleted in Phase 10.
      .filter((shape) => shape !== "ideas createdAt:ASCENDING");

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

  it("puts the tenancy field in the same position as the field it twins", () => {
    // Equality fields must precede ordered fields; their order relative to each
    // other does not affect matching. Keeping the position identical is what
    // makes the two sets readable as pairs during the coexistence window.
    for (const index of byTenancy("accountId")) {
      const twin = byTenancy("createdBy").find(
        (i) => shapeWithout(i, "createdBy") === shapeWithout(index, "accountId")
      );
      if (!twin) continue;
      expect(positionOf(index, "accountId")).toBe(positionOf(twin, "createdBy"));
    }
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
  it.each([
    ["accounts", "members"],
    ["accounts", "websiteContent"],
    ["accounts", "channelDescription"],
    ["accounts", "competitors"],
    ["ideas", "embedding"],
  ])("exempts %s.%s from automatic indexing", (collectionGroup, fieldPath) => {
    const override = exempt(collectionGroup, fieldPath);

    expect(override).toBeDefined();
    // An empty `indexes` array is what "exempt from all single-field indexing"
    // means to Firestore. A populated one silently re-enables the cost.
    expect(override!.indexes).toEqual([]);
  });
});

describe("firestore.indexes.json — shape", () => {
  it("references only collections that exist in the enum", () => {
    // The last outage was a rename that left this file pointing at `topics`.
    const known = new Set([
      "users", "scripts", "ideas", "packaging", "videoProjects", "hooks", "events",
      "accounts", "billing", "invites", "migrations", "usage",
    ]);

    const unknown = [...new Set(config.indexes.map((i) => i.collectionGroup))].filter(
      (g) => !known.has(g)
    );

    expect(unknown).toEqual([]);
  });

  it("declares a scope and an ordering direction on every field", () => {
    for (const index of config.indexes) {
      expect(index.queryScope).toBe("COLLECTION");
      for (const field of index.fields) {
        expect(field.order ?? field.arrayConfig).toBeDefined();
      }
    }
  });
});
