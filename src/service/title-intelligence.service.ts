import { GenerationConfig } from "@google/generative-ai";
import ResearchRepository from "../repository/research.repository.js";
import { generateStreamingContent } from "../utlils/ai.js";
import {
  GENERATION_CONFIG_SMART_TITLES,
  GENERATION_CONFIG_PACKAGING,
  GENERATION_CONFIG_TITLES,
  GENERATION_CONFIG_SCORED_TITLES,
} from "../constants/firebase.js";
import {
  GENERATE_SCORED_TITLES_SYSTEM_PROMPT,
  GENERATE_SCORED_TITLES_USER_PROMPT,
  ANALYZE_CONTENT_SYSTEM_PROMPT,
  ANALYZE_CONTENT_USER_PROMPT,
  FIND_PATTERNS_SYSTEM_PROMPT,
  FIND_PATTERNS_USER_PROMPT,
  GENERATE_ENRICHED_TITLES_SYSTEM_PROMPT,
  GENERATE_ENRICHED_TITLES_USER_PROMPT,
  SCORE_TITLES_SYSTEM_PROMPT,
  SCORE_TITLES_USER_PROMPT,
} from "../constants/prompt.js";
import { performance } from "perf_hooks";
import {
  ContentAnalysis,
  PatternAnalysis,
  ScoredTitle,
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

  // The research pool decides what the model imitates — spam in, spam out. Drop
  // Shorts/livestream junk, collapse duplicates, limit each channel to 2 titles
  // (kills "EPISODE #11 / #12 / #13" series spam), and cap the list so only clean,
  // distinct competitor titles reach the prompt. `seen` and `channelCounts` are
  // shared across lists so the keyword list can't re-introduce trending entries.
  private cleanVideos<T extends { title: string; channelTitle: string }>(
    videos: T[],
    seen: Set<string>,
    channelCounts: Map<string, number>,
    cap: number
  ): T[] {
    const isJunk = (t: string): boolean =>
      /#shorts?\b/i.test(t) ||
      /🔴|\bLIVE\b/.test(t) ||
      t.trim().length < 15;
    const normalize = (t: string): string =>
      t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

    const out: T[] = [];
    for (const video of videos) {
      if (out.length >= cap) break;
      if (isJunk(video.title)) continue;
      const key = normalize(video.title);
      if (!key || seen.has(key)) continue;
      const channelCount = channelCounts.get(video.channelTitle) ?? 0;
      if (channelCount >= 2) continue;
      seen.add(key);
      channelCounts.set(video.channelTitle, channelCount + 1);
      out.push(video);
    }
    return out;
  }

  // "1.2M views" tells the model which competitor titles actually earned clicks —
  // without it, a 2M-view winner and a 3K-view also-ran read as equals.
  private formatViews(views: number): string {
    if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1)}M views`;
    if (views >= 1_000) return `${Math.round(views / 1_000)}K views`;
    return `${views} views`;
  }

  private formatTitleLines(
    videos: { title: string; videoId: string }[],
    stats: Record<string, number>
  ): string {
    return videos
      .map((v) => {
        const views = stats[v.videoId];
        return views ? `${v.title} — ${this.formatViews(views)}` : v.title;
      })
      .join("\n");
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

  // --- Deep pipeline (4 sequential LLM calls, higher quality) ---

  private analyzeInput = async (idea: string, script: string): Promise<ContentAnalysis> => {
    const userPrompt = ANALYZE_CONTENT_USER_PROMPT
      .replace("{content}", this.buildContentBlock(idea, script));
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

  deepGenerate = async (idea: string, script: string): Promise<SmartTitlesResult> => {
    // Step 1: Analyze the input
    const analysis = await this.analyzeInput(idea, script);

    // Step 2: Fetch YouTube data in parallel using the LLM-detected topic
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

  // --- Fast pipeline (1 merged LLM call) ---

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

    const seen = new Set<string>();
    const channelCounts = new Map<string, number>();
    const cleanTrending = this.cleanVideos(trendingVideos, seen, channelCounts, 12);
    const cleanTop = this.cleanVideos(topVideos, seen, channelCounts, 12);

    const stats = await this.researchRepo.getVideoStats(
      [...cleanTrending, ...cleanTop].map((v) => v.videoId)
    );
    const trendingTitles = this.formatTitleLines(cleanTrending, stats);
    const topVideoTitles = this.formatTitleLines(cleanTop, stats);
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
