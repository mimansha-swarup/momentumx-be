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
    return this.repo.get(userId);
  };

  updateProfile = async (userId: string, data: IOnboardingPayload) => {
    const record = await formatUserData(data, this.extractService);
    await this.repo.update(userId, record);
    return record;
  };
}

export default UserService;
