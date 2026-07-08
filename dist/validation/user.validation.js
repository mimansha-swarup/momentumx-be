import { z } from "zod";
import { extractChannelInfo } from "../utlils/regex.js";
// First real validation layer (phase 3.1). Establishes the Zod pattern reused
// across the API afterwards. Rules: trim every string, cap lengths, verify
// channel URLs are resolvable YouTube URLs, and strip unknown keys (Zod objects
// strip by default) so the client can never smuggle fields into the stored doc.
//
// Channel-URL validity reuses `extractChannelInfo` — the SAME check the extract
// pipeline runs downstream — so we never diverge from what the pipeline accepts.
const MAX = {
    short: 200,
    medium: 500,
    long: 1000,
    text: 5000,
    url: 2000,
    competitors: 20,
};
const youtubeChannelUrl = z
    .string()
    .trim()
    .min(1)
    .max(MAX.url)
    .refine((value) => extractChannelInfo(value) !== null, {
    message: "must be a valid YouTube channel URL (youtube.com/@handle, /channel/ID, /c/name or /user/name)",
});
// Optional website: absent or a real http(s) URL. Empty string is allowed so an
// FE that always sends the field (blank) is not rejected.
const websiteUrl = z
    .string()
    .trim()
    .max(MAX.url)
    .refine((value) => value === "" || /^https?:\/\/\S+\.\S+/i.test(value), {
    message: "must be a valid URL",
});
// Base shape — every field optional with its per-field rules. Cross-field
// requirements are layered on top per use case (see onboardingSchema).
const userFields = z.object({
    userName: youtubeChannelUrl.optional(),
    brandName: z.string().trim().max(MAX.short).optional(),
    niche: z.string().trim().max(MAX.short).optional(),
    targetAudience: z.string().trim().max(MAX.medium).optional(),
    website: websiteUrl.optional(),
    purpose: z.string().trim().max(MAX.long).optional(),
    description: z.string().trim().max(MAX.text).optional(),
    competitors: z.array(youtubeChannelUrl).max(MAX.competitors).optional(),
    format: z.enum(["talking_head", "faceless"]).optional(),
});
// Onboarding (3.8): the required minimum is split by entry path —
//   • channel path:    a channel URL is enough (we enrich everything from it)
//   • no-channel path: niche + targetAudience
// `brandName`/`userName` are no longer individually required. Low-friction:
// the fastest path is just the URL.
export const onboardingSchema = userFields.refine((data) => Boolean(data.userName) ||
    (Boolean(data.niche) && Boolean(data.targetAudience)), {
    message: "Provide a YouTube channel URL, or both a niche and a target audience",
    path: ["userName"],
});
// Profile update: every field optional, no cross-field requirement (a partial
// edit may touch a single field).
export const profileUpdateSchema = userFields;
// Onboarding prefill (3.2): a single channel URL to infer suggestions from.
export const prefillSchema = z.object({
    channelUrl: youtubeChannelUrl,
});
