const MAX_RESULTS = 10;
const KEYWORD_MAX_RESULTS = 20;
const API_KEY = process.env.YT_API;
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
                `&maxResults=${MAX_RESULTS}` +
                `&key=${API_KEY}`;
            try {
                const res = await fetch(url);
                const data = await res.json();
                return (data?.items || []).map((item) => ({
                    title: item.snippet.title,
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
                const res = await fetch(url);
                const data = await res.json();
                return (data?.items || []).map((item) => item.snippet.title);
            }
            catch (error) {
                throw new Error("YouTube API unavailable — failed to fetch channel videos");
            }
        };
        this.getKeywordSignals = async (query) => {
            const url = `https://www.googleapis.com/youtube/v3/search` +
                `?q=${encodeURIComponent(query)}` +
                `&order=relevance` +
                `&type=video` +
                `&part=snippet` +
                `&maxResults=${KEYWORD_MAX_RESULTS}` +
                `&key=${API_KEY}`;
            try {
                const res = await fetch(url);
                const data = await res.json();
                return (data?.items || []).map((item) => ({
                    title: item.snippet.title,
                    channelTitle: item.snippet.channelTitle,
                }));
            }
            catch (error) {
                throw new Error("YouTube API unavailable — failed to fetch keyword signals");
            }
        };
    }
}
export default ResearchRepository;
