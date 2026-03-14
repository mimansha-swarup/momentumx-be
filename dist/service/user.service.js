import ExtractRepository from "../repository/extract.repository.js";
import { stats } from "../constants/collection.js";
import ExtractService from "./extract.service.js";
import { formatUserData } from "../utlils/content.js";
class UserService {
    constructor(repo) {
        this.createOnboardingData = async (userId, data) => {
            let record;
            try {
                record = await formatUserData({ ...data, stats }, this.extractService);
                return record;
            }
            catch (error) {
                console.log("error", error);
            }
            finally {
                this.repo.add(userId, record);
            }
        };
        this.getProfile = async (userId) => {
            try {
                const record = await this.repo.get(userId);
                return record;
            }
            catch (error) {
                console.log("error", error);
            }
        };
        this.updateProfile = async (userId, data) => {
            try {
                const record = await formatUserData(data, this.extractService);
                await this.repo.update(userId, record);
                return record;
            }
            catch (error) {
                console.log("error", error);
            }
        };
        this.repo = repo;
        this.extractService = new ExtractService(new ExtractRepository());
    }
}
export default UserService;
