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

export interface SmartTitlesResult {
  analysis: ContentAnalysis;
  patterns: PatternAnalysis;
  titles: ScoredTitle[];
}
