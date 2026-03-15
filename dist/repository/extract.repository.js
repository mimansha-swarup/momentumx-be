const MAX_RESULTS = 10;
const API_KEY = process.env.YT_API;
class ExtractRepository {
    constructor() {
        this.getYTChanelTitles = async (channelId) => {
            try {
                const res = await fetch(`https://www.googleapis.com/youtube/v3/search?key=${API_KEY}&channelId=${channelId}&part=snippet,id&order=viewCount&type=video&maxResults=${MAX_RESULTS}`);
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
                const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=id,brandingSettings&${param}&key=${API_KEY}`);
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
