// Implicit signal capture (6A.1 / GA §10): fire-and-forget telemetry of the
// actions the product doc wants tracked from day 1 (selects, exports, regens).
// Replaces the explicit like/dislike feedback removed in §9. Stored append-only
// in COLLECTIONS.EVENTS; no user-facing reads yet (analytics consumes later).

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
  metadata?: Record<string, unknown>;
}
