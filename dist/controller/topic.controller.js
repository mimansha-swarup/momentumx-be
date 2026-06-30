import { randomUUID } from "crypto";
import { formatGeneratedTitle } from "../utlils/content.js";
import { asyncHandler } from "../middleware/async_handler.js";
class TopicController {
    constructor(service) {
        this.retrieveTopics = asyncHandler(async (req, res) => {
            const { limit = "9", createdAt = "", docId = "", searchText = "", isScriptGenerated = "", } = req.query;
            const cursor = {
                createdAt: createdAt,
                docId: docId,
            };
            const filters = {
                searchText: searchText,
                isScriptGenerated: Boolean(isScriptGenerated),
            };
            const data = await this.service.getPaginatedUsersTopics({
                userId: req.userId,
                limit: parseInt(limit, 10),
                cursor,
                filters,
            });
            res.sendSuccess({
                message: "successfully retrieved topics",
                data,
            });
        });
        this.generateTopics = asyncHandler(async (req, res) => {
            const data = await this.service.generateTopics(req.userId);
            const batchId = randomUUID();
            const modifiedDataResults = await Promise.allSettled((data || [])?.map(async (record) => formatGeneratedTitle(record, req.userId, batchId)));
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
        this.editTopic = asyncHandler(async (req, res) => {
            const topicId = req.params.topicId;
            const data = await this.service.editTopics(topicId, req.userId, req.body);
            res.sendSuccess({
                message: "Title updated successfully",
                data: { ...data, id: topicId },
            });
        });
        this.regenerateAll = asyncHandler(async (req, res) => {
            const data = await this.service.regenerateAll(req.userId);
            res.sendSuccess({ message: "Topics regenerated successfully", data });
        });
        this.regenerateOne = asyncHandler(async (req, res) => {
            const data = await this.service.regenerateOne(req.userId, req.params.topicId);
            res.sendSuccess({ message: "Topic regenerated successfully", data });
        });
        this.updateFeedback = asyncHandler(async (req, res) => {
            const { feedback } = req.body;
            const data = await this.service.updateFeedback(req.userId, req.params.topicId, feedback);
            res.sendSuccess({ message: "Feedback updated successfully", data });
        });
        this.exportTopics = asyncHandler(async (req, res) => {
            const data = await this.service.exportTopics(req.userId);
            res.sendSuccess({ message: "Topics exported successfully", data });
        });
        this.service = service;
    }
}
export default TopicController;
