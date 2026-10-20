import { youtubeJson } from "./youtube-cache.repository.js";
import { decodeEntities } from "../utlils/regex.js";
const MAX_RESULTS = 10;
const API_KEY = process.env.YT_API;
// Phase 01 item 8. These two calls sit on the onboarding and refresh-context
// paths and had no timeout, unlike research.repository.ts — a stalled YouTube
// connection would hang the request indefinitely. Same 8s bound, same reason.
class ExtractRepository {
    constructor() {
        this.getYTChanelTitles = async (channelId) => {
            try {
                const data = await youtubeJson(`https://www.googleapis.com/youtube/v3/search?key=${API_KEY}&channelId=${encodeURIComponent(channelId)}&part=snippet,id&order=viewCount&type=video&maxResults=${MAX_RESULTS}`);
                // Decoded because these titles land in the channel context that
                // utlils/content.ts formats straight INTO the generation prompt.
                const title = data?.items?.map((videoItem) => decodeEntities(videoItem?.snippet?.title ?? ""));
                return title;
            }
            catch (error) {
                throw error;
            }
        };
        this.retrieveChannelId = async (param) => {
            try {
                const data = await youtubeJson(`https://www.googleapis.com/youtube/v3/channels?part=id,brandingSettings&${param}&key=${API_KEY}`);
                return data;
            }
            catch (error) {
                throw error;
            }
        };
    }
}
export default ExtractRepository;
