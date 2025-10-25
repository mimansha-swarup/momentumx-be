import ExtractRepository from "../repository/extract.repository.js";
import { stats } from "../constants/collection.js";
import UserRepository from "../repository/user.repository.js";
import ExtractService from "./extract.service.js";
import { formatUserData } from "src/utlils/content.js";

class UserService {
  private repo: UserRepository;
  private extractService: ExtractService;

  constructor(repo: UserRepository) {
    this.repo = repo;
    this.extractService = new ExtractService(new ExtractRepository());
  }

  createOnboardingData = async (userId: string, data: IOnboardingPayload) => {
    let record;
    try {
      record = await formatUserData(
        { ...data, stats },
        this.extractService,
        this.repo
      );

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
      const record = await formatUserData(data, this.extractService, this.repo);
      await this.repo.update(userId, record);
      return record;
    } catch (error) {
      console.log("error", error);
    }
  };
}

export default UserService;
