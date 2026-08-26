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

// Both fixtures carry a createdAt, because both real write paths stamp one —
// packaging.repository.ts on generate, packaging.service.ts on save. The earlier
// version of this file omitted the field entirely, which is exactly why it could
// not see that `createdAt` collided on every merged pair.
const legacyDoc = (over: Record<string, unknown> = {}) => ({
  id: "auto-abc",
  videoProjectId: "proj-1",
  createdBy: "uid-1",
  titles: [{ title: "Edited by hand", characterCount: 14 }],
  description: "The user's edited description.",
  // Deliberately the LATER createdAt on the NEWER document, so "newer updatedAt
  // wins" gives the wrong answer here and the test below can see it.
  createdAt: 900,
  updatedAt: 2000,
  ...over,
});

const generatedDoc = (over: Record<string, unknown> = {}) => ({
  id: "proj-1",
  videoProjectId: "proj-1",
  createdBy: "uid-1",
  thumbnail: ["A generated brief"],
  shorts: { segments: [{ content: "Hook" }] },
  createdAt: 500,
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

  it("never reports createdAt as a collision", () => {
    // The bug that made the script unrunnable. Both documents always have a
    // createdAt and they were written at different moments, so with createdAt in
    // MERGEABLE every merged pair collided, the script exited 2, and the phase's
    // gate — "collisions must be zero or triaged" — could never clear.
    const { collisions } = mergePackaging(legacyDoc(), generatedDoc());

    expect(collisions).not.toContain("createdAt");
    expect(collisions).toEqual([]);
  });

  it("keeps the EARLIER createdAt, not the one on the newer document", () => {
    // "Newer updatedAt wins" is right for content and wrong for a creation
    // stamp. The legacy document is the newer one AND carries the later
    // createdAt, so that rule would report the package as created at 900 —
    // after the generated items it contains.
    const { merged } = mergePackaging(legacyDoc(), generatedDoc());

    expect(merged.createdAt).toBe(500);
  });

  it("advances updatedAt when the legacy half wins", () => {
    // Otherwise a document that just absorbed newer content keeps the older
    // stamp and claims to predate what it now holds.
    const { merged } = mergePackaging(legacyDoc(), generatedDoc());

    expect(merged.updatedAt).toBe(2000);
  });

  it("treats the scaffold's empty shorts object as absent, like every other empty", () => {
    // `upsertGeneratedItem` creates a document with
    // `shorts: { segments: [], totalDuration: "" }`, so generating a TITLE leaves
    // an empty shorts object on the deterministic doc. It is the only empty that
    // is an object — `titles: []`, `description: ""` and `thumbnail: []` are all
    // caught generically — so it was the only one that counted as a value,
    // collided with the legacy document's real Shorts script, and won whenever
    // the scaffold was the newer of the two.
    const { merged, collisions } = mergePackaging(
      legacyDoc({ shorts: { segments: [{ content: "Real hook" }] }, updatedAt: 1000 }),
      generatedDoc({ shorts: { segments: [], totalDuration: "" }, updatedAt: 9000 })
    );

    expect(merged.shorts).toEqual({ segments: [{ content: "Real hook" }] });
    expect(collisions).not.toContain("shorts");
  });

  it("never lets a newer scaffold mark a carried-across item not_started", () => {
    // The status map cannot be resolved wholesale by recency. Here the newer
    // document is the scaffold, so its `description: "not_started"` would win —
    // over a description this same merge just carried across from the legacy
    // half. The item then reads as ungenerated, and the user regenerates over
    // their own text.
    const { merged } = mergePackaging(
      legacyDoc({
        itemStatuses: { title: "completed", description: "completed", thumbnail: "not_started", shorts: "not_started" },
        updatedAt: 1000,
      }),
      generatedDoc({
        itemStatuses: { title: "completed", description: "not_started", thumbnail: "completed", shorts: "not_started" },
        updatedAt: 9000,
      })
    );

    expect(merged.description).toBe("The user's edited description.");
    expect(merged.itemStatuses).toEqual({
      title: "completed",
      description: "completed",
      thumbnail: "completed",
      shorts: "not_started",
    });
  });

  it.each([
    ["the legacy half is newer", 9000, 1000, "stale"],
    ["the generated half is newer", 1000, 9000, "completed"],
  ])(
    "still lets the newer document decide between two real statuses — %s",
    (_case, legacyUpdated, targetUpdated, expected) => {
      // "anything beats not_started" is the only override. A stale item versus a
      // completed one is a real disagreement, and there the newer document is
      // still the answer. BOTH directions, because a per-item rule that always
      // reached for the same side would pass a one-directional test while
      // ignoring recency entirely.
      const { merged } = mergePackaging(
        legacyDoc({ itemStatuses: { description: "stale" }, updatedAt: legacyUpdated }),
        generatedDoc({ itemStatuses: { description: "completed" }, updatedAt: targetUpdated })
      );

      expect(merged.itemStatuses).toEqual({ description: expected });
    }
  );

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
