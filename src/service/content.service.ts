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
  constructor(repo: ContentRepository) {
    this.repo = repo;
  }
  generateTopics = async (uid, userRecord) => {
    const userData = await userService.createOnboardingData(`123`, userRecord);
    console.log("userData: ", userData);
    try {
      let userPrompt = TOPIC_USER_PROMPT.replace(
        "{brandName}",
        userData.brandName
      )
        .replace("{BRAND_VOICE}", userData.brandName)
        .replace("{targetAudience}", userData.targetAudience)
        .replace("competitors}", userData.competitors.join(", "))
        .replace("{niche}", userData.niche)
        .replace("{websiteContent}", userData.websiteContent);
      const result = await generateContent(TOPIC_SYSTEM_PROMPT, userPrompt);
      return result?.response?.candidates?.[0]?.content?.parts?.[0]?.text;
    } catch (error) {
      console.log("error", error);
    }
    return {};
  };

  getUsersTopic = async (userId: string) => {
    try {
      const doc = await this.repo.getTopicsByUid(userId);
      return doc;
    } catch (error) {
      console.log("error", error);
    }
    return {};
  };
}

export default ContentService;
