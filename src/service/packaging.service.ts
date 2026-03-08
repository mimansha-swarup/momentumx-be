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
import VideoProjectService from "./video-project.service.js";
import { generateStreamingContent } from "../utlils/ai.js";
import { firebase } from "../config/firebase.js";

class PackagingService {
  private repo: PackagingRepository;

  constructor(repo: PackagingRepository, private videoProjectService?: VideoProjectService) {
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

  generateTitle = async (script: string, selectedHook?: string) => {
    try {
      const userPrompt = GENERATE_TITLE_PROMPT
        .replace("{script}", script)
        .replace("{selectedHook}", selectedHook ?? "");
      const result = await this.generateContent(userPrompt);
      return result;
    } catch (error) {
      console.log("error generating title", error);
      throw error;
    }
  };

  generateDescription = async (script: string, title: string, selectedHook?: string) => {
    try {
      const userPrompt = GENERATE_DESCRIPTION_PROMPT
        .replace("{script}", script)
        .replace("{title}", title)
        .replace("{selectedHook}", selectedHook ?? "");
      const result = await this.generateContent(userPrompt);
      return result;
    } catch (error) {
      console.log("error generating description", error);
      throw error;
    }
  };

  generateThumbnail = async (script: string, title: string, selectedHook?: string) => {
    try {
      const userPrompt = GENERATE_THUMBNAIL_PROMPT
        .replace("{script}", script)
        .replace("{title}", title)
        .replace("{selectedHook}", selectedHook ?? "");
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

  savePackaging = async (userId: string, data: Record<string, unknown>, videoProjectId?: string) => {
    try {
      if (videoProjectId && this.videoProjectService) {
        await this.videoProjectService.getById(videoProjectId, userId);
      }
      const packagingData = {
        ...data,
        createdBy: userId,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        ...(videoProjectId ? { videoProjectId } : {}),
      };
      const result = await this.repo.save(packagingData);
      if (videoProjectId && this.videoProjectService) {
        this.videoProjectService.linkResource(videoProjectId, "packaging", result.id as string, userId).catch(console.error);
      }
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

  regenerateItem = async (
    userId: string,
    packagingId: string,
    item: string,
    script: string,
    title?: string,
    duration?: number,
    selectedHook?: string
  ) => {
    const pkg = await this.repo.get(packagingId);
    if (!pkg) {
      const err = new Error("Packaging not found") as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    if (pkg.createdBy !== userId) {
      const err = new Error("Forbidden") as Error & { statusCode: number };
      err.statusCode = 403;
      throw err;
    }
    const validItems = ["title", "description", "thumbnail", "shorts"];
    if (!validItems.includes(item)) {
      const err = new Error(`item must be one of: ${validItems.join(", ")}`) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }
    if (!script) {
      const err = new Error("script is required") as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }
    if ((item === "description" || item === "thumbnail") && !title) {
      const err = new Error("title is required for description and thumbnail regeneration") as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }
    if (item === "shorts" && !duration) {
      const err = new Error("duration is required for shorts regeneration") as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }

    let result: unknown;
    let fieldKey: string;

    if (item === "title") {
      result = await this.generateTitle(script, selectedHook);
      fieldKey = "titles";
    } else if (item === "description") {
      result = await this.generateDescription(script, title!, selectedHook);
      fieldKey = "description";
    } else if (item === "thumbnail") {
      result = await this.generateThumbnail(script, title!, selectedHook);
      fieldKey = "thumbnail";
    } else {
      result = await this.generateShorts(script, duration!);
      fieldKey = "shorts";
    }

    await this.repo.update(packagingId, { [fieldKey]: result });
    return { id: packagingId, item, data: result };
  };

  updateFeedback = async (
    userId: string,
    packagingId: string,
    item: string,
    feedback: "like" | "dislike" | null
  ) => {
    const pkg = await this.repo.get(packagingId);
    if (!pkg) {
      const err = new Error("Packaging not found") as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    if (pkg.createdBy !== userId) {
      const err = new Error("Forbidden") as Error & { statusCode: number };
      err.statusCode = 403;
      throw err;
    }
    const validItems = ["title", "description", "thumbnail", "shorts"];
    if (!validItems.includes(item)) {
      const err = new Error(`item must be one of: ${validItems.join(", ")}`) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }
    const validFeedback = ["like", "dislike", null];
    if (!validFeedback.includes(feedback)) {
      const err = new Error('feedback must be "like", "dislike", or null') as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }

    await this.repo.update(packagingId, { [`feedback.${item}`]: feedback });
    return { id: packagingId, item, feedback };
  };

  exportPackaging = async (userId: string, packagingId: string) => {
    const pkg = await this.repo.get(packagingId);
    if (!pkg) {
      const err = new Error("Packaging not found") as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    if (pkg.createdBy !== userId) {
      const err = new Error("Forbidden") as Error & { statusCode: number };
      err.statusCode = 403;
      throw err;
    }

    const today = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const formatValue = (val: unknown): string => {
      if (val === undefined || val === null) return "N/A";
      if (typeof val === "string") return val;
      return JSON.stringify(val, null, 2);
    };

    const titles = pkg.titles;
    const titlesText = Array.isArray(titles)
      ? titles.map((t: unknown, i: number) => `${i + 1}. ${typeof t === "string" ? t : JSON.stringify(t)}`).join("\n")
      : formatValue(titles);

    const lines = [
      `Video Package — ${today}`,
      "══════════════════════════════════",
      "",
      "TITLES",
      "──────",
      titlesText,
      "",
      "DESCRIPTION",
      "───────────",
      formatValue(pkg.description),
      "",
      "THUMBNAIL BRIEF",
      "───────────────",
      formatValue(pkg.thumbnail),
      "",
      "SHORTS SCRIPT",
      "─────────────",
      formatValue(pkg.shorts),
    ];

    return { text: lines.join("\n") };
  };
}

export default PackagingService;
