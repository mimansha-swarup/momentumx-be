import { TOPIC_SYSTEM_PROMPT, TOPIC_USER_PROMPT } from "../constants/prompt";
import ContentRepository from "../repository/content.repository";
import UserRepository from "../repository/user.repository";
import { generateContent } from "../utlils/ai";
import UserService from "./user.service";
import { UserRecord } from "firebase-admin/auth";

//  createOnboardingData
const userService = new UserService(new UserRepository());
class ContentService {
  private repo: ContentRepository;
  private userRepo: UserRepository;
  constructor(repo: ContentRepository, userRepo: UserRepository) {
    this.repo = repo;
    this.userRepo = userRepo;
  }
  generateTopics = async (userId: string) => {
    try {
      const userRecord = await this.userRepo.get(userId);
      let userPrompt = TOPIC_USER_PROMPT.replace(
        "{brandName}",
        userRecord?.brandName
      )
        .replace("{BRAND_VOICE}", userRecord?.brandName)
        .replace("{targetAudience}", userRecord?.targetAudience)
        .replace("competitors}", userRecord?.competitors.join(", "))
        .replace("{niche}", userRecord?.niche)
        .replace("{websiteContent}", userRecord?.websiteContent);
      const result = await generateContent(TOPIC_SYSTEM_PROMPT, userPrompt);
      return JSON.parse(
        result?.response?.candidates?.[0]?.content?.parts?.[0]?.text
      );
    } catch (error) {
      console.log("error", error);
    }
    return "";
  };

  getUsersTopic = async (userId: string) => {
    try {
      const doc = await this.repo.getTopicsByUid(userId);
      return doc?.data?.map((data) => ({
        ...data,
        createdAt: data?.createdAt?.toDate(),
      }));
    } catch (error) {
      console.log("error", error);
    }
    return {};
  };

  saveTopics = (userId: string, data: unknown[]) => {
    try {
      this.repo.saveTopics(userId, data);
    } catch (error) {}
  };
}

export default ContentService;
