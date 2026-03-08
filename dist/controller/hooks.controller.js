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
    }
}
export default HooksController;
