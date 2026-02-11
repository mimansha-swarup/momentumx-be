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
    res.sendError = ({ message, statusCode, detail }) => {
        const code = Number(statusCode) || 500;
        res.status(code).json({
            success: false,
            message,
            detail,
        });
    };
    next();
};
