class HooksController {
    constructor(service) {
        this.service = service;
        this.handleError = (error, res, next) => {
            const err = error;
            if (err.statusCode) {
                res.sendError({ message: err.message, statusCode: err.statusCode });
            }
            else {
                next(error);
            }
        };
        this.generate = async (req, res, next) => {
            try {
                const { videoProjectId, script } = req.body;
                if (!videoProjectId || !script) {
                    return res.sendError({ message: "videoProjectId and script are required", statusCode: 400 });
                }
                const data = await this.service.generate(req.userId, videoProjectId, script);
                res.sendSuccess({ message: "Hooks generated successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.select = async (req, res, next) => {
            try {
                const hooksId = req.params.hooksId;
                const { hookIndex, videoProjectId } = req.body;
                if (hookIndex === undefined || hookIndex === null || !videoProjectId) {
                    return res.sendError({ message: "hookIndex and videoProjectId are required", statusCode: 400 });
                }
                const data = await this.service.select(req.userId, hooksId, hookIndex, videoProjectId);
                res.sendSuccess({ message: "Hook selected successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.regenerate = async (req, res, next) => {
            try {
                const hooksId = req.params.hooksId;
                const { script } = req.body;
                if (!script) {
                    return res.sendError({ message: "script is required", statusCode: 400 });
                }
                const data = await this.service.regenerate(req.userId, hooksId, script);
                res.sendSuccess({ message: "Hooks regenerated successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.updateFeedback = async (req, res, next) => {
            try {
                const hooksId = req.params.hooksId;
                const { hookIndex, feedback } = req.body;
                if (hookIndex === undefined || hookIndex === null) {
                    return res.sendError({ message: "hookIndex is required", statusCode: 400 });
                }
                if (feedback === undefined) {
                    return res.sendError({ message: "feedback is required", statusCode: 400 });
                }
                const data = await this.service.updateFeedback(req.userId, hooksId, hookIndex, feedback);
                res.sendSuccess({ message: "Feedback updated successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.exportHooks = async (req, res, next) => {
            try {
                const hooksId = req.params.hooksId;
                const data = await this.service.exportHooks(req.userId, hooksId);
                res.sendSuccess({ message: "Hooks exported successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
    }
}
export default HooksController;
