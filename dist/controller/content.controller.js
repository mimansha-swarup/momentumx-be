import { randomUUID } from "crypto";
import { formatGeneratedTitle } from "../utlils/content.js";
import { firebase } from "../config/firebase.js";
class ContentController {
    constructor(service) {
        this.handleError = (error, res, next) => {
            const err = error;
            if (err.message === "Forbidden") {
                res.sendError({ message: "Forbidden", statusCode: 403 });
            }
            else if (err.message === "Topic not found") {
                res.sendError({ message: "Topic not found", statusCode: 404 });
            }
            else if (err.statusCode) {
                res.sendError({ message: err.message, statusCode: err.statusCode });
            }
            else {
                next(error);
            }
        };
        this.retrieveTopics = async (req, res, next) => {
            try {
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
            }
            catch (error) {
                next(error);
            }
        };
        this.retrieveScripts = async (req, res, next) => {
            try {
                const data = await this.service.getUsersScript(req.userId);
                res.sendSuccess({
                    message: "successfully retrieved scripts",
                    data,
                });
            }
            catch (error) {
                next(error);
            }
        };
        this.generateTopics = async (req, res, next) => {
            try {
                const data = await this.service.generateTopics(req.userId);
                const batchId = randomUUID();
                const modifiedDataResults = await Promise.allSettled((data || [])?.map(async (record) => formatGeneratedTitle(record, req.userId, batchId)));
                // Filter out failed ones, keep only successful
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
            }
            catch (e) {
                console.log("e: ", e);
                next(e);
            }
        };
        this.editTopic = async (req, res, next) => {
            try {
                const topicId = req.params.topicId;
                await this.service.editTopics(topicId, req.userId, req.body);
                res.sendSuccess({
                    message: "Title updated successfully",
                    data: { ...req.body, id: topicId },
                });
            }
            catch (error) {
                next(error);
            }
        };
        this.editScript = async (req, res, next) => {
            try {
                const scriptId = req.params.scriptId;
                await this.service.editScript(scriptId, req.userId, req.body);
                res.sendSuccess({
                    message: "Title updated successfully",
                    data: { ...req.body, scriptId },
                });
            }
            catch (error) {
                next(error);
            }
        };
        this.regenerateAll = async (req, res, next) => {
            try {
                const data = await this.service.regenerateAll(req.userId);
                res.sendSuccess({ message: "Topics regenerated successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.regenerateOne = async (req, res, next) => {
            try {
                const data = await this.service.regenerateOne(req.userId, req.params.topicId);
                res.sendSuccess({ message: "Topic regenerated successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.updateFeedback = async (req, res, next) => {
            try {
                const { feedback } = req.body;
                const data = await this.service.updateFeedback(req.userId, req.params.topicId, feedback);
                res.sendSuccess({ message: "Feedback updated successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.exportTopics = async (req, res, next) => {
            try {
                const data = await this.service.exportTopics(req.userId);
                res.sendSuccess({ message: "Topics exported successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.generateScript = async (req, res, next) => {
            try {
                const token = req.query.token || "";
                const scriptId = req.params.scriptId;
                if (!token) {
                    return res.sendError({ message: "Unauthorized" });
                }
                const decodedToken = await firebase.auth().verifyIdToken(token);
                const uid = decodedToken.uid;
                await this.service.generateScripts(uid, scriptId, res);
            }
            catch (error) {
                next(error);
            }
        };
        this.retrieveScriptById = async (req, res, next) => {
            try {
                const data = await this.service.getScriptById(req.params.scriptId, req.userId);
                res.sendSuccess({
                    message: "successfully retrieved script",
                    data,
                });
            }
            catch (error) {
                next(error);
            }
        };
        this.service = service;
    }
}
export default ContentController;
