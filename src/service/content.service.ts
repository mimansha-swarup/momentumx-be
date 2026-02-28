import { randomUUID } from "crypto";
import { Response } from "express";
import {
  SCRIPT_SYSTEM_PROMPT,
  SCRIPT_USER_PROMPT,
  TOPIC_SYSTEM_PROMPT,
  TOPIC_USER_PROMPT,
} from "../constants/prompt.js";

import ContentRepository from "../repository/content.repository.js";
import UserRepository from "../repository/user.repository.js";
import VideoProjectService from "./video-project.service.js";
import { generateContent, generateStreamingContent } from "../utlils/ai.js";
import {
  formatCreatorsData,
  formatGeneratedScript,
  formatGeneratedTitle,
  getClusteredTitles,
} from "../utlils/content.js";
import {
  GENERATION_CONFIG_SCRIPTS,
  GENERATION_CONFIG_TITLES,
} from "../constants/firebase.js";
import { IGetTopicByUserIdArgs } from "../types/repository/content.js";
import { firebase } from "../config/firebase.js";

//  createOnboardingData
class ContentService {
  private repo: ContentRepository;
  private userRepo: UserRepository;
  constructor(
    repo: ContentRepository,
    userRepo: UserRepository,
    private videoProjectService?: VideoProjectService,
  ) {
    this.repo = repo;
    this.userRepo = userRepo;
  }

  getPaginatedUsersTopics = async ({
    userId,
    limit,
    cursor,
    filters,
  }: IGetTopicByUserIdArgs) => {
    try {
      const docs = await this.repo.getTopics({
        userId,
        limit,
        cursor,
        filters,
      });
      const lastDoc = docs[docs.length - 1];

      const nextCursor = lastDoc
        ? {
            createdAt: lastDoc.createdAt.toDate().toISOString(),
            docId: lastDoc.id,
          }
        : null;

      return {
        meta: {
          nextCursor,
          hasNextPage: limit === docs.length,
        },
        lists: docs?.map((doc) => ({
          ...doc,
          createdAt:
            typeof doc.createdAt === "string"
              ? doc.createdAt
              : doc.createdAt?.toDate()?.toISOString(),
          updatedAt: doc?.updatedAt,
        })),
      };
    } catch (error) {
      console.log("error", error);
    }
    return {};
  };

  generateTopics = async (userId: string) => {
    try {
      const similarTitles = await getClusteredTitles(userId, this.repo);

      const userRecord = await this.userRepo.get(userId);
      let userPrompt = TOPIC_USER_PROMPT.replace(
        "{brandName}",
        userRecord?.brandName,
      )
        .replace("{BRAND_VOICE}", userRecord?.brandName)
        .replace("{targetAudience}", userRecord?.targetAudience)
        .replace("{competitors}", userRecord?.competitors?.join(", "))
        .replace("{niche}", userRecord?.niche)
        .replace("{websiteContent}", userRecord?.websiteContent);

      const text = formatCreatorsData(userRecord, similarTitles.flat());

      const result = await generateContent(
        TOPIC_SYSTEM_PROMPT,
        userPrompt,
        GENERATION_CONFIG_TITLES,
        "text/plain",
        text,
      );

      let accumulatedRes = "";

      for await (const chunk of result.stream) {
        const part = chunk.text();
        if (part) {
          accumulatedRes += part;
        }
      }

      const parsedRes = JSON.parse(accumulatedRes) as string[];

      this.userRepo.update(userId, {
        "stats.topics": firebase.firestore.FieldValue.increment(
          parsedRes.length,
        ),
      });

      return parsedRes;
    } catch (error) {
      console.log("error", error);
    }
  };

  saveBatchTopics = async (data: unknown[]) => {
    try {
      return await this.repo.batchSaveTopics(data);
    } catch (error) {
      console.log("error: ", error);
    }
  };

  editTopics = async (titleId: string, userId: string, resBody: Record<string, string>) => {
    const topic = await this.repo.getTopic(titleId);
    if (!topic) throw new Error("Topic not found");
    if (topic.createdBy !== userId) throw new Error("Forbidden");
    await this.repo.updateTopic(titleId, resBody);
    return resBody;
  };

  editScript = async (scriptId: string, userId: string, resBody: Record<string, string>) => {
    const script = await this.repo.getScriptById(scriptId);
    if (!script) throw new Error("Script not found");
    if (script.createdBy !== userId) throw new Error("Forbidden");
    await this.repo.editScript(scriptId, resBody);
    return resBody;
  };

