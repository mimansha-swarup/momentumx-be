import { youtubeJson } from "./youtube-cache.repository.js";
import { decodeEntities } from "../utlils/regex.js";
// The logged reason is UNTRUSTED text. `response.json()` throws a SyntaxError whose
// message can quote the response body, and every URL here carries `key=${API_KEY}` — so
// a malformed upstream response that echoed the request would put the API key in the
// logs. Redact before logging rather than trusting the upstream never to reflect it.
const safeReason = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /key=[^&\s"']+/gi,
    "key=[redacted]"
  );

const MAX_RESULTS = 10;
const TRENDING_MAX_RESULTS = 15;
const KEYWORD_MAX_RESULTS = 20;
const API_KEY = process.env.YT_API;

// videoDuration=medium (4-20 min) excludes Shorts and livestreams; relevanceLanguage
// keeps results in the user's language. Both cut spam from the research pool.
const SEARCH_QUALITY_PARAMS = `&videoDuration=medium&relevanceLanguage=en`;

// fetch() has no implicit timeout — a stalled YouTube connection would hang idea
// generation forever (research is meant to degrade, never block). Bound every call
// so a slow/dead response rejects; the caller then falls back to no research signals.

export interface TrendingVideo {
  title: string;
  channelTitle: string;
  videoId: string;
}

export interface KeywordSignal {
  title: string;
  channelTitle: string;
  videoId: string;
}

class ResearchRepository {
  getTrendingVideos = async (niche: string): Promise<TrendingVideo[]> => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setUTCHours(0, 0, 0, 0);
    const publishedAfter = thirtyDaysAgo.toISOString();

    const url =
      `https://www.googleapis.com/youtube/v3/search` +
      `?q=${encodeURIComponent(niche)}` +
      `&order=viewCount` +
      `&publishedAfter=${encodeURIComponent(publishedAfter)}` +
      `&type=video` +
      `&part=snippet` +
      `&maxResults=${TRENDING_MAX_RESULTS}` +
      SEARCH_QUALITY_PARAMS +
      `&key=${API_KEY}`;

    try {
      const data: {
        items: {
          id: { videoId: string };
          snippet: { title: string; channelTitle: string };
        }[];
      } = await youtubeJson(url);

      return (data?.items || []).map((item) => ({
        title: decodeEntities(item.snippet.title),
        channelTitle: decodeEntities(item.snippet.channelTitle),
        videoId: item.id.videoId,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "youtube_fetch_failed",
        detail: "YouTube API unavailable — failed to fetch trending videos",
        reason: safeReason(error),
      }));
      throw new Error("YouTube API unavailable — failed to fetch trending videos");
    }
  };

  getChannelTopVideos = async (channelId: string): Promise<string[]> => {
    const url =
      `https://www.googleapis.com/youtube/v3/search` +
      `?channelId=${encodeURIComponent(channelId)}` +
      `&order=viewCount` +
      `&type=video` +
      `&part=snippet` +
      `&maxResults=${MAX_RESULTS}` +
      `&key=${API_KEY}`;

    try {
      const data: {
        items: { snippet: { title: string } }[];
      } = await youtubeJson(url);

      return (data?.items || []).map((item) => decodeEntities(item.snippet.title));
    } catch (error) {
      console.error(JSON.stringify({
        event: "youtube_fetch_failed",
        detail: "YouTube API unavailable — failed to fetch channel videos",
        reason: safeReason(error),
      }));
      throw new Error("YouTube API unavailable — failed to fetch channel videos");
    }
  };

  getVideoStats = async (videoIds: string[]): Promise<Record<string, number>> => {
    if (videoIds.length === 0) return {};

    const url =
      `https://www.googleapis.com/youtube/v3/videos` +
      `?part=statistics` +
      `&id=${videoIds.join(",")}` +
      `&key=${API_KEY}`;

    try {
      const data: {
        items: { id: string; statistics: { viewCount?: string } }[];
      } = await youtubeJson(url);

      const stats: Record<string, number> = {};
      for (const item of data?.items || []) {
        if (!item.id) continue;
        stats[item.id] = Number(item.statistics?.viewCount ?? 0);
      }
      return stats;
    } catch (error) {
      console.error(JSON.stringify({
        event: "youtube_fetch_failed",
        detail: "YouTube API unavailable — failed to fetch video stats",
        reason: safeReason(error),
      }));
      throw new Error("YouTube API unavailable — failed to fetch video stats");
    }
  };

  getKeywordSignals = async (query: string): Promise<KeywordSignal[]> => {
    const url =
      `https://www.googleapis.com/youtube/v3/search` +
      `?q=${encodeURIComponent(query)}` +
      `&order=relevance` +
      `&type=video` +
      `&part=snippet` +
      `&maxResults=${KEYWORD_MAX_RESULTS}` +
      SEARCH_QUALITY_PARAMS +
      `&key=${API_KEY}`;

    try {
      const data: {
        items: {
          id: { videoId: string };
          snippet: { title: string; channelTitle: string };
        }[];
      } = await youtubeJson(url);

      return (data?.items || []).map((item) => ({
        title: decodeEntities(item.snippet.title),
        channelTitle: decodeEntities(item.snippet.channelTitle),
        videoId: item.id.videoId,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "youtube_fetch_failed",
        detail: "YouTube API unavailable — failed to fetch keyword signals",
        reason: safeReason(error),
      }));
      throw new Error("YouTube API unavailable — failed to fetch keyword signals");
    }
  };
}

export default ResearchRepository;
