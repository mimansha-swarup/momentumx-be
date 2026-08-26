export const responseFormatter = (_req, res, next) => {
    res.sendSuccess = ({ message = "", statusCode = 200, meta, data, warning = "", }) => {
        res.status(statusCode).json({
            success: true,
            data,
            message,
            meta,
            warning,
        });
    };
    res.sendError = ({ message, statusCode, detail, code }) => {
        // `status` is the HTTP code; `code` is the machine-readable reason (Phase 05).
        // They were both called `code` here before, which is why this reads oddly.
        const status = Number(statusCode) || 500;
        res.status(status).json({
            success: false,
            message,
            code,
            detail,
        });
    };
    next();
};
