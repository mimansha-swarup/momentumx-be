import ExtractRepository from "../repository/extract.repository.js";
import UserRepository from "../repository/user.repository.js";
import ExtractService from "./extract.service.js";
import { formatUserData, resolveChannel } from "../utlils/content.js";
import { generateStreamingContent } from "../utlils/ai.js";
import { fillTemplate } from "../utlils/prompt-blocks.js";
import {
  ONBOARDING_PREFILL_SYSTEM_PROMPT,
  ONBOARDING_PREFILL_PROMPT,
} from "../constants/prompt.js";
import { GENERATION_CONFIG_PREFILL } from "../constants/firebase.js";
import { computeProfileCompleteness } from "../utlils/profile.js";
import { NotFound } from "../utlils/errors.js";

interface IPrefillSuggestions {
  niche: string;
  targetAudience: string;
  brandName: string;
}

class UserService {
  private repo: UserRepository;
  private extractService: ExtractService;

  constructor(repo: UserRepository) {
    this.repo = repo;
    this.extractService = new ExtractService(new ExtractRepository());
  }

  createOnboardingData = async (userId: string, data: IOnboardingPayload) => {
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
  prefillFromChannel = async (channelUrl: string) => {
    const channel = await resolveChannel(this.extractService, channelUrl);

    const hasSignal =
      channel.description.trim().length > 0 || channel.titles.length > 0;
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

  private inferOnboardingFields = async (
    channelDescription: string,
    topTitles: string[]
  ): Promise<IPrefillSuggestions> => {
    const userPrompt = fillTemplate(ONBOARDING_PREFILL_PROMPT, {
      "{channelDescription}": channelDescription,
      "{topTitles}": topTitles.join("\n"),
    });

    const result = await generateStreamingContent(
      ONBOARDING_PREFILL_SYSTEM_PROMPT,
      userPrompt,
      GENERATION_CONFIG_PREFILL
    );

    let accumulated = "";
    for await (const chunk of result.stream) {
      const part = chunk.text();
      if (part) accumulated += part;
    }

    const parsed = JSON.parse(accumulated) as Partial<IPrefillSuggestions>;
    return {
      niche: parsed.niche ?? "",
      targetAudience: parsed.targetAudience ?? "",
      brandName: parsed.brandName ?? "",
    };
  };

  getProfile = async (userId: string) => {
    // Completeness (3.4) is computed read-time from the record and never
    // persisted — it drives the FE meter and "add next" nudges.
    const record = await this.repo.get(userId);
    return { ...(record ?? {}), completeness: computeProfileCompleteness(record) };
  };

  updateProfile = async (userId: string, data: IOnboardingPayload) => {
    const record = await formatUserData(data, this.extractService);
    await this.repo.update(userId, record);
    return record;
  };

  // Refresh context (3.7): re-run channel/website enrichment from the STORED
  // onboarding inputs — no form fields needed. This is also the path that
  // enriches after the fast onboarding save. Competitors may be stored as raw
  // URL strings (fresh onboarding, pre-enrichment) OR as enriched {url,...}
  // objects (already refreshed) — map both back to their URLs for re-resolution.
  refreshContext = async (userId: string) => {
    const record = await this.repo.get(userId);
    if (!record) throw NotFound("User not found");

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
            .map((competitor: unknown) =>
              typeof competitor === "string"
                ? competitor
                : (competitor as { url?: string })?.url
            )
            .filter((url: unknown): url is string => Boolean(url))
        : [],
    } as IOnboardingPayload;

    const refreshed = await formatUserData(input, this.extractService);
    await this.repo.update(userId, refreshed);
    return { ...refreshed, completeness: computeProfileCompleteness(refreshed) };
  };
}

export default UserService;
