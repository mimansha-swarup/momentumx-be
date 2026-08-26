// Phase 05a re-key, tested against the shape that loses data.
//
// The whole risk is one case: a project with BOTH a legacy auto-ID save document
// AND a deterministic persist-on-generate document. `upsertGeneratedItem` has
// always keyed on videoProjectId while the save path minted auto-IDs, so this is
// not hypothetical — it is what any project that was both generated and edited
// looks like. "Just re-key it" writes one over the other and silently destroys
// half of a package the user considers finished.
//
// So most of this file is about the merge, not about the paging.

// The module reaches for a real Firestore client at import time. `mergePackaging`
// is pure, but it does not get to be tested without this.
jest.mock("firebase-admin/firestore", () => ({ FieldPath: { documentId: () => "__name__" } }));
jest.mock("../../../src/config/firebase", () => ({
  db: { collection: jest.fn(), batch: jest.fn() },
  firebase: { firestore: { FieldValue: { serverTimestamp: () => "server-ts" } } },
}));

import { mergePackaging } from "../../../src/scripts/rekey-packaging";

const legacyDoc = (over: Record<string, unknown> = {}) => ({
  id: "auto-abc",
  videoProjectId: "proj-1",
  createdBy: "uid-1",
  titles: [{ title: "Edited by hand", characterCount: 14 }],
  description: "The user's edited description.",
  updatedAt: 2000,
  ...over,
});

const generatedDoc = (over: Record<string, unknown> = {}) => ({
  id: "proj-1",
  videoProjectId: "proj-1",
  createdBy: "uid-1",
  thumbnail: ["A generated brief"],
  shorts: { segments: [{ content: "Hook" }] },
  updatedAt: 1000,
  ...over,
});

describe("merging a legacy document onto the deterministic one", () => {
  it("keeps BOTH halves — the edited text and the generated items", () => {
    // The case the phase exists for. Losing either half is invisible until the
    // user opens the project and finds their work gone.
    const { merged } = mergePackaging(legacyDoc(), generatedDoc());

    expect(merged.description).toBe("The user's edited description.");
    expect(merged.titles).toEqual([{ title: "Edited by hand", characterCount: 14 }]);
    expect(merged.thumbnail).toEqual(["A generated brief"]);
    expect(merged.shorts).toEqual({ segments: [{ content: "Hook" }] });
  });

  it("does not report a collision when only one side holds a field", () => {
    // Complementary halves are the NORMAL case. Calling it a collision would bury
    // the real ones in noise and stall the delete commit forever.
    const { collisions } = mergePackaging(legacyDoc(), generatedDoc());

    expect(collisions).toEqual([]);
  });

  it("reports a collision when both sides hold DIFFERENT values", () => {
    const { collisions } = mergePackaging(
      legacyDoc({ description: "From the save path" }),
      generatedDoc({ description: "From generation" })
    );

    expect(collisions).toEqual(["description"]);
  });

  it("resolves a collision toward the newer updatedAt", () => {
    const newerLegacy = mergePackaging(
      legacyDoc({ description: "newer", updatedAt: 5000 }),
      generatedDoc({ description: "older", updatedAt: 1000 })
    );
    const newerTarget = mergePackaging(
      legacyDoc({ description: "older", updatedAt: 1000 }),
      generatedDoc({ description: "newer", updatedAt: 5000 })
    );

    expect(newerLegacy.merged.description).toBe("newer");
    expect(newerTarget.merged.description).toBe("newer");
  });

  it("is not fooled by identical values on both sides", () => {
    const { collisions } = mergePackaging(
      legacyDoc({ description: "same" }),
      generatedDoc({ description: "same" })
    );

    expect(collisions).toEqual([]);
  });

  it("treats an empty array as absent, not as a value worth preserving", () => {
    // A blank `thumbnail: []` on the legacy doc must not overwrite a real brief.
    const { merged, collisions } = mergePackaging(
      legacyDoc({ thumbnail: [] }),
      generatedDoc({ thumbnail: ["A generated brief"] })
    );

    expect(merged.thumbnail).toEqual(["A generated brief"]);
    expect(collisions).toEqual([]);
  });

  it("never lets stale state be quietly cleared by the merge", () => {
    // isStale rides with the content. A merge that dropped it would un-stale a
    // package nothing had regenerated — the same class of bug as a plain re-save
    // clearing stale flags.
    const { merged } = mergePackaging(
      legacyDoc({ isStale: true, staleReason: "hooks_regenerated", updatedAt: 9000 }),
      generatedDoc()
    );

    expect(merged.isStale).toBe(true);
    expect(merged.staleReason).toBe("hooks_regenerated");
  });

  it("takes the legacy document wholesale when there is nothing to merge with", () => {
    const { merged, collisions } = mergePackaging(legacyDoc(), null);

    expect(merged).toMatchObject({ videoProjectId: "proj-1", description: "The user's edited description." });
    expect(collisions).toEqual([]);
  });

  it("handles Firestore Timestamps, not just numbers, when comparing recency", () => {
    // updatedAt is a Timestamp in production and a number in most fixtures.
    // Comparing them raw would make every real document look equally old, so
    // every collision would silently resolve the same way.
    const ts = (ms: number) => ({ toMillis: () => ms });
    const { merged } = mergePackaging(
      legacyDoc({ description: "newer", updatedAt: ts(5000) }),
      generatedDoc({ description: "older", updatedAt: ts(1000) })
    );

    expect(merged.description).toBe("newer");
  });
});