  generateScripts = async (userId: string, scriptId: string, res: Response) => {
    try {
      const [userRecord, titleRecord] = await Promise.all([
        this.userRepo.get(userId),
        this.repo.getTopic(scriptId),
      ]);

      let userPrompt = SCRIPT_USER_PROMPT.replace(
        "{brandName}",
        userRecord?.brandName,
      )
        .replace("{brandName}", userRecord?.brandName)
        .replace("{targetAudience}", userRecord?.targetAudience)
        .replace("{competitors}", userRecord?.competitors.join(", "))
        .replace("{niche}", userRecord?.niche)
        .replace("{websiteContent}", userRecord?.websiteContent)
        .replace("{title}", titleRecord?.title);

      const result = await generateStreamingContent(
        SCRIPT_SYSTEM_PROMPT,
        userPrompt,
        GENERATION_CONFIG_SCRIPTS,
      );

      let accumulatedRes = "";

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      for await (const chunk of result.stream) {
        const part = chunk.text();
        if (part) {
          accumulatedRes += part;
          res.write(`data: ${JSON.stringify(part)}\n\n`);
        }
      }

      res.write(`event: done\n`);
      res.write(`data: [done]\n\n`);
      res.end();

      const formattedData = formatGeneratedScript(
        titleRecord?.title,
        titleRecord?.id,
        accumulatedRes,
        userId,
      );
      this.repo.updateTopic(titleRecord?.id, {
        isScriptGenerated: true,
      });
      await this.repo.saveScript(titleRecord?.id, formattedData);
      this.userRepo.update(userId, {
        "stats.scripts": firebase.firestore.FieldValue.increment(1),
      });

      return accumulatedRes;
    } catch (error) {
      console.log("error", error);
    }
    return {};
  };

  getUsersScript = async (userId: string) => {
    try {
      const doc = await this.repo.getScripts(userId);
      return doc;
    } catch (error) {
      console.log("error", error);
    }
    return {};
  };

  getScriptById = async (scriptId: string, userId: string) => {
    try {
      const doc = await this.repo.getScriptById(scriptId);
      if (!doc) return null;
      if (doc.createdBy !== userId) throw new Error("Forbidden");
      return doc;
    } catch (error) {
      console.log("error", error);
      throw error;
    }
  };

  regenerateAll = async (userId: string) => {
    const activeTopics = await this.repo.getActiveBatch(userId);

    // Fire stale cascade for any topics linked to a video project
    if (this.videoProjectService) {
      for (const topic of activeTopics) {
        if (topic.videoProjectId) {
          this.videoProjectService.markStale(topic.videoProjectId, "research").catch((err) => console.error("markStale failed for project", topic.videoProjectId, err));
        }
      }
    }

    // Archive current active batch
    await this.repo.archiveUserTopics(userId);

    // Generate new titles
    const titles = await this.generateTopics(userId);
    if (!titles || titles.length === 0) {
      throw new Error("Unable to generate topics at the moment");
    }

    const batchId = randomUUID();
    const formattedResults = await Promise.allSettled(
      titles.map((title) => formatGeneratedTitle(title, userId, batchId)),
    );
    const formatted = formattedResults
      .filter((r) => r.status === "fulfilled")
      .map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof formatGeneratedTitle>>>).value);

    return this.saveBatchTopics(formatted);
  };

  regenerateOne = async (userId: string, topicId: string) => {
    const topic = await this.repo.getTopic(topicId);
    if (!topic) {
      const err = new Error("Topic not found") as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    if (topic.createdBy !== userId) {
      const err = new Error("Forbidden") as Error & { statusCode: number };
      err.statusCode = 403;
      throw err;
    }

    const titles = await this.generateTopics(userId);
    if (!titles || titles.length === 0) {
      throw new Error("Unable to generate topics at the moment");
    }

    const newTitle = titles[0];
    const formatted = await formatGeneratedTitle(newTitle, userId, topic.batchId ?? undefined);

    await this.repo.updateTopic(topicId, {
      title: formatted.title,
      embedding: formatted.embedding,
      isScriptGenerated: false,
      videoProjectId: null,
      userFeedback: null,
    });

    return { ...formatted, id: topicId };
  };

  updateFeedback = async (
    userId: string,
    topicId: string,
    feedback: "like" | "dislike" | null,
  ) => {
    const topic = await this.repo.getTopic(topicId);
    if (!topic) {
      const err = new Error("Topic not found") as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    if (topic.createdBy !== userId) {
      const err = new Error("Forbidden") as Error & { statusCode: number };
      err.statusCode = 403;
      throw err;
    }

    const validFeedback = ["like", "dislike", null];
    if (!validFeedback.includes(feedback)) {
      const err = new Error('feedback must be "like", "dislike", or null') as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }

    await this.repo.updateTopic(topicId, { userFeedback: feedback });
    return { id: topicId, userFeedback: feedback };
  };

  exportTopics = async (userId: string) => {
    const activeTopics = await this.repo.getActiveBatch(userId);

    const sorted = [...activeTopics].sort((a, b) => {
      const aTime = a.createdAt?.toDate?.()?.getTime?.() ?? 0;
      const bTime = b.createdAt?.toDate?.()?.getTime?.() ?? 0;
      return aTime - bTime;
    });

    const today = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const lines = [
      `Research Topics — ${today}`,
      "──────────────────────────────────",
      ...sorted.map((t, i) => `${i + 1}. ${t.title}`),
    ];

    return { text: lines.join("\n"), count: sorted.length };
  };
}

export default ContentService;
