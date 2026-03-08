import {
  PACKAGING_SYSTEM_PROMPT,
  GENERATE_HOOKS_PROMPT,
} from "../constants/prompt.js";
import { GENERATION_CONFIG_PACKAGING } from "../constants/firebase.js";
import { generateStreamingContent } from "../utlils/ai.js";
import HooksRepository from "../repository/hooks.repository.js";
import VideoProjectService from "./video-project.service.js";
import { IHooksBatch } from "../types/routes/hooks.js";

class HooksService {
  constructor(
    private repo: HooksRepository,
    private videoProjectService: VideoProjectService
  ) {}

  generate = async (
    userId: string,
    videoProjectId: string,
    script: string
  ): Promise<IHooksBatch> => {
    await this.videoProjectService.getById(videoProjectId, userId);

    const userPrompt = GENERATE_HOOKS_PROMPT.replace("{script}", script);

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

    const parsed = JSON.parse(accumulatedRes) as { hooks: string[] };

    const hooksBatch = await this.repo.save({
      videoProjectId,
      createdBy: userId,
      hooks: parsed.hooks,
    });

    return hooksBatch;
  };

  select = async (
    userId: string,
    hooksId: string,
    hookIndex: number,
    videoProjectId: string
  ): Promise<{ id: string; hooksId: string; selectedHookIndex: number }> => {
    const hooksBatch = await this.repo.findById(hooksId);
    if (!hooksBatch) {
      const err = new Error("Hooks batch not found") as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    if (hooksBatch.createdBy !== userId) {
      const err = new Error("Forbidden") as Error & { statusCode: number };
      err.statusCode = 403;
      throw err;
    }
    if (hookIndex < 0 || hookIndex >= hooksBatch.hooks.length) {
      const err = new Error(
        `hookIndex out of range. Must be 0–${hooksBatch.hooks.length - 1}`
      ) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }

    return this.videoProjectService.setSelectedHook(videoProjectId, hooksId, hookIndex, userId);
  };
}

export default HooksService;
