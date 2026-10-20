// Implicit signal capture (6A.1 / GA §10): fire-and-forget telemetry of the
// actions the product doc wants tracked from day 1 (selects, exports, regens).
// Replaces the explicit like/dislike feedback removed in §9. Stored in a bounded
// sample in COLLECTIONS.EVENTS; no user-facing reads or audit-log guarantees.

export const enum EventType {
  PROJECT_CREATED = "project_created", // idea selected → project (or BYO title)
  HOOK_SELECTED = "hook_selected",
  TITLE_SELECTED = "title_selected", // finalized the publish title
  EXPORT = "export",
  REGENERATE = "regenerate",
}

export interface IEvent {
  type: EventType;
  createdBy: string; // userId (from authMiddleware)
  /**
   * Phase 03 dual-write. Required, not optional: this is a write-only shape, and
   * `ignoreUndefinedProperties: true` means a dropped stamp vanishes silently
   * rather than erroring — per-channel usage would just under-count.
   */
  accountId: string;
  metadata?: Record<string, unknown>;
}
