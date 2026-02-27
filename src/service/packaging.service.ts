import {
  PACKAGING_SYSTEM_PROMPT,
  GENERATE_TITLE_PROMPT,
  GENERATE_DESCRIPTION_PROMPT,
  GENERATE_THUMBNAIL_PROMPT,
  GENERATE_HOOKS_PROMPT,
  GENERATE_SHORTS_PROMPT,
} from "../constants/prompt.js";
import { GENERATION_CONFIG_PACKAGING } from "../constants/firebase.js";
import PackagingRepository from "../repository/packaging.repository.js";
import { generateStreamingContent } from "../utlils/ai.js";
import { firebase } from "../config/firebase.js";

class PackagingService {
  private repo: PackagingRepository;

  constructor(repo: PackagingRepository) {
    this.repo = repo;
  }

  private generateContent = async (userPrompt: string) => {
    const result = await generateStreamingContent(
      PACKAGING_SYSTEM_PROMPT,
      userPrompt,
      GENERATION_CONFIG_PACKAGING
    );

    let accumulatedRes = "";
    for await (const chunk of result.stream) {
      const part = chunk.text();
      if (part) {
        accumulatedRes += part;
      }
    }

    return JSON.parse(accumulatedRes);
  };

  generateTitle = async (script: string) => {
    try {
      const userPrompt = GENERATE_TITLE_PROMPT.replace("{script}", script);
      const result = await this.generateContent(userPrompt);
      return result;
    } catch (error) {
      console.log("error generating title", error);
      throw error;
    }
  };

  generateDescription = async (script: string, title: string) => {
    try {
      const userPrompt = GENERATE_DESCRIPTION_PROMPT
        .replace("{script}", script)
        .replace("{title}", title);
      const result = await this.generateContent(userPrompt);
      return result;
    } catch (error) {
      console.log("error generating description", error);
      throw error;
    }
  };

  generateThumbnail = async (script: string, title: string) => {
    try {
      const userPrompt = GENERATE_THUMBNAIL_PROMPT
        .replace("{script}", script)
        .replace("{title}", title);
      const result = await this.generateContent(userPrompt);
      return result;
    } catch (error) {
      console.log("error generating thumbnail", error);
      throw error;
    }
  };

  generateHooks = async (script: string) => {
    try {
      const userPrompt = GENERATE_HOOKS_PROMPT.replace("{script}", script);
      const result = await this.generateContent(userPrompt);
      return result;
    } catch (error) {
      console.log("error generating hooks", error);
      throw error;
    }
  };

  generateShorts = async (script: string, duration: number) => {
    try {
      const userPrompt = GENERATE_SHORTS_PROMPT
        .replace("{script}", script)
        .replace(/{duration}/g, duration.toString());
      const result = await this.generateContent(userPrompt);
      return result;
    } catch (error) {
      console.log("error generating shorts", error);
      throw error;
    }
  };

  savePackaging = async (userId: string, data: Record<string, unknown>) => {
    try {
      const packagingData = {
        ...data,
        createdBy: userId,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      const result = await this.repo.save(packagingData);
      return result;
    } catch (error) {
      console.log("error saving packaging", error);
      throw error;
    }
  };

  getPackaging = async (packagingId: string, userId: string) => {
    try {
      const result = await this.repo.get(packagingId);
      if (!result) return null;
      if (result.createdBy !== userId) throw new Error("Unauthorized");
      return result;
    } catch (error) {
      console.log("error getting packaging", error);
      throw error;
    }
  };

  getPackagingByUser = async (userId: string) => {
    try {
      const result = await this.repo.getByUserId(userId);
      return result;
    } catch (error) {
      console.log("error getting packaging by user", error);
      throw error;
    }
  };
}

export default PackagingService;
