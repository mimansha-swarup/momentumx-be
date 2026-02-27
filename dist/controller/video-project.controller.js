class VideoProjectController {
    constructor(service) {
        this.service = service;
        this.handleError = (error, res, next) => {
            const err = error;
            if (err.message === "Not found") {
                res.sendError({ message: "Not found", statusCode: 404 });
            }
            else if (err.message === "Forbidden") {
                res.sendError({ message: "Forbidden", statusCode: 403 });
            }
            else if (err.statusCode) {
                res.sendError({ message: err.message, statusCode: err.statusCode });
            }
            else {
                next(error);
            }
        };
        this.create = async (req, res, next) => {
            try {
                const { topicId } = req.body;
                if (!topicId) {
                    return res.sendError({ message: "topicId is required", statusCode: 400 });
                }
                const data = await this.service.create(req.userId, topicId);
                res.sendSuccess({ data, message: "Video project created successfully", statusCode: 201 });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.list = async (req, res, next) => {
            try {
                const { status, limit, cursor } = req.query;
                const data = await this.service.list(req.userId, {
                    status: status,
                    limit: limit ? parseInt(limit, 10) : undefined,
                    cursor,
                });
                res.sendSuccess({ data, message: "Video projects retrieved successfully" });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.getById = async (req, res, next) => {
            try {
                const { projectId } = req.params;
                const data = await this.service.getById(projectId, req.userId);
                res.sendSuccess({ data, message: "Video project retrieved successfully" });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.update = async (req, res, next) => {
            try {
                const { projectId } = req.params;
                const { workingTitle } = req.body;
                const data = await this.service.update(projectId, req.userId, { workingTitle });
                res.sendSuccess({ data, message: "Video project updated successfully" });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.delete = async (req, res, next) => {
            try {
                const { projectId } = req.params;
                const data = await this.service.delete(projectId, req.userId);
                res.sendSuccess({ data, message: "Video project deleted successfully" });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.startStep = async (req, res, next) => {
            try {
                const { projectId, stepName } = req.params;
                const data = await this.service.startStep(projectId, stepName, req.userId);
                res.sendSuccess({ data, message: "Step started successfully" });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.completeStep = async (req, res, next) => {
            try {
                const { projectId, stepName } = req.params;
                const data = await this.service.completeStep(projectId, stepName, req.userId);
                res.sendSuccess({ data, message: "Step completed successfully" });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.linkResource = async (req, res, next) => {
            try {
                const { projectId, resourceType } = req.params;
                const { resourceId } = req.body;
                if (!resourceId) {
                    return res.sendError({ message: "resourceId is required", statusCode: 400 });
                }
                const data = await this.service.linkResource(projectId, resourceType, resourceId, req.userId);
                res.sendSuccess({ data, message: "Resource linked successfully" });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
    }
}
export default VideoProjectController;
