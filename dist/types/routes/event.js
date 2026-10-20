// Implicit signal capture (6A.1 / GA §10): fire-and-forget telemetry of the
// actions the product doc wants tracked from day 1 (selects, exports, regens).
// Replaces the explicit like/dislike feedback removed in §9. Stored in a bounded
// sample in COLLECTIONS.EVENTS; no user-facing reads or audit-log guarantees.
export {};
