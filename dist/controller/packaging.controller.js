class PackagingController {
    constructor(service) {
        this.generateTitle = async (req, res, next) => {
            try {
                const { script } = req.body;
                if (!script) {
                    return res.sendError({ message: "Script is required", statusCode: 400 });
                }
                const data = await this.service.generateTitle(script);
                res.sendSuccess({
                    message: "Title generated successfully",
                    data,
                });
            }
            catch (error) {
                next(error);
            }
        };
        this.generateDescription = async (req, res, next) => {
            try {
                const { script, title } = req.body;
                if (!script) {
                    return res.sendError({ message: "Script is required", statusCode: 400 });
                }
                if (!title) {
                    return res.sendError({ message: "Title is required", statusCode: 400 });
                }
                const data = await this.service.generateDescription(script, title);
                res.sendSuccess({
                    message: "Description generated successfully",
                    data,
                });
            }
            catch (error) {
                next(error);
            }
        };
        this.generateThumbnail = async (req, res, next) => {
            try {
                const { script, title } = req.body;
                if (!script) {
                    return res.sendError({ message: "Script is required", statusCode: 400 });
                }
                if (!title) {
                    return res.sendError({ message: "Title is required", statusCode: 400 });
                }
                const data = await this.service.generateThumbnail(script, title);
                res.sendSuccess({
                    message: "Thumbnail instructions generated successfully",
                    data,
                });
            }
            catch (error) {
                next(error);
            }
        };
        this.generateHooks = async (req, res, next) => {
            try {
                const { script } = req.body;
                if (!script) {
                    return res.sendError({ message: "Script is required", statusCode: 400 });
                }
                const data = await this.service.generateHooks(script);
                res.sendSuccess({
                    message: "Hooks generated successfully",
                    data,
                });
            }
            catch (error) {
                next(error);
            }
        };
        this.generateShorts = async (req, res, next) => {
            try {
                const { script, duration } = req.body;
                if (!script) {
                    return res.sendError({ message: "Script is required", statusCode: 400 });
                }
                if (!duration) {
                    return res.sendError({ message: "Duration is required", statusCode: 400 });
                }
                const data = await this.service.generateShorts(script, duration);
                res.sendSuccess({
                    message: "Shorts script generated successfully",
                    data,
                });
            }
            catch (error) {
                next(error);
            }
        };
        this.save = async (req, res, next) => {
            try {
                const data = await this.service.savePackaging(req.userId, req.body);
                res.sendSuccess({
                    message: "Packaging saved successfully",
                    data,
                });
            }
            catch (error) {
                next(error);
            }
        };
        this.getPackaging = async (req, res, next) => {
            try {
                const { packagingId } = req.params;
                const data = await this.service.getPackaging(packagingId, req.userId);
                if (!data) {
                    return res.sendError({ message: "Packaging not found", statusCode: 404 });
                }
                res.sendSuccess({
                    message: "Packaging retrieved successfully",
                    data,
                });
            }
            catch (error) {
                const err = error;
                if (err.message === "Unauthorized") {
                    return res.sendError({ message: "Unauthorized", statusCode: 403 });
                }
                next(error);
            }
        };
        this.getPackagingByUser = async (req, res, next) => {
            try {
                const data = await this.service.getPackagingByUser(req.userId);
                res.sendSuccess({
                    message: "Packaging list retrieved successfully",
                    data,
                });
            }
            catch (error) {
                next(error);
            }
        };
        this.handleError = (error, res, next) => {
            const err = error;
            if (err.statusCode) {
                res.sendError({ message: err.message, statusCode: err.statusCode });
            }
            else {
                next(error);
            }
        };
        this.regenerateItem = async (req, res, next) => {
            try {
                const { packagingId, item } = req.params;
                const { script, title, duration } = req.body;
                if (!script) {
                    return res.sendError({ message: "script is required", statusCode: 400 });
                }
                const data = await this.service.regenerateItem(req.userId, packagingId, item, script, title, duration);
                res.sendSuccess({ message: "Packaging item regenerated successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.updateFeedback = async (req, res, next) => {
            try {
                const { packagingId } = req.params;
                const { item, feedback } = req.body;
                if (!item) {
                    return res.sendError({ message: "item is required", statusCode: 400 });
                }
                if (feedback === undefined) {
                    return res.sendError({ message: "feedback is required", statusCode: 400 });
                }
                const data = await this.service.updateFeedback(req.userId, packagingId, item, feedback);
                res.sendSuccess({ message: "Feedback updated successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.exportPackaging = async (req, res, next) => {
            try {
                const { packagingId } = req.params;
                const data = await this.service.exportPackaging(req.userId, packagingId);
                res.sendSuccess({ message: "Packaging exported successfully", data });
            }
            catch (error) {
                this.handleError(error, res, next);
            }
        };
        this.service = service;
    }
}
export default PackagingController;
