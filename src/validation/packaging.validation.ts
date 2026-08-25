import { z } from "zod";

// POST /v1/packaging/save (Phase 01 item 7).
//
// This body is spread onto the stored packaging document. Before this schema
// existed, `packaging.controller.ts` passed `...rest` straight through and
// `savePackaging` forwarded every unrecognised key to the write — which let a
// client set `isStale`, `staleReason`, `staleSince` and `itemStatuses` directly
// on the update path, defeating the stale cascade that the surrounding comments
// in that function exist to protect.
//
// The job here is KEY ALLOWLISTING, not shape validation: Zod strips unknown
// keys, and `PackagingService.normalizeField` remains the single source of truth
// for the shape of each content field (it accepts both the bare and wrapped
// forms, and throws its own BadRequest with a field-specific message). Restating
// those shapes here would put the same rules in two places and guarantee they
// drift.
//
// A save carries EDITS ONLY. Generated content is already persisted by the
// generate-* endpoints, so every field is optional — a save that touches one
// field sends one field.
export const packagingSaveSchema = z.object({
  // Door model: absent means "no project yet", and the service lazily creates a
  // shallow one. Present-but-empty is a client bug, not a door.
  videoProjectId: z.string().trim().min(1).optional(),

  // Content fields — normalizeField owns their shapes. `unknown` here means
  // "this key is permitted", not "anything goes downstream".
  titles: z.unknown().optional(),
  description: z.unknown().optional(),
  thumbnail: z.unknown().optional(),
  shorts: z.unknown().optional(),

  // User selections. Nullable because the client clears a pick by sending null.
  selectedTitleIndex: z.number().int().min(0).nullable().optional(),
  selectedThumbnailIndex: z.number().int().min(0).nullable().optional(),
});

export type PackagingSaveInput = z.infer<typeof packagingSaveSchema>;

// Shared with the generate-* endpoints below.
const MAX_SCRIPT = 100_000;
const MAX_TITLE = 300;

/**
 * The four `generate-*` endpoints share a shape: an optional server-resolvable
 * `script`, an optional `videoProjectId`, and whatever that item needs.
 *
 * `videoProjectId` is OPTIONAL by design. Without it these are stateless previews
 * that persist nothing — the "door" behaviour that lets someone package a video
 * whose script step never ran. Requiring it here would close those doors.
 *
 * `script` is likewise optional: the server resolves it from the project when
 * omitted, and the stored script is the source of truth.
 */
const generateBase = {
  script: z.string().max(MAX_SCRIPT).optional(),
  videoProjectId: z.string().trim().min(1).optional(),
};

/** POST /v1/packaging/generate-title */
export const generateTitleSchema = z.object({ ...generateBase });

/** POST /v1/packaging/generate-description */
export const generateDescriptionSchema = z.object({
  ...generateBase,
  title: z.string().trim().max(MAX_TITLE).optional(),
});

/** POST /v1/packaging/generate-thumbnail */
export const generateThumbnailSchema = z.object({
  ...generateBase,
  title: z.string().trim().max(MAX_TITLE).optional(),
});

/**
 * POST /v1/packaging/generate-shorts
 *
 * `duration` is required — the controller rejects a missing one with a 400 today,
 * so this moves that check to the edge rather than changing behaviour. Bounded
 * because it drives the generated segment plan: a Shorts script is seconds, not
 * hours, and an absurd value produces an absurd generation.
 */
export const generateShortsSchema = z.object({
  ...generateBase,
  duration: z
    .number()
    .int("duration must be a whole number of seconds")
    .min(1, "duration must be at least 1 second")
    .max(600, "duration must be 600 seconds or fewer"),
});

/**
 * POST /v1/packaging/:packagingId/regenerate/:item
 *
 * `item` is a path param, validated in the service against the allowed set. Every
 * body field is optional because which ones matter depends on the item — the
 * service enforces that (e.g. description and thumbnail require a title).
 */
export const regenerateItemSchema = z.object({
  script: z.string().max(MAX_SCRIPT).optional(),
  title: z.string().trim().max(MAX_TITLE).optional(),
  duration: z.number().int().min(1).max(600).optional(),
});

/**
 * POST /v1/packaging/:packagingId/select-title
 *
 * Finalises a title variation and renames the project, so a bad index renames the
 * project to nothing. The service range-checks against the actual variation count;
 * this rejects the shapes that can never be valid.
 */
export const selectTitleSchema = z.object({
  index: z.number().int("index must be a whole number").min(0, "index must be 0 or greater"),
});
