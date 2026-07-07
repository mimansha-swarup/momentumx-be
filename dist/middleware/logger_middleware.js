// Credentials arrive as query params on some routes (SSE ?token=) — never log them.
const redactQueryParams = (url) => url.replace(/([?&](?:token|key|apikey|api_key)=)[^&]*/gi, "$1[REDACTED]");
const loggerMiddleware = (req, _res, next) => {
    const log = `${new Date().toISOString()} - ${req.method} ${redactQueryParams(req.originalUrl)}`;
    console.log(log);
    next();
};
export default loggerMiddleware;
