import { packagingSaveSchema } from "../../src/validation/packaging.validation";

// Phase 01 item 7. `POST /v1/packaging/save` spreads its body onto the stored
// document, so anything this schema lets through is persisted verbatim.
describe("packagingSaveSchema", () => {
  it("accepts the payload the client actually sends", () => {
    const parsed = packagingSaveSchema.parse({
      videoProjectId: "proj-1",
      titles: [{ title: "A title", score: 8 }],
      selectedTitleIndex: 0,
      description: "An SEO description",
      thumbnail: ["Brief one", "Brief two"],
      selectedThumbnailIndex: 1,
      shorts: { segments: [{ text: "hi" }], totalDuration: "0:45" },
    });

    expect(parsed.videoProjectId).toBe("proj-1");
    expect(parsed.selectedThumbnailIndex).toBe(1);
    expect(parsed.shorts).toEqual({ segments: [{ text: "hi" }], totalDuration: "0:45" });
  });

  it("accepts an edit that touches a single field", () => {
    const parsed = packagingSaveSchema.parse({ description: "Just the description" });
    expect(parsed.description).toBe("Just the description");
    expect(Object.keys(parsed)).toEqual(["description"]);
  });

  // ---------------------------------------------------------------------------
  // The reason this schema exists.
  //
  // `savePackaging` deliberately does NOT recompute these on update — a re-save
  // must not un-stale a package an upstream regenerate marked stale, and must not
  // rewrite per-item statuses. Before this schema, the body spread straight over
  // both, so a client could clear the stale cascade by sending one boolean.
  // ---------------------------------------------------------------------------
  it("strips the stale flags", () => {
    const parsed = packagingSaveSchema.parse({
      description: "edit",
      isStale: false,
      staleReason: null,
      staleSince: null,
    });

    expect(parsed).not.toHaveProperty("isStale");
    expect(parsed).not.toHaveProperty("staleReason");
    expect(parsed).not.toHaveProperty("staleSince");
  });

  it("strips itemStatuses", () => {
    const parsed = packagingSaveSchema.parse({
      description: "edit",
      itemStatuses: {
        title: "completed",
        description: "completed",
        thumbnail: "completed",
        shorts: "completed",
      },
    });

    expect(parsed).not.toHaveProperty("itemStatuses");
  });

  // Ownership and tenancy fields are stamped server-side after the body spread.
  // That ordering is the only thing protecting `createdBy` today; stripping the
  // keys here means the ordering stops being load-bearing — which matters when
  // Phase 03 adds `accountId` to the same write.
  it("strips ownership and tenancy fields", () => {
    const parsed = packagingSaveSchema.parse({
      description: "edit",
      createdBy: "another-user",
      accountId: "another-account",
      id: "forged-id",
    });

    expect(parsed).not.toHaveProperty("createdBy");
    expect(parsed).not.toHaveProperty("accountId");
    expect(parsed).not.toHaveProperty("id");
  });

  // script/hooks were already deleted in the service; stripping them at the edge
  // keeps that from being the only line standing between a client snapshot and
  // the document.
  it("strips script and hooks snapshots", () => {
    const parsed = packagingSaveSchema.parse({
      description: "edit",
      script: "a whole script",
      hooks: ["hook one"],
    });

    expect(parsed).not.toHaveProperty("script");
    expect(parsed).not.toHaveProperty("hooks");
  });

  it("rejects an empty videoProjectId rather than treating it as a door save", () => {
    expect(packagingSaveSchema.safeParse({ videoProjectId: "" }).success).toBe(false);
    expect(packagingSaveSchema.safeParse({ videoProjectId: "   " }).success).toBe(false);
  });

  it("rejects a non-numeric or negative selection index", () => {
    expect(packagingSaveSchema.safeParse({ selectedTitleIndex: "0" }).success).toBe(false);
    expect(packagingSaveSchema.safeParse({ selectedThumbnailIndex: -1 }).success).toBe(false);
    expect(packagingSaveSchema.safeParse({ selectedThumbnailIndex: 1.5 }).success).toBe(false);
  });

  it("allows a null selection so a pick can be cleared", () => {
    const parsed = packagingSaveSchema.parse({ selectedThumbnailIndex: null });
    expect(parsed.selectedThumbnailIndex).toBeNull();
  });
});
