import ExtractRepository from "../repository/extract.repository.js";
import { stats } from "../constants/collection.js";
import UserRepository from "../repository/user.repository.js";
import ExtractService from "./extract.service.js";

class UserService {
  private repo: UserRepository;
  private extractService: ExtractService;

  constructor(repo: UserRepository) {
    this.repo = repo;
    this.extractService = new ExtractService(new ExtractRepository());
  }

  createOnboardingData = async (userId: string, data: IOnboardingPayload) => {
    const record = { ...data, websiteContent: "", stats };
    try {
      const asyncList: Promise<unknown>[] = [];
      if (data.website) {
        asyncList.push(this.repo.getWebsiteContent(data.website));
      }
      if (data.competitors) {
        asyncList.push(
          ...[data.userName, ...record.competitors]?.map((competitorUrl) =>
            this.extractService.retrieveChannelId(competitorUrl)
          )
        );
      }
      const settledList = await Promise.allSettled(asyncList);
      const [websiteContent, userId, ...competitorId] = settledList;

      asyncList.length = 0;

      asyncList.push(
        ...[{ value: userId.value }, ...competitorId]?.map((competitor) =>
          this.extractService.getTopTenTitle(competitor.value)
        )
      );
      const [userTitle, ...settledTitle] = await Promise.allSettled(asyncList);

      record.competitors = data.competitors?.map((url, idx) => ({
        url,
        id: competitorId[idx]?.value || "",
        titles: settledTitle[idx]?.value || [],
      }));

      record.userTitle = userTitle?.value;

      record.websiteContent = (websiteContent?.value as string) || "";

      return record;
    } catch (error) {
      console.log("error", error);
    } finally {
      this.repo.add(userId, record);
    }
  };

  getProfile = async (userId: string) => {
    try {
      const record = await this.repo.get(userId);
      return record;
    } catch (error) {
      console.log("error", error);
    }
  };

  updateProfile = async (userId: string, data: IOnboardingPayload) => {
    const record = { ...data, websiteContent: "" };
    try {
      const asyncList: Promise<unknown>[] = [];
      if (data.website) {
        asyncList.push(this.repo.getWebsiteContent(data.website));
      }
      if (data.competitors) {
        asyncList.push(
          ...[data.userName, ...record.competitors]?.map((competitorUrl) =>
            this.extractService.retrieveChannelId(competitorUrl)
          )
        );
      }
      const settledList = await Promise.allSettled(asyncList);
      const [websiteContent, userYTId, ...competitorId] = settledList;

      asyncList.length = 0;

      asyncList.push(
        ...[{ value: userYTId.value }, ...competitorId]?.map((competitor) =>
          this.extractService.getTopTenTitle(competitor.value)
        )
      );
      const [userTitle, ...settledTitle] = await Promise.allSettled(asyncList);

      record.competitors = data.competitors?.map((url, idx) => ({
        url,
        id: competitorId[idx]?.value || "",
        titles: settledTitle[idx]?.value || [],
      }));

      record.userTitle = userTitle?.value;

      record.websiteContent = (websiteContent?.value as string) || "";
      await this.repo.update(userId, record);
      return record;
    } catch (error) {
      console.log("error", error);
    }
  };
}

export default UserService;
