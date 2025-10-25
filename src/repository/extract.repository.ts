const MAX_RESULTS = 10;
const API_KEY = process.env.YT_API;

class ExtractRepository {
  constructor() {}

  getYTChanelTitles = async (channelId: string) => {
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/search?key=${API_KEY}&channelId=${channelId}&part=snippet,id&order=viewCount&type=video&maxResults=${MAX_RESULTS}`
      );
      const data: {
        items: {
          snippet: {
            title: string;
          };
        }[];
      } = await res.json();
      const title = data?.items?.map((videoItem) => videoItem?.snippet?.title);

      return title;
    } catch (error) {
      console.log("error:  at getYTContent", error);
    }
  };

  retrieveChannelId = async (param: string) => {
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=id,brandingSettings&${param}&key=${API_KEY}`
      );
      const data: {
        items: {
          id: string;
          brandingSettings: { channel: { description: string } };
        }[];
      } = await res.json();
      return data;
    } catch (error) {
      console.log("error:  at getYTContent", error);
    }
  };
}

export default ExtractRepository;
