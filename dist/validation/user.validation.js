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
export const onboardingSchema = z.object({
    userName: youtubeChannelUrl,
    brandName: z.string().trim().min(1).max(MAX.short),
    niche: z.string().trim().min(1).max(MAX.short),
    targetAudience: z.string().trim().min(1).max(MAX.medium),
    website: websiteUrl.optional(),
    purpose: z.string().trim().max(MAX.long).optional(),
    description: z.string().trim().max(MAX.text).optional(),
    competitors: z.array(youtubeChannelUrl).max(MAX.competitors).optional(),
    format: z.enum(["talking_head", "faceless"]).optional(),
});
// Profile update: every field optional (partial edits), same per-field rules.
export const profileUpdateSchema = onboardingSchema.partial();
// Onboarding prefill (3.2): a single channel URL to infer suggestions from.
export const prefillSchema = z.object({
    channelUrl: youtubeChannelUrl,
});
