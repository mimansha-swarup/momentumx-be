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
