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
const YT_TIMEOUT_MS = 8000;
const ytFetch = (url) => fetch(url, { signal: AbortSignal.timeout(YT_TIMEOUT_MS) });
// The search API returns titles with HTML entities (&amp;, &#39;, …) — decode at the
// boundary so downstream prompts never see encoded text.
const decodeEntities = (text) => text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
class ResearchRepository {
    constructor() {
        this.getTrendingVideos = async (niche) => {
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            const publishedAfter = thirtyDaysAgo.toISOString();
            const url = `https://www.googleapis.com/youtube/v3/search` +
                `?q=${encodeURIComponent(niche)}` +
                `&order=viewCount` +
                `&publishedAfter=${encodeURIComponent(publishedAfter)}` +
                `&type=video` +
                `&part=snippet` +
                `&maxResults=${TRENDING_MAX_RESULTS}` +
                SEARCH_QUALITY_PARAMS +
                `&key=${API_KEY}`;
            try {
                const res = await ytFetch(url);
                const data = await res.json();
                return (data?.items || []).map((item) => ({
                    title: decodeEntities(item.snippet.title),
                    channelTitle: item.snippet.channelTitle,
                    videoId: item.id.videoId,
                }));
            }
            catch (error) {
                throw new Error("YouTube API unavailable — failed to fetch trending videos");
            }
        };
        this.getChannelTopVideos = async (channelId) => {
            const url = `https://www.googleapis.com/youtube/v3/search` +
                `?channelId=${encodeURIComponent(channelId)}` +
                `&order=viewCount` +
                `&type=video` +
                `&part=snippet` +
                `&maxResults=${MAX_RESULTS}` +
                `&key=${API_KEY}`;
            try {
                const res = await ytFetch(url);
                const data = await res.json();
                return (data?.items || []).map((item) => item.snippet.title);
            }
            catch (error) {
                throw new Error("YouTube API unavailable — failed to fetch channel videos");
            }
        };
        this.getVideoStats = async (videoIds) => {
            if (videoIds.length === 0)
                return {};
            const url = `https://www.googleapis.com/youtube/v3/videos` +
                `?part=statistics` +
                `&id=${videoIds.join(",")}` +
                `&key=${API_KEY}`;
            try {
                const res = await ytFetch(url);
                const data = await res.json();
                const stats = {};
                for (const item of data?.items || []) {
                    stats[item.id] = Number(item.statistics?.viewCount ?? 0);
                }
                return stats;
            }
            catch (error) {
                throw new Error("YouTube API unavailable — failed to fetch video stats");
            }
        };
        this.getKeywordSignals = async (query) => {
            const url = `https://www.googleapis.com/youtube/v3/search` +
                `?q=${encodeURIComponent(query)}` +
                `&order=relevance` +
                `&type=video` +
                `&part=snippet` +
                `&maxResults=${KEYWORD_MAX_RESULTS}` +
                SEARCH_QUALITY_PARAMS +
                `&key=${API_KEY}`;
            try {
                const res = await ytFetch(url);
                const data = await res.json();
                return (data?.items || []).map((item) => ({
                    title: decodeEntities(item.snippet.title),
                    channelTitle: item.snippet.channelTitle,
                    videoId: item.id.videoId,
                }));
            }
            catch (error) {
                throw new Error("YouTube API unavailable — failed to fetch keyword signals");
            }
        };
    }
}
export default ResearchRepository;
