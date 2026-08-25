import { z } from "zod";

const MAX_TITLE = 300;

/**
 * POST /v1/video-projects
 *
 * Exactly one of `ideaId` or `title`:
 *  - `ideaId` — start from an idea that already exists.
 *  - `title`  — the bring-your-own-title door, which mints an idea then a project.
 *
 * Both is rejected rather than silently preferring one, because the two produce
 * different documents and a client sending both has a bug the server should
 * surface, not paper over.
 */
export const createVideoProjectSchema = z
  .object({
    ideaId: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).max(MAX_TITLE).optional(),
  })
  .refine((data) => Boolean(data.ideaId) !== Boolean(data.title), {
    message: "Provide exactly one of ideaId or title",
    path: ["ideaId"],
  });

/** PATCH /v1/video-projects/:projectId — title is the only editable field. */
export const updateVideoProjectSchema = z.object({
  title: z.string().trim().min(1, "title is required").max(MAX_TITLE),
});

/**
 * PATCH /v1/video-projects/:projectId/link/:resourceType
 *
 * `resourceType` is a path param and is validated in the service against the
 * allowed set. The body carries only the id — and the SERVICE still verifies that
 * the resource exists and belongs to the caller (Phase 01 item 6). This schema
 * bounds the input; it is not the ownership check.
 */
export const linkResourceSchema = z.object({
  resourceId: z.string().trim().min(1, "resourceId is required"),
});
