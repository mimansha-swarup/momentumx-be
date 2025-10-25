import { extractChannelInfo } from "../utlils/regex.js";
import ExtractRepository from "../repository/extract.repository.js";

class ExtractService {
  private repo: ExtractRepository;

  constructor(repo: ExtractRepository) {
    this.repo = repo;
  }

  retrieveChannelId = async (channelUrl: string) => {
    const info = extractChannelInfo(channelUrl);

    if (!info) throw new Error("Invalid YouTube channel URL");

    if (info.type === "channel") return info.value;

    const param =
      info.type === "handle"
        ? `forHandle=@${info.value}`
        : `forUsername=${info.value}`;

    const channelRes = await this.repo.retrieveChannelId(param);
    const channel = channelRes?.items?.[0];

    return {
      id: channel?.id,
      description: channel?.brandingSettings?.channel?.description,
    };
  };

  getTopTenTitle = async (channelId: string) => {
    return this.repo.getYTChanelTitles(channelId);
  };
}

export default ExtractService;
