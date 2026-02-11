const loggerMiddleware = (req, _res, next) => {
    const log = `${new Date().toISOString()} - ${req.method} ${req.originalUrl}`;
    console.log(log);
    next();
};
export default loggerMiddleware;
