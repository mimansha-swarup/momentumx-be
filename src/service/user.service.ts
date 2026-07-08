import ExtractRepository from "../repository/extract.repository.js";
import UserRepository from "../repository/user.repository.js";
import ExtractService from "./extract.service.js";
import { formatUserData } from "../utlils/content.js";

class UserService {
  private repo: UserRepository;
  private extractService: ExtractService;

  constructor(repo: UserRepository) {
    this.repo = repo;
    this.extractService = new ExtractService(new ExtractRepository());
  }

  createOnboardingData = async (userId: string, data: IOnboardingPayload) => {
    // `stats` is seeded at user creation by the auth trigger (functions/) and
    // maintained via FieldValue.increment, so onboarding no longer writes it —
    // re-onboarding must not reset accumulated counters.
    const record = await formatUserData(data, this.extractService);
    await this.repo.add(userId, record);
    return record;
  };

  getProfile = async (userId: string) => {
    return this.repo.get(userId);
  };

  updateProfile = async (userId: string, data: IOnboardingPayload) => {
    const record = await formatUserData(data, this.extractService);
    await this.repo.update(userId, record);
    return record;
  };
}

export default UserService;
