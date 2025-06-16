import { stats } from "../constants/collection.js";
import UserRepository from "../repository/user.repository.js";

class UserService {
  private repo: UserRepository;

  constructor(repo: UserRepository) {
    this.repo = repo;
  }

  createOnboardingData = async (userId: string, data: IOnboardingPayload) => {
    const record = { ...data, websiteContent: "", stats };
    try {
      if (data.website) {
        const websiteContent = await this.repo.getWebsiteContent(data.website);

        record.websiteContent = websiteContent || "";
      }
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
    try {
      const record = { ...data, websiteContent: "" };

      const websiteContent = await this.repo.getWebsiteContent(data.website);

      record.websiteContent = websiteContent || "";

      await this.repo.update(userId, record);
      return record;
    } catch (error) {
      console.log("error", error);
    }
  };
}

export default UserService;
