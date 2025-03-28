import UserRepository from "../repository/user.repository";

class UserService {
  private repo: UserRepository;

  constructor(repo: UserRepository) {
    this.repo = repo;
  }

  createOnboardingData = async (userId: string, data: IOnboardingPayload) => {
    try {
      const record = { ...data, websiteContent: "" };

      const websiteContent = await this.repo.getWebsiteContent(data.website);
      console.log('websiteContent: ', websiteContent);

      record.websiteContent = websiteContent;

      
      // this.repo.update(userId, data);
      return record
    } catch (error) {
      console.log("error", error);
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
      console.log('websiteContent: ', websiteContent);

      record.websiteContent = websiteContent;

      await this.repo.update(userId, record);
      return record;
    } catch (error) {
      console.log("error", error);
    }
  }

}

export default UserService;
