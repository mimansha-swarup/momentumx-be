import { GenerationConfig } from "@google/generative-ai";
import ResearchRepository from "../repository/research.repository.js";
import { generateStreamingContent } from "../utlils/ai.js";
import { GENERATION_CONFIG_SMART_TITLES } from "../constants/firebase.js";
import {
  GENERATE_SCORED_TITLES_SYSTEM_PROMPT,
  GENERATE_SCORED_TITLES_USER_PROMPT,
} from "../constants/prompt.js";
import { performance } from "perf_hooks";
import {
  ContentAnalysis,
  ScoredTitlesResult,
  SmartTitlesResult,
  TitleTimings,
} from "../types/routes/title-intelligence.js";

class TitleIntelligenceService {
  constructor(private researchRepo: ResearchRepository) {}

  private async callLLM<T>(
    systemPrompt: string,
    userPrompt: string,
    config: GenerationConfig
  ): Promise<T> {
    const result = await generateStreamingContent(systemPrompt, userPrompt, config);
    let accumulated = "";
    for await (const chunk of result.stream) {
      const part = chunk.text();
      if (part) accumulated += part;
    }
    try {
      return JSON.parse(accumulated) as T;
    } catch {
      throw new Error("LLM returned invalid JSON — check the prompt/generation config");
    }
  }

  private buildContentBlock(idea: string, script: string): string {
    const parts: string[] = [];
    if (idea) parts.push(`Idea: ${idea}`);
    if (script) parts.push(`Script: ${script.slice(0, 1000)}`);
    return parts.join("\n\n");
  }

  // The YouTube search query is derived straight from the raw input — no LLM topic
  // extraction needed. The idea (or the script's opening) is a more specific, higher-
  // relevance query than a generic derived topic like "personal finance".
  private buildSearchQuery(idea: string, script: string): string {
    const raw = (idea || script).trim();
    return raw.slice(0, 120);
  }

  // Single LLM call: analyze the content, study the research titles, generate 20
  // candidates, score them, and return the top 10 — plus the analysis and patterns
  // it derived so the response keeps its research transparency.
  private generateScoredTitles = async (
    idea: string,
    script: string,
    trendingTitles: string,
    topVideoTitles: string
  ): Promise<ScoredTitlesResult> => {
    const userPrompt = GENERATE_SCORED_TITLES_USER_PROMPT
      .replace("{content}", this.buildContentBlock(idea, script))
      .replace("{trendingTitles}", trendingTitles)
      .replace("{topVideos}", topVideoTitles);
    return this.callLLM<ScoredTitlesResult>(
      GENERATE_SCORED_TITLES_SYSTEM_PROMPT,
      userPrompt,
      GENERATION_CONFIG_SMART_TITLES
    );
  };

  generate = async (
    idea: string,
    script: string
  ): Promise<{ result: SmartTitlesResult; timings: TitleTimings }> => {
    const t0 = performance.now();

    // Step 1: Fetch YouTube data in parallel using a query derived from the raw input
    const query = this.buildSearchQuery(idea, script);
    const t1 = performance.now();

    const [trendingVideos, topVideos] = await Promise.all([
      this.researchRepo.getTrendingVideos(query),
      this.researchRepo.getKeywordSignals(query),
    ]);

    const trendingTitles = trendingVideos.map((v) => v.title).join("\n");
    const topVideoTitles = topVideos.map((v) => v.title).join("\n");
    const t2 = performance.now();

    // Step 2: Single call — analyze, find patterns, generate 20, score, return top 10
    const { analysis, patterns, insights = "", titles } = await this.generateScoredTitles(
      idea,
      script,
      trendingTitles,
      topVideoTitles
    );
    const t3 = performance.now();

    const normalizedAnalysis: ContentAnalysis = {
      topic: analysis?.topic ?? "",
      keywords: Array.isArray(analysis?.keywords) ? analysis.keywords : [],
      emotion: analysis?.emotion ?? "",
      intent: analysis?.intent ?? "",
    };

    const result: SmartTitlesResult = {
      analysis: normalizedAnalysis,
      patterns: { patterns, insights },
      titles,
    };
    const timings: TitleTimings = {
      analyzeMs: Math.round(t1 - t0),
      youtubeMs: Math.round(t2 - t1),
      mergedMs: Math.round(t3 - t2),
      totalMs: Math.round(t3 - t0),
    };
    return { result, timings };
  };
}

export default TitleIntelligenceService;
