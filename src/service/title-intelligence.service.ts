import { GenerationConfig } from "@google/generative-ai";
import ResearchRepository from "../repository/research.repository.js";
import { generateStreamingContent } from "../utlils/ai.js";
import {
  GENERATION_CONFIG_PACKAGING,
  GENERATION_CONFIG_TITLES,
  GENERATION_CONFIG_SCORED_TITLES,
} from "../constants/firebase.js";
import {
  ANALYZE_CONTENT_SYSTEM_PROMPT,
  ANALYZE_CONTENT_USER_PROMPT,
  FIND_PATTERNS_SYSTEM_PROMPT,
  FIND_PATTERNS_USER_PROMPT,
  GENERATE_ENRICHED_TITLES_SYSTEM_PROMPT,
  GENERATE_ENRICHED_TITLES_USER_PROMPT,
  SCORE_TITLES_SYSTEM_PROMPT,
  SCORE_TITLES_USER_PROMPT,
} from "../constants/prompt.js";
import {
  ContentAnalysis,
  PatternAnalysis,
  ScoredTitle,
  SmartTitlesResult,
} from "../types/routes/title-intelligence.js";

class TitleIntelligenceService {
  constructor(private researchRepo: ResearchRepository) {}

  private async callLLM<T>(
    systemPrompt: string,
    userPrompt: string,
    config: GenerationConfig
  ): Promise<T> {
    console.log("hwew 2")
    let result;
    try {
      result = await generateStreamingContent(systemPrompt, userPrompt, config);
    } catch (err) {
      console.error("generateStreamingContent threw:", err);
      throw err;
    }
    console.log("here 3")
    let accumulated = "";
    for await (const chunk of result.stream) {
      const part = chunk.text();
      if (part) accumulated += part;
    }
    console.log("accumulated", accumulated)
    return JSON.parse(accumulated) as T;
  }

  private buildContentBlock(idea: string, script: string): string {
    const parts: string[] = [];
    if (idea) parts.push(`Idea: ${idea}`);
    if (script) parts.push(`Script: ${script.slice(0, 1000)}`);
    return parts.join("\n\n");
  }

  private analyzeInput = async (idea: string, script: string): Promise<ContentAnalysis> => {
    const userPrompt = ANALYZE_CONTENT_USER_PROMPT
      .replace("{content}", this.buildContentBlock(idea, script));
      console.log("user prompt", userPrompt)
    return this.callLLM<ContentAnalysis>(
      ANALYZE_CONTENT_SYSTEM_PROMPT,
      userPrompt,
      GENERATION_CONFIG_PACKAGING
    );
  };

  private findPatterns = async (
    trendingTitles: string,
    topVideoTitles: string
  ): Promise<PatternAnalysis> => {
    const userPrompt = FIND_PATTERNS_USER_PROMPT
      .replace("{trendingTitles}", trendingTitles)
      .replace("{topVideos}", topVideoTitles);
    return this.callLLM<PatternAnalysis>(
      FIND_PATTERNS_SYSTEM_PROMPT,
      userPrompt,
      GENERATION_CONFIG_PACKAGING
    );
  };

  private generateTitles = async (
    idea: string,
    script: string,
    analysis: ContentAnalysis,
    patternAnalysis: PatternAnalysis
  ): Promise<string[]> => {
    const userPrompt = GENERATE_ENRICHED_TITLES_USER_PROMPT
      .replace("{content}", this.buildContentBlock(idea, script))
      .replace("{topic}", analysis.topic)
      .replace("{keywords}", analysis.keywords.join(", "))
      .replace("{emotion}", analysis.emotion)
      .replace("{intent}", analysis.intent)
      .replace("{patterns}", patternAnalysis.patterns.join("\n"));
    return this.callLLM<string[]>(
      GENERATE_ENRICHED_TITLES_SYSTEM_PROMPT,
      userPrompt,
      GENERATION_CONFIG_TITLES
    );
  };

  private scoreTitles = async (
    titles: string[],
    analysis: ContentAnalysis
  ): Promise<ScoredTitle[]> => {
    const userPrompt = SCORE_TITLES_USER_PROMPT
      .replace("{titles}", titles.map((t, i) => `${i + 1}. ${t}`).join("\n"))
      .replace("{topic}", analysis.topic)
      .replace("{emotion}", analysis.emotion)
      .replace("{intent}", analysis.intent);
    return this.callLLM<ScoredTitle[]>(
      SCORE_TITLES_SYSTEM_PROMPT,
      userPrompt,
      GENERATION_CONFIG_SCORED_TITLES
    );
  };

  generate = async (idea: string, script: string): Promise<SmartTitlesResult> => {
    // Step 1: Analyze the input
    console.log("heree")
    const analysis = await this.analyzeInput(idea, script);
    console.log("analysis", analysis)

    // Step 2: Fetch YouTube data in parallel using the detected topic
    const [trendingVideos, topVideos] = await Promise.all([
      this.researchRepo.getTrendingVideos(analysis.topic),
      this.researchRepo.getKeywordSignals(analysis.topic),
    ]);

    const trendingTitles = trendingVideos.map((v) => v.title).join("\n");
    const topVideoTitles = topVideos.map((v) => v.title).join("\n");

    // Step 3: Find patterns in the data
    const patternAnalysis = await this.findPatterns(trendingTitles, topVideoTitles);

    // Step 4: Generate 20 titles
    const titles = await this.generateTitles(idea, script, analysis, patternAnalysis);

    // Step 5: Score and return top 10
    const scoredTitles = await this.scoreTitles(titles, analysis);

    return { analysis, patterns: patternAnalysis, titles: scoredTitles };
  };
}

export default TitleIntelligenceService;
