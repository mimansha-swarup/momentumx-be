import { z } from "zod";

// Shared caps. A script is the largest thing a client sends anywhere in the API;
// 100k characters is far beyond any real script (a 20-minute video runs ~3k words
// / ~18k characters) while still bounding the request.
const MAX_SCRIPT = 100_000;

/**
 * POST /v1/hooks/generate
 *
 * `script` is optional and SHOULD be omitted — the server resolves it from the
 * project. Sending a stale copy is worse than sending nothing, since the stored
 * script is the source of truth. It stays accepted because the door paths rely on
 * it (see docs/features/hooks/api.md).
 *
 * `videoProjectId` is accepted here, and ONLY here, because this is a create
 * operation — the batch does not exist yet, so there is no stored document to
 * derive the owning project from. `select` and `regenerate` operate on an existing
 * batch and therefore take it from the document, per the "Owning IDs" rule in
 * .claude/rules/api-design.md.
 */
export const generateHooksSchema = z.object({
  videoProjectId: z.string().trim().min(1, "videoProjectId is required"),
  script: z.string().max(MAX_SCRIPT).optional(),
});

/**
 * POST /v1/hooks/:hooksId/select
 *
 * A batch is exactly five hooks, so the index is bounded here rather than only in
 * the service. Note there is deliberately NO `videoProjectId` — accepting one
 * would let a caller bind a batch to a project it was never generated for.
 */
export const selectHookSchema = z.object({
  hookIndex: z
    .number()
    .int("hookIndex must be a whole number")
    .min(0, "hookIndex must be 0 or greater"),
});

/** POST /v1/hooks/:hooksId/regenerate — same reasoning as generate's `script`. */
export const regenerateHooksSchema = z.object({
  script: z.string().max(MAX_SCRIPT).optional(),
});
