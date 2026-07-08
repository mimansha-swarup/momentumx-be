import ExtractRepository from "../repository/extract.repository.js";
import ExtractService from "./extract.service.js";
import { formatUserData, resolveChannel } from "../utlils/content.js";
import { generateStreamingContent } from "../utlils/ai.js";
import { fillTemplate } from "../utlils/prompt-blocks.js";
import { ONBOARDING_PREFILL_SYSTEM_PROMPT, ONBOARDING_PREFILL_PROMPT, } from "../constants/prompt.js";
import { GENERATION_CONFIG_PREFILL } from "../constants/firebase.js";
import { computeProfileCompleteness } from "../utlils/profile.js";
import { NotFound } from "../utlils/errors.js";
class UserService {
    constructor(repo) {
        this.createOnboardingData = async (userId, data) => {
            // `stats` is seeded at user creation by the auth trigger (functions/) and
            // maintained via FieldValue.increment, so onboarding no longer writes it —
            // re-onboarding must not reset accumulated counters.
            const record = await formatUserData(data, this.extractService);
            await this.repo.add(userId, record);
            return record;
        };
        // Onboarding prefill (3.2): resolve a channel URL and infer onboarding fields
        // from its description + top titles, so the user confirms rather than types.
        // Nothing is persisted — these are suggestions. Channel resolution is
        // best-effort (never throws); with no signal we return blank suggestions
        // instead of asking the model to hallucinate from nothing.
        this.prefillFromChannel = async (channelUrl) => {
            const channel = await resolveChannel(this.extractService, channelUrl);
            const hasSignal = channel.description.trim().length > 0 || channel.titles.length > 0;
            const suggestions = hasSignal
                ? await this.inferOnboardingFields(channel.description, channel.titles)
                : { niche: "", targetAudience: "", brandName: "" };
            return {
                suggestions,
                channel: {
                    channelDescription: channel.description,
                    topTitles: channel.titles,
                },
            };
        };
        this.inferOnboardingFields = async (channelDescription, topTitles) => {
            const userPrompt = fillTemplate(ONBOARDING_PREFILL_PROMPT, {
                "{channelDescription}": channelDescription,
                "{topTitles}": topTitles.join("\n"),
            });
            const result = await generateStreamingContent(ONBOARDING_PREFILL_SYSTEM_PROMPT, userPrompt, GENERATION_CONFIG_PREFILL);
            let accumulated = "";
            for await (const chunk of result.stream) {
                const part = chunk.text();
                if (part)
                    accumulated += part;
            }
            const parsed = JSON.parse(accumulated);
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
            return { ...(record ?? {}), completeness: computeProfileCompleteness(record) };
        };
        this.updateProfile = async (userId, data) => {
            const record = await formatUserData(data, this.extractService);
            await this.repo.update(userId, record);
            return record;
        };
        // Refresh context (3.7): re-run channel/website enrichment from the STORED
        // onboarding inputs — no form fields needed. Competitors are stored as
        // objects, so map them back to their URLs for re-resolution.
        this.refreshContext = async (userId) => {
            const record = await this.repo.get(userId);
            if (!record)
                throw NotFound("User not found");
            const input = {
                userName: record.userName,
                website: record.website,
                brandName: record.brandName,
                niche: record.niche,
                targetAudience: record.targetAudience,
                purpose: record.purpose,
                description: record.description,
                format: record.format,
                competitors: Array.isArray(record.competitors)
                    ? record.competitors
                        .map((competitor) => competitor?.url)
                        .filter((url) => Boolean(url))
                    : [],
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
