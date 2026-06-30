import { randomUUID } from "crypto";
import { Request, Response } from "express";
import ContentService from "../service/content.service.js";
import { formatGeneratedTitle } from "../utlils/content.js";
import { asyncHandler } from "../middleware/async_handler.js";

class TopicController {
  private service: ContentService;

  constructor(service: ContentService) {
    this.service = service;
  }

  retrieveTopics = asyncHandler(async (req: Request, res: Response) => {
    const {
      limit = "9",
      createdAt = "",
      docId = "",
      searchText = "",
      isScriptGenerated = "",
    } = req.query;
    const cursor = {
      createdAt: createdAt as string,
      docId: docId as string,
    };
    const filters = {
      searchText: searchText as string,
      isScriptGenerated: Boolean(isScriptGenerated),
    };

    const data = await this.service.getPaginatedUsersTopics({
      userId: req.userId,
      limit: parseInt(limit as string, 10),
      cursor,
      filters,
    });

    res.sendSuccess({
      message: "successfully retrieved topics",
      data,
    });
  });

  generateTopics = asyncHandler(async (req: Request, res: Response) => {
    const data = await this.service.generateTopics(req.userId);
    const batchId = randomUUID();
    const modifiedDataResults = await Promise.allSettled(
      (data || [])?.map(async (record) =>
        formatGeneratedTitle(record, req.userId, batchId),
      ),
    );
    const modifiedData = modifiedDataResults
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);

    if (!modifiedData?.length) {
      throw new Error("Unable to generate at the moment");
    }
    const updatedData = await this.service.saveBatchTopics(modifiedData);
    res.sendSuccess({
      message: "successfully generated topics",
      data: updatedData,
    });
  });

  editTopic = asyncHandler(async (req: Request, res: Response) => {
    const topicId = req.params.topicId;
    const data = await this.service.editTopics(topicId, req.userId, req.body);
    res.sendSuccess({
      message: "Title updated successfully",
      data: { ...data, id: topicId },
    });
  });

  regenerateAll = asyncHandler(async (req: Request, res: Response) => {
    const data = await this.service.regenerateAll(req.userId);
    res.sendSuccess({ message: "Topics regenerated successfully", data });
  });

  regenerateOne = asyncHandler(async (req: Request, res: Response) => {
    const data = await this.service.regenerateOne(req.userId, req.params.topicId);
    res.sendSuccess({ message: "Topic regenerated successfully", data });
  });

  updateFeedback = asyncHandler(async (req: Request, res: Response) => {
    const { feedback } = req.body as { feedback: "like" | "dislike" | null };
    const data = await this.service.updateFeedback(req.userId, req.params.topicId, feedback);
    res.sendSuccess({ message: "Feedback updated successfully", data });
  });

  exportTopics = asyncHandler(async (req: Request, res: Response) => {
    const data = await this.service.exportTopics(req.userId);
    res.sendSuccess({ message: "Topics exported successfully", data });
  });
}

export default TopicController;
