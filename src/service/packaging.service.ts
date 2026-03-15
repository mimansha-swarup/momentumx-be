import {
  PACKAGING_SYSTEM_PROMPT,
  GENERATE_TITLE_PROMPT,
  GENERATE_DESCRIPTION_PROMPT,
  GENERATE_THUMBNAIL_PROMPT,
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

      throw error;
    }
  };

  private buildItemStatuses = (data: Record<string, unknown>) => {
    const hasContent = (key: string) => {
      const val = data[key];
      if (val === undefined || val === null) return false;
      if (Array.isArray(val)) return val.length > 0;
      if (typeof val === "string") return val.trim().length > 0;
      return true;
    };

    return {
      title: hasContent("titles") ? "completed" as const : "not_started" as const,
      description: hasContent("description") ? "completed" as const : "not_started" as const,
      thumbnail: hasContent("thumbnail") ? "completed" as const : "not_started" as const,
      shorts: hasContent("shorts") ? "completed" as const : "not_started" as const,
    };
  };

  savePackaging = async (userId: string, data: Record<string, unknown>, videoProjectId?: string) => {
    try {
      if (videoProjectId && this.videoProjectService) {
        await this.videoProjectService.getById(videoProjectId, userId);
      }

      const itemStatuses = this.buildItemStatuses(data);

      const packagingData = {
        ...data,
        createdBy: userId,
        itemStatuses,
        isStale: false,
        staleReason: null,
        staleSince: null,
        ...(videoProjectId ? { videoProjectId } : {}),
      };

      let result: Record<string, unknown>;

      // Upsert: check if packaging already exists for this video project
      if (videoProjectId) {
        const existing = await this.repo.findByVideoProject(videoProjectId);
        if (existing) {
          result = await this.repo.update(existing.id as string, {
            ...packagingData,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          result = await this.repo.save({
            ...packagingData,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
        }
      } else {
        result = await this.repo.save({
          ...packagingData,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }

      if (videoProjectId && this.videoProjectService) {
        this.videoProjectService
          .linkResource(videoProjectId, "packaging", result.id as string, userId)
          .then(() => this.videoProjectService!.completeStep(videoProjectId, "packaging", userId))
          .catch(console.error);
      }
      return result;
    } catch (error) {

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

      throw error;
    }
  };

  getPackagingByUser = async (userId: string) => {
    try {
      const result = await this.repo.getByUserId(userId);
      return result;
    } catch (error) {

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

    // Save previous item status for rollback on failure
    const currentStatuses = (pkg.itemStatuses ?? {}) as Record<string, string>;
    const statusKey = item as string;
    const previousStatus = currentStatuses[statusKey] ?? "not_started";

    let result: unknown;
    let fieldKey: string;

    try {
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
    } catch (genError) {
      // Rollback status on generation failure
      await this.repo.update(packagingId, {
        [`itemStatuses.${statusKey}`]: previousStatus,
      });
      throw genError;
    }

    // Atomic write: content + status update
    const updateData: Record<string, unknown> = {
      [fieldKey]: result,
      [`itemStatuses.${statusKey}`]: "completed",
    };

    // Check if clearing stale flag is needed
    const allItems = ["title", "description", "thumbnail", "shorts"];
    const anyStillStale = allItems.some(
      (k) => k !== statusKey && currentStatuses[k] === "stale"
    );

    if (!anyStillStale) {
      updateData.isStale = false;
      updateData.staleReason = null;
      updateData.staleSince = null;
    }

    await this.repo.update(packagingId, updateData);
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
