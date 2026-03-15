import ExtractRepository from "../repository/extract.repository.js";
import { stats } from "../constants/collection.js";
import ExtractService from "./extract.service.js";
import { formatUserData } from "../utlils/content.js";
class UserService {
    constructor(repo) {
        this.createOnboardingData = async (userId, data) => {
            const record = await formatUserData({ ...data, stats }, this.extractService);
            await this.repo.add(userId, record);
            return record;
        };
        this.getProfile = async (userId) => {
            return this.repo.get(userId);
        };
        this.updateProfile = async (userId, data) => {
            const record = await formatUserData(data, this.extractService);
            await this.repo.update(userId, record);
            return record;
        };
        this.repo = repo;
        this.extractService = new ExtractService(new ExtractRepository());
    }
}
export default UserService;
