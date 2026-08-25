const MAX_RESULTS = 10;
const API_KEY = process.env.YT_API;
// Phase 01 item 8. These two calls sit on the onboarding and refresh-context
// paths and had no timeout, unlike research.repository.ts — a stalled YouTube
// connection would hang the request indefinitely. Same 8s bound, same reason.
const YT_TIMEOUT_MS = 8000;
const ytFetch = (url) => fetch(url, { signal: AbortSignal.timeout(YT_TIMEOUT_MS) });
class ExtractRepository {
    constructor() {
        this.getYTChanelTitles = async (channelId) => {
            try {
                const res = await ytFetch(`https://www.googleapis.com/youtube/v3/search?key=${API_KEY}&channelId=${channelId}&part=snippet,id&order=viewCount&type=video&maxResults=${MAX_RESULTS}`);
                const data = await res.json();
                const title = data?.items?.map((videoItem) => videoItem?.snippet?.title);
                return title;
            }
            catch (error) {
                throw error;
            }
        };
        this.retrieveChannelId = async (param) => {
            try {
                const res = await ytFetch(`https://www.googleapis.com/youtube/v3/channels?part=id,brandingSettings&${param}&key=${API_KEY}`);
                const data = await res.json();
                return data;
            }
            catch (error) {
                throw error;
            }
        };
    }
}
export default ExtractRepository;
