import { extractChannelInfo, extractTextFromHTML } from "../utlils/regex.js";
class ExtractService {
    constructor(repo) {
        this.getWebsiteContent = async (url) => {
            const res = await fetch(url);
            const html = await res.text();
            return extractTextFromHTML(html);
        };
        this.retrieveChannelId = async (channelUrl) => {
            const info = extractChannelInfo(channelUrl);
            if (!info)
                throw new Error("Invalid YouTube channel URL");
            if (info.type === "channel")
                return info.value;
            const param = info.type === "handle"
                ? `forHandle=@${info.value}`
                : `forUsername=${info.value}`;
            const channelRes = await this.repo.retrieveChannelId(param);
            const channel = channelRes?.items?.[0];
            return {
                id: channel?.id,
                description: channel?.brandingSettings?.channel?.description,
            };
        };
        this.getTopTenTitle = async (channelId) => {
            return this.repo.getYTChanelTitles(channelId);
        };
        this.repo = repo;
    }
}
export default ExtractService;
