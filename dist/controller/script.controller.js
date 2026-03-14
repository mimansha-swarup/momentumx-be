import { firebase } from "../config/firebase.js";
class ScriptController {
    constructor(service) {
        this.handleError = (error, res, next) => {
            const err = error;
            if (err.message === "Forbidden") {
                res.sendError({ message: "Forbidden", statusCode: 403 });
            }
            else if (err.message === "Script not found") {
                res.sendError({ message: "Script not found", statusCode: 404 });
            }
            else if (err.statusCode) {
                res.sendError({ message: err.message, statusCode: err.statusCode });
            }
            else {
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
        this.editScript = async (req, res, next) => {
            try {
                const scriptId = req.params.scriptId;
                await this.service.editScript(scriptId, req.userId, req.body);
                res.sendSuccess({
                    message: "Script updated successfully",
                    data: { ...req.body, scriptId },
                });
            }
            catch (error) {
                next(error);
            }
        };
        this.regenerateScript = async (req, res, next) => {
            try {
                const { scriptId } = req.params;
                const data = await this.service.regenerateScript(req.userId, scriptId);
                res.sendSuccess({ message: "Script regenerated successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.updateScriptFeedback = async (req, res, next) => {
            try {
                const { scriptId } = req.params;
                const { feedback } = req.body;
                if (feedback === undefined) {
                    return res.sendError({ message: "feedback is required", statusCode: 400 });
                }
                const data = await this.service.updateScriptFeedback(req.userId, scriptId, feedback);
                res.sendSuccess({ message: "Script feedback updated", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.exportScript = async (req, res, next) => {
            try {
                const { scriptId } = req.params;
                const data = await this.service.exportScript(req.userId, scriptId);
                res.sendSuccess({ message: "Script exported successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.service = service;
    }
}
export default ScriptController;
