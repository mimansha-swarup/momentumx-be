import { Response } from "express";
import {
  SCRIPT_SYSTEM_PROMPT,
  SCRIPT_USER_PROMPT,
  TOPIC_SYSTEM_PROMPT,
  TOPIC_USER_PROMPT,
} from "../constants/prompt.js";

import ContentRepository from "../repository/content.repository.js";
import UserRepository from "../repository/user.repository.js";
import { generateContent, generateStreamingContent } from "../utlils/ai.js";
import {
  formatCreatorsData,
  formatGeneratedScript,
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
  constructor(repo: ContentRepository, userRepo: UserRepository) {
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
      const userRecord = await this.userRepo.get(userId);
      let userPrompt = TOPIC_USER_PROMPT.replace(
        "{brandName}",
        userRecord?.brandName
      )
        .replace("{BRAND_VOICE}", userRecord?.brandName)
        .replace("{targetAudience}", userRecord?.targetAudience)
        .replace("{competitors}", userRecord?.competitors.join(", "))
        .replace("{niche}", userRecord?.niche)
        .replace("{websiteContent}", userRecord?.websiteContent);

      const text = formatCreatorsData(userRecord);

      const result = await generateContent(
        TOPIC_SYSTEM_PROMPT,
        userPrompt,
        GENERATION_CONFIG_TITLES,
        "text/plain",
        text
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
          parsedRes.length
        ),
      });

      return parsedRes;
    } catch (error) {
      console.log("error", error);
    }
  };

  saveBatchTopics = (data: unknown[]) => {
    try {
      return this.repo.batchSaveTopics(data);
    } catch (error) {
      console.log("error: ", error);
    }
  };

  editTopics = async (titleId: string, resBody: Record<string, string>) => {
    await this.repo.updateTopic(titleId, resBody);
    return resBody;
  };

  editScript = async (scriptId: string, resBody: Record<string, string>) => {
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
        userRecord?.brandName
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
        GENERATION_CONFIG_SCRIPTS
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
        userId
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

  getScriptById = async (scriptId: string) => {
    try {
      const doc = await this.repo.getScriptById(scriptId);
      return doc;
    } catch (error) {
      console.log("error", error);
    }
  };
}

export default ContentService;
