import { formatGeneratedTitle } from "../utlils/content.js";
import { firebase } from "../config/firebase.js";
class ContentController {
    constructor(service) {
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
                const modifiedDataResults = await Promise.allSettled((data || [])?.map(async (record) => formatGeneratedTitle(record, req.userId)));
                // Filter out failed ones, keep only successful
                const modifiedData = modifiedDataResults
                    .filter((result) => result.status === "fulfilled")
                    .map((result) => result.value);
                if (!modifiedData?.length) {
                    throw new Error("Unable to generate at the moment");
                }
                const updatedData = this.service.saveBatchTopics(modifiedData);
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
