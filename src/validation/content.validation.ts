import { z } from "zod";

// Idea generation (3.3): an optional, not-yet-persisted context for the
// instant-first-idea flow. The body is optional — no body = generate from the
// persisted user record (unchanged behavior). Every context field is optional
// and merged over the stored record server-side.
export const generateIdeasSchema = z.object({
  context: z
    .object({
      niche: z.string().trim().max(200),
      targetAudience: z.string().trim().max(500),
      brandName: z.string().trim().max(200),
      topTitles: z.array(z.string().trim().max(300)).max(20),
    })
    .partial()
    .optional(),
});

export type GenerateIdeasInput = z.infer<typeof generateIdeasSchema>;

// Caps mirror the shapes these fields actually hold. A script is the largest
// client-sent payload in the API; 100k characters is far beyond a real script
// (a 20-minute video is ~3k words / ~18k characters) while still bounding it.
const MAX_TITLE = 300;
const MAX_SCRIPT = 100_000;

/**
 * PATCH /v1/ideas/edit/:ideaId
 *
 * `title` is the ONLY client-editable field. The service already whitelists it —
 * this schema makes the same rule visible at the edge and strips the rest before
 * the service sees them, so `archived`, `embedding`, `batchId`, `createdBy` and
 * `isScriptGenerated` cannot arrive at all.
 */
export const editIdeaSchema = z.object({
  title: z.string().trim().min(1, "title cannot be empty").max(MAX_TITLE),
});

/**
 * PATCH /v1/scripts/edit/:scriptId
 *
 * `script` and `title` are editable; at least one must be present, matching the
 * service's "No editable fields provided" guard.
 *
 * Editing `script` cascades stale to hooks and packaging, so an empty-string
 * script would silently invalidate downstream work with nothing to show for it.
 */
export const editScriptSchema = z
  .object({
    script: z.string().min(1, "script cannot be empty").max(MAX_SCRIPT).optional(),
    title: z.string().trim().min(1, "title cannot be empty").max(MAX_TITLE).optional(),
  })
  .refine((data) => data.script !== undefined || data.title !== undefined, {
    message: "No editable fields provided (allowed: script, title)",
    path: ["script"],
  });
