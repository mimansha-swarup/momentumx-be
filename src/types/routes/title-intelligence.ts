export interface GenerateSmartTitlesBody {
  idea?: string;
  script?: string;
}

export interface ContentAnalysis {
  topic: string;
  keywords: string[];
  emotion: string;
  intent: string;
}

export interface PatternAnalysis {
  patterns: string[];
  insights: string;
}

export interface ScoredTitle {
  title: string;
  score: number;
  reason: string;
}

// Raw output of the merged generate+score LLM call: patterns/insights it derived
// plus the top-10 scored titles, all in one response.
export interface ScoredTitlesResult {
  analysis: ContentAnalysis;
  patterns: string[];
  insights?: string;
  titles: ScoredTitle[];
}

export interface SmartTitlesResult {
  analysis: ContentAnalysis;
  patterns: PatternAnalysis;
  titles: ScoredTitle[];
}

// Per-stage latency instrumentation (surfaced in the response `meta` for tuning).
export interface TitleTimings {
  analyzeMs: number;
  youtubeMs: number;
  mergedMs: number;
  totalMs: number;
}
