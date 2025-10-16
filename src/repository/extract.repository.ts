const MAX_RESULTS = 10;
const API_KEY = process.env.YT_API;

class ExtractRepository {
  constructor() {}

  getYTChanelTitles = async (channelId: string) => {
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/search?key=${API_KEY}&channelId=${channelId}&part=snippet,id&order=viewCount&type=video&maxResults=${MAX_RESULTS}`
      );
      const data = await res.json();
      const title = data?.items?.map((videoItem) => videoItem?.snippet?.title);

      return title;
    } catch (error) {
      console.log("error:  at getYTContent", error);
    }
  };

  retrieveChannelId = async (param: string) => {
    try {
      console.log("param", param);
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=id&${param}&key=${API_KEY}`
      );
      const data = await res.json();
      return data;
    } catch (error) {
      console.log("error:  at getYTContent", error);
    }
  };
}

export default ExtractRepository;
