import ExtractRepository from "../repository/extract.repository.js";
import ExtractService from "./extract.service.js";
import { formatUserData, resolveChannel } from "../utlils/content.js";
import { collectJson, generateStreamingContent } from "../utlils/ai.js";
import { fillTemplate } from "../utlils/prompt-blocks.js";
import { ONBOARDING_PREFILL_SYSTEM_PROMPT, ONBOARDING_PREFILL_PROMPT, } from "../constants/prompt.js";
import { GENERATION_CONFIG_PREFILL } from "../constants/firebase.js";
import { computeProfileCompleteness } from "../utlils/profile.js";
import { NotFound } from "../utlils/errors.js";
class UserService {
    constructor(repo) {
        this.createOnboardingData = async (userId, data) => {
            // Value-first: persist the user-provided minimum IMMEDIATELY so the onboarding
            // gate clears without blocking on YouTube/website enrichment (a multi-second
            // network call). Enrichment — channel titles/description, website content,
            // competitor resolution — runs as a SEPARATE request via refresh-context,
            // which the FE fires in the background right after onboarding. (Serverless
            // can't reliably run post-response work, so it's a separate request, not a
            // deferred inline job.) `stats` is seeded at user creation by the auth trigger
            // and maintained via FieldValue.increment, so onboarding never writes it.
            await this.repo.add(userId, data);
            return data;
        };
        // Onboarding prefill (3.2): resolve a channel URL and infer onboarding fields
        // from its description + top titles, so the user confirms rather than types.
        // Nothing is persisted — these are suggestions. Channel resolution is
        // best-effort (never throws); with no signal we return blank suggestions
        // instead of asking the model to hallucinate from nothing.
        this.prefillFromChannel = async (channelUrl) => {
            const channel = await resolveChannel(this.extractService, channelUrl);
            const description = channel?.description ?? "";
            const titles = channel?.titles ?? [];
            const suggestions = description.trim() || titles.length
                ? await this.inferOnboardingFields(description, titles)
                : { niche: "", targetAudience: "", brandName: "" };
            return {
                suggestions,
                channel: { channelDescription: description, topTitles: titles },
            };
        };
        this.inferOnboardingFields = async (channelDescription, topTitles) => {
            const userPrompt = fillTemplate(ONBOARDING_PREFILL_PROMPT, {
                "{channelDescription}": channelDescription,
                "{topTitles}": topTitles.join("\n"),
            });
            const result = await generateStreamingContent(ONBOARDING_PREFILL_SYSTEM_PROMPT, userPrompt, GENERATION_CONFIG_PREFILL);
            const parsed = await collectJson(result, "channel suggestions");
            return {
                niche: parsed.niche ?? "",
                targetAudience: parsed.targetAudience ?? "",
                brandName: parsed.brandName ?? "",
            };
        };
        this.getProfile = async (userId) => {
            // Completeness (3.4) is computed read-time from the record and never
            // persisted — it drives the FE meter and "add next" nudges.
            const record = await this.repo.get(userId);
            return {
                ...(record ?? {}),
                // Always answer with the uid. The onboarding write (`repo.add`) never
                // stores it, so profiles created that way came back without one — and the
                // client treated a uid-less response as "no profile", threw the stored
                // niche/targetAudience away, and bounced the user back into onboarding
                // forever. It's `req.userId` here, so this can never be wrong or drift.
                uid: userId,
                completeness: computeProfileCompleteness(record),
            };
        };
        this.updateProfile = async (userId, data) => {
            const record = await formatUserData(data, this.extractService);
            await this.repo.update(userId, record);
            return record;
        };
        // Refresh context (3.7): re-run channel/website enrichment from the STORED
        // onboarding inputs — no form fields needed. This is also the path that
        // enriches after the fast onboarding save. Competitors may be stored as raw
        // URL strings (fresh onboarding, pre-enrichment) OR as enriched {url,...}
        // objects (already refreshed) — map both back to their URLs for re-resolution.
        this.refreshContext = async (userId) => {
            const record = await this.repo.get(userId);
            if (!record)
                throw NotFound("User not found");
            // Only `competitors` needs reshaping; everything else round-trips as stored.
            const { userName, website, brandName, niche, targetAudience, purpose, description, format } = record;
            const input = {
                userName, website, brandName, niche, targetAudience, purpose, description, format,
                competitors: (Array.isArray(record.competitors) ? record.competitors : [])
                    .map((c) => (typeof c === "string" ? c : c?.url))
                    .filter((url) => Boolean(url)),
            };
            const refreshed = await formatUserData(input, this.extractService);
            await this.repo.update(userId, refreshed);
            return { ...refreshed, completeness: computeProfileCompleteness(refreshed) };
        };
        this.repo = repo;
        this.extractService = new ExtractService(new ExtractRepository());
    }
}
export default UserService;
